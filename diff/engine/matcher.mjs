// 语义差异匹配器
// 两阶段：
//   模式 global（全文最优）：在全部块上做序列对齐，能自然发现跨块移动；
//   模式 local（受限局部）：先在章节分块内对齐，再对未匹配块做一次跨块二次匹配。
// 超复杂度预算时 global 退化为 local，并在报告中标注 degraded 与原因。

import { jaccard } from './parser.mjs'
import { normalizeCode, diffLines } from './whitespace.mjs'
import { severityOf, TYPE_SEVERITY } from './rules.mjs'

const MATCH_SCORE = 8
const GAP_PENALTY = 0 // 0/1 型对齐，惩罚体现为错配机会成本
const KIND_MISMATCH = -6

let SEQ = 0
function itemId() {
  SEQ += 1
  return `item-${Date.now().toString(36)}-${SEQ}`
}

function recordCounters(counters, n, m, mode) {
  counters.cells += n * m
  counters.pairs += n + m
}

/**
 * 块相似度（0~1），不同类型间返回 0。
 * 代码块使用规范化签名重合度（语言敏感空白策略体现在签名里）。
 */
export function blockSimilarity(a, b, budget = {}) {
  if (a.kind !== b.kind) return 0
  switch (a.kind) {
    case 'heading':
      return a.text.trim() === b.text.trim() ? 1 : jaccard(a.shingles, b.shingles)
    case 'paragraph':
    case 'list':
      return jaccard(a.shingles, b.shingles)
    case 'code': {
      if (a.lang !== b.lang) {
        // 语言变化本身即语义事件，给极低相似度以避免配对
        return a.text === b.text ? 0.05 : 0
      }
      if (a.fingerprint === b.fingerprint) return 1
      const na = normalizeCode(a.text, a.lang)
      const nb = normalizeCode(b.text, b.lang)
      if (na.signature === nb.signature) return 0.97 // 语言相关的纯空白差异
      // 行集合相似度（廉价估计），精确行级差异在 compareCode 中计算
      const sa = new Set(na.lines)
      const sb = new Set(nb.lines)
      return jaccard(new Set(sa), new Set(sb))
    }
    case 'table':
      return tableSimilarity(a, b)
    default:
      return a.fingerprint === b.fingerprint ? 1 : jaccard(a.shingles, b.shingles)
  }
}

function tableSimilarity(a, b) {
  // 参数行按参数名（稳定身份）匹配，行序重排不降低相似度
  const ra = new Map(a.rows.map((r) => [r.key, r]))
  const rb = new Map(b.rows.map((r) => [r.key, r]))
  const keys = new Set([...ra.keys(), ...rb.keys()])
  if (!keys.size) return jaccard(a.shingles, b.shingles)
  let hit = 0
  for (const k of keys) {
    const x = ra.get(k)
    const y = rb.get(k)
    if (x && y && x.cells.join('|') === y.cells.join('|')) hit++
  }
  return hit / keys.size
}

/**
 * Needleman–Wunsch 风格的块序列对齐（线性空间打分，O(nm)）。
 * strongMap: 稳定身份直接相同的块对 => 强制高分
 */
export function alignBlocks(listA, listB, strongPairs, counters, budget) {
  const n = listA.length
  const m = listB.length
  recordCounters(counters, n, m, 'align')
  const strong = new Set(strongPairs.map(([x, y]) => x.id + '||' + y.id))

  function sim(i, j) {
    const a = listA[i]
    const b = listB[j]
    if (strong.has(a.id + '||' + b.id)) return 1
    return blockSimilarity(a, b, budget)
  }

  const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1))
  const tb = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1)) // 1 diag 2 up 3 left
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      let s = sim(i - 1, j - 1)
      if (listA[i - 1].kind !== listB[j - 1].kind) s = KIND_MISMATCH / 10
      const score = s >= 0.999 ? MATCH_SCORE : s * MATCH_SCORE
      const diag = dp[i - 1][j - 1] + score
      const up = dp[i - 1][j] + GAP_PENALTY
      const left = dp[i][j - 1] + GAP_PENALTY
      if (diag >= up && diag >= left) {
        dp[i][j] = diag
        tb[i][j] = 1
      } else if (up >= left) {
        dp[i][j] = up
        tb[i][j] = 2
      } else {
        dp[i][j] = left
        tb[i][j] = 3
      }
    }
  }
  const pairs = []
  const pairedA = new Set()
  const pairedB = new Set()
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && tb[i][j] === 1) {
      pairs.push([listA[i - 1], listB[j - 1]])
      pairedA.add(listA[i - 1].id)
      pairedB.add(listB[j - 1].id)
      i--
      j--
    } else if (i > 0 && (j === 0 || tb[i][j] === 2)) {
      i--
    } else {
      j--
    }
  }
  pairs.reverse()
  return { pairs, pairedA, pairedB }
}

