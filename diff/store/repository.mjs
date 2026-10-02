// 领域仓储：版本发布/撤回、比较运行、规则钉版缓存、分享授权、冻结导出

import { JsonDB } from './db.mjs'
import { DEFAULT_RULES, RULES_VERSION } from '../engine/rules.mjs'
import { parseDocument } from '../engine/parser.mjs'
import { compareDocuments, freezeSnapshot } from '../engine/matcher.mjs'
import crypto from 'crypto'

export class Repository {
  constructor(dbFile) {
    this.db = new JsonDB(dbFile)
    // 内存中的取消代数：每次取消递增；迟到块回报时比对代数
    this.generations = new Map()
    this._ensureRules()
  }

  _ensureRules() {
    let v = this.db.findOne('rules', (r) => r.rulesVersion === RULES_VERSION)
    if (!v) {
      v = this.db.insert('rules', { rulesVersion: RULES_VERSION, rules: DEFAULT_RULES, active: true })
    }
    return v
  }

  currentRulesVersion() {
    const active = this.db.findOne('rules', (r) => r.active)
    return active ? active.rulesVersion : RULES_VERSION
  }

  getRules(version) {
    const rec = this.db.findOne('rules', (r) => r.rulesVersion === (version || this.currentRulesVersion()))
    if (!rec) throw Object.assign(new Error('UNKNOWN_RULES_VERSION'), { code: 'UNKNOWN_RULES_VERSION', version })
    return rec.rules
  }

  registerRules(rulesVersion, rules, { activate = false } = {}) {
    let rec = this.db.findOne('rules', (r) => r.rulesVersion === rulesVersion)
    if (rec) {
      // 允许通过 activate 重新激活已注册的旧版本
      if (activate && !rec.active) {
        this.db.find('rules', (r) => r.rulesVersion !== rulesVersion).forEach((r) => Object.assign(r, { active: false }))
        rec = this.db.update('rules', rec._id, { active: true })
      }
      return rec
    }
    rec = this.db.insert('rules', { rulesVersion, rules, active: activate })
    if (activate) this.db.find('rules', (r) => r.rulesVersion !== rulesVersion).forEach((r) => Object.assign(r, { active: false }))
    this.db.save()
    return rec
  }

  /* ---------- 版本 ---------- */

  saveVersion({ docId, versionId, title, content, status = 'draft', author, publishedRevision }) {
    const old = this.db.findOne('versions', (v) => v.docId === docId && v.versionId === versionId)
    const fp = crypto.createHash('sha256').update(content).digest('hex')
    if (old) {
      return this.db.update('versions', old._id, { title, content, status, author, publishedRevision, contentHash: fp })
    }
    return this.db.insert('versions', {
      docId, versionId, title, content, status, author, publishedRevision, contentHash: fp,
    })
  }

  getVersion(docId, versionId) {
    return this.db.findOne('versions', (v) => v.docId === docId && v.versionId === versionId)
  }

  // 发布：生成不可变发布版（revision 单调），草稿与发布分离
  publish(docId, versionId, { acl = ['*'] } = {}) {
    const v = this.getVersion(docId, versionId)
    if (!versionId || !v) throw Object.assign(new Error('VERSION_NOT_FOUND'), { code: 'VERSION_NOT_FOUND' })
    const last = this.db.find('versions', (x) => x.docId === docId && x.publishedAt)
      .map((x) => x.publishedRevision || 0)
      .reduce((m, n) => Math.max(m, n), 0)
    const revision = last + 1
    return this.db.update('versions', v._id, {
      status: 'published', publishedAt: new Date().toISOString(), publishedRevision: revision, acl,
    })
  }

