// 语义差异主编排：
// 1) 解析两侧文档 -> 稳定身份
// 2) 大章节分块；chunk 间做“全文最优匹配”（标题身份 + 路径相似度 DP）
// 3) chunk 内做“受限局部匹配”（LCS 加权 DP，受复杂度预算约束，超预算贪心降级）
// 4) 对局部未匹配节点做跨块二次匹配（移动检测，带预算闸门）
// 5) 内容相同的多余副本认定为 copy（不与 move 混淆）
// 6) 产出统一 entries，每条都携带两侧原版位置锚点

import { parseMarkdown } from '../markdown/parser.js'
import { assignIdentities } from './identity.js'
import { chunkDocument } from './chunker.js'
import { align, pairScore } from './align.js'
import { diffProse } from './proseDiff.js'
import { diffCode } from './codeDiff.js'
import { diffTable } from './tableDiff.js'
import { diceSimilarity, normalizeProse, stripInlineMarkdown, textSimilarity } from './text.js'

/**
 * @typedef {Object} DiffOptions
 * @property {number} [budgetCells]        单次对齐 DP 单元预算（默认 40000）
 * @property {number} [crossChunkBudget]   跨块二次匹配总扫描预算
 * @property {number} [chapterLevel]       分块标题层级
 * @property {number} [polishThreshold]    润色相似度阈值
 * @property {string} [ruleVersion]        差异规则版本（随结果冻结）
 */

/**
 * @param {string} oldSource
 * @param {string} newSource
 * @param {DiffOptions} [opts]
 */