/**
 * 从对齐对中筛出"真正成立"的配对：
 *  - 稳定身份相同：总是成立
 *  - 其余要求相似度达到调用方给定阈值（块内修改 modifySimilarity；跨块移动 moveSimilarity）
 */
function acceptPairs(pairs, threshold, ctx = {}) {
  const accepted = []
  for (const [a, b] of pairs) {
    const stable = a.id === b.id
    const s = stable ? 1 : blockSimilarity(a, b, ctx.budget)
    if (stable || s >= threshold) accepted.push({ a, b, sim: s, stable })
  }
  return accepted
}

/**
 * 处理重复片段：同一指纹在一侧出现多次。
 * 规则：
 *  - 两侧同指纹数相同 => 按出现顺序一一配对（移动/不变）
 *  - 目标侧更多 => 多出的认定为 copied（复制段落另行认定）
 *  - 基线侧更多 => 多出的认定为 removed（复制被删除）
 * 复制/移动判定基于位置：配对块的章节身份不同 => moved。
 */
function buildIdentityGroups(docA, docB) {
  const groupsA = new Map()
  const groupsB = new Map()
  const add = (map, b) => {
    if (b.kind === 'heading') return
    const key = b.kind + '|' + b.fingerprint
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(b)
  }
  docA.blocks.forEach((b) => add(groupsA, b))
  docB.blocks.forEach((b) => add(groupsB, b))
  return { groupsA, groupsB }
}

function classifyMove(a, b) {
  if ((a.sectionId || '') !== (b.sectionId || '')) return true
  // 同章节但顺序大幅变化也算移动，交给对齐阶段处理；这里只判跨章节
  return false
}

/* ---------------- 参数表比较 ---------------- */

function cellText(row, col) {
  return (row?.cells[col] ?? '').trim()
}

function compareTable(tA, tB, sevOf) {
  const items = []
  const rowMapA = new Map(tA.rows.map((r) => [r.key, r]))
  const rowMapB = new Map(tB.rows.map((r) => [r.key, r]))

  // 表头列重排（仅在列集合相同、顺序不同时）
  const colsReordered =
    tA.headers.length === tB.headers.length &&
    new Set(tA.headers).size === new Set(tB.headers).size &&
    tA.headers.some((h, i) => h !== tB.headers[i])
  if (colsReordered) {
    items.push(mkItem('table-column-reordered', 'cosmetic', tA, tB, {
      detail: '参数表列顺序调整，内容未变',
    }))
  }

  // 行序检测：共同键按不同顺序出现
  const commonKeys = tA.rows.map((r) => r.key).filter((k) => rowMapB.has(k))
  const bOrderIndex = new Map(tB.rows.map((r, i) => [r.key, i]))
  const orderInA = commonKeys
  const orderInB = commonKeys.map((k) => bOrderIndex.get(k))
  let reordered = false
  for (let i = 1; i < orderInB.length; i++) {
    if (orderInB[i] < orderInB[i - 1]) reordered = true
  }
  if (reordered && commonKeys.length > 1) {
    const anyContentChange = commonKeys.some((k) => rowMapA.get(k).cells.join('|') !== rowMapB.get(k).cells.join('|'))
    items.push(mkItem('param-row-reordered', 'cosmetic', tA, tB, {
      detail: anyContentChange ? '参数行重排且部分内容变化（见各行明细）' : '参数行顺序调整（表格重排），参数内容未变',
    }))
  }

  for (const key of commonKeys) {
    const rA = rowMapA.get(key)
    const rB = rowMapB.get(key)
    if (rA.cells.join('|') === rB.cells.join('|')) continue

    // 默认值变更：major，与描述润色分级展示
    const defCols = tA.colMap.defaultValue.filter((c) => c < rA.cells.length)
    for (const c of defCols) {
      const va = cellText(rA, c)
      const vb = cellText(rB, c)
      if (va !== vb) {
        items.push(mkItem('param-default-changed', 'major', tA, tB, {
          param: key,
          column: tA.headers[c],
          before: va,
          after: vb,
          rowA: rA,
          rowB: rB,
          detail: `参数 ${key} 默认值：${va || '（空）'} → ${vb || '（空）'}`,
        }))
      }
    }
    // 描述变化：minor
    const descCols = tA.colMap.description.filter((c) => c < rA.cells.length)
    for (const c of descCols) {
      const va = cellText(rA, c)
      const vb = cellText(rB, c)
      if (va !== vb) {
        const sim = jaccard(new Set(va.split(/\s+/)), new Set(vb.split(/\s+/)))
        items.push(mkItem('param-description-changed', 'minor', tA, tB, {
          param: key,
          column: tA.headers[c],
          before: va,
          after: vb,
          polish: sim >= 0.5,
          rowA: rA,
          rowB: rB,
          detail: `参数 ${key} 描述${sim >= 0.5 ? '润色' : '修改'}`,
        }))
      }
    }
    // 类型变化：major
    for (const c of tA.colMap.type.filter((c) => c < rA.cells.length)) {
      const va = cellText(rA, c)
      const vb = cellText(rB, c)
      if (va !== vb) {
        items.push(mkItem('param-type-changed', 'major', tA, tB, {
          param: key, column: tA.headers[c], before: va, after: vb, rowA: rA, rowB: rB,
          detail: `参数 ${key} 类型：${va || '（空）'} → ${vb || '（空）'}`,
        }))
      }
    }
    // 其它列变化兜底
    const known = new Set([...defCols, ...descCols, ...tA.colMap.type].filter((c) => c !== tA.colMap.key))
    rA.cells.forEach((va, c) => {
      if (c === tA.colMap.key || known.has(c)) return
      const vb = rB.cells[c] ?? ''
      if (va.trim() !== vb.trim()) {
        items.push(mkItem('param-description-changed', 'minor', tA, tB, {
          param: key, column: tA.headers[c] || `第${c + 1}列`, before: va, after: vb, rowA: rA, rowB: rB,
          detail: `参数 ${key} 的 ${tA.headers[c] || '字段'} 变化`,
        }))
      }
    })
  }

  // 新增/删除参数行
  for (const [key, rB] of rowMapB) {
    if (!rowMapA.has(key)) {
      items.push(mkItem('param-row-added', 'major', tA, tB, {
        param: key, rowB: rB,
        detail: `新增参数 ${key}`,
      }))
    }
  }
  for (const [key, rA] of rowMapA) {
    if (!rowMapB.has(key)) {
      items.push(mkItem('param-row-removed', 'critical', tA, tB, {
        param: key, rowA: rA,
        detail: `删除参数 ${key}`,
      }))
    }
  }
  return items
}

