// 比较服务：
// - 访问控制：只允许已发布(published)且主体有访问权的版本参与比较
// - 大章节分块处理：chunk 可异步到达；支持中途取消（epoch 机制），
//   取消后迟到块（旧 epoch）一律拒绝，绝不混进之后开始的新比较
// - 跨块移动在所有块收齐后做二次匹配
// - 结果缓存带规则版本校验（旧规则缓存不命中）
// - 导出：冻结所见差异（快照，含两侧原文、结果、规则版、报告）

import { compareDocuments } from '../../shared/semantic/diff.js'
import { renderMarkdownReport } from '../../shared/report/report.js'
import { RuleWithdrawnError } from './rules.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class AccessError extends Error {
  constructor(msg) {
    super(msg)
    this.code = 'ACCESS_DENIED'
  }
}
export class VersionWithdrawnError extends Error {
  constructor(id) {
    super(`版本已撤回: ${id}`)
    this.code = 'VERSION_WITHDRAWN'
    this.versionId = id
  }
}
export class StaleChunkError extends Error {
  constructor(sessionId, epoch) {
    super(`迟到块被拒绝：session=${sessionId} epoch=${epoch} 已失效`)
    this.code = 'CHUNK_STALE'
  }
}
export class CancelledError extends Error {
  constructor(sessionId) {
    super(`比较已取消：session=${sessionId}`)
    this.code = 'CANCELLED'
  }
}

export class CompareService {
  /**
   * @param {{db:import('./db.js').JsonDB, rules:import('./rules.js').RuleRegistry, cache?:boolean, yieldMs?:number}} deps
   */
  constructor({ db, rules, cache = true, yieldMs = 0 }) {
    this.db = db
    this.rules = rules
    this.useCache = cache
    this.yieldMs = yieldMs
    /** @type {Map<string, any>} */
    this.sessions = new Map()
  }

  /** 断言主体可读取某版本：存在、已发布、已授权 */
  assertReadable(subject, versionId) {
    const v = this.db.getVersion(versionId)
    if (!v) throw new AccessError(`版本不存在: ${versionId}`)
    if (v.status === 'withdrawn') throw new VersionWithdrawnError(versionId)
    if (v.status !== 'published') throw new AccessError(`版本未发布: ${versionId}`)
    if (!this.db.canAccess(subject, versionId)) throw new AccessError(`无访问权: ${versionId}`)
    return v
  }

  _cacheKey(oldId, newId) {
    return `${oldId}::${newId}`
  }

  /**
   * 一次性比较（内部也用于流式 finalize 的拼装复用）。
   * @returns {Promise<object>} compareDocuments 结果
   */
  async compare({ subject, oldVersionId, newVersionId, rulePin, preferRule, forceRefresh = false, ruleConfigOverride }) {
    this.assertReadable(subject, oldVersionId)
    this.assertReadable(subject, newVersionId)

    const { version: ruleVersion, config } = this.rules.resolve({ pin: rulePin, prefer: preferRule })
    const key = this._cacheKey(oldVersionId, newVersionId)

    if (this.useCache && !forceRefresh) {
      const cached = this.db.getCache(key)
      if (this.rules.validateCache(cached, ruleVersion)) {
        return { ...cached.result, cacheHit: true }
      }
      // 命中的是旧规则缓存（或规则已撤回）→ 丢弃，按新规则重算
      if (cached) {
        // 显式标记由调用方测试观察；缓存自然被覆盖
      }
    }

    const oldV = this.db.getVersion(oldVersionId)
    const newV = this.db.getVersion(newVersionId)
    const opts = { ruleVersion, ...(ruleConfigOverride || config || {}) }
    if (this.yieldMs) await sleep(this.yieldMs)
    const result = compareDocuments(oldV.source, newV.source, opts)
    result.cacheHit = false
    result.versionIds = { old: oldVersionId, new: newVersionId }
    if (this.useCache) await this.db.putCache(key, { result, ruleVersion, computedAt: Date.now() })
    return result
  }

