// 大章节分块：以标题层级将文档切分为 chunk，用于受限局部匹配与并行处理。
// chunk 自身也有身份（标题路径），章节标题被改名时通过相似度配对。

import { hash32 } from './text.js'

/**
 * @typedef {Object} Chunk
 * @property {string} id              稳定 chunk 身份
 * @property {string} path            标题路径
 * @property {number} level
 * @property {string=} headingText
 * @property {number} headingIndex    标题节点在 nodes 中的下标（序言块为 -1）
 * @property {number[]} nodeIndexes   chunk 内节点在全量 nodes 中的下标
 */

/**
 * @param {import('../markdown/parser.js').MdNode[]} nodes
 * @param {{chapterLevel?:number}} [opts]
 * @returns {Chunk[]}
 */
export function chunkDocument(nodes, opts = {}) {
  const levels = nodes.filter((n) => n.type === 'heading').map((n) => n.level)
  // 默认章节层级：选择“同级标题至少出现 2 次”的最深层级，
  // 使单根 H1 + 多个 H2 的文档正确切成多个章节块。
  let chapterLevel
  if (opts.chapterLevel != null) {
    chapterLevel = opts.chapterLevel
  } else if (!levels.length) {
    chapterLevel = 1
  } else {
    const countByLevel = new Map()
    for (const l of levels) countByLevel.set(l, (countByLevel.get(l) || 0) + 1)
    chapterLevel = Math.min(...levels)
    for (const l of [...countByLevel.keys()].sort((a, b) => a - b)) {
      if (countByLevel.get(l) >= 2) {
        chapterLevel = l
        break
      }
    }
  }

  /** @type {Chunk[]} */
  const chunks = []
  /** @type {Chunk} */
  let cur = {
    id: 'chunk@preamble',
    path: '',
    level: 0,
    headingText: undefined,
    headingIndex: -1,
    nodeIndexes: []
  }
  chunks.push(cur)
  const pathStack = []

  nodes.forEach((n, idx) => {
    if (n.type === 'heading') {
      pathStack[n.level - 1] = n.slug
      for (let k = n.level; k < pathStack.length; k++) pathStack[k] = undefined
      if (n.level <= chapterLevel) {
        const path = pathStack.filter(Boolean).join('/')
        cur = {
          id: `chunk@${path || hash32('h' + n.text)}`,
          path,
          level: n.level,
          headingText: n.text,
          headingIndex: idx,
          nodeIndexes: [idx]
        }
        chunks.push(cur)
        return
      }
    }
    cur.nodeIndexes.push(idx)
  })

  return chunks
}