  // 撤回：发布版变为 withdrawn；已生成的分享链接随之失效
  withdraw(docId, versionId) {
    const v = this.getVersion(docId, versionId)
    if (!v) throw Object.assign(new Error('VERSION_NOT_FOUND'), { code: 'VERSION_NOT_FOUND' })
    this.db.update('versions', v._id, { status: 'withdrawn', withdrawnAt: new Date().toISOString() })
    for (const s of this.db.find('shares', (s) => s.docId === docId && (s.baselineId === versionId || s.targetId === versionId))) {
      this.db.update('shares', s._id, { status: 'revoked', revokedReason: 'version-withdrawn' })
    }
    this.db.save()
    return v
  }

  canAccess(versionRec, user) {
    if (!versionRec) return false
    if (versionRec.status === 'published') {
      const acl = versionRec.acl || ['*']
      return acl.includes('*') || acl.includes(user)
    }
    // 撤回版对任何人不可见（含作者）
    if (versionRec.status === 'withdrawn') return false
    // 草稿仅作者本人/编辑可用于内部比较；分享与导出另有 published 硬门槛
    if (versionRec.status === 'draft') {
      return versionRec.author === user || user === 'editor' || user === 'admin'
    }
    return false
  }

  /* ---------- 比较运行（支持取消代数） ---------- */

  startRun({ docId, baselineId, targetId, rulesVersion, requester }) {
    const rv = rulesVersion || this.currentRulesVersion()
    this.getRules(rv) // 未知规则版本直接失败
    const gen = (this.generations.get(docId) || 0) + 1
    this.generations.set(docId, gen)
    const run = this.db.insert('runs', {
      docId, baselineId, targetId, rulesVersion: rv,
      status: 'running', generation: gen, requester,
    })
    return { run, generation: gen }
  }

  currentGeneration(docId) {
    return this.generations.get(docId) || 0
  }

  // 取消当前代数：之后完成的迟到块/迟到运行不得写入新比较
  cancel(docId) {
    const gen = (this.generations.get(docId) || 0) + 1
    this.generations.set(docId, gen)
    for (const r of this.db.find('runs', (r) => r.docId === docId && r.status === 'running')) {
      this.db.update('runs', r._id, { status: 'cancelled', cancelledGeneration: gen })
    }
    return gen
  }

  finishRun(runId, generation, docId, report) {
    // 代数守卫：迟到结果一律丢弃，绝不混进已开始的新一轮比较
    if (generation !== this.currentGeneration(docId)) {
      this.db.update('runs', runId, { status: 'stale-discarded', discardedAt: new Date().toISOString() })
      return { discarded: true }
    }
    const run = this.db.update('runs', runId, { status: 'done', report, finishedAt: new Date().toISOString() })
    this.putCache({
      docId,
      baselineId: report.baselineId,
      targetId: report.targetId,
      rulesVersion: report.rulesVersion,
      reportId: report.reportId,
    })
    return { discarded: false, run }
  }

  getRun(runId) {
    return this.db.findOne('runs', (r) => r._id === runId)
  }

  /* ---------- 缓存（键为 文档+基线+目标；规则版本作为内容字段，旧规则命中 => stale） ---------- */

  cacheKey({ docId, baselineId, targetId }) {
    return [docId, baselineId, targetId].join('::')
  }

  putCache(entry) {
    const key = this.cacheKey(entry)
    const exist = this.db.findOne('cache', (c) => c.key === key)
    const rec = { ...entry, key, cachedAt: new Date().toISOString(), stale: false }
    if (exist) return this.db.update('cache', exist._id, rec)
    return this.db.insert('cache', rec)
  }

  lookupCache({ docId, baselineId, targetId, rulesVersion }) {
    // rulesVersion：调用方明确指定时与之比较；否则与“当前规则版本”比较
    const key = this.cacheKey({ docId, baselineId, targetId })
    const hit = this.db.findOne('cache', (c) => c.key === key)
    if (!hit) return { hit: false }
    const expected = rulesVersion || this.currentRulesVersion()
    if (hit.rulesVersion !== expected) {
      // 缓存来自旧规则（或非所请求版本）：标记 stale，不静默用于分享/导出
      this.db.update('cache', hit._id, { stale: true })
      return { hit: true, stale: true, entry: hit, expectedRulesVersion: expected }
    }
    return { hit: true, stale: false, entry: hit }
  }