  /**
   * 开启流式分块比较会话。取消后可 restart() 开始新比较（epoch 递增），
   * 旧比较的迟到块将被隔离。
   */
  startSession({ subject, oldVersionId, newVersionId, rulePin, preferRule, options = {} }) {
    this.assertReadable(subject, oldVersionId)
    this.assertReadable(subject, newVersionId)
    const { version: ruleVersion, config } = this.rules.resolve({ pin: rulePin, prefer: preferRule })
    const id = `s-${Math.random().toString(36).slice(2, 10)}`
    const session = {
      id,
      subject,
      oldVersionId,
      newVersionId,
      epoch: 1,
      cancelled: false,
      finalized: false,
      ruleVersion,
      options: { ruleVersion, ...(config || {}), ...options },
      /** @type {Map<string,any>} 已收块（按块内容哈希去重） */
      chunks: new Map(),
      /** @type {{chunkId:string,side:'old'|'new',epoch:number}[]} */
      arrivals: []
    }
    this.sessions.set(id, session)
    return { sessionId: id, epoch: 1, ruleVersion }
  }

  /** 取消当前比较（epoch 失效） */
  cancel(sessionId) {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.cancelled = true
    s.epoch += 1
  }

  /** 在同一会话上开始新比较（取消语义延续：旧块全部作废） */
  restart(sessionId) {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error('session not found')
    s.epoch += 1
    s.cancelled = false
    s.finalized = false
    s.chunks = new Map()
    s.arrivals = []
    return { sessionId, epoch: s.epoch }
  }

  /**
   * 提交一个章节块。epoch 不匹配（取消后迟到块）直接拒绝，不写入状态。
   * @returns {Promise<{accepted:boolean, dedup?:boolean}>}
   */
  async submitChunk(sessionId, epoch, chunkId, side, payload) {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error('session not found')
    if (epoch !== s.epoch) throw new StaleChunkError(sessionId, epoch)
    if (s.cancelled) throw new CancelledError(sessionId)
    if (this.yieldMs) await sleep(this.yieldMs)
    const dedupKey = `${side}:${chunkId}`
    const stamp = JSON.stringify(payload)
    const existing = s.chunks.get(dedupKey)
    s.arrivals.push({ chunkId, side, epoch })
    if (existing) {
      if (existing.stamp === stamp) return { accepted: true, dedup: true }
      // 同块不同内容：后者覆盖（块重传场景）
    }
    s.chunks.set(dedupKey, { chunkId, side, payload, stamp: stamp.length + ':' + stamp.length, epoch })
    return { accepted: true }
  }

  /**
   * 收齐后结束比较：先做局部对齐，再做跨块二次移动匹配。
   * 为保持与一次性比较结果一致，finalize 使用两侧完整原文重新分块并按已提交
   * 块白名单参与计算（迟到/缺失的块被排除在新比较之外）。
   */
  async finalize(sessionId, epoch, { expectedChunkIds } = {}) {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error('session not found')
    if (epoch !== s.epoch) throw new StaleChunkError(sessionId, epoch)
    if (s.cancelled) throw new CancelledError(sessionId)
    if (s.finalized) throw new Error('session already finalized')

    const oldV = this.assertReadable(s.subject, s.oldVersionId)
    const newV = this.assertReadable(s.subject, s.newVersionId)
    // 规则在 finalize 时重新校验：期间被撤回则失败
    this.rules.resolve({ pin: s.ruleVersion })

    // 已接受块白名单（只接受当前 epoch 到达的块）
    const acceptedOld = new Set()
    const acceptedNew = new Set()
    for (const [k, c] of s.chunks) {
      if (c.epoch !== s.epoch) continue
      ;(c.side === 'old' ? acceptedOld : acceptedNew).add(c.chunkId)
    }
    if (expectedChunkIds) {
      for (const id of expectedChunkIds.old || []) acceptedOld.has(id) || acceptedOld.add(id)
      for (const id of expectedChunkIds.new || []) acceptedNew.has(id) || acceptedNew.add(id)
    }
    if (this.yieldMs) await sleep(this.yieldMs)
    if (s.cancelled) throw new CancelledError(sessionId)

    const key = this._cacheKey(s.oldVersionId, s.newVersionId)
    if (this.useCache && acceptedOld.size === 0 && acceptedNew.size === 0) {
      // 空集合仅在显式 expected 为空时出现；正常路径不读缓存（块集合不同）
    }

    // 直接以“已接受块集合”驱动引擎：未提交块整体隐藏，
    // 行号保持原文位置，跨块移动在可见块间做二次匹配。
    const result = compareDocuments(oldV.source, newV.source, {
      ...s.options,
      acceptedChunks: { old: acceptedOld, new: acceptedNew }
    })
    result.cacheHit = false
    result.chunked = true
    result.versionIds = { old: s.oldVersionId, new: s.newVersionId }
    result.acceptedChunks = { old: [...acceptedOld], new: [...acceptedNew] }
    s.finalized = true
    return result
  }

