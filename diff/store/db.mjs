// 轻量 JSON 文档数据库（演示用，接口语义与生产 DB 一致）。
// 集合：
//   versions  文档版本（含 draft / published / withdrawn 状态与内容快照）
//   runs      比较任务（基线、目标、所用规则版本、结果报告、状态与取消代数）
//   shares    分享链接（仅引用有访问权的发布版；版本撤回即失效）
//   exports   导出冻结快照
//   rules     已注册的规则版本
//   cache     比较缓存（key 含规则版本；旧规则命中标记 stale）

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

export class JsonDB {
  constructor(file) {
    this.file = file
    this.data = {
      versions: [],
      runs: [],
      shares: [],
      exports: [],
      rules: [],
      cache: [],
    }
    if (file) {
      try {
        if (fs.existsSync(file)) this.data = JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch (e) {
        // 损坏文件不吞掉，隔离为 .corrupt 后重建
        fs.renameSync(file, file + '.corrupt-' + Date.now())
      }
      this.dir = path.dirname(file)
      fs.mkdirSync(this.dir, { recursive: true })
    }
    this.timers = new Map()
  }

  id(prefix) {
    return `${prefix}_${crypto.randomBytes(6).toString('hex')}`
  }

  save() {
    if (!this.file) return
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    fs.renameSync(tmp, this.file)
  }

  insert(coll, doc) {
    const now = new Date().toISOString()
    const rec = { _id: this.id(coll.slice(0, 3)), createdAt: now, ...doc }
    this.data[coll].push(rec)
    this.save()
    return rec
  }

  find(coll, pred) {
    return this.data[coll].filter(pred)
  }

  findOne(coll, pred) {
    return this.data[coll].find(pred) || null
  }

  update(coll, id, patch) {
    const rec = this.findOne(coll, (r) => r._id === id || r.id === id)
    if (!rec) return null
    Object.assign(rec, patch, { updatedAt: new Date().toISOString() })
    this.save()
    return rec
  }

  remove(coll, pred) {
    const before = this.data[coll].length
    this.data[coll] = this.data[coll].filter((r) => !pred(r))
    this.save()
    return before - this.data[coll].length
  }
}
