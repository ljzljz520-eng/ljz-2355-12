// 文档解析器：把 Markdown 解析为带稳定身份的块节点
// 节点种类：heading（标题）/ table（参数表）/ code（代码块）/ paragraph / list / other
//
// 稳定身份来源（优先级从高到低）：
//   1. 显式锚点：标题或块后的 {#stable-id}
//   2. 标题层级路径 slug（章节路径）
//   3. 参数表行：参数名（首列），列：表头名
//   4. 代码块：所属章节 + 语言 + 可选标题 + 章内序号
//   5. 段落：内容指纹（shingles），匹配阶段再消歧（重复片段/复制）

import crypto from 'crypto'

export function fingerprint(text) {
  return crypto.createHash('sha1').update(text).update('\n').digest('hex')
}

const SLUG_STRIP = /[!?。，、；：""''（）()【】\[\]{}.,;:!?'"`~@#$%^&*+=|\\/<>]/g

export function slugify(text) {
  return String(text)
    .trim()
    .toLowerCase()
    .replace(SLUG_STRIP, '')
    .replace(/\s+/g, '-')
}

// 词级 shingles：中文按字、拉丁按词混合切分，兼顾中英文档
export function shingles(text, k = 3) {
  const norm = String(text).replace(/\s+/g, ' ').trim()
  const toks = []
  const re = /[A-Za-z0-9_]+|[一-鿿]/g
  let m
  while ((m = re.exec(norm))) toks.push(m[0])
  if (toks.length < k) return new Set(toks.length ? [toks.join('')] : [])
  const out = new Set()
  for (let i = 0; i + k <= toks.length; i++) out.add(toks.slice(i, i + k).join('|'))
  return out
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

function parseTableRow(line) {
  let s = line.trim()
  const m = s.match(/^\|?(.*?)\|?$/)
  s = m[1]
  // 不处理转义边界的极端情况，满足常规参数表
  const cells = s.split('|').map((c) => c.trim().replace(/^\\\|/, '|'))
  return cells
}

function isDivider(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c.replace(/\s/g, '')))
}

// 参数表启发式：表头中出现这些列名时认定为 API 参数表
const PARAM_HEADERS_ZH = ['参数', '属性', '名称', '名字']
const DEFAULT_HEADERS = ['默认值', '默认', 'default', 'defaults']
const DESC_HEADERS = ['说明', '描述', 'description', 'desc', '说明 ']
const TYPE_HEADERS = ['类型', 'type']

function classifyColumns(headers) {
  const map = { key: -1, defaultValue: [], description: [], type: [] }
  headers.forEach((h, i) => {
    const lk = h.toLowerCase().trim()
    if (map.key === -1 && (PARAM_HEADERS_ZH.includes(h) || lk === 'name' || lk === 'param' || lk === 'parameter' || lk === 'prop' || lk.endsWith('参数'))) {
      map.key = i
    }
    if (DEFAULT_HEADERS.includes(h) || lk === 'default value') map.defaultValue.push(i)
    if (DESC_HEADERS.includes(h) || lk.startsWith('desc')) map.description.push(i)
    if (TYPE_HEADERS.includes(h) || lk === 'type') map.type.push(i)
  })
  if (map.key === -1) map.key = 0
  return map
}

/**
 * 解析整篇文档。
 * @returns {{blocks: Array, chunks: Array<{id,title,level,start,end,blocks}>}}
 */