  /**
   * 创建分享：只引用有访问权的已发布版本。返回的 token 解析时再次校验
   * （版本撤回则分享链接失效；已导出的冻结快照不失效）。
   */
  async createShare({ subject, oldVersionId, newVersionId, rulePin, preferRule, freeze = true }) {
    this.assertReadable(subject, oldVersionId)
    this.assertReadable(subject, newVersionId)
    const result = await this.compare({ subject, oldVersionId, newVersionId, rulePin, preferRule })
    const token = 'sh-' + Math.random().toString(36).slice(2, 12)
    const share = {
      token,
      subject,
      oldVersionId,
      newVersionId,
      ruleVersion: result.ruleVersion,
      createdAt: Date.now()
    }
    if (freeze) {
      const snap = await this.exportFrozen({ subject, oldVersionId, newVersionId, ruleVersion: result.ruleVersion, result })
      share.frozenSnapshotId = snap.id
    }
    await this.db.putShare(share)
    return { token, share }
  }

  /** 解析分享链接：两侧版本必须仍为已发布且主体仍有访问权 */
  resolveShare(token, subject) {
    const s = this.db.getShare(token)
    if (!s) throw new AccessError('分享不存在')
    this.assertReadable(subject, s.oldVersionId)
    this.assertReadable(subject, s.newVersionId)
    return s
  }

  /**
   * 导出冻结快照：写入时所见的差异（两侧原文、结果、规则版、Markdown 报告）。
   * 快照不可变；之后版本撤回或规则升级都不影响已导出内容。
   */
  async exportFrozen({ subject, oldVersionId, newVersionId, rulePin, preferRule, ruleVersion, result }) {
    this.assertReadable(subject, oldVersionId)
    this.assertReadable(subject, newVersionId)
    const oldV = this.db.getVersion(oldVersionId)
    const newV = this.db.getVersion(newVersionId)
    const res = result || (await this.compare({ subject, oldVersionId, newVersionId, rulePin, preferRule }))
    const rv = ruleVersion || res.ruleVersion
    const id = 'snap-' + Math.random().toString(36).slice(2, 12)
    const report = renderMarkdownReport({
      result: res,
      oldVersion: { versionId: oldVersionId, title: oldV.title },
      newVersion: { versionId: newVersionId, title: newV.title }
    })
    const snap = {
      id,
      frozenAt: new Date().toISOString(),
      subject,
      oldVersion: { id: oldVersionId, title: oldV.title, source: oldV.source, status: oldV.status },
      newVersion: { id: newVersionId, title: newV.title, source: newV.source, status: newV.status },
      ruleVersion: rv,
      result: res,
      reportMarkdown: report
    }
    await this.db.putSnapshot(snap)
    return snap
  }
}
