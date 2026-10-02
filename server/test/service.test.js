import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { JsonDB } from '../src/db.js'
import { RuleRegistry, RuleWithdrawnError } from '../src/rules.js'
import {
  CompareService,
  AccessError,
  VersionWithdrawnError,
  StaleChunkError,
  CancelledError
} from '../src/compareService.js'
import { BUTTON_V1, BUTTON_V2 } from '../src/seed.js'

const DOC_A = [
  '# 组件文档',
  '',
  '开篇说明。',
  '',
  '## 章节一',
  '',
  '章节一的内容。',
  '',
  '待移动的公共段落。',
  '',
  '## 章节二',
  '',
  '章节二的内容。',
  ''
].join('\n')

const DOC_B = [
  '# 组件文档',
  '',
  '开篇说明。',
  '',
  '## 章节一',
  '',
  '章节一的内容。',
  '',
  '## 章节二',
  '',
  '章节二的内容。',
  '',
  '待移动的公共段落。',
  ''
].join('\n')

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semdiff-'))
  const db = new JsonDB(path.join(dir, 'db.json'))
  const rules = new RuleRegistry(db)
  const service = new CompareService({ db, rules, cache: true })
  return { dir, db, rules, service }
}

async function fixtureVersions(db) {
  await db.putVersion({ id: 'v1', docId: 'd', title: 'V1', source: DOC_A, status: 'published', createdAt: 1 })
  await db.putVersion({ id: 'v2', docId: 'd', title: 'V2', source: DOC_B, status: 'published', createdAt: 2 })
  await db.grant('alice', 'v1')
  await db.grant('alice', 'v2')
}

beforeEach(async () => {})

test('访问控制：未发布/无权限/不存在一律拒绝', async () => {
  const { db, rules, service } = setup()
  await rules.publish('rule-v1', {})
  await fixtureVersions(db)

  await db.putVersion({ id: 'draft', docId: 'd', title: '草稿', source: DOC_A, status: 'draft' })
  await db.grant('alice', 'draft')
  await assert.rejects(() => service.compare({ subject: 'alice', oldVersionId: 'draft', newVersionId: 'v2' }), AccessError)

  // bob 未授权
  await assert.rejects(() => service.compare({ subject: 'bob', oldVersionId: 'v1', newVersionId: 'v2' }), AccessError)

  await assert.rejects(() => service.compare({ subject: 'alice', oldVersionId: 'nope', newVersionId: 'v2' }), AccessError)
})

test('一个版本撤回：比较立即 410，缓存也被作废', async () => {
  const { db, rules, service } = setup()
  await rules.publish('rule-v1', {})
  await fixtureVersions(db)

  const first = await service.compare({ subject: 'alice', oldVersionId: 'v1', newVersionId: 'v2' })
  assert.equal(first.cacheHit, false)
  const second = await service.compare({ subject: 'alice', oldVersionId: 'v1', newVersionId: 'v2' })
  assert.equal(second.cacheHit, true)

  await db.setVersionStatus('v2', 'withdrawn')
  await db.invalidateCacheForVersion('v2')
  await assert.rejects(
    () => service.compare({ subject: 'alice', oldVersionId: 'v1', newVersionId: 'v2' }),
    (e) => e instanceof VersionWithdrawnError && e.code === 'VERSION_WITHDRAWN'
  )
})

test('缓存命中旧规则：规则升级后旧缓存被丢弃并按新版本重算', async () => {
  const { db, rules, service } = setup()
  await rules.publish('rule-v1', { polishThreshold: 0.72 })
  await rules.publish('rule-v2', { polishThreshold: 0.5 })
  await fixtureVersions(db)

  const r1 = await service.compare({ subject: 'alice', oldVersionId: 'v1', newVersionId: 'v2' })
  assert.equal(r1.ruleVersion, 'rule-v2') // 默认最新激活版
  // 让 rule-v2 撤回到只剩 v1（模拟“规则回滚”）
  await rules.withdraw('rule-v2')
  const r2 = await service.compare({ subject: 'alice', oldVersionId: 'v1', newVersionId: 'v2' })
  assert.equal(r2.ruleVersion, 'rule-v1')
  assert.equal(r2.cacheHit, false) // 旧缓存记录的是 rule-v2，必须失效

  // 显式 pin 已撤回规则 => 直接报错，不得静默使用
  await assert.rejects(
    () => service.compare({ subject: 'alice', oldVersionId: 'v1', newVersionId: 'v2', rulePin: 'rule-v2' }),
    RuleWithdrawnError
  )
})

