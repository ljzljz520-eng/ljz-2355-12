// 比较服务 HTTP 封装（Node 内置 http，零额外依赖）。
// 路由：
//   POST /api/compare                 一次性比较
//   POST /api/compare/sessions        开启分块会话
//   POST /api/compare/:id/chunks      提交块 {epoch, chunkId, side, payload}
//   POST /api/compare/:id/cancel      取消
//   POST /api/compare/:id/restart     开始新比较（epoch+1）
//   POST /api/compare/:id/finalize    结束（跨块二次匹配）
//   POST /api/shares                  创建分享（仅可访问版本）
//   GET  /api/shares/:token?subject=  解析分享（重新校验访问权/撤回）
//   POST /api/exports                 导出冻结快照
//   GET  /api/snapshots/:id
//   POST /api/admin/rules             发布规则
//   POST /api/admin/rules/:version/withdraw
//   POST /api/admin/versions/:id/withdraw
// 访问主体通过 x-subject 头（演示用，生产应换鉴权）。

import http from 'node:http'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { JsonDB } from './db.js'
import { RuleRegistry } from './rules.js'
import { CompareService, AccessError, VersionWithdrawnError, StaleChunkError, CancelledError } from './compareService.js'
import { RuleNotFoundError, RuleWithdrawnError } from './rules.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export function createApp(dbFile = path.join(__dirname, '..', 'data', 'db.json')) {
  const db = new JsonDB(dbFile)
  const rules = new RuleRegistry(db)
  const service = new CompareService({ db, rules })

  const send = (res, status, body) => {
    const json = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(json) })
    res.end(json)
  }

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
        } catch (e) {
          reject(e)
        }
      })
      req.on('error', reject)
    })

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const p = url.pathname
    const subject = req.headers['x-subject']?.toString() || 'anonymous'
    try {
      if (req.method === 'GET' && p === '/health') return send(res, 200, { ok: true })

      if (req.method === 'POST' && p === '/api/compare') {
        const b = await readBody(req)
        const result = await service.compare({
          subject,
          oldVersionId: b.oldVersionId,
          newVersionId: b.newVersionId,
          rulePin: b.rulePin,
          preferRule: b.preferRule,
          forceRefresh: b.forceRefresh
        })
        return send(res, 200, result)
      }

      if (req.method === 'POST' && p === '/api/compare/sessions') {
        const b = await readBody(req)
        const s = service.startSession({
          subject,
          oldVersionId: b.oldVersionId,
          newVersionId: b.newVersionId,
          rulePin: b.rulePin,
          preferRule: b.preferRule,
          options: b.options
        })
        return send(res, 201, s)
      }

      let m = p.match(/^\/api\/compare\/([^/]+)\/(chunks|cancel|restart|finalize)$/)
      if (m && req.method === 'POST') {
        const [, id, action] = m
        const b = await readBody(req)
        if (action === 'chunks') {
          const r = await service.submitChunk(id, b.epoch, b.chunkId, b.side, b.payload)
          return send(res, 200, r)
        }
        if (action === 'cancel') {
          service.cancel(id)
          return send(res, 200, { cancelled: true, epoch: service.sessions.get(id)?.epoch })
        }
        if (action === 'restart') {
          return send(res, 200, service.restart(id))
        }
        const r = await service.finalize(id, b.epoch, { expectedChunkIds: b.expectedChunkIds })
        return send(res, 200, r)
      }

      if (req.method === 'POST' && p === '/api/shares') {
        const b = await readBody(req)
        const r = await service.createShare({
          subject,
          oldVersionId: b.oldVersionId,
          newVersionId: b.newVersionId,
          rulePin: b.rulePin,
          preferRule: b.preferRule,
          freeze: b.freeze !== false
        })
        return send(res, 201, { token: r.token, shareUrl: `/diff?share=${r.token}` })
      }

      m = p.match(/^\/api\/shares\/([^/]+)$/)
      if (m && req.method === 'GET') {
        const s = service.resolveShare(m[1], subject)
        return send(res, 200, s)
      }

      if (req.method === 'POST' && p === '/api/exports') {
        const b = await readBody(req)
        const snap = await service.exportFrozen({
          subject,
          oldVersionId: b.oldVersionId,
          newVersionId: b.newVersionId,
          rulePin: b.rulePin,
          preferRule: b.preferRule
        })
        return send(res, 201, { snapshotId: snap.id, frozenAt: snap.frozenAt, reportMarkdown: snap.reportMarkdown })
      }

      m = p.match(/^\/api\/snapshots\/([^/]+)$/)
      if (m && req.method === 'GET') {
        const snap = db.getSnapshot(m[1])
        if (!snap) return send(res, 404, { error: 'snapshot not found' })
        return send(res, 200, snap)
      }

      if (req.method === 'POST' && p === '/api/admin/rules') {
        const b = await readBody(req)
        await rules.publish(b.version, b.config)
        return send(res, 201, { ok: true })
      }
      m = p.match(/^\/api\/admin\/rules\/([^/]+)\/withdraw$/)
      if (m && req.method === 'POST') {
        await rules.withdraw(decodeURIComponent(m[1]))
        return send(res, 200, { ok: true })
      }
      m = p.match(/^\/api\/admin\/versions\/([^/]+)\/withdraw$/)
      if (m && req.method === 'POST') {
        await db.setVersionStatus(decodeURIComponent(m[1]), 'withdrawn')
        await db.invalidateCacheForVersion(decodeURIComponent(m[1]))
        return send(res, 200, { ok: true })
      }

      // 静态：导出快照的只读 HTML（演示分享落地）
      if (req.method === 'GET' && p === '/') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        return res.end('semantic-diff service: use HTTP API')
      }
      send(res, 404, { error: 'not found', path: p })
    } catch (err) {
      const code = err.code || ''
      if (code === 'ACCESS_DENIED') return send(res, 403, { error: err.message, code })
      if (code === 'VERSION_WITHDRAWN') return send(res, 410, { error: err.message, code, versionId: err.versionId })
      if (code === 'RULE_WITHDRAWN') return send(res, 410, { error: err.message, code, ruleVersion: err.ruleVersion })
      if (code === 'CHUNK_STALE') return send(res, 409, { error: err.message, code, sessionId: err.sessionId })
      if (code === 'CANCELLED') return send(res, 409, { error: err.message, code })
      send(res, 500, { error: String(err && err.message || err) })
    }
  })

  return { server, db, rules, service }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 5174)
  const { server } = createApp()
  server.listen(port, () => console.log(`semantic-diff service on http://localhost:${port}`))
}