  /* ---------- 比较编排 ---------- */

  async compare({ docId, baselineId, targetId, rulesVersion, requester, useCache = true, preferredMode, signal }) {
    const explicitRules = !!rulesVersion
    const rules = this.getRules(rulesVersion)
    if (useCache) {
      // 明确请求某规则版本时，仅接受该版本的缓存；
      // 未指定（默认当前规则）而命中旧规则缓存 => stale，交调用方提示，不静默复用。
      const c = this.lookupCache({ docId, baselineId, targetId, rulesVersion: rules.rulesVersion })
      if (c.hit && !c.stale) {
        const run = this.db.findOne('runs', (r) => r.report && r.report.reportId === c.entry.reportId)
        return { cached: true, stale: false, report: run?.report || null }
      }
      if (c.hit && c.stale && !explicitRules) {
        return { cached: true, stale: true, entry: c.entry, currentRulesVersion: c.expectedRulesVersion }
      }
      // stale 但调用方显式指定了规则版本 => 继续按该版本重算
    }

    const vA = this.requireAccessibleVersion(docId, baselineId, requester)
    const vB = this.requireAccessibleVersion(docId, targetId, requester)

    const { run, generation } = this.startRun({ docId, baselineId, targetId, rulesVersion: rules.rulesVersion, requester })
    // 调用方（HTTP 层）可传入 AbortSignal；缺省时内部建一个，由 cancel(docId) 间接处理
    const controller = signal ? null : new AbortController()
    const usedSignal = signal || controller.signal

    let report
    try {
      const docA = parseDocument(vA.content, { docId })
      const docB = parseDocument(vB.content, { docId })
      report = await compareDocuments(docA, docB, rules, {
        baselineId, targetId, signal: usedSignal, preferredMode,
      })
    } catch (e) {
      if (e.code === 'ABORTED') {
        this.db.update('runs', run._id, { status: 'cancelled' })
        const err = new Error('比较已取消')
        err.code = 'CANCELLED'
        throw err
      }
      this.db.update('runs', run._id, { status: 'failed', error: String(e.message || e) })
      throw e
    }
    const out = this.finishRun(run._id, generation, docId, report)
    if (out.discarded) {
      const err = new Error('结果已过期（比较被新请求取代），已丢弃')
      err.code = 'STALE_RUN_DISCARDED'
      throw err
    }
    return { cached: false, stale: false, report, run: out.run }
  }

  requireAccessibleVersion(docId, versionId, user) {
    const v = this.getVersion(docId, versionId)
    if (!v) throw Object.assign(new Error('VERSION_NOT_FOUND'), { code: 'VERSION_NOT_FOUND', versionId })
    if (!this.canAccess(v, user)) {
      throw Object.assign(new Error('VERSION_NOT_ACCESSIBLE'), { code: 'VERSION_NOT_ACCESSIBLE', versionId, status: v.status })
    }
    return v
  }

  /* ---------- 分享：只引用有访问权的发布版 ---------- */

  createShare({ docId, baselineId, targetId, user, ttlHours = 24 * 7 }) {
    // 顺序：先确认两版都是“发布版”（草稿/撤回一律不可分享），再校验访问权
    const rawA = this.getVersion(docId, baselineId)
    const rawB = this.getVersion(docId, targetId)
    if (!rawA || !rawB) throw Object.assign(new Error('VERSION_NOT_FOUND'), { code: 'VERSION_NOT_FOUND' })
    if (rawA.status !== 'published' || rawB.status !== 'published' ||
        rawA.publishedRevision == null || rawB.publishedRevision == null) {
      throw Object.assign(new Error('ONLY_PUBLISHED_REVISIONS_SHAREABLE'), { code: 'ONLY_PUBLISHED_REVISIONS_SHAREABLE' })
    }
    const vA = this.requireAccessibleVersion(docId, baselineId, user)
    const vB = this.requireAccessibleVersion(docId, targetId, user)
    const token = crypto.createHash('sha256').update([docId, baselineId, targetId, Date.now(), Math.random()].join(':')).digest('hex').slice(0, 16)
    const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString()
    // 规则版本一并钉住：分享内容与比较时规则绑定
    const rulesVersion = this.currentRulesVersion()
    return this.db.insert('shares', {
      token, docId,
      baselineId, targetId,
      baselineRevision: vA.publishedRevision, targetRevision: vB.publishedRevision,
      rulesVersion, status: 'active', createdBy: user, expiresAt,
    })
  }

