// 轻量 Markdown AST 解析器（面向语义差异）。
// 节点类型：heading | code | table | paragraph | list
// 每个节点携带：id、fingerprint、源行号区间、heading 路径锚点。
// 不追求完整 CommonMark，只覆盖产品文档平台的语义节点。

import { hash32, normalizeProse, stripInlineMarkdown } from '../semantic/text.js'

/**
 * @typedef {Object} MdNode
 * @property {string} type
 * @property {number} startLine 1-based
 * @property {number} endLine
 * @property {string} fingerprint 语义指纹
 * @property {string=} lang            code
 * @property {string=} text            code/paragraph/heading
 * @property {number=} level           heading
 * @property {string=} slug            heading
 * @property {string[]=} header        table
 * @property {string[][]=} rows        table
 * @property {number[]=} aligns        table (0:left 1:center 2:right)
 * @property {{text:string,term:boolean}[][]=} items list
 * @property {{text:string,term:boolean}[]=} para  paragraph/list-item 统一词项
 * @property {string} path            所在标题路径（用于定位）
 */

const FENCE_RE = /^(\s*)(`{3,}|~{3,})([^\s`~]*)\s*(.*)$/
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*\S)\s*$/

/** slug 与 VitePress/GitHub 风格接近：小写、去标点、空格转 - */
export function slugify(s) {
  return stripInlineMarkdown(s)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-')
}

/**
 * 解析 Markdown 文本为节点数组。
 * @param {string} source
 * @returns {{nodes: MdNode[], lineCount: number}}
 */
export function parseMarkdown(source) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  /** @type {MdNode[]} */
  const nodes = []
  /** @type {(string|undefined)[]} */
  const headingStack = []
  const currentPath = () => headingStack.filter(Boolean).join(' / ')

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // 围栏代码块
    const fence = line.match(FENCE_RE)
    if (fence) {
      const marker = fence[2]
      const ch = marker[0]
      const lang = fence[3]
      const start = i + 1
      i++
      const body = []
      while (i < lines.length && !new RegExp('^\\s*' + ch + '{' + marker.length + ',}\\s*$').test(lines[i])) {
        body.push(lines[i])
        i++
      }
      const end = i + 1 // 结束围栏行（若存在）
      i++ // 跳过结束围栏（或越过 EOF）
      const text = body.join('\n')
      nodes.push({
        type: 'code',
        startLine: start,
        endLine: Math.min(end, lines.length),
        lang: lang || '',
        text,
        path: currentPath(),
        fingerprint: hash32('code\x01' + (lang || '') + '\x01' + text)
      })
      continue
    }

    // ATX 标题
    const h = line.match(HEADING_RE)
    if (h) {
      const level = h[1].length
      const text = h[2].trim()
      headingStack[level - 1] = slugify(text)
      for (let k = level; k < headingStack.length; k++) headingStack[k] = undefined
      nodes.push({
        type: 'heading',
        startLine: i + 1,
        endLine: i + 1,
        level,
        text,
        slug: slugify(text),
        path: currentPath(),
        fingerprint: hash32('heading\x01' + level + '\x01' + normalizeProse(stripInlineMarkdown(text)))
      })
      i++
      continue
    }

    // GFM 表格：表头行 | 分隔行 | 若干数据行
    if (isTableRow(line) && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
      const start = i + 1
      const header = splitRow(line)
      const aligns = splitRow(lines[i + 1]).map((c) => {
        const t = c.trim()
        if (t.startsWith(':') && t.endsWith(':')) return 1
        if (t.endsWith(':')) return 2
        return 0
      })
      i += 2
      const rows = []
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(splitRow(lines[i]))
        i++
      }
      nodes.push({
        type: 'table',
        startLine: start,
        endLine: i,
        header,
        aligns,
        rows,
        path: currentPath(),
        fingerprint: tableFingerprint(header, rows)
      })
      continue
    }

    // 列表（连续的列表行；支持缩进续行视为同一项）
    if (LIST_RE.test(line)) {
      const start = i + 1
      /** @type {{text:string,term:boolean}[][]} */
      const items = []
      while (i < lines.length) {
        const m = lines[i].match(LIST_RE)
        if (!m) {
          // 缩进续行（含空行后的续行）归入上一项
          const nextNonBlank = /^\s*$/.test(lines[i]) ? lines[i + 1] : lines[i]
          if (items.length && nextNonBlank && /^\s+\S/.test(nextNonBlank) && nextNonBlank.trim()) {
            items[items.length - 1].push(...terms(nextNonBlank.trim()))
            i++
            continue
          }
          break
        }
        items.push(terms(m[3]))
        i++
      }
      nodes.push({
        type: 'list',
        startLine: start,
        endLine: i,
        items,
        para: items.flat(),
        path: currentPath(),
        fingerprint: hash32('list\x01' + items.map((it) => normalizeProse(it.map((t) => t.text).join(' '))).join('\x02'))
      })
      continue
    }

    // 空行
    if (/^\s*$/.test(line)) {
      i++
      continue
    }

    // 段落（吸收到空行/下一结构开始）
    const start = i + 1
    const buf = [line]
    i++
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !HEADING_RE.test(lines[i]) && !FENCE_RE.test(lines[i]) && !LIST_RE.test(lines[i])) {
      if (isTableRow(lines[i]) && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) break
      buf.push(lines[i])
      i++
    }
    const text = buf.join(' ')
    nodes.push({
      type: 'paragraph',
      startLine: start,
      endLine: i,
      text,
      para: terms(text),
      path: currentPath(),
      fingerprint: hash32('para\x01' + normalizeProse(stripInlineMarkdown(text)))
    })
  }

  return { nodes, lineCount: lines.length }
}

function isTableRow(l) {
  const t = l.trim()
  return t.includes('|') && /^\|?.*\|.*$/.test(t) && /[^\s|]/.test(t.replace(/\|/g, ' '))
}

function isTableDelimiter(l) {
  const t = l.trim()
  if (!t.includes('-') || !t.includes('|')) return false
  return splitRow(l).every((c) => /^\s*:?-{1,}:?\s*$/.test(c))
}

function splitRow(l) {
  let t = l.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1)
  return t.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim())
}

/** 行内“词项”：代码片段标记 term=true（技术词），其余普通文本 */
function terms(text) {
  /** @type {{text:string,term:boolean}[]} */
  const out = []
  const re = /`([^`]+)`/g
  let last = 0
  let m
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), term: false })
    out.push({ text: m[1], term: true })
    last = re.lastIndex
  }
  if (last < text.length) out.push({ text: text.slice(last), term: false })
  return out
}

function tableFingerprint(header, rows) {
  // 参数表身份不依赖行顺序（支持重排识别）：对“行内容多重集”做无序哈希
  const parts = [
    'table',
    'h:' + header.map((c) => normalizeProse(stripInlineMarkdown(c))).join('|')
  ]
  const rowHashes = rows.map((r) => hash32(r.map((c) => normalizeProse(stripInlineMarkdown(c))).join('|'))).sort()
  parts.push('r:' + rowHashes.join(','))
  return hash32(parts.join('\x01'))
}

export { terms as inlineTerms, normalizeProse as _normProse }
