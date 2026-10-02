// 文本规范化 / 指纹 / 相似度工具（同构：浏览器与 Node 均可使用）

/**
 * FNV-1a 32bit 非加密哈希，用于稳定身份指纹
 * @param {string} s
 * @returns {string}
 */
export function hash32(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * 段落/描述类文本规范化：折叠所有连续空白（含行首尾），小写。
 * 仅用于“润色级”比较，不用于代码块。
 * @param {string} s
 */
export function normalizeProse(s) {
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
}

/** 去除 markdown 行内标记（粗体/斜体/代码/链接），用于描述润色判定 */
export function stripInlineMarkdown(s) {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
}

/** bigram 集合（基于码点，兼容中文） */
export function bigrams(s) {
  const set = new Set()
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
  return set
}

/**
 * Sørensen–Dice 系数（0..1），空串约定为 1 当两者皆空，否则 0。
 * @param {string} a
 * @param {string} b
 */
export function diceSimilarity(a, b) {
  if (!a && !b) return 1
  if (!a || !b) return 0
  if (a === b) return 1
  if (a.length === 1 && b.length === 1) return a === b ? 1 : 0
  const A = bigrams(a)
  const B = bigrams(b)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  return (2 * inter) / (A.size + B.size)
}

/**
 * 行内最小差异：逐词 LCS，返回带标记的片段（用于描述润色等行内高亮）。
 * 复杂度预算由调用方保证（单元格/段落内文本通常很短）。
 * @param {string} oldText
 * @param {string} newText
 */
export function inlineDiff(oldText, newText) {
  const toks = (s) => s.match(/\s+|\w+|[^\w\s]/g) || []
  const a = toks(oldText)
  const b = toks(newText)
  const n = a.length
  const m = b.length
  if (n * m > 250_000) {
    // 预算保护：退化为整段替换
    return [
      ...(oldText ? [{ kind: 'del', text: oldText }] : []),
      ...(newText ? [{ kind: 'ins', text: newText }] : [])
    ]
  }
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  /** @type {{kind:string,text:string}[]} */
  const parts = []
  const push = (kind, text) => {
    const last = parts[parts.length - 1]
    if (last && last.kind === kind) last.text += text
    else parts.push({ kind, text })
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push('eq', a[i])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push('del', a[i])
      i++
    } else {
      push('ins', b[j])
      j++
    }
  }
  while (i < n) push('del', a[i++])
  while (j < m) push('ins', b[j++])
  return parts
}

/**
 * 归一化 Levenshtein 相似度（字符级，对短中文文本比 bigram Dice 更稳定）。
 * 带预算保护：超长串直接返回 0 交由调用方走其他判据。
 * @param {string} a
 * @param {string} b
 * @param {number} [budget]
 * @returns {number} 0..1
 */
export function levenshteinSimilarity(a, b, budget = 10_000) {
  if (a === b) return 1
  if (!a || !b) return 0
  if (a.length * b.length > budget) return 0
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = new Int32Array(b.length + 1)
    cur[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    prev = cur
  }
  const dist = prev[b.length]
  return 1 - dist / Math.max(a.length, b.length)
}

/**
 * 综合文本相似度：短文本（<=12 字符）以 Levenshtein 为主，
 * 长文本以 bigram Dice 为主；两者取大，避免短词被过度惩罚。
 * @param {string} a
 * @param {string} b
 */
export function textSimilarity(a, b) {
  if (a === b) return 1
  const d = diceSimilarity(a, b)
  if (Math.max(a.length, b.length) <= 12) {
    return Math.max(d, levenshteinSimilarity(a, b))
  }
  return d
}
