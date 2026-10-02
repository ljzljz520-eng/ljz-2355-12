// 代码节点比较：语言敏感空白策略 + 行级 LCS（带预算保护）。

import { classifyCode, normalizeCode, policyOf } from './whitespace.js'
import { hash32 } from './text.js'

/**
 * @typedef {Object} CodeHunk
 * @property {number} oldStart 1-based，含
 * @property {number} oldCount
 * @property {number} newStart
 * @property {number} newCount
 * @property {{kind:'eq'|'del'|'ins', text:string}[]} lines
 */

/**
 * @typedef {Object} CodeDiffResult
 * @property {'identical'|'format-only'|'semantic'} kind
 * @property {string} lang
 * @property {'insensitive'|'exact'} policy
 * @property {CodeHunk[]} hunks
 * @property {string=} note
 */

/**
 * @param {string} oldCode
 * @param {string} newCode
 * @param {string} lang
 * @param {{budgetCells?:number}} [opts]
 * @returns {CodeDiffResult}
 */
export function diffCode(oldCode, newCode, lang, opts = {}) {
  const cls = classifyCode(oldCode, newCode, lang)
  const policy = policyOf(lang)
  if (cls.identical) return { kind: 'identical', lang: cls.lang, policy, hunks: [] }
  if (cls.formatOnly) {
    return {
      kind: 'format-only',
      lang: cls.lang,
      policy,
      hunks: [],
      note: policy === 'insensitive'
        ? '仅缩进 / 行尾空白变化，该语言空白无语义，已折叠'
        : '仅换行风格差异'
    }
  }

  // 语义级比较：insensitive 语言在规范化后的行上做 LCS（缩进不参与）；
  // exact 语言保留整行（含前导空白）。
  const rawA = (oldCode ?? '').replace(/\r\n?/g, '\n').split('\n')
  const rawB = (newCode ?? '').replace(/\r\n?/g, '\n').split('\n')
  const a = policy === 'insensitive' ? rawA.map((l) => l.trim()).filter((l) => l.length) : rawA
  const b = policy === 'insensitive' ? rawB.map((l) => l.trim()).filter((l) => l.length) : rawB

  const n = a.length
  const m = b.length
  const budgetCells = opts.budgetCells ?? 250_000
  /** @type {{kind:'eq'|'del'|'ins',text:string}[]} */
  let tagged = []
  let degraded = false

  if (n * m <= budgetCells) {
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        tagged.push({ kind: 'eq', text: rawA[i] ?? a[i] })
        i++
        j++
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        tagged.push({ kind: 'del', text: rawA[i] ?? a[i] })
        i++
      } else {
        tagged.push({ kind: 'ins', text: rawB[j] ?? b[j] })
        j++
      }
    }
    while (i < n) tagged.push({ kind: 'del', text: rawA[i++] ?? a[i - 1] })
    while (j < m) tagged.push({ kind: 'ins', text: rawB[j++] ?? b[j - 1] })
  } else {
    // 退化：按行哈希贪心配对，未配行为删除/新增
    degraded = true
    const bHash = new Map()
    b.forEach((line, idx) => {
      const h = hash32(line)
      if (!bHash.has(h)) bHash.set(h, [])
      bHash.get(h).push(idx)
    })
    const usedB = new Set()
    for (const line of a) {
      const list = bHash.get(hash32(line))
      const j = list && list.find((x) => !usedB.has(x))
      if (j !== undefined) {
        usedB.add(j)
        tagged.push({ kind: 'eq', text: line })
      } else {
        tagged.push({ kind: 'del', text: line })
      }
    }
    b.forEach((line, j) => {
      if (!usedB.has(j)) tagged.push({ kind: 'ins', text: line })
    })
  }

  return {
    kind: 'semantic',
    lang: cls.lang,
    policy,
    hunks: toHunks(tagged),
    note: degraded ? '文件过大，行级对比已切换为快速模式（结果可能不精确）' : undefined
  }
}

/** 行标记收敛为带上下文的 hunk（上下文 1 行） */
function toHunks(tagged, context = 1) {
  /** @type {CodeHunk[]} */
  const hunks = []
  const changeIdx = []
  tagged.forEach((t, i) => t.kind !== 'eq' && changeIdx.push(i))
  const taken = new Set()
  for (const ci of changeIdx) {
    if (taken.has(ci)) continue
    const start = Math.max(0, ci - context)
    let end = ci
    // 合并邻近 hunk
    let k = changeIdx.indexOf(ci)
    while (k + 1 < changeIdx.length && changeIdx[k + 1] - end <= 2 * context + 1) {
      k++
      end = changeIdx[k]
    }
    end = Math.min(tagged.length - 1, end + context)
    for (let p = start; p <= end; p++) taken.add(p)
    const lines = tagged.slice(start, end + 1)
    let oldStart = 0
    let newStart = 0
    for (let p = 0; p < start; p++) {
      if (tagged[p].kind !== 'ins') oldStart++
      if (tagged[p].kind !== 'del') newStart++
    }
    let oldCount = 0
    let newCount = 0
    for (const l of lines) {
      if (l.kind !== 'ins') oldCount++
      if (l.kind !== 'del') newCount++
    }
    hunks.push({ oldStart: oldStart + 1, oldCount, newStart: newStart + 1, newCount, lines })
  }
  return hunks
}

export { normalizeCode }