/* ---------------- 代码块比较 ---------------- */

function compareCode(cA, cB, ctx) {
  const items = []
  if (cA.lang !== cB.lang) {
    items.push(mkItem('code-semantic-change', 'major', cA, cB, {
      detail: `代码语言变更：${cA.lang || 'text'} → ${cB.lang || 'text'}`,
      langChanged: true,
    }))
    return items
  }
  if (cA.fingerprint === cB.fingerprint) return items

  const normA = normalizeCode(cA.text, cA.lang)
  const normB = normalizeCode(cB.text, cB.lang)

  if (normA.signature === normB.signature) {
    // 语言相关空白差异：JS 缩进折叠 cosmetic；Python 等 strict 语言不会走到这里
    items.push(mkItem('whitespace-only', 'cosmetic', cA, cB, {
      detail: `代码仅空白/排版变化（${cA.lang || 'text'} 策略：${normA.policy.indent}）`,
      whitespacePolicy: normA.policy.indent,
      language: cA.lang,
    }))
    return items
  }

  // 超预算则不做行级 LCS，给粗粒度结论并标记
  const lineBudget = ctx.rules.budget.maxCodeLinesLcs
  const over = normA.lines.length * normB.lines.length > lineBudget
  let hunks = []
  let degraded = false
  if (over) {
    degraded = true
  } else {
    const ops = diffLines(normA, normB)
    hunks = groupHunks(ops)
    // 规范化行号 -> 绝对行号：代码体从围栏行的下一行开始
    const offA = cA.startLine + 1
    const offB = cB.startLine + 1
    hunks = hunks.map((h) => ({
      ...h,
      aStart: h.aStart === null ? null : h.aStart + offA,
      aEnd: h.aEnd + offA,
      bStart: h.bStart === null ? null : h.bStart + offB,
      bEnd: h.bEnd + offB,
    }))
  }

  // 判断是否只是注释变化：忽略注释后签名一致 => minor
  const ncA = normalizeCode(cA.text, cA.lang, { ignoreComments: true })
  const ncB = normalizeCode(cB.text, cB.lang, { ignoreComments: true })
  const commentOnly = ncA.signature === ncB.signature

  const type = commentOnly ? 'code-comment-only' : 'code-semantic-change'
  items.push(mkItem(type, commentOnly ? 'minor' : 'major', cA, cB, {
    detail: commentOnly
      ? `代码仅注释变化（${cA.lang || 'text'}）`
      : `代码语义变化（${cA.lang || 'text'}，空白策略 ${normA.policy.indent}）`,
    language: cA.lang,
    whitespacePolicy: normA.policy.indent,
    strictWhitespace: normA.policy.indent === 'strict',
    hunks,
    degraded,
    note: degraded ? '代码块过大，已跳过逐行比对（复杂度预算保护）' : undefined,
  }))
  return items
}