test('跨块移动：分块 finalize 得到 moved 条目', async () => {
  const { db, rules, service } = setup()
  await rules.publish('rule-v1', {})
  await fixtureVersions(db)

  const { sessionId, epoch } = service.startSession({ subject: 'alice', oldVersionId: 'v1', newVersionId: 'v2' })
  // 模拟章节块分两次到达
  await service.submitChunk(sessionId, epoch, 'chunk@组件文档/章节一', 'old', {})
  await service.submitChunk(sessionId, epoch, 'chunk@组件文档/章节二', 'old', {})
  await service.submitChunk(sessionId, epoch, 'chunk@组件文档/章节一', 'new', {})
  await service.submitChunk(sessionId, epoch, 'chunk@组件文档/章节二', 'new', {})
  const result = await service.finalize(sessionId, epoch)
  const moved = result.entries.filter((e) => e.structural === 'moved')
  assert.equal(moved.length, 1)
  assert.equal(moved[0].anchors.old.startLine, 9)
  assert.equal(moved[0].anchors.new.startLine, 13)
})

test('取消后迟到块不得混进新比较：旧 epoch 块被 409 拒绝，restart 后隔离干净', async () => {
  const { db, rules, service } = setup()
  await rules.publish('rule-v1', {})
  await fixtureVersions(db)

  const { sessionId, epoch: e1 } = service.startSession({ subject: 'alice', oldVersionId: 'v1', newVersionId: 'v2' })
  await service.submitChunk(sessionId, e1, 'chunk@组件文档/章节一', 'old', {})
  // 用户取消
  service.cancel(sessionId)
  // 迟到块仍带旧 epoch => 拒绝，绝不写入
  await assert.rejects(
    () => service.submitChunk(sessionId, e1, 'chunk@组件文档/章节二', 'old', {}),
    StaleChunkError
  )
  // 取消状态下提交当前 epoch 也应被拒绝
  await assert.rejects(
    () => service.submitChunk(sessionId, e1 + 1, 'x', 'old', {}),
    CancelledError
  )

  // 开始新比较（epoch 递增）
  const { epoch: e2 } = service.restart(sessionId)
  assert.notEqual(e2, e1)
  // 只提交一个新块，旧比较的块不得残留：finalize 时章节二缺失 => 不应出现“移动”结果
  await service.submitChunk(sessionId, e2, 'chunk@组件文档/章节一', 'old', {})
  await service.submitChunk(sessionId, e2, 'chunk@组件文档/章节一', 'new', {})
  const result = await service.finalize(sessionId, e2, {
    expectedChunkIds: { old: ['chunk@组件文档/章节一'], new: ['chunk@组件文档/章节一'] }
  })
  assert.equal(result.entries.some((x) => x.structural === 'moved'), false)
  assert.deepEqual(result.acceptedChunks.old, ['chunk@组件文档/章节一'])
})

test('分享 URL 只引用有访问权的发布版；版本撤回后链接失效；冻结导出仍可读', async () => {
  const { db, rules, service } = setup()
  await rules.publish('rule-v1', {})
  await fixtureVersions(db)

  const { token } = await service.createShare({ subject: 'alice', oldVersionId: 'v1', newVersionId: 'v2' })
  const resolved = service.resolveShare(token, 'alice')
  assert.equal(resolved.oldVersionId, 'v1')

  // bob 无 v2 权限：不得解析
  assert.throws(() => service.resolveShare(token, 'bob'), AccessError)

  // 导出冻结快照
  const snap = await service.exportFrozen({ subject: 'alice', oldVersionId: 'v1', newVersionId: 'v2' })
  assert.ok(snap.reportMarkdown.includes('语义差异报告'))
  assert.equal(snap.ruleVersion, 'rule-v1')

  // 撤回 v2：实时比较/分享解析失败，但冻结快照保持不变
  await db.setVersionStatus('v2', 'withdrawn')
  assert.throws(() => service.resolveShare(token, 'alice'), VersionWithdrawnError)
  const snapAgain = db.getSnapshot(snap.id)
  assert.equal(snapAgain.newVersion.source, DOC_B)
  assert.ok(snapAgain.reportMarkdown.includes('/p/v2/doc'))
})

test('种子文档（Button）比较：默认值 major + 描述润色 minor + JSON 纯格式折叠', async () => {
  const { rules, service } = setup()
  await rules.publish('rule-v1', {})
  const db2 = service.db
  await db2.putVersion({ id: 'b1', docId: 'b', title: 'B1', source: BUTTON_V1, status: 'published' })
  await db2.putVersion({ id: 'b2', docId: 'b', title: 'B2', source: BUTTON_V2, status: 'published' })
  await db2.grant('alice', 'b1')
  await db2.grant('alice', 'b2')
  const r = await service.compare({ subject: 'alice', oldVersionId: 'b1', newVersionId: 'b2' })
  const table = r.entries.find((e) => e.type === 'table')
  const typeRow = table.detail.rowChanges.find((rc) => rc.key === 'type')
  assert.equal(typeRow.cells.find((c) => c.kind === 'default-change').severity, 'major')
  const sizeRow = table.detail.rowChanges.find((rc) => rc.key === 'size')
  assert.equal(sizeRow.cells.find((c) => c.kind === 'description-polish').severity, 'minor')
  const code = r.entries.find((e) => e.type === 'code')
  assert.equal(code.formatOnly, true)
})