  resolveShare(token, user) {
    const s = this.db.findOne('shares', (x) => x.token === token)
    if (!s) throw Object.assign(new Error('SHARE_NOT_FOUND'), { code: 'SHARE_NOT_FOUND' })
    if (s.status !== 'active') {
      throw Object.assign(new Error('SHARE_REVOKED'), { code: 'SHARE_REVOKED', reason: 'version-withdrawn' })
    }
    if (s.expiresAt && new Date(s.expiresAt) < new Date()) {
      throw Object.assign(new Error('SHARE_EXPIRED'), { code: 'SHARE_EXPIRED' })
    }
    const vA = this.getVersion(s.docId, s.baselineId)
    const vB = this.getVersion(s.docId, s.targetId)
    // 撤回即时生效
    if (!vA || vA.status !== 'published' || !vB || vB.status !== 'published') {
      this.db.update('shares', s._id, { status: 'revoked', revokedReason: 'version-withdrawn' })
      throw Object.assign(new Error('SHARE_REVOKED'), { code: 'SHARE_REVOKED', reason: 'version-withdrawn' })
    }
    // 被分享者仍需在发布版 ACL 内
    if (!this.canAccess(vA, user) || !this.canAccess(vB, user)) {
      throw Object.assign(new Error('SHARE_ACCESS_DENIED'), { code: 'SHARE_ACCESS_DENIED' })
    }
    return { share: s, baseline: vA, target: vB }
  }

  /* ---------- 导出：冻结所见差异 ---------- */

  async exportDiff({ docId, baselineId, targetId, user, rulesVersion, includeRaw = true, includeCosmetic = true }) {
    const vA = this.requireAccessibleVersion(docId, baselineId, user)
    const vB = this.requireAccessibleVersion(docId, targetId, user)
    // 导出冻结“当前规则下所见差异”：显式传入旧规则版本一律拒绝
    const current = this.currentRulesVersion()
    if (rulesVersion && rulesVersion !== current) {
      throw Object.assign(new Error('STALE_RULES_CANNOT_EXPORT'), { code: 'STALE_RULES_CANNOT_EXPORT' })
    }
    // 强制绕过缓存重算，确保不以旧规则缓存作为导出依据
    const cmp = await this.compare({ docId, baselineId, targetId, rulesVersion: current, requester: user, useCache: false })
    if (cmp.stale) {
      throw Object.assign(new Error('STALE_RULES_CANNOT_EXPORT'), { code: 'STALE_RULES_CANNOT_EXPORT' })
    }
    const rules = this.getRules(current)
    const docA = parseDocument(vA.content, { docId })
    const docB = parseDocument(vB.content, { docId })
    const snapshot = freezeSnapshot(
      includeRaw ? vA.content : '', includeRaw ? vB.content : '', docA, docB, cmp.report,
      { titleA: vA.title, titleB: vB.title, rules, includeCosmetic }
    )
    snapshot.exportedBy = user
    snapshot.docId = docId
    const rec = this.db.insert('exports', {
      docId, baselineId, targetId,
      baselineRevision: vA.publishedRevision, targetRevision: vB.publishedRevision,
      rulesVersion: rules.rulesVersion, snapshot,
    })
    return rec
  }
}