export function compareDocuments(oldSource, newSource, opts = {}) {
  const budgetCells = opts.budgetCells ?? 40_000
  const crossChunkBudget = opts.crossChunkBudget ?? 200_000
  const ruleVersion = opts.ruleVersion ?? 'rule-default'

  const oldParsed = parseMarkdown(oldSource)
  const newParsed = parseMarkdown(newSource)
  const oldNodes = assignIdentities(oldParsed.nodes)
  const newNodes = assignIdentities(newParsed.nodes)

  const oldChunks = chunkDocument(oldNodes, { chapterLevel: opts.chapterLevel })
  const newChunks = chunkDocument(newNodes, { chapterLevel: opts.chapterLevel })

  // 分块流式模式：只有已提交（被接受）的章节块参与比较；
  // 其余节点整体隐藏（不产生删除/新增），行号仍保持原文位置。
  const acceptedOld = opts.acceptedChunks?.old
  const acceptedNew = opts.acceptedChunks?.new
  const oldChunkVisible = (c) => !acceptedOld || acceptedOld.has(c.id)
  const newChunkVisible = (c) => !acceptedNew || acceptedNew.has(c.id)

  // ---- 1. 全文最优匹配：章节级配对（DP；只在双方都已提交的块间进行） ----
  const chapterPairs = matchChunks(oldChunks, newChunks, budgetCells, { oldChunkVisible, newChunkVisible })

  /** @type {any[]} */
  const entries = []
  /** @type {Set<number>} */
  const consumedOld = new Set()
  /** @type {Set<number>} */
  const consumedNew = new Set()
  const warnings = new Set()
  let degraded = false
  let totalCells = 0
  /** @type {Array<{chunkOld:string,chunkNew:string,degraded:boolean,cells:number}>} */
  const localStats = []

  // ---- 2. 受限局部匹配 ----
  /** @type {{oldNode:number,newNode:number,basis:string,score:number,chunkOld:string,chunkNew:string}[]} */
  const localPairs = []

  for (const { ia, ib, score } of chapterPairs.pairs) {
    const ca = oldChunks[ia]
    const cb = newChunks[ib]
    const A = ca.nodeIndexes.map((x) => oldNodes[x])
    const B = cb.nodeIndexes.map((x) => newNodes[x])
    const r = align(A, B, { budgetCells })
    totalCells += r.cells
    if (r.degraded) {
      degraded = true
      warnings.add(`章节「${cb.headingText || ca.headingText || '序言'}」节点较多，已使用快速匹配，结果可能遗漏远距离改写。`)
    }
    localStats.push({ chunkOld: ca.id, chunkNew: cb.id, degraded: r.degraded, cells: r.cells })
    for (const p of r.pairs) {
      localPairs.push({
        oldNode: ca.nodeIndexes[p.a],
        newNode: cb.nodeIndexes[p.b],
        basis: p.basis,
        score: p.score,
        chunkOld: ca.id,
        chunkNew: cb.id
      })
    }
  }

  /** @type {number[]} */
  const unmatchedOldLocal = []
  /** @type {number[]} */
  const unmatchedNewLocal = []
  /** 未提交块中的节点：整体隐藏，既不配对也不计增删 */
  const hiddenOld = new Set()
  const hiddenNew = new Set()
  oldChunks.forEach((c) => {
    if (!oldChunkVisible(c)) c.nodeIndexes.forEach((i) => hiddenOld.add(i))
  })
  newChunks.forEach((c) => {
    if (!newChunkVisible(c)) c.nodeIndexes.forEach((i) => hiddenNew.add(i))
  })
  // 未参与局部配对且不在隐藏块中的节点才是局部未匹配
  {
    const seenA = new Set()
    const seenB = new Set()
    for (const p of localPairs) {
      seenA.add(p.oldNode)
      seenB.add(p.newNode)
    }
    oldNodes.forEach((_, idx) => {
      if (!seenA.has(idx) && !hiddenOld.has(idx)) unmatchedOldLocal.push(idx)
    })
    newNodes.forEach((_, idx) => {
      if (!seenB.has(idx) && !hiddenNew.has(idx)) unmatchedNewLocal.push(idx)
    })
  }

  // ---- 3. 跨块二次匹配（移动检测，预算闸门） ----
  const cross = crossChunkMatch(
    unmatchedOldLocal.map((i) => oldNodes[i]),
    unmatchedNewLocal.map((i) => newNodes[i]),
    crossChunkBudget
  )
  if (cross.degraded) {
    degraded = true
    warnings.add('跨章节移动检测超出复杂度预算，部分远距离移动可能仅显示为删除/新增。')
  }

  /** @type {Map<number,{newNode:number,basis:string,score:number}>} */
  const movedOld = new Map()
  /** @type {Set<number>} */
  const movedNew = new Set()
  unmatchedOldLocal.forEach((globalIdx, k) => {
    const hit = cross.pairs.get(k)
    if (hit !== undefined) {
      const newGlobal = unmatchedNewLocal[hit]
      movedOld.set(globalIdx, { newNode: newGlobal, basis: cross.basis.get(k) || 'similar', score: cross.score.get(k) || 0 })
      movedNew.add(newGlobal)
    }
  })

  // ---- 4. 生成已配对节点的差异条目 ----
  const oldChunkOf = new Map()
  const newChunkOf = new Map()
  oldChunks.forEach((c, ci) => c.nodeIndexes.forEach((ni) => oldChunkOf.set(ni, ci)))
  newChunks.forEach((c, ci) => c.nodeIndexes.forEach((ni) => newChunkOf.set(ni, ci)))

  for (const p of localPairs) {
    consumedOld.add(p.oldNode)
    consumedNew.add(p.newNode)
    const a = oldNodes[p.oldNode]
    const b = newNodes[p.newNode]
    const entry = classifyPair(a, b, p.basis, opts)
    if (entry) {
      entry.structural = 'modified'
      entries.push({ ...entry, anchors: anchors(a, b), chunks: { old: oldChunks[oldChunkOf.get(p.oldNode)].id, new: newChunks[newChunkOf.get(p.newNode)].id } })
    }
  }

  // 移动配对（含“移动 + 修改”）
  for (const [oldGlobal, info] of movedOld) {
    consumedOld.add(oldGlobal)
    consumedNew.add(info.newNode)
    const a = oldNodes[oldGlobal]
    const b = newNodes[info.newNode]
    const inner = classifyPair(a, b, info.basis, opts)
    const severity = inner ? inner.severity : 'none'
    entries.push({
      id: `mv-${a.startLine}-${b.startLine}`,
      type: a.type,
      structural: 'moved',
      severity,
      formatOnly: inner ? inner.formatOnly : false,
      detail: inner ? inner.detail : { kind: 'identical' },
      anchors: anchors(a, b),
      chunks: { old: oldChunks[oldChunkOf.get(oldGlobal)].id, new: newChunks[newChunkOf.get(info.newNode)].id }
    })
  }

  // ---- 5. 剩余未匹配：删除/新增；复制段落另行认定 ----
  /** @type {number[]} */
  const leftoverOld = unmatchedOldLocal.filter((i) => !consumedOld.has(i))
  /** @type {number[]} */
  const leftoverNew = unmatchedNewLocal.filter((i) => !consumedNew.has(i))

  // 复制检测：新增节点若指纹与任一已消费旧节点（或剩余旧节点）相同，则认定 copy
  // 注意：move 走稳定身份/相似度跨块配对；copy 仅在“原对象仍在原处存在”时成立。
  const oldByFingerprint = new Map()
  oldNodes.forEach((n, idx) => {
    if (!oldByFingerprint.has(n.fingerprint)) oldByFingerprint.set(n.fingerprint, [])
    oldByFingerprint.get(n.fingerprint).push(idx)
  })

  for (const gi of leftoverNew) {
    const n = newNodes[gi]
    const candidates = oldByFingerprint.get(n.fingerprint) || []
    // 原对象必须仍存在（被某条 pair/move 消费，或属于未删除的剩余旧节点）
    const survivingSource = candidates.find((oi) => consumedOld.has(oi) || leftoverOld.includes(oi))
    if (survivingSource !== undefined && (n.type === 'paragraph' || n.type === 'list' || n.type === 'code')) {
      const src = oldNodes[survivingSource]
      entries.push({
        id: `cp-${n.startLine}`,
        type: n.type,
        structural: 'copied',
        severity: 'none',
        formatOnly: false,
        detail: { kind: 'copy', sourceNote: '内容与源位置完全一致' },
        anchors: { old: anchorOf(src, 'old'), new: anchorOf(n, 'new') },
        chunks: { old: oldChunks[oldChunkOf.get(survivingSource)].id, new: newChunks[newChunkOf.get(gi)].id }
      })
      consumedNew.add(gi)
      continue
    }
  }

  for (const gi of leftoverOld) {
    if (consumedOld.has(gi)) continue
    const n = oldNodes[gi]
    entries.push({
      id: `del-${n.startLine}`,
      type: n.type,
      structural: 'deleted',
      severity: 'major',
      formatOnly: false,
      detail: { kind: 'removed' },
      anchors: { old: anchorOf(n, 'old'), new: null },
      chunks: { old: oldChunks[oldChunkOf.get(gi)].id, new: null }
    })
  }
  for (const gi of leftoverNew) {
    if (consumedNew.has(gi)) continue
    const n = newNodes[gi]
    entries.push({
      id: `ins-${n.startLine}`,
      type: n.type,
      structural: 'added',
      severity: 'major',
      formatOnly: false,
      detail: { kind: 'added' },
      anchors: { old: null, new: anchorOf(n, 'new') },
      chunks: { old: null, new: newChunks[newChunkOf.get(gi)].id }
    })
  }

  // 按新文档阅读顺序排序（无新侧锚点的按旧侧）
  entries.sort((e1, e2) => {
    const l1 = e1.anchors.new ? e1.anchors.new.startLine : Number.MAX_SAFE_INTEGER
    const l2 = e2.anchors.new ? e2.anchors.new.startLine : Number.MAX_SAFE_INTEGER
    if (l1 !== l2) return l1 - l2
    return (e1.anchors.old?.startLine ?? 0) - (e2.anchors.old?.startLine ?? 0)
  })

  const counts = countBy(entries)
  if (counts.formatOnly > 0 && counts.semantic === 0 && counts.structural === 0) {
    warnings.add('两版仅有排版/空白类变化，无语义差异。')
  }

  return {
    ruleVersion,
    oldMeta: { lineCount: oldParsed.lineCount, nodeCount: oldNodes.length, chunkCount: oldChunks.length },
    newMeta: { lineCount: newParsed.lineCount, nodeCount: newNodes.length, chunkCount: newChunks.length },
    entries,
    stats: {
      ...counts,
      totalCells,
      degraded,
      budgetCells,
      crossChunkBudget,
      local: localStats
    },
    warnings: [...warnings]
  }
}

