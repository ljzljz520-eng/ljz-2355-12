// 语义差异测试套件
// 运行：node test/run.mjs
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import assert from 'assert'
import { parseDocument } from '../diff/engine/parser.mjs'
import { normalizeCode, isWhitespaceOnly, resolvePolicy } from '../diff/engine/whitespace.mjs'
import { compareDocuments, freezeSnapshot } from '../diff/engine/matcher.mjs'
import { DEFAULT_RULES } from '../diff/engine/rules.mjs'
import { Repository } from '../diff/store/repository.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8')

let passed = 0
let failed = 0
const cases = []
function test(name, fn) {
  cases.push([name, fn])
}
async function run() {
  for (const [name, fn] of cases) {
    try {
      await fn()
      passed++
      console.log('  ✓ ' + name)
    } catch (e) {
      failed++
      console.error('  ✗ ' + name)
      console.error('    ' + (e.stack || e).split('\n').slice(0, 4).join('\n    '))
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed) process.exit(1)
}

const findItems = (rep, type) => rep.items.filter((i) => i.type === type)
const one = (rep, type) => {
  const r = findItems(rep, type)
  assert.ok(r.length, `期望存在 ${type}，实际类型：${[...new Set(rep.items.map((i) => i.type))].join(',')}`)
  return r[0]
}

/* ---------------- 1. 语言敏感空白 ---------------- */

test('空白策略：JS 缩进变化属于可忽略空白（free），Python 缩进变化具有语义（strict）', async () => {
  const jsA = 'function f(){\n  return 1\n}\n'
  const jsB = 'function f(){\n    return 1\n}\n'
  assert.equal(resolvePolicy('js').resolved, 'javascript')
  assert.equal(isWhitespaceOnly(jsA, jsB, 'js'), true, 'JS 缩进差异应为纯空白')

  const pyA = 'def f():\n  return 1\n'
  const pyB = 'def f():\n    return 1\n'
  assert.equal(isWhitespaceOnly(pyA, pyB, 'python'), false, 'Python 缩进差异不应被忽略')

  const makeA = 'a:\n\t echo 1\n'
  const makeB = 'a:\n\t\techo 1\n'
  assert.equal(isWhitespaceOnly(makeA, makeB, 'make'), false, 'Makefile 空白敏感')

  // 未知语言：保守策略
  assert.equal(resolvePolicy('xyz-lang').known, false)
  assert.equal(isWhitespaceOnly('a\n  b', 'a\n\tb', 'xyz-lang'), false)
})

test('空白规范化保留原始行号映射，供行级跳回', async () => {
  const code = '\n\n  x\n y\n'
  const n = normalizeCode(code, 'js')
  assert.ok(n.entries.length >= 2)
  assert.equal(n.entries[0].idx, 2, '前导空行被跳过后原始行号正确')
})

/* ---------------- 2. 分级：默认值 major / 描述润色 minor / 纯格式 cosmetic ---------------- */

test('分级：参数默认值变更为 major，描述润色为 minor，粗体格式为 cosmetic', async () => {
  const docA = parseDocument(fx('guide-v1.md'), { docId: 'guide' })
  const docB = parseDocument(fx('guide-v2.md'), { docId: 'guide' })
  const rep = await compareDocuments(docA, docB, DEFAULT_RULES, { baselineId: 'v1.0', targetId: 'v1.1' })

  const def = one(rep, 'param-default-changed')
  assert.equal(def.severity, 'major')
  assert.equal(def.param, 'type')
  assert.equal(def.before, 'default')
  assert.equal(def.after, 'primary')

  const desc = findItems(rep, 'param-description-changed')
  assert.ok(desc.length >= 2, 'type 与 disabled 的描述均变化')
  assert.ok(desc.every((d) => d.severity === 'minor'))

  const fmt = one(rep, 'format-only')
  assert.equal(fmt.severity, 'cosmetic')
})

test('表格重排：行序变化识别为 cosmetic，不误报默认值变更', async () => {
  const docA = parseDocument(fx('guide-v1.md'), { docId: 'guide' })
  const docB = parseDocument(fx('guide-v2.md'), { docId: 'guide' })
  const rep = await compareDocuments(docA, docB, DEFAULT_RULES, { baselineId: 'v1.0', targetId: 'v1.1' })

  const reo = one(rep, 'param-row-reordered')
  assert.equal(reo.severity, 'cosmetic')
  // 被重排但内容未变的 size 不应产生默认值/描述差异
  const sizeItems = rep.items.filter((i) => i.param === 'size')
  assert.equal(sizeItems.length, 0, 'size 行仅位置变化：' + JSON.stringify(sizeItems.map((i) => i.type)))
  // 新增参数 icon，删除/新增不应因重排而误报
  assert.ok(findItems(rep, 'param-row-added').some((i) => i.param === 'icon'))
})

test('代码块：vue 缩进差异为纯空白；python 缩进差异升级为语义变化', async () => {
  const docA = parseDocument(fx('guide-v1.md'), { docId: 'guide' })
  const docB = parseDocument(fx('guide-v2.md'), { docId: 'guide' })
  const rep = await compareDocuments(docA, docB, DEFAULT_RULES, { baselineId: 'v1.0', targetId: 'v1.1' })

  const ws = one(rep, 'whitespace-only')
  assert.equal(ws.severity, 'cosmetic')
  assert.equal(ws.language, 'vue')

  const codeSem = findItems(rep, 'code-semantic-change')
  const py = codeSem.find((i) => i.language === 'python')
  assert.ok(py, 'Python 缩进改动必须报告为语义变化')
  assert.equal(py.severity, 'major')
  assert.equal(py.strictWhitespace, true)
  assert.ok(py.hunks.length, '应有行级变更块')
})

/* ---------------- 3. 移动、复制与重复片段 ---------------- */

test('重复片段：同内容多实例不乱配；目标多出的副本认定为 copied', async () => {
  const docA = parseDocument(fx('dup-v1.md'), { docId: 'dup' })
  const docB = parseDocument(fx('dup-v2.md'), { docId: 'dup' })
  // 小文档走 global
  const rep = await compareDocuments(docA, docB, DEFAULT_RULES, { baselineId: 'v1', targetId: 'v2' })
  const copies = findItems(rep, 'copied')
  assert.ok(copies.length >= 1, '目标版本有 3 份免责声明 vs 基线 2 份，应认定复制')
  assert.ok(copies.every((c) => c.from && c.to), '复制项需可跳回来源与副本两处')
})

test('移动段落：跨大章节移动沿稳定身份/内容匹配，标注 moved 且级别 cosmetic', async () => {
  const docA = parseDocument(fx('guide-v1.md'), { docId: 'guide' })
  const docB = parseDocument(fx('guide-v2.md'), { docId: 'guide' })
  const rep = await compareDocuments(docA, docB, DEFAULT_RULES, { baselineId: 'v1.0', targetId: 'v1.1' })
  // "操作完成后请及时关闭弹窗" 从注意事项移到… 两版中它在注意事项；免责声明从注意事项移到最佳实践
  const moved = rep.items.filter((i) => i.moved || i.type === 'moved')
  assert.ok(moved.length >= 1, '应识别至少一处跨章节移动')
  const m = moved[0]
  const loc = m.to || m
  assert.ok((m.fromSection || m.from?.section?.join()), '移动项需记录来源章节')
  assert.ok((m.toSection || m.to?.section?.join()), '移动项需记录目标章节')
})

test('受限局部模式 + 跨块二次匹配同样能发现跨章节移动', async () => {
  const docA = parseDocument(fx('guide-v1.md'), { docId: 'guide' })
  const docB = parseDocument(fx('guide-v2.md'), { docId: 'guide' })
  const rep = await compareDocuments(docA, docB, DEFAULT_RULES, { baselineId: 'v1.0', targetId: 'v1.1', preferredMode: 'local' })
  assert.equal(rep.mode, 'local')
  const moved = rep.items.filter((i) => i.moved || i.type === 'moved')
  assert.ok(moved.length >= 1, '局部模式经跨块二次匹配应发现跨章节移动')
})

/* ---------------- 4. 每处差异可跳回两个原版位置 ---------------- */

test('所有 item 携带 from/to 定位（版本、块 id、行号），行号落在原文范围内', async () => {
  const rawA = fx('guide-v1.md')
  const rawB = fx('guide-v2.md')
  const la = rawA.split('\n').length
  const lb = rawB.split('\n').length
  const docA = parseDocument(rawA, { docId: 'guide' })
  const docB = parseDocument(rawB, { docId: 'guide' })
  const rep = await compareDocuments(docA, docB, DEFAULT_RULES, { baselineId: 'v1.0', targetId: 'v1.1' })
  assert.ok(rep.items.length > 0)
  for (const it of rep.items) {
    assert.ok(it.from || it.to, '至少一侧定位')
    for (const side of ['from', 'to']) {
      const loc = it[side]
      if (!loc) continue
      assert.ok(loc.blockId, side + ' blockId')
      assert.equal(loc.versionId, side === 'from' ? 'v1.0' : 'v1.1')
      const limit = side === 'from' ? la : lb
      assert.ok(loc.startLine >= 0 && loc.startLine < limit, `${it.type} ${side} 行号越界: ${loc.startLine}/${limit}`)
    }
  }
  // 冻结快照自包含
  const snap = freezeSnapshot(rawA, rawB, docA, docB, rep, { rules: DEFAULT_RULES })
  assert.equal(snap.baseline.content, rawA)
  assert.equal(snap.target.content, rawB)
  assert.equal(snap.report.items.length, rep.items.length)
})

/* ---------------- 5. 复杂度预算与退化提示 ---------------- */

test('复杂度预算：超预算自动退化为 local 并给出 degraded 提示', async () => {
  const docA = parseDocument(fx('huge-v1.md'), { docId: 'huge' })
  const docB = parseDocument(fx('huge-v2.md'), { docId: 'huge' })
  const cells = docA.blocks.length * docB.blocks.length
  assert.ok(cells > DEFAULT_RULES.budget.maxGlobalCells, `测试夹具确实超预算: ${cells}`)
  const rep = await compareDocuments(docA, docB, DEFAULT_RULES, { baselineId: 'h1', targetId: 'h2' })
  assert.equal(rep.mode, 'local')
  assert.equal(rep.degraded, true)
  assert.ok(rep.warnings.some((w) => w.includes('退化')), '需解释退化原因')
})

test('请求全文最优且关闭回退时，超预算抛出预算异常', async () => {
  const rules = { ...DEFAULT_RULES, budget: { ...DEFAULT_RULES.budget, fallbackToLocal: false } }
  const docA = parseDocument(fx('huge-v1.md'), { docId: 'huge' })
  const docB = parseDocument(fx('huge-v2.md'), { docId: 'huge' })
  await assert.rejects(compareDocuments(docA, docB, rules, { baselineId: 'h1', targetId: 'h2', preferredMode: 'global' }),
    /COMPLEXITY_BUDGET/
  )
})

/* ---------------- 6. 仓储层：发布/撤回/分享/导出/缓存/取消 ---------------- */

const tmpDB = () => path.join(__dirname, 'tmp-' + Math.random().toString(36).slice(2) + '.json')

test('分享 URL 只引用有访问权的发布版；草稿不可分享', async () => {
  const repo = new Repository(tmpDB())
  repo.saveVersion({ docId: 'd', versionId: 'a', content: fx('guide-v1.md'), status: 'draft' })
  repo.saveVersion({ docId: 'd', versionId: 'b', content: fx('guide-v2.md'), status: 'draft' })
  assert.throws(() => repo.createShare({ docId: 'd', baselineId: 'a', targetId: 'b', user: 'public' }), /ONLY_PUBLISHED/)
  repo.publish('d', 'a', { acl: ['*'] })
  repo.publish('d', 'b', { acl: ['*'] })
  const s = repo.createShare({ docId: 'd', baselineId: 'a', targetId: 'b', user: 'public' })
  const resolved = repo.resolveShare(s.token, 'public')
  assert.equal(resolved.baseline.publishedRevision, 1)
  // ACL：受限发布版其他人无权
})

test('一个版本撤回后：分享链接立即失效，版本不可再用于比较', async () => {
  const repo = new Repository(tmpDB())
  repo.saveVersion({ docId: 'd', versionId: 'a', content: fx('guide-v1.md'), status: 'draft' })
  repo.saveVersion({ docId: 'd', versionId: 'b', content: fx('guide-v2.md'), status: 'draft' })
  repo.publish('d', 'a')
  repo.publish('d', 'b')
  const s = repo.createShare({ docId: 'd', baselineId: 'a', targetId: 'b', user: 'public' })
  repo.withdraw('d', 'b')
  assert.throws(() => repo.resolveShare(s.token, 'public'), /SHARE_REVOKED/)
  await assert.rejects(repo.compare({ docId: 'd', baselineId: 'a', targetId: 'b', requester: 'public', useCache: false }), /VERSION_NOT_ACCESSIBLE/)
})

test('缓存命中旧规则：标记 stale，不静默复用，且禁止导出', async () => {
  const repo = new Repository(tmpDB())
  repo.saveVersion({ docId: 'd', versionId: 'a', content: fx('guide-v1.md'), status: 'draft' })
  repo.saveVersion({ docId: 'd', versionId: 'b', content: fx('guide-v2.md'), status: 'draft' })
  repo.publish('d', 'a')
  repo.publish('d', 'b')
  // 用旧规则计算并缓存
  const oldRules = { ...DEFAULT_RULES, rulesVersion: '2023.06.01-semdiff-v0' }
  repo.registerRules('2023.06.01-semdiff-v0', oldRules, { activate: true })
  const first = await repo.compare({ docId: 'd', baselineId: 'a', targetId: 'b', requester: 'public', rulesVersion: '2023.06.01-semdiff-v0', useCache: false })
  assert.equal(first.report.rulesVersion, '2023.06.01-semdiff-v0')
  // 新规则成为当前版本
  repo.registerRules(DEFAULT_RULES.rulesVersion, DEFAULT_RULES, { activate: true })
  const hit = repo.lookupCache({ docId: 'd', baselineId: 'a', targetId: 'b' })
  assert.equal(hit.hit, true)
  assert.equal(hit.stale, true, '旧规则缓存必须被识别为 stale')
  // compare 在 stale 时显式返回 stale
  const out = await repo.compare({ docId: 'd', baselineId: 'a', targetId: 'b', requester: 'public' })
  assert.equal(out.stale, true)
  // 显式以旧规则导出同样被禁止（只能导出当前规则下的所见差异）
  await assert.rejects(repo.exportDiff({ docId: 'd', baselineId: 'a', targetId: 'b', user: 'public', rulesVersion: '2023.06.01-semdiff-v0' }), /STALE_RULES/)
})

test('取消代数：取消后迟到完成的运行被标记丢弃，不污染新比较', async () => {
  const repo = new Repository(tmpDB())
  repo.saveVersion({ docId: 'd', versionId: 'a', content: fx('guide-v1.md'), status: 'draft' })
  repo.saveVersion({ docId: 'd', versionId: 'b', content: fx('guide-v2.md'), status: 'draft' })
  repo.publish('d', 'a')
  repo.publish('d', 'b')
  const r1 = repo.startRun({ docId: 'd', baselineId: 'a', targetId: 'b' })
  const r2 = repo.startRun({ docId: 'd', baselineId: 'a', targetId: 'b' }) // 新一代
  assert.ok(r2.generation > r1.generation)
  // 第一代迟到完成
  const out1 = repo.finishRun(r1.run._id, r1.generation, 'd', { reportId: 'late', baselineId: 'a', targetId: 'b', rulesVersion: DEFAULT_RULES.rulesVersion })
  assert.equal(out1.discarded, true)
  const staleRun = repo.getRun(r1.run._id)
  assert.equal(staleRun.status, 'stale-discarded')
  // 第二代正常完成
  const out2 = repo.finishRun(r2.run._id, r2.generation, 'd', { reportId: 'fresh', baselineId: 'a', targetId: 'b', rulesVersion: DEFAULT_RULES.rulesVersion })
  assert.equal(out2.discarded, false)
})

test('异步分块比较：AbortSignal 在块边界中断比较', async () => {
  const docA = parseDocument(fx('huge-v1.md'), { docId: 'huge' })
  const docB = parseDocument(fx('huge-v2.md'), { docId: 'huge' })
  const controller = new AbortController()
  // 立即在下一个事件循环 tick 取消；分块循环在边界应观察到并抛出
  setImmediate(() => controller.abort())
  await assert.rejects(
    compareDocuments(docA, docB, DEFAULT_RULES, { baselineId: 'h1', targetId: 'h2', preferredMode: 'local', signal: controller.signal }),
    /ABORTED/
  )
})

test('迟到结果防护：被取消/取代的比较即使回写也不污染新运行（代数守卫）', async () => {
  const repo = new Repository(tmpDB())
  const { run, generation } = repo.startRun({ docId: 'g', baselineId: 'a', targetId: 'b' })
  repo.cancel('g') // 代数 +1
  const out = repo.finishRun(run._id, generation, 'g', { reportId: 'x', baselineId: 'a', targetId: 'b', rulesVersion: DEFAULT_RULES.rulesVersion })
  assert.equal(out.discarded, true)
  assert.equal(repo.getRun(run._id).status, 'stale-discarded')
})

test('导出冻结快照：含两版原文、规则版本与全部定位', async () => {
  const repo = new Repository(tmpDB())
  repo.saveVersion({ docId: 'd', versionId: 'a', content: fx('guide-v1.md'), status: 'draft' })
  repo.saveVersion({ docId: 'd', versionId: 'b', content: fx('guide-v2.md'), status: 'draft' })
  repo.publish('d', 'a')
  repo.publish('d', 'b')
  const rec = await repo.exportDiff({ docId: 'd', baselineId: 'a', targetId: 'b', user: 'public' })
  const snap = rec.snapshot
  assert.equal(snap.schema, 'semdiff-export/v1')
  assert.equal(snap.baseline.id, 'a')
  assert.equal(snap.target.id, 'b')
  assert.equal(snap.rulesVersion, DEFAULT_RULES.rulesVersion)
  assert.ok(snap.baseline.content.includes('Button'))
  assert.ok(snap.report.items.every((i) => (i.from || i.to)))
})

test('ACL：不在发布版访问名单内的用户不能查看/比较/分享', async () => {
  const repo = new Repository(tmpDB())
  repo.saveVersion({ docId: 'd', versionId: 'a', content: fx('guide-v1.md'), status: 'draft' })
  repo.saveVersion({ docId: 'd', versionId: 'b', content: fx('guide-v2.md'), status: 'draft' })
  repo.publish('d', 'a', { acl: ['alice'] })
  repo.publish('d', 'b', { acl: ['alice'] })
  await assert.rejects(repo.compare({ docId: 'd', baselineId: 'a', targetId: 'b', requester: 'bob', useCache: false }), /VERSION_NOT_ACCESSIBLE/)
  assert.throws(() => repo.createShare({ docId: 'd', baselineId: 'a', targetId: 'b', user: 'bob' }), /VERSION_NOT_ACCESSIBLE/)
  // alice 可以
  const ok = await repo.compare({ docId: 'd', baselineId: 'a', targetId: 'b', requester: 'alice', useCache: false })
  assert.ok(ok.report)
})

run()