export function parseDocument(content, opts = {}) {
  const docId = opts.docId || 'doc'
  const lines = String(content).replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let i = 0
  let order = 0
  const sectionStack = [] // {level, title, slug, id}
  let codeOrdinal = 0
  let tableOrdinal = 0
  const contentOrdinal = new Map()

  const sectionPath = () => sectionStack.map((s) => s.slug)
  const sectionId = () => (sectionStack.length ? sectionStack.map((s) => s.id).join('::') : '_root')

  function push(b) {
    b.order = order++
    b.startLine = b.startLine ?? 0
    blocks.push(b)
    return b
  }

  while (i < lines.length) {
    const line = lines[i]

    // VitePress/Markdown 自定义容器：::: name ... :::
    // 与本项目的 ::: demo 容器对齐；demo 容器内容是示例路径，按容器块解析
    const cont = line.match(/^(\s*)(:{3,})\s*([A-Za-z][\w-]*)\s*(.*)$/)
    if (cont) {
      const startLine = i
      const markerLen = cont[2].length
      const containerType = cont[3].toLowerCase()
      const info = cont[4] || ''
      const body = []
      i++
      while (i < lines.length) {
        if (new RegExp('^\\s*:{' + markerLen + ',}\\s*$').test(lines[i])) break
        body.push(lines[i])
        i++
      }
      const endLine = i
      i++
      const text = body.join('\n')
      const b = push({
        kind: 'container',
        docId,
        id: undefined,
        containerType,
        info,
        text,
        startLine,
        endLine,
        section: sectionPath(),
        sectionId: sectionId(),
      })
      b.fingerprint = fingerprint('container:' + containerType + ':' + text)
      b.shingles = shingles(info + ' ' + text)
      b.contentKey = b.kind + ':' + b.fingerprint
      const ck = 'container:' + b.fingerprint
      const ord = contentOrdinal.get(ck) || 0
      contentOrdinal.set(ck, ord + 1)
      b.id = `container:${b.fingerprint.slice(0, 10)}${ord ? '#' + ord : ''}`
      b.contentOrdinal = ord
      continue
    }

    // 围栏代码块
    const fence = line.match(/^(\s*)(`{3,}|~{3,})\s*([^\s`~]*)\s*(.*)$/)
    if (fence) {
      const startLine = i
      const marker = fence[2][0]
      const len = fence[2].length
      const lang = fence[3] || ''
      const info = fence[4] || ''
      const body = []
      i++
      while (i < lines.length) {
        const close = lines[i].match(/^\s*(`{3,}|~{3,})/)
        if (close && close[1][0] === marker && close[1].length >= len) break
        body.push(lines[i])
        i++
      }
      const endLine = i // 围栏结束行（若文件结束则为末行）
      i++
      codeOrdinal++
      const secSlug = sectionStack.length ? sectionStack[sectionStack.length - 1].slug : '_root'
      const titleMatch = info.match(/\[([^\]]+)\]/)
      const codeTitle = titleMatch ? titleMatch[1] : info.trim()
      const explicitId = (info.match(/\{#([A-Za-z0-9_-]+)\}/) || [])[1]
      const b = push({
        kind: 'code',
        docId,
        id: explicitId || `code:${secSlug}:${slugify(lang || 'text')}:${codeTitle ? slugify(codeTitle) + ':' : ''}${codeOrdinal}`,
        explicit: !!explicitId,
        lang: lang.toLowerCase(),
        codeTitle,
        text: body.join('\n'),
        startLine,
        endLine,
        section: sectionPath(),
        sectionId: sectionId(),
      })
      b.fingerprint = fingerprint(b.kind + ':' + b.lang + ':' + b.text)
      b.shingles = shingles(b.text)
      continue
    }

    // 标题（含可选 {#id}）
    const head = line.match(/^(#{1,6})\s+(.*?)\s*$/)
    if (head) {
      const level = head[1].length
      let title = head[2].trim()
      let explicitId
      const anc = title.match(/\{#([A-Za-z0-9_-][A-Za-z0-9_.-]*)\}\s*$/)
      if (anc) {
        explicitId = anc[1]
        title = title.slice(0, anc.index).trim()
      }
      while (sectionStack.length && sectionStack[sectionStack.length - 1].level >= level) sectionStack.pop()
      const slug = slugify(title)
      // 同路径重名标题追加序号
      const parentPath = sectionStack.map((s) => s.slug)
      let unique = slug
      let n = 2
      const existingSiblings = new Set(sectionStack.length ? sectionStack[sectionStack.length - 1].children || (sectionStack[sectionStack.length - 1].children = []) : rootTitles(blocks))
      while (existingSiblings.has(unique)) unique = `${slug}-${n++}`
      existingSiblings.add(unique)
      const id = explicitId || `h:${[...parentPath, unique].join('::')}`
      const sec = { level, title, slug: unique, id }
      sectionStack.push(sec)
      const b = push({
        kind: 'heading',
        docId,
        id,
        explicit: !!explicitId,
        level,
        text: title,
        startLine: i,
        endLine: i,
        section: sectionPath(),
        sectionId: sectionId(),
      })
      b.fingerprint = fingerprint('heading:' + b.text)
      b.shingles = shingles(b.text)
      i++
      continue
    }

    // GFM 表格
    if (i + 1 < lines.length && /\|/.test(line) && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && parseTableRow(lines[i + 1]).length >= 2 && isDivider(parseTableRow(lines[i + 1]))) {
      const startLine = i
      const headers = parseTableRow(line)
      i += 2
      const rawRows = []
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim() !== '') {
        const cells = parseTableRow(lines[i])
        rawRows.push({ cells, line: i })
        i++
      }
      const endLine = i - 1
      tableOrdinal++
      const colMap = classifyColumns(headers)
      const secSlug = sectionStack.length ? sectionStack[sectionStack.length - 1].slug : '_root'
      const precedingHeading = [...blocks].reverse().find((x) => x.kind === 'heading')
      const name = (precedingHeading ? slugify(precedingHeading.text) : secSlug)
      const rows = rawRows.map((r, idx) => {
        const key = (r.cells[colMap.key] ?? '').trim()
        return {
          id: `row:${name}:${key || idx}`,
          key,
          cells: r.cells,
          order: idx,
          line: r.line,
        }
      })
      const b = push({
        kind: 'table',
        docId,
        id: `table:${name}:${tableOrdinal}`,
        tableName: name,
        ordinal: tableOrdinal,
        headers,
        colMap,
        rows,
        startLine,
        endLine,
        section: sectionPath(),
        sectionId: sectionId(),
      })
      b.fingerprint = fingerprint('table:' + headers.join('|') + '//' + rows.map((r) => r.key + '=' + r.cells.join('|')).join('\n'))
      b.shingles = shingles(headers.join(' ') + ' ' + rows.map((r) => r.cells.join(' ')).join(' '))
      continue
    }

    // 列表项
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const startLine = i
      const items = []
      while (i < lines.length && (/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) || /^\s+\S/.test(lines[i]))) {
        items.push(lines[i])
        i++
      }
      const text = items.join('\n')
      const b = push({ kind: 'list', docId, text, startLine, endLine: i - 1, section: sectionPath(), sectionId: sectionId() })
      b.fingerprint = fingerprint('list:' + text)
      b.shingles = shingles(text)
      pushPlainIdentity(b)
      continue
    }

    // 空行
    if (line.trim() === '') {
      i++
      continue
    }

    // 普通段落（连续非空、非块起始行）
    const startLine = i
    const plines = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^(\s*)(`{3,}|~{3,})/.test(lines[i]) &&
      !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])
    ) {
      plines.push(lines[i])
      i++
    }
    if (!plines.length) {
      i++
      continue
    }
    const text = plines.join('\n')
    const b = push({ kind: 'paragraph', docId, text, startLine, endLine: i - 1, section: sectionPath(), sectionId: sectionId() })
    b.fingerprint = fingerprint('p:' + text)
    b.shingles = shingles(text)
    pushPlainIdentity(b)
  }

  // 分块：以"大章节"（默认 level<=2，可配）切分
  const chunkLevel = opts.chunkLevel ?? 2
  const chunks = []
  let cur = { id: 'chunk:_root', title: '', level: 0, headingBlock: null, start: 0, end: blocks.length, blocks: [] }
  for (const b of blocks) {
    if (b.kind === 'heading' && b.level <= chunkLevel) {
      if (cur.blocks.length || cur.headingBlock) chunks.push(cur)
      cur = { id: `chunk:${b.id}`, title: b.text, level: b.level, headingBlock: b, start: blocks.indexOf(b), end: 0, blocks: [] }
    }
    cur.blocks.push(b)
  }
  chunks.push(cur)
  chunks.forEach((c, idx) => {
    c.index = idx
    c.end = c.start + c.blocks.length
  })

  return { docId, blocks, chunks, lines }

  function pushPlainIdentity(b) {
    // 段落/列表的稳定身份只由内容指纹决定（不含章节路径）：
    // 这样跨章节移动仍能沿身份匹配；重复内容通过出现序号在文档内保持 id 唯一。
    const key = b.kind + ':' + b.fingerprint
    const n = contentOrdinal.get(key) || 0
    contentOrdinal.set(key, n + 1)
    b.id = `${b.kind}:${b.fingerprint.slice(0, 10)}${n ? '#' + n : ''}`
    b.contentKey = key
    b.contentOrdinal = n
  }
}

function rootTitles(blocks) {
  // module 级缓存不必要，简单去重即可
  return blocks.filter((b) => b.kind === 'heading' && b.level === 1).map((b) => b.slug)
}

/**
 * 生成跳回原版的定位信息。
 */
export function locate(block, versionId, extra = {}) {
  if (!block) return null
  return {
    versionId,
    blockId: block.id,
    startLine: block.startLine ?? 0,
    endLine: block.endLine ?? block.startLine ?? 0,
    anchor: block.kind === 'heading' ? block.id : block.sectionId ? `sec:${block.sectionId}` : undefined,
    section: block.section,
    ...extra,
  }
}