// 章节配对：身份（路径）优先，标题相似度补配；用 LCS DP 做最优序保持。
// visibility 谓词用于分块流式模式：未提交块完全不参与（既不配对也不计未匹配）。
function matchChunks(oldChunks, newChunks, budgetCells, visibility = {}) {
  const oldVisible = visibility.oldChunkVisible || (() => true)
  const newVisible = visibility.newChunkVisible || (() => true)
  const ai = oldChunks.map((_, i) => i).filter((i) => oldVisible(oldChunks[i]))
  const bi = newChunks.map((_, i) => i).filter((i) => newVisible(newChunks[i]))
  const A = ai.map((i) => oldChunks[i])
  const B = bi.map((i) => newChunks[i])
  const score = (x, y) => {
    if (x.headingIndex === -1 || y.headingIndex === -1) {
      return x.headingIndex === -1 && y.headingIndex === -1 ? 60 : 0
    }
    if (x.id === y.id) return 100
    const sim = textSimilarity(normalizeProse(stripInlineMarkdown(x.headingText || '')), normalizeProse(stripInlineMarkdown(y.headingText || '')))
    return sim >= 0.5 ? 25 + sim * 40 : 0
  }
  const n = A.length
  const m = B.length
  if (n * m > budgetCells) {
    // 章节通常很少，极少走到；贪心保底
    const used = new Set()
    /** @type {{ia:number,ib:number,score:number}[]} */
    const pairs = []
    for (let i = 0; i < n; i++) {
      let best = null
      for (let j = 0; j < m; j++) {
        if (used.has(j)) continue
        const s = score(A[i], B[j])
        if (s >= 25 && (!best || s > best.score)) best = { ia: i, ib: j, score: s }
      }
      if (best) {
        pairs.push(best)
        used.add(best.ib)
      }
    }
    const remapPairs = pairs.map((p) => ({ ia: ai[p.ia], ib: bi[p.ib], score: p.score }))
    return {
      pairs: remapPairs,
      unmatchedA: range(n).filter((i) => !pairs.some((p) => p.ia === i)).map((i) => ai[i]),
      unmatchedB: range(m).filter((j) => !used.has(j)).map((j) => bi[j])
    }
  }
  const S = Array.from({ length: n }, () => new Float32Array(m))
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) S[i][j] = score(A[i], B[j])
  const dp = Array.from({ length: n + 1 }, () => new Float32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const best = Math.max(dp[i + 1][j], dp[i][j + 1])
      dp[i][j] = S[i][j] >= 25 ? Math.max(best, S[i][j] + dp[i + 1][j + 1]) : best
    }
  }
  /** @type {{ia:number,ib:number,score:number}[]} */
  const pairs = []
  const usedA = new Set()
  const usedB = new Set()
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (S[i][j] >= 25 && dp[i][j] === S[i][j] + dp[i + 1][j + 1]) {
      pairs.push({ ia: i, ib: j, score: S[i][j] })
      usedA.add(i)
      usedB.add(j)
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }
  return {
    pairs: pairs.map((p) => ({ ia: ai[p.ia], ib: bi[p.ib], score: p.score })),
    unmatchedA: range(n).filter((x) => !usedA.has(x)).map((i) => ai[i]),
    unmatchedB: range(m).filter((x) => !usedB.has(x)).map((j) => bi[j])
  }
}

