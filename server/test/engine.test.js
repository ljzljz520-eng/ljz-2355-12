import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareDocuments } from '../../shared/semantic/diff.js'
import { policyOf, classifyCode } from '../../shared/semantic/whitespace.js'
import { diffTable, columnRoles } from '../../shared/semantic/tableDiff.js'
import { parseMarkdown } from '../../shared/markdown/parser.js'
import { anchorURL, renderMarkdownReport } from '../../shared/report/report.js'

const byStruct = (result, s) => result.entries.filter((e) => e.structural === s)

test('空白策略：不能对所有语言统一忽略空白', () => {
  assert.equal(policyOf('python'), 'exact')
  assert.equal(policyOf('yaml'), 'exact')
  assert.equal(policyOf('json'), 'insensitive')
  assert.equal(policyOf(''), 'exact') // 未知/缺失保守精确
  // JSON 美化是纯格式
  assert.ok(classifyCode('{"a": 1, "b": 2}', '{\n  "a": 1,\n  "b": 2\n}', 'json').formatOnly)
  // Python 缩进改变是语义变化
  assert.ok(classifyCode('def f():\n  x=1', 'def f():\n    x=1', 'python').semantic)
  // 字符串内部空白即便在 insensitive 语言中也保留语义
  assert.ok(classifyCode("f('a b')", "f('a  b')", 'javascript').semantic)
})

test('重复片段：移动段落沿稳定身份匹配，复制段落另行认定', () => {
  const oldDoc = ['# A', '', '通用提示文本。', '', '# B', '', '章节 B 内容。', ''].join('\n')
  const newDoc = ['# A', '', '通用提示文本。', '', '# B', '', '章节 B 内容。', '', '通用提示文本。', ''].join('\n')
  const r = compareDocuments(oldDoc, newDoc)
  // 原对象仍在 A 中，末尾多出一份完全相同副本 => copied，而不是 moved
  const copies = byStruct(r, 'copied')
  assert.equal(copies.length, 1)
  assert.equal(byStruct(r, 'moved').length, 0)
  assert.deepEqual(copies[0].anchors.old.startLine, 3)
  assert.deepEqual(copies[0].anchors.new.startLine, 9)
  assert.equal(byStruct(r, 'added').length, 0)
})

test('跨章节移动认定为 moved（旧位置不再保留）', () => {
  const oldDoc = ['# A', '', '被搬走的段落。', '', '# B', '', '留在 B 的段落。', ''].join('\n')
  const newDoc = ['# A', '', '# B', '', '留在 B 的段落。', '', '被搬走的段落。', ''].join('\n')
  const r = compareDocuments(oldDoc, newDoc)
  const moved = byStruct(r, 'moved')
  assert.equal(moved.length, 1)
  assert.equal(moved[0].anchors.old.startLine, 3)
  assert.equal(moved[0].anchors.new.startLine, 7)
  assert.equal(byStruct(r, 'copied').length, 0)
  assert.equal(byStruct(r, 'added').length, 0)
  assert.equal(byStruct(r, 'deleted').length, 0)
})

test('参数表：行重排不报错；默认值变更是 major，描述润色是 minor', () => {
  const oldMd = [
    '## API',
    '',
    '| 参数 | 默认值 | 描述 |',
    '| --- | --- | --- |',
    '| size | md | 按钮尺寸 |',
    '| disabled | false | 是否禁用 |',
    ''
  ].join('\n')
  const newMd = [
    '## API',
    '',
    '| 参数 | 默认值 | 描述 |',
    '| --- | --- | --- |',
    '| disabled | false | 是否禁用按钮组件 |',
    '| size | lg | 按钮尺寸 |',
    ''
  ].join('\n')
  const r = compareDocuments(oldMd, newMd)
  const table = r.entries.find((e) => e.type === 'table')
  assert.ok(table)
  assert.equal(table.detail.reorderedRows, true)
  assert.equal(table.severity, 'major')
  const sizeChange = table.detail.rowChanges.find((rc) => rc.key === 'size')
  const defCell = sizeChange.cells.find((c) => c.kind === 'default-change')
  assert.equal(defCell.severity, 'major')
  assert.equal(defCell.oldText, 'md')
  assert.equal(defCell.newText, 'lg')
  const disChange = table.detail.rowChanges.find((rc) => rc.key === 'disabled')
  const descCell = disChange.cells.find((c) => c.kind === 'description-polish')
  assert.equal(descCell.severity, 'minor')
})

