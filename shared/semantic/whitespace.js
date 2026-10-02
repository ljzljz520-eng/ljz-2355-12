// 语言敏感的空白策略。
// 核心原则：代码块中的空白可能承载语义，不能对所有语言统一忽略。
// - insensitive: 空白无语义（如 JSON/JS 风格的美化），按语言感知的词法 token 序列比较
// - exact:       空白高度敏感（Python/YAML/Makefile 等），逐字符比较
// 代码节点携带该策略，前端“折叠纯格式变化”只折叠 insensitive 的纯空白差异。

/** @typedef {'insensitive'|'exact'} WhitespacePolicy */

const ALIASES = {
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  yml: 'yaml'
}

/** @param {string} lang @returns {string} 规范语言名 */
export function canonicalLang(lang) {
  const l = (lang || '').trim().toLowerCase()
  return ALIASES[l] || l
}

// 白名单式：只有明确列出的“空白无语义”语言才折叠，未知语言默认精确（保守）
const INSENSITIVE_LANGS = new Set([
  'json', 'json5', 'javascript', 'typescript', 'jsx', 'tsx',
  'java', 'c', 'cpp', 'csharp', 'go', 'rust', 'php', 'ruby',
  'css', 'scss', 'less', 'html', 'xml', 'vue', 'sql', 'markdown'
])

/**
 * @param {string} lang
 * @returns {WhitespacePolicy}
 */
export function policyOf(lang) {
  return INSENSITIVE_LANGS.has(canonicalLang(lang)) ? 'insensitive' : 'exact'
}

// 行/块注释剥离（仅用于 token 比较）
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

// 词法切分：标识符/数字/字符串 各为一个 token，其他非空白字符独立成 token。
// 这样“是否仅空白差异”与标点旁空格、换行、缩进无关，但对字符串内部空白敏感。
const LEX_RE = /(\s+)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b[\w$]+\b|[^\s\w$])/g

/**
 * @param {string} code
 * @param {string} lang
 */
export function lexTokens(code, lang) {
  const stripped = ['javascript', 'typescript', 'jsx', 'tsx', 'java', 'c', 'cpp', 'csharp', 'go', 'rust', 'php', 'css', 'scss', 'less', 'vue', 'sql'].includes(canonicalLang(lang))
    ? stripComments(code)
    : code
  /** @type {string[]} */
  const tokens = []
  for (const m of stripped.matchAll(LEX_RE)) {
    if (m[1] !== undefined) continue // 空白
    tokens.push(m[2])
  }
  return tokens
}

/**
 * 按策略规范化代码：
 * - insensitive：语言感知词法 token 序列（缩进/换行/标点旁空白均不参与
 *   “是否存在实质差异”的判定；原文仍保留用于行级展示）
 * - exact：统一换行符为 \n（换行风格不属于语义），其余逐字符保留
 * @param {string} code
 * @param {string} lang
 */
export function normalizeCode(code, lang) {
  const unix = (code ?? '').replace(/\r\n?/g, '\n')
  if (policyOf(lang) === 'insensitive') return lexTokens(unix, lang).join(' ')
  return unix.replace(/\s+$/, '')
}

/**
 * 判定两份代码的差异类别。
 * @returns {{identical:boolean, formatOnly:boolean, semantic:boolean, policy:WhitespacePolicy, lang:string}}
 */
export function classifyCode(oldCode, newCode, lang) {
  const policy = policyOf(lang)
  const o = oldCode ?? ''
  const n = newCode ?? ''
  const identical = o.replace(/\r\n?/g, '\n') === n.replace(/\r\n?/g, '\n')
  if (identical) return { identical: true, formatOnly: false, semantic: false, policy, lang: canonicalLang(lang) }
  if (policy === 'insensitive' && normalizeCode(o, lang) === normalizeCode(n, lang)) {
    return { identical: false, formatOnly: true, semantic: false, policy, lang: canonicalLang(lang) }
  }
  return { identical: false, formatOnly: false, semantic: true, policy, lang: canonicalLang(lang) }
}