/**
 * 跨块二次匹配：旧未匹配节点 -> 新未匹配节点。
 * 身份优先（稳定身份），其次高相似度。预算用扫描次数计数。
 * 每个旧节点最多取一个最佳新节点，且新节点不重复占用（1:1）。
 */
function crossChunkMatch(oldUnmatched, newUnmatched, budget) {
  /** @type {Map<number, number>} */
  const pairs = new Map()
  /** @type {Map<number, string>} */
  const basis = new Map()
  /** @type {Map<number, number>} */
  const scoreMap = new Map()
  let scans = 0
  let degraded = false
  const usedNew = new Set()

  // 第一趟：稳定身份（段落身份含内容指纹，只对内容相同者命中；标题/代码/表用路径身份）
  for (let i = 0; i < oldUnmatched.length; i++) {
    const a = oldUnmatched[i]
    let best = null
    for (let j = 0; j < newUnmatched.length; j++) {
      scans++
      if (usedNew.has(j)) continue
      const b = newUnmatched[j]
      if (a.type !== b.type) continue
      if (a.identity === b.identity) {
        const s = a.type === 'code' ? 80 : 90
        if (!best || s > best.score) best = { j, score: s, basis: 'identity' }
      }
      if (scans > budget) break
    }
    if (best) {
      pairs.set(i, best.j)
      basis.set(i, best.basis)
      scoreMap.set(i, best.score)
      usedNew.add(best.j)
    }
    if (scans > budget) {
      degraded = true
      break
    }
  }

  // 第二趟：高相似度（移动后被改写）
  if (scans <= budget) {
    for (let i = 0; i < oldUnmatched.length; i++) {
      if (pairs.has(i)) continue
      const a = oldUnmatched[i]
      let best = null
      for (let j = 0; j < newUnmatched.length; j++) {
        scans++
        if (usedNew.has(j)) continue
        const b = newUnmatched[j]
        const { score: s, basis: bs } = pairScore(a, b)
        if (s >= 45 && (!best || s > best.score)) best = { j, score: s, basis: bs }
        if (scans > budget) break
      }
      if (best) {
        pairs.set(i, best.j)
        basis.set(i, best.basis)
        scoreMap.set(i, best.score)
        usedNew.add(best.j)
      }
      if (scans > budget) {
        degraded = true
        break
      }
    }
  }

  return { pairs, basis, score: scoreMap, scans, degraded }
}

