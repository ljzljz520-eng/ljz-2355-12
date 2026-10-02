// 节点稳定身份：移动段落沿稳定身份匹配，复制段落另行认定。
//
// identity 设计（跨版本稳定）：
// - heading：slug（同级别标题重名时附加序号）
// - code：所在标题路径 + 语言 + 出现序号（同路径同语言内）
// - table：所在标题路径（一章通常一张参数表）
// - paragraph/list：所在标题路径 + 语义指纹；同指纹在同章重复出现时附出现序号
//
// “身份”只解决“同一对象”的 1:1 锚定；内容完全相同的重复片段由 diff 阶段
// 通过 fingerprint 另行认定为 copy，不会与 move 混淆。

import { slugify } from '../markdown/parser.js'
import { hash32, normalizeProse, stripInlineMarkdown } from './text.js'

/**
 * 为解析后的节点补充稳定 identity。
 * @param {import('../markdown/parser.js').MdNode[]} nodes
 * @returns {import('../markdown/parser.js').MdNode[]} 同一数组（原地补充）
 */
export function assignIdentities(nodes) {
  const headingCount = new Map()
  const codeSeen = new Map()
  const tableSeen = new Map()
  const paraSeen = new Map()

  for (const n of nodes) {
    if (n.type === 'heading') {
      const base = `h${n.level}:${slugify(n.text)}`
      const k = headingCount.get(base) || 0
      headingCount.set(base, k + 1)
      n.identity = k === 0 ? base : `${base}#${k + 1}`
    } else if (n.type === 'code') {
      const base = `code@${n.path || '∅'}:${(n.lang || 'none')}`
      const k = codeSeen.get(base) || 0
      codeSeen.set(base, k + 1)
      n.identity = `${base}#${k + 1}`
    } else if (n.type === 'table') {
      const base = `table@${n.path || '∅'}`
      const k = tableSeen.get(base) || 0
      tableSeen.set(base, k + 1)
      n.identity = `${base}#${k + 1}`
    } else {
      const plain = normalizeProse(stripInlineMarkdown(n.text || ''))
      const base = `${n.type}@${n.path || '∅'}:${hash32(plain)}`
      const k = paraSeen.get(base) || 0
      paraSeen.set(base, k + 1)
      n.identity = `${base}#${k + 1}`
    }
  }
  return nodes
}
