// 语义差异 HTTP 服务（Node 内置 http，无额外依赖）
//
// 路由：
//   POST /api/versions/:docId/:versionId   保存版本（body: {title,content,status}）
//   POST /api/versions/:docId/:versionId/publish
//   POST /api/versions/:docId/:versionId/withdraw
//   GET  /api/versions/:docId/:versionId
//   POST /api/compare                      比较（body 含 docId/baselineId/targetId/rulesVersion?/mode?）
//   POST /api/cancel                       取消当前比较代（body: {docId}）
//   GET  /api/report/:runId
//   POST /api/shares                       创建分享
//   GET  /api/shares/:token
//   POST /api/export                       导出冻结快照
//   GET  /api/rules                        规则版本信息
//   GET  /api/health

import http from 'http'
import { URL } from 'url'
import { Repository } from '../store/repository.mjs'
import { RULES_VERSION } from '../engine/rules.mjs'

export function createServer({ dbFile = './data/semdiff.json', publicDir } = {}) {
  const repo = new Repository(dbFile)
  const liveAborts = new Map() // docId -> AbortController for the latest compare

  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  const mapError = (res, e) => {
    const code = e.code || 'INTERNAL'
    const status = {
      VERSION_NOT_FOUND: 404,
      VERSION_NOT_ACCESSIBLE: 403,
      SHARE_NOT_FOUND: 404,
      SHARE_REVOKED: 410,
      SHARE_EXPIRED: 410,
      SHARE_ACCESS_DENIED: 403,
      ONLY_PUBLISHED_REVISIONS_SHAREABLE: 409,
      UNKNOWN_RULES_VERSION: 422,
      COMPLEXITY_BUDGET_EXCEEDED: 422,
      CANCELLED: 499,
      STALE_RUN_DISCARDED: 409,
      STALE_RULES_CANNOT_EXPORT: 409,
    }[code] || 500
    return json(res, status, { error: code, detail: e.detail || String(e.message || e) })
  }
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      // 必须按 Buffer 收集后再整体以 UTF-8 解码：
      // 若把每个 chunk 隐式转成字符串拼接，跨 chunk 边界的多字节字符会被切成 U+FFFD，
      // 这会让代码块/参数表中的中文内容产生随机“伪差异”。
      const chunks = []
      let size = 0
      req.on('data', (c) => {
        const buf = Buffer.isBuffer(c) ? c : Buffer.from(c)
        size += buf.length
        if (size > 20 * 1024 * 1024) {
          reject(new Error('BODY_TOO_LARGE'))
          req.destroy()
          return
        }
        chunks.push(buf)
      })
      req.on('end', () => {
        if (!size) return resolve({})
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (e) {
          reject(e)
        }
      })
      req.on('error', reject)
    })

  // 简化的用户识别：x-user 头（演示），默认 public
  const userOf = (req) => req.headers['x-user'] || 'public'

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const p = url.pathname
    const user = userOf(req)
    try {
      if (p === '/api/health') return json(res, 200, { ok: true, rulesVersion: RULES_VERSION })
      if (p === '/api/rules') return json(res, 200, { current: repo.currentRulesVersion(), all: repo.db.data.rules.map((r) => ({ version: r.rulesVersion, active: r.active })) })
      if (p === '/api/admin/rules' && req.method === 'POST') {
        const body = await readBody(req)
        if (!body.rulesVersion || !body.rules) return json(res, 400, { error: 'MISSING_FIELDS' })
        repo.registerRules(body.rulesVersion, body.rules, { activate: !!body.activate })
        return json(res, 200, { ok: true, current: repo.currentRulesVersion() })
      }

      // 版本内容
      let m = p.match(/^\/api\/versions\/([^/]+)\/([^/]+)$/)
      if (m && req.method === 'POST') {
        const [, docId, versionId] = m
        const body = await readBody(req)
        const rec = repo.saveVersion({
          docId, versionId,
          title: body.title || versionId,
          content: body.content || '',
          status: body.status || 'draft',
          author: user,
          publishedRevision: body.publishedRevision,
        })
        return json(res, 200, { ok: true, version: strip(rec) })
      }
      if (m && req.method === 'GET') {
        const [, docId, versionId] = m
        const v = repo.getVersion(docId, versionId)
        if (!v) return json(res, 404, { error: 'VERSION_NOT_FOUND' })
        return json(res, 200, { version: strip(v, !!repo.canAccess(v, user)) })
      }

      m = p.match(/^\/api\/versions\/([^/]+)\/([^/]+)\/(publish|withdraw)$/)
      if (m && req.method === 'POST') {
        const [, docId, versionId, action] = m
        const body = await readBody(req).catch(() => ({}))
        if (action === 'publish') {
          const rec = repo.publish(docId, versionId, { acl: body.acl })
          return json(res, 200, { ok: true, version: strip(rec) })
        }
        repo.withdraw(docId, versionId)
        return json(res, 200, { ok: true, withdrawn: versionId })
      }

      if (p === '/api/compare' && req.method === 'POST') {
        const body = await readBody(req)
        const { docId, baselineId, targetId, rulesVersion, mode, useCache = true } = body
        if (!docId || !baselineId || !targetId) return json(res, 400, { error: 'MISSING_FIELDS' })

        // 每篇文档同一时刻只有最新一代比较有效：新比较开始即令上一代的迟到结果失效
        const controller = new AbortController()
        liveAborts.set(docId, controller)

        try {
          const out = await repo.compare({
            docId, baselineId, targetId, rulesVersion,
            requester: user, useCache, preferredMode: mode, signal: controller.signal,
          })
          if (out.cached && out.stale) {
            return json(res, 200, {
              cached: true,
              stale: true,
              message: '缓存来自旧版差异规则，未静默复用；请用当前规则重新比较',
              cachedRulesVersion: out.entry.rulesVersion,
              currentRulesVersion: out.currentRulesVersion,
            })
          }
          return json(res, 200, { cached: out.cached, stale: false, report: out.report })
        } catch (e) {
          return mapError(res, e)
        }
      }

      if (p === '/api/cancel' && req.method === 'POST') {
        const body = await readBody(req)
        const docId = body.docId
        if (!docId) return json(res, 400, { error: 'MISSING_DOC_ID' })
        const gen = repo.cancel(docId)
        const ctl = liveAborts.get(docId)
        ctl && ctl.abort()
        return json(res, 200, { ok: true, cancelledGeneration: gen })
      }

      if ((m = p.match(/^\/api\/report\/([^/]+)$/)) && req.method === 'GET') {
        const run = repo.getRun(m[1])
        if (!run) return json(res, 404, { error: 'RUN_NOT_FOUND' })
        return json(res, 200, { run: { id: run._id, status: run.status, generation: run.generation, report: run.report || null, error: run.error } })
      }

      if (p === '/api/shares' && req.method === 'POST') {
        const body = await readBody(req)
        try {
          const s = repo.createShare({ docId: body.docId, baselineId: body.baselineId, targetId: body.targetId, user })
          return json(res, 200, {
            ok: true,
            share: {
              token: s.token,
              expiresAt: s.expiresAt,
              rulesVersion: s.rulesVersion,
              url: `/api/shares/${s.token}`,
              viewerUrl: `/semdiff/?share=${s.token}`,
            },
          })
        } catch (e) {
          return mapError(res, e)
        }
      }

      if ((m = p.match(/^\/api\/shares\/([^/]+)$/)) && req.method === 'GET') {
        try {
          const out = repo.resolveShare(m[1], user)
          return json(res, 200, {
            share: { token: out.share.token, docId: out.share.docId, baselineId: out.share.baselineId, targetId: out.share.targetId, rulesVersion: out.share.rulesVersion, status: out.share.status },
          })
        } catch (e) {
          return mapError(res, e)
        }
      }

      if (p === '/api/export' && req.method === 'POST') {
        const body = await readBody(req)
        try {
          const rec = await repo.exportDiff({
            docId: body.docId, baselineId: body.baselineId, targetId: body.targetId, user,
            rulesVersion: body.rulesVersion, includeCosmetic: body.includeCosmetic !== false,
          })
          // 导出物本身即冻结快照，可直接下载
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="semdiff-${body.baselineId}-${body.targetId}.json"` })
          return res.end(JSON.stringify(rec.snapshot, null, 2))
        } catch (e) {
          return mapError(res, e)
        }
      }

      if (publicDir && req.method === 'GET' && !p.startsWith('/api/')) {
        return serveStatic(publicDir, p, res)
      }

      json(res, 404, { error: 'NOT_FOUND', path: p })
    } catch (e) {
      mapError(res, e)
    }
  })

  server.locals = { repo }
  return server
}

function strip(v, includeContent = true) {
  const { content, ...rest } = v
  // 无访问权时绝不回传正文，只给元数据（前端跳回原文也需先有权限再取）
  return includeContent ? v : rest
}

import fs from 'fs'
import path from 'path'
function serveStatic(root, urlPath, res) {
  const safe = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '')
  let file = path.join(root, safe === '/' || safe === '' ? 'index.html' : safe)
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html')
  if (!fs.existsSync(file)) {
    res.writeHead(404)
    return res.end('not found')
  }
  const ext = path.extname(file)
  const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[ext] || 'application/octet-stream'
  res.writeHead(200, { 'content-type': type })
  fs.createReadStream(file).pipe(res)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 5174)
  const server = createServer({ dbFile: process.env.DB_FILE || './data/semdiff.json', publicDir: new URL('../public', import.meta.url).pathname })
  server.listen(port, () => console.log(`semdiff server on http://localhost:${port}`))
}