/** 将同 chunk 内已配对节点分类为条目（不含结构信息） */
function classifyPair(a, b, basis, opts) {
  const base = { type: a.type }
  if (a.type === 'heading') {
    const d = diffProse(a.text, b.text, opts)
    if (d.kind === 'identical') return null
    return {
      ...base,
      severity: d.kind === 'format-only' ? 'none' : 'major',
      formatOnly: d.kind === 'format-only',
      detail: { kind: d.kind, inline: d.inline, similarity: d.similarity, oldText: a.text, newText: b.text }
    }
  }
  if (a.type === 'code') {
    const d = diffCode(a.text, b.text, a.lang, opts)
    if (d.kind === 'identical') return null
    return {
      ...base,
      severity: d.kind === 'format-only' ? 'none' : 'major',
      formatOnly: d.kind === 'format-only',
      detail: { kind: d.kind, ...d }
    }
  }
  if (a.type === 'table') {
    const d = diffTable(a, b)
    if (!d.semantic && !d.reorderedRows && !d.reorderedColumns && !d.formatOnly) return null
    return {
      ...base,
      severity: d.severity ?? 'none',
      formatOnly: d.formatOnly && !d.semantic,
      detail: { kind: d.semantic ? 'changed' : d.formatOnly ? 'format-only' : 'reordered', ...d }
    }
  }
  // paragraph / list
  const oldText = a.text ?? (a.items || []).map((it) => it.map((t) => t.text).join('')).join('\n')
  const newText = b.text ?? (b.items || []).map((it) => it.map((t) => t.text).join('')).join('\n')
  const d = diffProse(oldText, newText, opts)
  if (d.kind === 'identical') return null
  return {
    ...base,
    severity: d.kind === 'minor' ? 'minor' : d.kind === 'format-only' ? 'none' : 'major',
    formatOnly: d.kind === 'format-only',
    detail: { kind: d.kind, inline: d.inline, similarity: d.similarity, oldText, newText }
  }
}

function anchorOf(node, side) {
  return {
    side,
    startLine: node.startLine,
    endLine: node.endLine,
    path: node.path || '',
    slug: node.type === 'heading' ? node.slug : nearestSlug(node.path),
    heading: node.type === 'heading' ? node.text : undefined
  }
}

function nearestSlug(p) {
  if (!p) return ''
  const parts = p.split(' / ').filter(Boolean)
  return parts[parts.length - 1] || ''
}

function anchors(a, b) {
  return { old: anchorOf(a, 'old'), new: anchorOf(b, 'new') }
}

function range(n) {
  const r = []
  for (let i = 0; i < n; i++) r.push(i)
  return r
}

function countBy(entries) {
  let major = 0
  let minor = 0
  let formatOnly = 0
  let moved = 0
  let copied = 0
  let added = 0
  let deleted = 0
  let semantic = 0
  let structural = 0
  for (const e of entries) {
    if (e.structural === 'moved') {
      moved++
      structural++
    }
    if (e.structural === 'copied') {
      copied++
      structural++
    }
    if (e.structural === 'added') added++
    if (e.structural === 'deleted') deleted++
    if (e.formatOnly) {
      formatOnly++
      continue
    }
    if (e.severity === 'major') {
      major++
      semantic++
    } else if (e.severity === 'minor') minor++
  }
  return { major, minor, formatOnly, moved, copied, added, deleted, semantic, structural: added + deleted + moved + copied }
}
