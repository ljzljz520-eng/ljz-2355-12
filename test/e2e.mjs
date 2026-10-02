// 端到端 HTTP 回归：上传、发布、比较、缓存、旧规则、分享、撤回、导出、取消、编码
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import assert from 'assert'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE || 'http://localhost:5190'
const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8')

let n = 0
const ok = (m) => console.log('  ✓ ' + m)
async function j(method, p, body, user = 'public') {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-user': user },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

async function upload(doc, ver, file, acl) {
  await j('POST', `/api/versions/${doc}/${ver}`, { content: fx(file), status: 'draft' })
  await j('POST', `/api/versions/${doc}/${ver}/publish`, { acl: acl || ['*'] })
}

async function main() {
  // 健康检查
  const h = await j('GET', '/api/health')
  assert.equal(h.status, 200)
  ok('服务健康')

  // 上传 guide 两版（含中文/参数表/多语言代码）
  await upload('guide', 'g1', 'guide-v1.md')
  await upload('guide', 'g2', 'guide-v2.md')
  ok('两版上传并发布')

  // 比较
  const cmp = await j('POST', '/api/compare', { docId: 'guide', baselineId: 'g1', targetId: 'g2', useCache: false })
  assert.equal(cmp.status, 200)
  const rep = cmp.data.report
  assert.ok(rep.items.length > 0)
  assert.ok(rep.items.find((i) => i.type === 'param-default-changed' && i.param === 'type'))
  assert.ok(rep.items.find((i) => i.type === 'whitespace-only'))
  assert.ok(rep.items.find((i) => i.type === 'code-semantic-change' && i.language === 'python'))
  assert.ok(rep.items.find((i) => i.type === 'copied') || rep.items.find((i) => i.type === 'moved'))
  ok('比较产出默认值/空白/语义代码/复制或移动差异')

  // 每处差异可跳回两个原版位置
  for (const it of rep.items) {
    for (const side of ['from', 'to']) {
      const loc = it[side]
      if (!loc) continue
      assert.ok(loc.versionId && loc.blockId && typeof loc.startLine === 'number', side + ' 定位不完整')
    }
  }
  ok('每处差异均带双端原版定位（版本/块id/行号）')

  // 缓存命中
  const cached = await j('POST', '/api/compare', { docId: 'guide', baselineId: 'g1', targetId: 'g2' })
  assert.equal(cached.data.cached, true)
  assert.equal(cached.data.stale, false)
  ok('相同规则缓存命中')

  // 旧规则缓存
  await j('POST', '/api/admin/rules', {
    rulesVersion: '2023.06.01-semdiff-v0',
    rules: { ...(await import('../diff/engine/rules.mjs')).DEFAULT_RULES, rulesVersion: '2023.06.01-semdiff-v0' },
    activate: true,
  })
  await j('POST', '/api/compare', { docId: 'guide', baselineId: 'g1', targetId: 'g2', rulesVersion: '2023.06.01-semdiff-v0', useCache: false })
  const { DEFAULT_RULES } = await import('../diff/engine/rules.mjs')
  await j('POST', '/api/admin/rules', { rulesVersion: DEFAULT_RULES.rulesVersion, rules: DEFAULT_RULES, activate: true })
  const stale = await j('POST', '/api/compare', { docId: 'guide', baselineId: 'g1', targetId: 'g2' })
  assert.equal(stale.data.stale, true)
  assert.ok(stale.data.message.includes('旧版'))
  ok('命中旧规则缓存时标记 stale 且不静默复用')

  // 旧规则导出被拒
  const badExp = await j('POST', '/api/export', { docId: 'guide', baselineId: 'g1', targetId: 'g2', rulesVersion: '2023.06.01-semdiff-v0' })
  assert.equal(badExp.status, 409)
  ok('旧规则导出被拒绝（STALE_RULES_CANNOT_EXPORT）')

  // 当前规则导出冻结快照
  const exp = await j('POST', '/api/export', { docId: 'guide', baselineId: 'g1', targetId: 'g2' })
  assert.equal(exp.status, 200)
  const snap = exp.data
  assert.equal(snap.schema, 'semdiff-export/v1')
  assert.equal(snap.rulesVersion, DEFAULT_RULES.rulesVersion)
  assert.ok(snap.baseline.content.includes('Button'))
  assert.ok(snap.target.content.includes('Button'))
  ok('导出为自包含冻结快照（两版原文+规则+定位）')

  // 折叠导出
  const expColl = await j('POST', '/api/export', { docId: 'guide', baselineId: 'g1', targetId: 'g2', includeCosmetic: false })
  assert.ok(expColl.data.report.items.every((i) => i.severity !== 'cosmetic'))
  assert.ok(expColl.data.report.items.length < snap.report.items.length)
  ok('导出支持冻结“纯格式折叠”的所见视图')

  // 分享：仅发布版
  const sh = await j('POST', '/api/shares', { docId: 'guide', baselineId: 'g1', targetId: 'g2' })
  assert.equal(sh.status, 200)
  const token = sh.data.share.token
  const resolved = await j('GET', `/api/shares/${token}`)
  assert.equal(resolved.status, 200)
  ok('发布版可创建并解析分享链接')

  // ACL
  const denied = await j('POST', '/api/shares', { docId: 'guide', baselineId: 'g1', targetId: 'g2' }, 'bob')
  // g1/g2 acl=* ，bob 也能访问；改用受限版本验证
  await upload('priv', 'p1', 'dup-v1.md', ['alice'])
  await upload('priv', 'p2', 'dup-v2.md', ['alice'])
  const bobDeny = await j('POST', '/api/compare', { docId: 'priv', baselineId: 'p1', targetId: 'p2', useCache: false }, 'bob')
  assert.equal(bobDeny.status, 403)
  const aliceOk = await j('POST', '/api/compare', { docId: 'priv', baselineId: 'p1', targetId: 'p2', useCache: false }, 'alice')
  assert.equal(aliceOk.status, 200)
  ok('ACL：无访问权用户 403，授权用户可比较')

  // 撤回 => 分享失效 + 比较拒绝
  await j('POST', '/api/versions/guide/g2/withdraw', {})
  const revoked = await j('GET', `/api/shares/${token}`)
  assert.equal(revoked.status, 410)
  const cmpAfter = await j('POST', '/api/compare', { docId: 'guide', baselineId: 'g1', targetId: 'g2', useCache: false })
  assert.equal(cmpAfter.status, 403)
  ok('版本撤回：分享 410 失效、比较 403 拒绝')

  // 大文档：local + 退化提示
  await upload('big', 'b1', 'huge-v1.md')
  await upload('big', 'b2', 'huge-v2.md')
  const big = await j('POST', '/api/compare', { docId: 'big', baselineId: 'b1', targetId: 'b2', useCache: false })
  assert.equal(big.data.report.mode, 'local')
  assert.equal(big.data.report.degraded, true)
  assert.ok(big.data.report.warnings.some((w) => w.includes('退化')))
  // 编码正确性：中文大文档只有预期的一处改写
  const kinds = big.data.report.items.map((i) => i.type)
  assert.deepEqual(kinds, ['text-reword'])
  ok('大文档退化为局部匹配并提示；UTF-8 边界无伪差异')

  // 取消接口可用
  const cancel = await j('POST', '/api/cancel', { docId: 'big' })
  assert.equal(cancel.status, 200)
  ok('取消接口返回代数')

  // 静态页
  const index = await fetch(BASE + '/').then((r) => r.text())
  assert.ok(index.includes('语义差异'))
  ok('前端页面可访问')

  console.log('\n端到端全部通过 ✅')
}

main().catch((e) => {
  console.error('E2E 失败:', e)
  process.exit(1)
})
