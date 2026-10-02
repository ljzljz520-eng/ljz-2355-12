// 语言敏感的空白规范化。
// 核心原则：代码块中的空白可能携带语义（Python/Haskell/YAML/Makefile 等），
// 不能对所有语言统一忽略。每种语言给出独立的规范化等级与注释剥离规则。

// strict  : 空白完全敏感（缩进即语义），仅做行尾修剪的可选控制
// relaxed : 缩进变化无语义，但行内空白与空行仍保留
// free    : 类似 C 的语言，缩进/连续空白通常无语义
const POLICY = {
  python: { indent: 'strict', collapseInner: false, blankLines: 'count', lineComment: '#' },
  py: { alias: 'python' },
  make: { indent: 'strict', collapseInner: false, blankLines: 'count', lineComment: '#' },
  makefile: { alias: 'make' },
  yaml: { indent: 'strict', collapseInner: false, blankLines: 'count', lineComment: '#' },
  yml: { alias: 'yaml' },
  haskell: { indent: 'strict', layout: true, blankLines: 'ignore', lineComment: '--' },
  hs: { alias: 'haskell' },
  jade: { indent: 'strict', blankLines: 'ignore' },
  pug: { indent: 'strict', blankLines: 'ignore' },
  coffeescript: { indent: 'strict', blankLines: 'ignore', lineComment: '#' },
  coffee: { alias: 'coffeescript' },

  javascript: { indent: 'free', collapseInner: true, blankLines: 'ignore', lineComment: '//' },
  js: { alias: 'javascript' },
  jsx: { alias: 'javascript' },
  mjs: { alias: 'javascript' },
  cjs: { alias: 'javascript' },
  typescript: { indent: 'free', collapseInner: true, blankLines: 'ignore', lineComment: '//' },
  ts: { alias: 'typescript' },
  tsx: { alias: 'typescript' },
  vue: { indent: 'free', collapseInner: true, blankLines: 'ignore', lineComment: '<!--' },
  java: { indent: 'free', collapseInner: true, blankLines: 'ignore', lineComment: '//' },
  c: { indent: 'free', collapseInner: true, blankLines: 'ignore', lineComment: '//' },
  h: { alias: 'c' },
  cpp: { indent: 'free', collapseInner: true, blankLines: 'ignore', lineComment: '//' },
  csharp: { indent: 'free', collapseInner: true, blankLines: 'ignore', lineComment: '//' },
  cs: { alias: 'csharp' },
  go: { indent: 'free', collapseInner: true, blankLines: 'ignore', lineComment: '//' },
  rust: { indent: 'free', collapseInner: true, blankLines: 'ignore', lineComment: '//' },
  rs: { alias: 'rust' },
  kotlin: { indent: 'free', collapseInner: true, blankLines: 'ignore', lineComment: '//' },
  kt: { alias: 'kotlin' },
  swift: { indent: 'free', collapseInner: true, blankLines: 'ignore', lineComment: '//' },
  php: { indent: 'free', collapseInner: true, blankLines: 'ignore', lineComment: '//' },
  ruby: { indent: 'free', collapseInner: true, blankLines: 'ignore', lineComment: '#' },
  rb: { alias: 'ruby' },
  scala: { indent: 'free', collapseInner: true, blankLines: 'ignore', lineComment: '//' },
  shell: { indent: 'relaxed', collapseInner: false, blankLines: 'count', lineComment: '#' },
  bash: { alias: 'shell' },
  sh: { alias: 'shell' },
  sql: { indent: 'free', collapseInner: true, blankLines: 'ignore', lineComment: '--' },
  css: { indent: 'free', collapseInner: true, blankLines: 'ignore', lineComment: null },
  scss: { alias: 'css' },
  less: { alias: 'css' },
  html: { indent: 'free', collapseInner: true, blankLines: 'ignore', lineComment: '<!--' },
  xml: { indent: 'free', collapseInner: true, blankLines: 'ignore', lineComment: '<!--' },
  json: { indent: 'free', collapseInner: false, blankLines: 'ignore', lineComment: null },

  // 未知语言默认：不假设空白无语义，采用最保守的 strict 策略
  text: { indent: 'strict', collapseInner: false, blankLines: 'count', lineComment: null },
  plaintext: { alias: 'text' },
  unknown: { alias: 'text' },
}