test('参数表：新增/删除参数为 major；列重排标注但不改变语义', () => {
  const oldT = parseMarkdown(
    ['| 参数 | 默认值 | 描述 |', '| --- | --- | --- |', '| a | 1 | 说明一 |', ''].join('\n')
  ).nodes[0]
  const newT = parseMarkdown(
    ['| 描述 | 参数 | 默认值 |', '| --- | --- | --- |', '| 说明一 | a | 1 |', '| 说明二 | b | 2 |', ''].join('\n')
  ).nodes[0]
  const d = diffTable(oldT, newT)
  assert.equal(d.reorderedColumns, true)
  const added = d.rowChanges.find((rc) => rc.kind === 'added')
  assert.equal(added.key, 'b')
  assert.equal(d.severity, 'major')
})

test('代码块：insensitive 语言纯缩进变化被标记为 formatOnly（前端可折叠）', () => {
  const oldDoc = ['## s', '', '```js', 'function f(){return 1}', '```', ''].join('\n')
  const newDoc = ['## s', '', '```js', 'function f() {', '  return 1', '}', '```', ''].join('\n')
  const r = compareDocuments(oldDoc, newDoc)
  const code = r.entries.find((e) => e.type === 'code')
  assert.equal(code.formatOnly, true)
  assert.equal(code.severity, 'none')
  assert.equal(code.detail.policy, 'insensitive')
})

test('代码块：Python 缩进变化产生语义 hunk', () => {
  const oldDoc = ['## s', '', '```python', 'def f():', '  return 1', '```', ''].join('\n')
  const newDoc = ['## s', '', '```python', 'def f():', '    return 1', '```', ''].join('\n')
  const r = compareDocuments(oldDoc, newDoc)
  const code = r.entries.find((e) => e.type === 'code')
  assert.equal(code.formatOnly, false)
  assert.equal(code.detail.policy, 'exact')
  assert.ok(code.detail.hunks.length >= 1)
})

test('分级：描述润色 minor 与实质改写 major', () => {
  const oldDoc = ['## s', '', '这是一个用于说明按钮用法的段落。', ''].join('\n')
  const polish = compareDocuments(oldDoc, ['## s', '', '这是一个用来说明按钮用法的段落。', ''].join('\n'))
  assert.equal(polish.entries[0].severity, 'minor')
  const rewrite = compareDocuments(
    oldDoc,
    ['## s', '', '组件已废弃，所有 API 与旧版本完全不兼容，请迁移到新组件。', ''].join('\n')
  )
  assert.equal(rewrite.entries[0].severity, 'major')
})

test('复杂度预算：超预算触发 degraded 并给出提示，仍返回结果', () => {
  // 极小预算迫使任何非平凡对齐走贪心降级
  const paras = Array.from({ length: 12 }, (_, i) => `段落内容编号 ${i} 号。`).join('\n\n')
  const oldDoc = `# T\n\n${paras}\n`
  const newDoc = `# T\n\n${paras}\n`
  const r = compareDocuments(oldDoc, newDoc, { budgetCells: 4, crossChunkBudget: 2 })
  assert.equal(r.stats.degraded, true)
  assert.ok(r.warnings.length >= 1)
  // 降级结果仍是可用的：没有错误地把全部节点算成删除+新增
  assert.ok(r.entries.length < 24)
})

test('规则版本随结果冻结', () => {
  const r = compareDocuments('# A\n\n文本。\n', '# A\n\n文本改了。\n', { ruleVersion: 'rule-v9' })
  assert.equal(r.ruleVersion, 'rule-v9')
})

test('报告中每处差异均可跳回两个原版位置（锚点齐全）', () => {
  const oldDoc = ['# A', '', '旧段落内容。', '', '```js', '1', '```', ''].join('\n')
  const newDoc = ['# A', '', '新段落内容。', '', '```js', '2', '```', ''].join('\n')
  const r = compareDocuments(oldDoc, newDoc)
  for (const e of r.entries) {
    if (e.structural === 'added') assert.ok(e.anchors.new && !e.anchors.old)
    else if (e.structural === 'deleted') assert.ok(e.anchors.old && !e.anchors.new)
    else assert.ok(e.anchors.old && e.anchors.new)
  }
  const oldV = { versionId: 'v1' }
  const newV = { versionId: 'v2' }
  const md = renderMarkdownReport({ result: r, oldVersion: oldV, newVersion: newV })
  // 每条非新增/删除至少出现两个 /p/ 链接
  const modified = r.entries.filter((e) => e.structural === 'modified')
  for (const e of modified) {
    const oh = anchorURL(oldV, e.anchors.old)
    const nh = anchorURL(newV, e.anchors.new)
    assert.match(oh, /L\d+/)
    assert.match(nh, /L\d+/)
    assert.ok(md.includes(oh) && md.includes(nh))
  }
})
