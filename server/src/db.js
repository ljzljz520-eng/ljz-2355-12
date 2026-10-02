// 极简 JSON 文件数据库：存放基线、目标版本、差异规则版本、访问权、分享与冻结快照。
// 记录结构：
//   versions[id] = { id, docId, status: 'draft'|'published'|'withdrawn', title,
//                    source, publishedAt, createdAt }
//   access[subject][versionId] = true
//   rules[version] = { version, status: 'active'|'withdrawn', createdAt, config }
//   diffCache[key] = { key, result, ruleVersion, computedAt }
//   shares[token] = { token, oldVersionId, newVersionId, createdAt, frozenSnapshotId? }
//   snapshots[id] = { id, ...冻结载荷 }
// 所有写操作整体序列化落盘，避免读到半写文件（先写临时文件再 rename）。

import fs from 'node:fs'
import path from 'node:path'

const clone = (v) => (v === undefined ? undefined : structuredClone(v))

const DEFAULTS = {
  versions: {},
  access: {},
  rules: {},
  diffCache: {},
  shares: {},
  snapshots: {}
}

export class JsonDB {
  /** @param {string} file */
  constructor(file) {
    this.file = file
    /** @type {typeof DEFAULTS} */
    this.data = structuredClone(DEFAULTS)
    this._chain = Promise.resolve()
    this._load()
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
        this.data = { ...structuredClone(DEFAULTS), ...raw }
      }
    } catch (err) {
      // 损坏文件不覆盖，改名隔离后空库启动
      const quarantined = this.file + '.corrupt.' + Date.now()
      fs.renameSync(this.file, quarantined)
      this.data = structuredClone(DEFAULTS)
    }
  }

  /** 串行化写操作，避免并发比较的落盘互相覆盖 */
  _flush() {
    const doWrite = () =>
      new Promise((resolve, reject) => {
        fs.mkdirSync(path.dirname(this.file), { recursive: true })
        const tmp = this.file + '.tmp'
        fs.writeFile(tmp, JSON.stringify(this.data, null, 2), (err) => {
          if (err) return reject(err)
          fs.rename(tmp, this.file, (e2) => (e2 ? reject(e2) : resolve()))
        })
      })
    this._chain = this._chain.then(doWrite, doWrite)
    return this._chain
  }

  // ---- versions ----
  putVersion(v) {
    this.data.versions[v.id] = { ...this.data.versions[v.id], ...v }
    return this._flush()
  }

  getVersion(id) {
    return this.data.versions[id] ? structuredClone(this.data.versions[id]) : null
  }

  listVersions(docId) {
    return Object.values(this.data.versions)
      .filter((v) => v.docId === docId)
      .map(clone)
  }

  setVersionStatus(id, status) {
    if (!this.data.versions[id]) throw new Error('version not found: ' + id)
    this.data.versions[id].status = status
    return this._flush()
  }

  // ---- access ----
  grant(subject, versionId) {
    ;(this.data.access[subject] ??= {})[versionId] = true
    return this._flush()
  }

  revoke(subject, versionId) {
    if (this.data.access[subject]) delete this.data.access[subject][versionId]
    return this._flush()
  }

  canAccess(subject, versionId) {
    return Boolean(this.data.access[subject]?.[versionId])
  }

  // ---- rules ----
  putRule(rule) {
    this.data.rules[rule.version] = { ...this.data.rules[rule.version], ...rule }
    return this._flush()
  }

  getRule(version) {
    return this.data.rules[version] ? structuredClone(this.data.rules[version]) : null
  }

  listRules() {
    return Object.values(this.data.rules).map(clone)
  }

  setRuleStatus(version, status) {
    if (!this.data.rules[version]) throw new Error('rule not found: ' + version)
    this.data.rules[version].status = status
    return this._flush()
  }

  // ---- diff cache ----
  getCache(key) {
    return this.data.diffCache[key] ? structuredClone(this.data.diffCache[key]) : null
  }

  putCache(key, entry) {
    this.data.diffCache[key] = { key, ...entry }
    return this._flush()
  }

  invalidateCacheForVersion(versionId) {
    let changed = false
    for (const [k, c] of Object.entries(this.data.diffCache)) {
      if (k.includes(versionId)) {
        delete this.data.diffCache[k]
        changed = true
      }
    }
    return changed ? this._flush() : Promise.resolve()
  }

  // ---- shares ----
  putShare(s) {
    this.data.shares[s.token] = { ...this.data.shares[s.token], ...s }
    return this._flush()
  }

  getShare(token) {
    return this.data.shares[token] ? structuredClone(this.data.shares[token]) : null
  }

  // ---- snapshots（导出冻结所见差异） ----
  putSnapshot(snap) {
    this.data.snapshots[snap.id] = structuredClone(snap)
    return this._flush()
  }

  getSnapshot(id) {
    return this.data.snapshots[id] ? structuredClone(this.data.snapshots[id]) : null
  }
}