export function resolvePolicy(langRaw) {
  const lang = String(langRaw || '').trim().toLowerCase()
  if (!lang) return { ...POLICY.text, resolved: 'unknown', known: false }
  const seen = new Set()
  let key = lang
  let p = POLICY[key]
  while (p && p.alias && !seen.has(key)) {
    seen.add(key)
    key = p.alias
    p = POLICY[key]
  }
  if (!p) return { ...POLICY.text, resolved: 'unknown', known: false, requested: lang }
  return { ...p, resolved: key, known: true, requested: lang }
}

function stripLineComment(line, token) {
  if (!token) return line
  if (token === '<!--') {
    // 仅处理整行被注释的常见形态，避免误删内联标记
    if (/^\s*<!--.*-->\s*$/.test(line)) return ''
    return line
  }
  const i = line.indexOf(token)
  if (i >= 0) return line.slice(0, i)
  return line
}

/**
 * 返回规范化后的行数组以及语义签名。
 * 规范化仅用于"比较"，原文始终保留用于展示与跳回定位。
 */
export function normalizeCode(code, langRaw, opts = {}) {
  const policy = resolvePolicy(langRaw)
  const ignoreComments = !!opts.ignoreComments
const rawLines = String(code).replace(/\r\n?/g, '\n').split('\n')
  let lines = rawLines.slice()

  // 去掉文件首尾纯空行带来的噪声（原文行号通过 idx 保留，供跳回定位）
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop()
  const afterTrailing = lines.length
  while (lines.length && lines[0].trim() === "") lines.shift()
  const leading = afterTrailing - lines.length

  let entries = lines.map((line, i) => ({ line, idx: i + leading }))

  if (ignoreComments && policy.lineComment) {
    entries = entries.map((en) => ({ ...en, line: stripLineComment(en.line, policy.lineComment) }))
  }

  entries = entries.map((en) => {
    const line = en.line
    let text
    if (policy.indent === "free") {
      text = line.trim()
      if (policy.collapseInner) text = text.replace(/[ 	]+/g, ' ')
    } else if (policy.indent === "relaxed") {
      text = line.trim()
    } else {
      // strict：保留行首空白（tab/空格不可互换），仅规整行尾
      text = line.replace(/[ 	]+$/g, '')
    }
    return { text, idx: en.idx }
  })

  let kept = entries
  if (policy.blankLines === 'ignore') {
    kept = entries.filter((en) => en.text.trim() !== "")
  }

  return {
    policy,
    entries: kept,
    lines: kept.map((en) => en.text),
    signature: kept.map((en) => en.text).join('\n'),
  }
}

/**
 * 逐行 LCS 比较代码，输出行级 op。
 * 输入为 normalizeCode 的结果（含原始行号映射），行号均指向未规范化的原文。
 */
export function diffLines(normA, normB) {
  const a = normA.lines
  const b = normB.lines
  const mapA = normA.entries.map((en) => en.idx)
  const mapB = normB.entries.map((en) => en.idx)
  const n = a.length
  const m = b.length
  // 复杂度预算：标准 LCS 为 O(n*m)，由调用方保证规模
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'equal', aLine: mapA[i], bLine: mapB[j], text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', aLine: mapA[i], text: a[i] })
      i++
    } else {
      ops.push({ type: 'ins', bLine: mapB[j], text: b[j] })
      j++
    }
  }
  while (i < n) ops.push({ type: 'del', aLine: mapA[i], text: a[i++] })
  while (j < m) ops.push({ type: 'ins', bLine: mapB[j], text: b[j++] })
  return ops
}

/**
 * 判断两个代码版本是否"仅空白差异"，结论是语言相关的。
 */
export function isWhitespaceOnly(codeA, codeB, lang) {
  const a = normalizeCode(codeA, lang)
  const b = normalizeCode(codeB, lang)
  return a.signature === b.signature
}
