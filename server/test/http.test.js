import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { createApp } from '../src/httpServer.js'
import { BUTTON_V1, BUTTON_V2 } from '../src/seed.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semhttp-'))
const dbFile = path.join(dir, 'db.json')
const { server, db, rules } = createApp(dbFile)

await new Promise((resolve) => server.listen(0, resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}`
after(() => server.close())

await rules.publish('rule-v1', {})
await rules.publish('rule-v2', {})
await db.putVersion({ id: 'b1', docId: 'b', title: 'B1', source: BUTTON_V1, status: 'published' })
await db.putVersion({ id: 'b2', docId: 'b', title: 'B2', source: BUTTON_V2, status: 'published' })
await db.grant('alice', 'b1')
await db.grant('alice', 'b2')

async function call(method, p, body, subject = 'alice') {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', 'x-subject': subject },
    body: body ? JSON.stringify(body) : undefined
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json }
}

test('HTTP: 比较 + 403 无权 + 410 撤回 + 旧规则缓存', async () => {
  const ok = await call('POST', '/api/compare', { oldVersionId: 'b1', newVersionId: 'b2' })
  assert.equal(ok.status, 200)
  assert.equal(ok.json.ruleVersion, 'rule-v2')
  assert.equal(ok.json.cacheHit, false)

  const cached = await call('POST', '/api/compare', { oldVersionId: 'b1', newVersionId: 'b2' })
  assert.equal(cached.json.cacheHit, true)

  const forbidden = await call('POST', '/api/compare', { oldVersionId: 'b1', newVersionId: 'b2' }, 'bob')
  assert.equal(forbidden.status, 403)

  // 规则撤回后 pin 旧规则 => 410
  const withdrawnRule = await call('POST', '/api/compare', { oldVersionId: 'b1', newVersionId: 'b2', rulePin: 'rule-v2' })
  // rule-v2 仍 active，先撤回
  await call('POST', '/api/admin/rules/rule-v2/withdraw', {})
  const afterWithdraw = await call('POST', '/api/compare', { oldVersionId: 'b1', newVersionId: 'b2', rulePin: 'rule-v2' })
  assert.equal(afterWithdraw.status, 410)
  assert.equal(afterWithdraw.json.code, 'RULE_WITHDRAWN')
  // 缓存里是 rule-v2，默认解析现在是 rule-v1，必须重算
  const recalced = await call('POST', '/api/compare', { oldVersionId: 'b1', newVersionId: 'b2' })
  assert.equal(recalced.json.ruleVersion, 'rule-v1')
  assert.equal(recalced.json.cacheHit, false)

  // 版本撤回 => 410
  await call('POST', '/api/admin/versions/b2/withdraw', {})
  const vw = await call('POST', '/api/compare', { oldVersionId: 'b1', newVersionId: 'b2' })
  assert.equal(vw.status, 410)
  assert.equal(vw.json.code, 'VERSION_WITHDRAWN')
})

test('HTTP: 分块会话取消后迟到块 409；restart 后干净', async () => {
  // 恢复 b2
  await db.setVersionStatus('b2', 'published')
  await db.grant('alice', 'b2')

  const s = await call('POST', '/api/compare/sessions', { oldVersionId: 'b1', newVersionId: 'b2' })
  assert.equal(s.status, 201)
  const { sessionId, epoch } = s.json

  const stale = await call('POST', `/api/compare/${sessionId}/cancel`, {})
  assert.equal(stale.status, 200)
  const newEpoch = stale.json.epoch

  const late = await call('POST', `/api/compare/${sessionId}/chunks`, { epoch, chunkId: 'c1', side: 'old', payload: {} })
  assert.equal(late.status, 409)
  assert.equal(late.json.code, 'CHUNK_STALE')

  const restarted = await call('POST', `/api/compare/${sessionId}/restart`, {})
  assert.ok(restarted.json.epoch > newEpoch)
})

test('HTTP: 分享仅授权版本；导出冻结快照含双位置链接', async () => {
  const created = await call('POST', '/api/shares', { oldVersionId: 'b1', newVersionId: 'b2' })
  assert.equal(created.status, 201)
  const token = created.json.token
  assert.match(created.json.shareUrl, /\/diff\?share=/)

  const bob = await fetch(`${base}/api/shares/${token}`, { headers: { 'x-subject': 'bob' } })
  assert.equal(bob.status, 403)

  const exp = await call('POST', '/api/exports', { oldVersionId: 'b1', newVersionId: 'b2' })
  assert.equal(exp.status, 201)
  assert.ok(exp.json.reportMarkdown.includes('/p/b1/doc'))
  assert.ok(exp.json.reportMarkdown.includes('/p/b2/doc'))

  const snap = await call('GET', `/api/snapshots/${exp.json.snapshotId}`, null)
  assert.equal(snap.status, 200)
  assert.equal(snap.json.oldVersion.source, BUTTON_V1)
})
