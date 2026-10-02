// 差异规则注册表：
// - 规则以版本号发布（rule-v1、rule-v2…），比较结果冻结所用 ruleVersion
// - 规则可撤回（withdrawn）：被撤回的规则不得用于新比较；显式 pin 撤回规则直接报错
// - 缓存条目必须与规则版本一致：命中缓存时若记录的 ruleVersion 与本次解析到的
//   规则版本不同，视为“缓存命中旧规则”，丢弃并按新规则重算。

import { JsonDB } from './db.js'

export class RuleNotFoundError extends Error {}
export class RuleWithdrawnError extends Error {
  constructor(version) {
    super(`差异规则版本已撤回: ${version}`)
    this.code = 'RULE_WITHDRAWN'
    this.ruleVersion = version
  }
}

export class RuleRegistry {
  /** @param {JsonDB} db */
  constructor(db) {
    this.db = db
  }

  /**
   * 解析本次比较使用的规则版本。
   * @param {{pin?:string, prefer?:string}} [opts] pin=显式指定（分享链接）；prefer=首选版本
   * @returns {{version:string, config:object}}
   */
  resolve(opts = {}) {
    if (opts.pin) {
      const r = this.db.getRule(opts.pin)
      if (!r) throw new RuleNotFoundError(opts.pin)
      if (r.status === 'withdrawn') throw new RuleWithdrawnError(opts.pin)
      return { version: r.version, config: r.config || {} }
    }
    if (opts.prefer) {
      const r = this.db.getRule(opts.prefer)
      if (r && r.status === 'active') return { version: r.version, config: r.config || {} }
    }
    // 默认：最新激活版本（按创建时间，其次版本号）
    const active = this.db
      .listRules()
      .filter((r) => r.status === 'active')
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0) || (a.version < b.version ? 1 : -1))
    if (!active.length) throw new RuleNotFoundError('(no active rules)')
    return { version: active[0].version, config: active[0].config || {} }
  }

  withdraw(version) {
    return this.db.setRuleStatus(version, 'withdrawn')
  }

  publish(version, config = {}) {
    return this.db.putRule({ version, status: 'active', createdAt: Date.now(), config })
  }

  /**
   * 校验缓存条目：规则版本不一致（命中旧规则）或规则已撤回 => 失效。
   * @param {{ruleVersion:string}|null} cached
   * @param {string} currentVersion
   */
  validateCache(cached, currentVersion) {
    if (!cached) return false
    if (cached.ruleVersion !== currentVersion) return false
    const r = this.db.getRule(currentVersion)
    if (!r || r.status !== 'active') return false
    return true
  }
}
