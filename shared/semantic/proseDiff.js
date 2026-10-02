// 段落与标题的语义比较：
// - 实质变更 major：语义相似度低于阈值（句子被重写/信息增删）
// - 描述润色 minor：高相似度的措辞调整（保留 inline diff 高亮）
// - 纯格式 format-only：仅空白/换行变化（normalizeProse 后相同），前端默认折叠

import { diceSimilarity, inlineDiff, normalizeProse, stripInlineMarkdown, textSimilarity } from './text.js'

/**
 * @typedef {Object} ProseDiff
 * @property {'identical'|'format-only'|'minor'|'major'} kind
 * @property {number} similarity
 * @property {{kind:string,text:string}[]} inline
 */

/**
 * @param {string} oldText
 * @param {string} newText
 * @param {{polishThreshold?:number}} [opts]
 * @returns {ProseDiff}
 */
export function diffProse(oldText, newText, opts = {}) {
  const polishThreshold = opts.polishThreshold ?? 0.72
  if (oldText === newText) return { kind: 'identical', similarity: 1, inline: [] }
  const a = normalizeProse(stripInlineMarkdown(oldText))
  const b = normalizeProse(stripInlineMarkdown(newText))
  if (a === b) {
    return { kind: 'format-only', similarity: 1, inline: [] }
  }
  const sim = textSimilarity(a, b)
  if (sim >= polishThreshold) {
    return { kind: 'minor', similarity: sim, inline: inlineDiff(oldText, newText) }
  }
  return { kind: 'major', similarity: sim, inline: inlineDiff(oldText, newText) }
}
