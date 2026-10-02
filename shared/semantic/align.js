// 对齐引擎：
// - 全文最优匹配：对章节（chunk）集合做全局最优（LCS 加权 DP，最大化配对总分）
// - 受限局部匹配：章节内部同样做 LCS DP，但受复杂度预算约束
// - 超预算退化为指纹/身份贪心匹配，并回传 degraded=true 供上层“对退化结果提示”
// - 跨块移动：先局部对齐，再对未匹配节点做二次匹配（见 diff.js）

import { diceSimilarity, normalizeProse, stripInlineMarkdown, textSimilarity } from './text.js'
import { classifyCode } from './whitespace.js'

/**
 * @typedef {Object} AlignPair
 * @property {number} a  旧侧节点下标（相对 nodes 数组）
 * @property {number} b  新侧节点下标
 * @property {number} score
 * @property {'identity'|'fingerprint'|'similar'|'table'} basis
 */

/**
 * 两个节点的配对评分（0 表示不可配对）。
 * @param {any} x 旧节点
 * @param {any} y 新节点
 * @returns {{score:number, basis?:AlignPair['basis']}}
 */
export function pairScore(x, y) {
  if (x.type !== y.type) return { score: 0 }

  if (x.type === 'heading') {
    if (x.identity === y.identity) return { score: 100, basis: 'identity' }
    const sim = textSimilarity(normalizeProse(stripInlineMarkdown(x.text)), normalizeProse(stripInlineMarkdown(y.text)))
    return sim >= 0.55 ? { score: 20 + sim * 30, basis: 'similar' } : { score: 0 }
  }

  if (x.type === 'code') {
    if (x.identity === y.identity) {
      // 身份锚点极强；代码内容差异程度另行计算
      const c = classifyCode(x.text, y.text, x.lang)
      return { score: c.identical ? 100 : 80, basis: 'identity' }
    }
    if (canonical(x.lang) && x.lang && canonical(x.lang) === canonical(y.lang)) {
      const sim = diceSimilarity(normalizeCodeLight(x.text), normalizeCodeLight(y.text))
      if (sim >= 0.9) return { score: 25 + sim * 20, basis: 'similar' }
    }
    return { score: 0 }
  }

  if (x.type === 'table') {
    // 列结构需可比较（列数一致，表头语义相近）
    if (x.header.length !== y.header.length) {
      // 列数变化仍允许配对，但分数降低，单元格比较按最小列数
      return { score: 30, basis: 'table' }
    }
    const heads = x.header.every((h, k) => normalizeProse(stripInlineMarkdown(h)) === normalizeProse(stripInlineMarkdown(y.header[k])))
    if (heads) return { score: 90, basis: 'identity' }
    const sim = diceSimilarity(
      x.header.map((h) => normalizeProse(stripInlineMarkdown(h))).join('|'),
      y.header.map((h) => normalizeProse(stripInlineMarkdown(h))).join('|')
    )
    return sim >= 0.6 ? { score: 30 + sim * 30, basis: 'table' } : { score: 30, basis: 'table' }
  }

  // paragraph / list
  if (x.identity === y.identity) return { score: 100, basis: 'identity' }
  if (x.fingerprint === y.fingerprint) return { score: 95, basis: 'fingerprint' }
  const sim = textSimilarity(normalizeProse(stripInlineMarkdown(x.text || '')), normalizeProse(stripInlineMarkdown(y.text || '')))
  return sim >= 0.6 ? { score: 20 + sim * 35, basis: 'similar' } : { score: 0 }
}

function canonical(l) {
  return (l || '').trim().toLowerCase()
}

function normalizeCodeLight(s) {
  return (s || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * LCS 加权对齐（全局最优 / 受限局部共用）。
 * 预算 = A.length * B.length；超出 budgetCell 时退化为贪心。
 *
 * @param {any[]} A 旧节点集合
 * @param {any[]} B 新节点集合
 * @param {{budgetCells?:number}} [opts]
 * @returns {{pairs:AlignPair[], unmatchedA:number[], unmatchedB:number[], degraded:boolean, cells:number}}
 */
export function align(A, B, opts = {}) {
  const budgetCells = opts.budgetCells ?? 100_000
  const n = A.length
  const m = B.length
  const cells = n * m
  const minPair = 25

  if (cells > budgetCells) {
    return greedyAlign(A, B, cells)
  }

  // 预计算分数
  /** @type {(Int16Array|null)[]} */
  const scoreRows = new Array(n)
  for (let i = 0; i < n; i++) {
    const row = new Int16Array(m)
    for (let j = 0; j < m; j++) {
      const { score } = pairScore(A[i], B[j])
      row[j] = score >= minPair ? Math.round(score) : 0
    }
    scoreRows[i] = row
  }

  // DP：dp[i][j] = A[i..],B[j..] 的最大配对总分
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const best = Math.max(dp[i + 1][j], dp[i][j + 1])
      const s = scoreRows[i][j]
      dp[i][j] = s ? Math.max(best, s + dp[i + 1][j + 1]) : best
    }
  }

  /** @type {AlignPair[]} */
  const pairs = []
  const usedA = new Set()
  const usedB = new Set()
  let i = 0
  let j = 0
  while (i < n && j < m) {
    const s = scoreRows[i][j]
    if (s && dp[i][j] === s + dp[i + 1][j + 1]) {
      const { basis } = pairScore(A[i], B[j])
      pairs.push({ a: i, b: j, score: s, basis: basis || 'similar' })
      usedA.add(i)
      usedB.add(j)
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++
    } else {
      j++
    }
  }

  return {
    pairs,
    unmatchedA: range(n).filter((x) => !usedA.has(x)),
    unmatchedB: range(m).filter((x) => !usedB.has(x)),
    degraded: false,
    cells
  }
}

/**
 * 退化路径：稳定身份/指纹贪心 + 相似度补配（O(n*m) 的常数更小，且可提前剪枝）。
 * @returns {{pairs:AlignPair[], unmatchedA:number[], unmatchedB:number[], degraded:boolean, cells:number}}
 */
function greedyAlign(A, B, cells) {
  const usedB = new Set()
  /** @type {AlignPair[]} */
  const pairs = []
  const usedA = new Set()

  // 多趟贪心：先强身份/指纹，再相似度
  /** @type {('identity'|'fingerprint'|'similar')[]} */
  const passes = ['identity', 'fingerprint', 'similar']
  for (const pass of passes) {
    for (let i = 0; i < A.length; i++) {
      if (usedA.has(i)) continue
      let best = null
      for (let j = 0; j < B.length; j++) {
        if (usedB.has(j)) continue
        const { score, basis } = pairScore(A[i], B[j])
        if (score < 25) continue
        if (pass === 'identity' && !(basis === 'identity' || (A[i].type === 'table' && score >= 90))) continue
        if (pass === 'fingerprint' && basis !== 'fingerprint') continue
        if (pass === 'similar' && basis === 'identity') continue
        if (!best || score > best.score) best = { a: i, b: j, score: Math.round(score), basis: basis || 'similar' }
      }
      if (best) {
        pairs.push(best)
        usedA.add(best.a)
        usedB.add(best.b)
      }
    }
  }

  return {
    pairs: pairs.sort((p, q) => p.a - q.a),
    unmatchedA: range(A.length).filter((x) => !usedA.has(x)),
    unmatchedB: range(B.length).filter((x) => !usedB.has(x)),
    degraded: true,
    cells
  }
}

function range(n) {
  const r = []
  for (let i = 0; i < n; i++) r.push(i)
  return r
}