function groupHunks(ops) {
  const hunks = []
  let cur = null
  const flush = () => {
    if (cur && cur.ops.length) hunks.push(cur)
    cur = null
  }
  for (const op of ops) {
    if (op.type === 'equal') {
      flush()
      continue
    }
    if (!cur) cur = { ops: [], aStart: Infinity, aEnd: -1, bStart: Infinity, bEnd: -1 }
    cur.ops.push(op)
    if (op.aLine !== undefined) {
      cur.aStart = Math.min(cur.aStart, op.aLine)
      cur.aEnd = Math.max(cur.aEnd, op.aLine)
    }
    if (op.bLine !== undefined) {
      cur.bStart = Math.min(cur.bStart, op.bLine)
      cur.bEnd = Math.max(cur.bEnd, op.bLine)
    }
  }
  flush()
  return hunks.map((h) => ({
    aStart: h.aStart === Infinity ? null : h.aStart,
    aEnd: h.aEnd,
    bStart: h.bStart === Infinity ? null : h.bStart,
    bEnd: h.bEnd,
    changes: h.ops,
  }))
}

/* ---------------- 段落/标题比较 ---------------- */

function isFormatOnly(aText, bText) {
  const strip = (s) =>
    s
      .replace(/[*_~`#>\-+[\]()!]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  return strip(aText) === strip(bText)
}

function compareParagraph(pA, pB) {
  if (pA.text === pB.text) return []
  if (isFormatOnly(pA.text, pB.text)) {
    return [mkItem('format-only', 'cosmetic', pA, pB, { detail: '仅 Markdown 格式标记变化（粗体/列表符等），文本一致' })]
  }
  const sim = jaccard(pA.shingles, pB.shingles)
  return [mkItem(sim >= 0.85 ? 'description-polish' : 'text-reword', 'minor', pA, pB, {
    similarity: sim,
    detail: sim >= 0.85 ? '描述润色：措辞调整，语义基本一致' : '段落内容改写',
  })]
}

function compareHeading(hA, hB) {
  if (hA.text === hB.text) return []
  const sim = jaccard(hA.shingles, hB.shingles)
  return [mkItem('heading-title-changed', sim >= 0.8 ? 'minor' : 'major', hA, hB, {
    similarity: sim,
    before: hA.text,
    after: hB.text,
    detail: `标题变化：${hA.text} → ${hB.text}`,
  })]
}

/* ---------------- item 构造（含双端跳回定位） ---------------- */

function locOf(block, versionId, row, extra = {}) {
  const base = {
    versionId,
    blockId: block.id,
    kind: block.kind,
    startLine: block.startLine ?? 0,
    endLine: block.endLine ?? block.startLine ?? 0,
    section: block.section,
    sectionId: block.sectionId,
  }
  if (row) {
    base.rowKey = row.key
    // 行号定位到该参数所在表格行
    base.startLine = row.line
    base.endLine = row.line
  }
  Object.assign(base, extra)
  return base
}

function mkItem(type, severity, a, b, extra = {}) {
  const item = {
    id: itemId(),
    type,
    severity: severity || severityOf(type),
    from: a ? locOf(a, extra.versionA || 'A', extra.rowA) : null,
    to: b ? locOf(b, extra.versionB || 'B', extra.rowB) : null,
    detail: extra.detail || type,
    blockType: a?.kind || b?.kind,
  }
  for (const k of Object.keys(extra)) {
    if (['rowA', 'rowB', 'versionA', 'versionB'].includes(k)) continue
    item[k] = extra[k]
  }
  return item
}

/* ---------------- 主比较流程 ---------------- */

/**
 * 异步分块比较：大章节分块处理时每个检查点让出事件循环，
 * 使 AbortSignal 取消可以及时生效；配合仓储层“代数守卫”，
 * 取消后才完成的迟到结果会被丢弃，绝不混进新比较。
 * @param docA parseDocument 结果（基线）
 * @param docB parseDocument 结果（目标）
 * @param rules DEFAULT_RULES 或钉版规则
 * @param opts { baselineId, targetId, signal: AbortSignal, preferredMode }
 */
export async function compareDocuments(docA, docB, rules, opts = {}) {
  const t0 = Date.now()
  const counters = { cells: 0, pairs: 0, codeLcsCells: 0 }
  const warnings = []
  const versionA = opts.baselineId || 'baseline'
  const versionB = opts.targetId || 'target'

  // 让出事件循环：让取消信号与新的比较代数在分块之间被观察到
  const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve))

  const throwIfCancelled = () => {
    if (opts.signal && opts.signal.aborted) {
      const e = new Error('ABORTED')
      e.code = 'ABORTED'
      throw e
    }
  }

  const globalCells = docA.blocks.length * docB.blocks.length
  const overGlobalBudget = globalCells > rules.budget.maxGlobalCells
  const preferred = opts.preferredMode || 'auto'
  let mode
  if (overGlobalBudget) {
    if (preferred === 'global' && !rules.budget.fallbackToLocal) {
      const e = new Error('COMPLEXITY_BUDGET_EXCEEDED')
      e.code = 'COMPLEXITY_BUDGET_EXCEEDED'
      e.detail = { globalCells, budget: rules.budget.maxGlobalCells }
      throw e
    }
    mode = 'local'
  } else {
    mode = preferred === 'local' ? 'local' : 'global'
  }
  let degraded = false
  const degradeReasons = []

  if (overGlobalBudget) {
    // 无论是自动降级还是请求 global 被降级，都属于退化结果，需要显式提示
    degraded = true
    degradeReasons.push(`全文对齐需 ${globalCells} 个单元，超过复杂度预算 ${rules.budget.maxGlobalCells}，已退化为受限局部匹配`)
    if (preferred !== 'local') {
      // 仅记录；不阻断
    } else {
      warnings.push(`大文档（${globalCells} 对齐单元）按请求使用受限局部匹配`)
    }
  }

  // 1) 稳定身份配对，分两类：
  //   (a) 结构身份：标题（显式锚点/章节路径 slug）、代码块、参数表 —— 按 id 精确配对
  //   (b) 内容身份：段落/列表 —— 按“内容指纹 + 出现序号”同序 1:1 配对
  //       （重复内容由此有序对齐，避免一份基线内容被占用两次；多出/少出留给复制/删除认定）
  const mapA = new Map(docA.blocks.map((b) => [b.id, b]))
  const mapB = new Map(docB.blocks.map((b) => [b.id, b]))
  const strongPairs = []
  const contentPairs = []
  const matchedA = new Set()
  const matchedB = new Set()
  const CONTENT_KINDS = new Set(['paragraph', 'list', 'container'])

  for (const [id, bA] of mapA) {
    if (CONTENT_KINDS.has(bA.kind)) continue
    const bB = mapB.get(id)
    if (bB && bA.kind === bB.kind) {
      strongPairs.push([bA, bB])
      matchedA.add(bA.id)
      matchedB.add(bB.id)
    }
  }

  // 内容身份：按内容指纹分组，同序一一配对（跨章节移动、重复片段都在此稳定处理）
  const contentGroupsA = new Map()
  const contentGroupsB = new Map()
  const pushGroup = (m, b) => {
    const key = b.contentKey || (b.kind + ':' + b.fingerprint)
    if (!m.has(key)) m.set(key, [])
    m.get(key).push(b)
  }
  docA.blocks.forEach((b) => CONTENT_KINDS.has(b.kind) && pushGroup(contentGroupsA, b))
  docB.blocks.forEach((b) => CONTENT_KINDS.has(b.kind) && pushGroup(contentGroupsB, b))
  for (const [key, listA] of contentGroupsA) {
    const listB = contentGroupsB.get(key) || []
    const common = Math.min(listA.length, listB.length)
    for (let k = 0; k < common; k++) {
      contentPairs.push({ a: listA[k], b: listB[k], sim: 1, stable: true, contentIdentity: true })
      matchedA.add(listA[k].id)
      matchedB.add(listB[k].id)
    }
  }

  let accepted = contentPairs.slice()

  if (mode === 'global') {
    throwIfCancelled()
    await yieldToEventLoop()
    // 序列对齐只处理未被身份占用的块，避免重复内容错配
    const remA = docA.blocks.filter((b) => !matchedA.has(b.id))
    const remB = docB.blocks.filter((b) => !matchedB.has(b.id))
    const { pairs } = alignBlocks(remA, remB, [], counters, rules.budget)
    const acc = acceptPairs(pairs, rules.match.modifySimilarity, { budget: rules.budget })
    for (const p of acc) {
      matchedA.add(p.a.id)
      matchedB.add(p.b.id)
    }
    accepted.push(...acc)
    for (const [a, b] of strongPairs) accepted.push({ a, b, sim: 1, stable: true })
  } else {
    // 受限局部：章节分块内对齐（仅剩余块）
    const chunkIndexA = new Map(docA.chunks.map((c) => [c.id, c]))
    const chunkIndexB = new Map(docB.chunks.map((c) => [c.id, c]))
    const chunkPairs = []
    for (const [id, cA] of chunkIndexA) {
      const cB = chunkIndexB.get(id)
      if (cB) chunkPairs.push([cA, cB])
    }
    // 标题改名导致 chunk id 不同的，用标题块相似度补配对
    const usedA = new Set(chunkPairs.map(([a]) => a.id))
    const usedB = new Set(chunkPairs.map(([, b]) => b.id))
    const unA = docA.chunks.filter((c) => !usedA.has(c.id))
    const unB = docB.chunks.filter((c) => !usedB.has(c.id))
    const provisional = []
    for (const ca of unA) {
      let best = null
      let bs = 0
      for (const cb of unB) {
        if (usedB.has(cb.id)) continue
        const s = ca.headingBlock && cb.headingBlock ? blockSimilarity(ca.headingBlock, cb.headingBlock) : 0
        if (s > bs) {
          bs = s
          best = cb
        }
      }
      if (best && bs >= rules.match.moveSimilarity) {
        provisional.push([ca, best, bs])
        usedB.add(best.id)
      }
    }
    chunkPairs.push(...provisional.map(([a, b]) => [a, b]))

    const localMatchedA = new Set(matchedA)
    const localMatchedB = new Set(matchedB)
    for (const [cA, cB] of chunkPairs) {
      throwIfCancelled()
      await yieldToEventLoop() // 大章节逐块处理：取消在块边界生效
      const la = cA.blocks.filter((b) => !localMatchedA.has(b.id))
      const lb = cB.blocks.filter((b) => !localMatchedB.has(b.id))
      const { pairs } = alignBlocks(la, lb, [], counters, rules.budget)
      const acc = acceptPairs(pairs, rules.match.modifySimilarity, { budget: rules.budget })
      for (const p of acc) {
        localMatchedA.add(p.a.id)
        localMatchedB.add(p.b.id)
      }
      accepted.push(...acc)
    }
    for (const [a, b] of strongPairs) accepted.push({ a, b, sim: 1, stable: true })

    // 2) 跨块二次匹配：只在未匹配块之间进行，发现跨大章节移动
    throwIfCancelled()
    await yieldToEventLoop()
    const restA = docA.blocks.filter((b) => !localMatchedA.has(b.id))
    const restB = docB.blocks.filter((b) => !localMatchedB.has(b.id))
    const cross = crossChunkMatch(restA, restB, rules, counters, throwIfCancelled)
    for (const w of cross.warnings) warnings.push(w)
    if (cross.budgetHit) {
      degraded = true
      degradeReasons.push('跨块二次匹配达到扫描预算，部分移动可能未识别')
    }
    accepted.push(...cross.matches)
    cross.matches.forEach((p) => {
      localMatchedA.add(p.a.id)
      localMatchedB.add(p.b.id)
    })
  }

  // 3) 重复片段 / 复制段落认定
  // 先剔除已被 1:1 对齐/稳定身份占用的块，只处理“剩余块”：
  //   - 同指纹的剩余块按出现顺序自动配为“内容相等对”（跨章节 => moved，内容相同不重复报错）；
  //   - 目标侧多出的同指纹副本 => copied（另行认定，区别于普通新增）；
  //   - 基线侧多出的同指纹副本 => 副本删除；
  //   - 已配对但指纹变化的块（改写）在第 4 步处理，这里绝不再算一次删除。
  const pairedA = new Set()
  const pairedB = new Set()
  for (const p of accepted) {
    pairedA.add(p.a.id)
    pairedB.add(p.b.id)
  }
  const { groupsA, groupsB } = buildIdentityGroups(docA, docB)
  const copyExtraB = []
  const copyExtraA = []
  const equalPairs = []
  for (const [fpKey, listAall] of groupsA) {
    const listBall = groupsB.get(fpKey) || []
    const listA = listAall.filter((x) => !pairedA.has(x.id))
    const listB = listBall.filter((x) => !pairedB.has(x.id))
    const common = Math.min(listA.length, listB.length)
    for (let k = 0; k < common; k++) equalPairs.push({ a: listA[k], b: listB[k], sim: 1, stable: false, equalContent: true })
    if (listB.length > listA.length) copyExtraB.push(...listB.slice(listA.length))
    if (listA.length > listB.length) copyExtraA.push(...listA.slice(listB.length))
  }
  // 基线完全没有、仅目标内重复（>=2 份）的新内容，除第一份按新增处理外，其余认定为复制
  for (const [fpKey, listBall] of groupsB) {
    if (groupsA.has(fpKey)) continue
    const listB = listBall.filter((x) => !pairedB.has(x.id))
    if (listB.length >= 2) copyExtraB.push(...listB.slice(1))
  }
  for (const p of equalPairs) {
    accepted.push(p)
    pairedA.add(p.a.id)
    pairedB.add(p.b.id)
  }
  const copyExtraBIds = new Set(copyExtraB.map((b) => b.id))
  const copyExtraAIds = new Set(copyExtraA.map((a) => a.id))

  const items = []
  const seenPair = new Set()

  // 4) 逐对生成差异明细
  for (const p of accepted) {
    const { a, b, stable } = p
    const key = a.id + '||' + b.id
    if (seenPair.has(key)) continue
    seenPair.add(key)

    let sub = []
    if (a.kind === 'table' && b.kind === 'table') sub = compareTable(a, b, {})
    else if (a.kind === 'code' && b.kind === 'code') sub = compareCode(a, b, { rules })
    else if (a.kind === 'heading' && b.kind === 'heading') sub = compareHeading(a, b)
    else if (a.kind === b.kind) sub = compareParagraph(a, b)

    // 跨章节移动（即使内容不变也标注；有内容变化时移动作为附加标记）
    const movedAcross = classifyMove(a, b)
    if (movedAcross && sub.length === 0) {
      items.push(mkItem('moved', 'cosmetic', a, b, {
        versionA, versionB,
        fromSection: a.section?.join(' > ') || '(根)',
        toSection: b.section?.join(' > ') || '(根)',
        detail: `段落从「${a.section?.join(' > ') || '根'}」移动到「${b.section?.join(' > ') || '根'}」`,
      }))
    } else if (movedAcross) {
      sub.forEach((it) => {
        it.moved = true
        it.fromSection = a.section?.join(' > ') || '(根)'
        it.toSection = b.section?.join(' > ') || '(根)'
        it.detail = `[跨章节移动] ${it.detail}`
      })
    }
    sub.forEach((it) => {
      it.from && (it.from.versionId = versionA)
      it.to && (it.to.versionId = versionB)
    })
    items.push(...sub)
    const degradedCode = sub.find((it) => it.degraded)
    if (degradedCode) {
      degraded = true
      degradeReasons.push(`代码块（${a.lang || 'text'}）超出逐行比对预算，行级定位不可用，已给出粗粒度结论`)
    }
    counters.codeLcsCells = counters.cells // 粗略记账
  }

  // 生成复制项（每处副本都指向来源原版位置与副本自身位置）
  for (const b of copyExtraB) {
    const sourceList = groupsA.get(b.kind + '|' + b.fingerprint)
    const source = sourceList ? sourceList[0] : null
    items.push(mkItem('copied', 'cosmetic', source, b, {
      versionA, versionB,
      detail: '段落被复制（目标版本出现同源副本，区别于普通新增）',
      copyOf: source ? source.id : null,
    }))
  }
  for (const a of copyExtraA) {
    items.push(mkItem('block-removed', 'critical', a, null, {
      versionA, versionB,
      detail: a.kind === 'code' ? '代码块副本被删除' : '段落副本被删除（同源副本之一）',
    }))
  }

  // 5) 未匹配块 => 新增/删除（accepted 已含内容相等对与复制/删除统计）
  for (const b of docB.blocks) {
    if (pairedB.has(b.id) || matchedB.has(b.id) || copyExtraBIds.has(b.id)) continue
    if (b.kind === 'heading') items.push(mkItem('heading-added', 'minor', null, b, { versionA, versionB, detail: `新增标题：${b.text}` }))
    else if (b.kind === 'code') items.push(mkItem('code-added', 'minor', null, b, { versionA, versionB, detail: '新增代码块' }))
    else if (b.kind === 'table') items.push(mkItem('table-added', 'minor', null, b, { versionA, versionB, detail: '新增参数表' }))
    else items.push(mkItem('block-added', 'minor', null, b, { versionA, versionB, detail: '新增段落' }))
  }
  for (const a of docA.blocks) {
    if (pairedA.has(a.id) || matchedA.has(a.id) || copyExtraAIds.has(a.id)) continue
    if (a.kind === 'heading') items.push(mkItem('heading-removed', 'critical', a, null, { versionA, versionB, detail: `删除标题：${a.text}` }))
    else if (a.kind === 'code') items.push(mkItem('code-removed', 'critical', a, null, { versionA, versionB, detail: '删除代码块' }))
    else if (a.kind === 'table') items.push(mkItem('table-removed', 'critical', a, null, { versionA, versionB, detail: '删除参数表' }))
    else items.push(mkItem('block-removed', 'critical', a, null, { versionA, versionB, detail: '删除段落' }))
  }

  // 6) 汇总与退化提示
  const bySeverity = { cosmetic: 0, minor: 0, major: 0, critical: 0 }
  for (const it of items) bySeverity[it.severity] = (bySeverity[it.severity] || 0) + 1

  if (degraded) {
    warnings.push(...degradeReasons)
    warnings.push('当前结果为受限匹配：可能遗漏跨章节移动或远距离改写，请人工复核')
  }

  const report = {
    reportId: `rep-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    baselineId: versionA,
    targetId: versionB,
    rulesVersion: rules.rulesVersion,
    mode,
    degraded,
    warnings,
    stats: {
      blocksA: docA.blocks.length,
      blocksB: docB.blocks.length,
      globalCells,
      budgetCells: rules.budget.maxGlobalCells,
      items: items.length,
      bySeverity,
      durationMs: Date.now() - t0,
    },
    items,
    createdAt: new Date().toISOString(),
  }
  return report
}

/**
 * 跨块二次匹配：在剩余块之间寻找移动/复制对。
 * 预算：maxShinglePairs 限制扫描对数；超预算按分块顺序贪心，剩余块不再强行配对。
 */
function crossChunkMatch(restA, restB, rules, counters, throwIfCancelled) {
  const matches = []
  const warnings = []
  let budgetHit = false
  const usedB = new Set()
  const candidates = []
  let scanned = 0

  // 按类型分组减少扫描
  const byKindB = new Map()
  for (const b of restB) {
    if (!byKindB.has(b.kind)) byKindB.set(b.kind, [])
    byKindB.get(b.kind).push(b)
  }

  for (const a of restA) {
    const pool = byKindB.get(a.kind) || []
    for (const b of pool) {
      if (usedB.has(b.id)) continue
      scanned++
      if (scanned > rules.budget.maxShinglePairs) {
        budgetHit = true
        break
      }
      counters.pairs++
      const s = blockSimilarity(a, b, rules.budget)
      if (s >= rules.match.moveSimilarity) {
        candidates.push({ a, b, sim: s, stable: a.id === b.id })
      }
    }
    if (budgetHit) break
  }

  // 全局最优 vs 局部贪心：二次匹配本身是受限局部的一部分；
  // 候选先按相似度排序贪心取对，避免一个目标块被多个源块占用。
  candidates.sort((x, y) => y.sim - x.sim)
  const usedA = new Set()
  for (const c of candidates) {
    if (usedA.has(c.a.id) || usedB.has(c.b.id)) continue
    usedA.add(c.a.id)
    usedB.add(c.b.id)
    matches.push(c)
  }

  if (budgetHit) {
    warnings.push(`跨块扫描在 ${rules.budget.maxShinglePairs} 对处达到预算上限`)
  }
  return { matches, warnings, budgetHit }
}

/**
 * 生成导出用冻结快照：包含原文、规则与全部定位信息，保证自包含、可复现。
 */
export function freezeSnapshot(docARaw, docBRaw, docA, docB, report, meta = {}) {
  const includeCosmetic = meta.includeCosmetic !== false
  const frozenReport = includeCosmetic
    ? report
    : {
        ...report,
        items: report.items.filter((i) => i.severity !== 'cosmetic'),
        exportedView: { cosmeticCollapsed: true, note: '按导出时所见（纯格式折叠）冻结；完整 items 需重新比较' },
      }
  return {
    frozenAt: new Date().toISOString(),
    schema: 'semdiff-export/v1',
    baseline: { id: report.baselineId, content: docARaw, title: meta.titleA },
    target: { id: report.targetId, content: docBRaw, title: meta.titleB },
    rulesVersion: report.rulesVersion,
    rules: meta.rules || null,
    report: frozenReport,
    locator: {
      note: '每个 item.from / item.to 含版本、块 id 与行号，可跳回两个原版位置',
    },
  }
}
