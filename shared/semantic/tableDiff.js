// 参数表语义比较：
// - 识别“参数名 / 默认值 / 描述 / 类型 / 必填”列角色
// - 行按参数名（第一列）对齐，支持行重排（不依赖物理顺序）
// - 单元格分级：默认值变更 = major，描述润色 = minor，参数增删 = major，列重排单独标注
// - 纯格式（对齐列的空白/对齐标记）不产生语义差异

import { hash32, inlineDiff, normalizeProse, stripInlineMarkdown, diceSimilarity, textSimilarity } from './text.js'

/**
 * @typedef {Object} CellChange
 * @property {number} col
 * @property {string} role
 * @property {'major'|'minor'} severity
 * @property {'default-change'|'description-polish'|'type-change'|'required-change'|'name-change'|'cell-change'} kind
 * @property {string} oldText
 * @property {string} newText
 * @property {{kind:string,text:string}[]} inline
 */

/**
 * @typedef {Object} RowChange
 * @property {'added'|'removed'|'changed'} kind
 * @property {number} oldRow  1-based 数据行号（相对表体，-1 表示无）
 * @property {number} newRow
 * @property {string} key     参数名
 * @property {CellChange[]} cells
 */

/**
 * @typedef {Object} TableDiff
 * @property {boolean} semantic       是否存在语义变化
 * @property {boolean} formatOnly     仅格式（对齐方式/列宽空白/列顺序物理排列）
 * @property {boolean} reorderedRows  行被重排（内容一致、顺序变化）
 * @property {boolean} reorderedColumns
 * @property {'major'|'minor'|null} severity
 * @property {RowChange[]} rowChanges
 * @property {{role:string,from:number,to:number}[]} movedColumns
 */

const ROLE_HINTS = [
  { role: 'name', re: /^(参数|名称|名字|字段|属性|name|key|param(eter)?s?|attribute|prop)$/i },
  { role: 'default', re: /^(默认值?|缺省值?|default(\s*value)?|initial)$/i },
  { role: 'description', re: /^(描述|说明|备注|description|desc|remark|comment)$/i },
  { role: 'type', re: /^(类型|type)$/i },
  { role: 'required', re: /^(必填|必须|required|mandatory)$/i }
]

/** @param {string[]} header */
export function columnRoles(header) {
  return header.map((h) => {
    const t = stripInlineMarkdown(h).trim().toLowerCase()
    for (const hint of ROLE_HINTS) {
      if (hint.re.test(t)) return hint.role
    }
    return 'other'
  })
}

const plain = (s) => normalizeProse(stripInlineMarkdown(s ?? ''))

/**
 * @param {any} oldTable
 * @param {any} newTable
 * @returns {TableDiff}
 */
export function diffTable(oldTable, newTable) {
  const oldRoles = columnRoles(oldTable.header)
  const newRoles = columnRoles(newTable.header)

  // 列重排：列数相同、列集合（按角色/表头文本）一致、物理顺序不同
  /** @type {{role:string,from:number,to:number}[]} */
  const movedColumns = []
  let reorderedColumns = false
  if (oldTable.header.length === newTable.header.length) {
    const sig = (h, role) => role !== 'other' ? `role:${role}` : `h:${plain(h)}`
    const newSigs = newTable.header.map((h, k) => sig(h, newRoles[k]))
    oldTable.header.forEach((h, k) => {
      const s = sig(h, oldRoles[k])
      const to = newSigs.indexOf(s)
      if (to !== -1 && to !== k) {
        movedColumns.push({ role: oldRoles[k], from: k, to })
        reorderedColumns = true
      }
    })
  }

  // 列映射（旧列 -> 新列）：按角色优先，其次按表头文本，再按下标
  const colMap = oldTable.header.map((h, k) => {
    const role = oldRoles[k]
    if (role !== 'other') {
      const to = newRoles.indexOf(role)
      if (to !== -1) return to
    }
    const tp = plain(h)
    const toText = newTable.header.findIndex((nh) => plain(nh) === tp)
    return toText !== -1 ? toText : (newTable.header[k] ? k : -1)
  })

  // 行键：名称列；否则第一列；否则行内容哈希
  const nameColOld = oldRoles.indexOf('name')
  const nameColNew = newRoles.indexOf('name')
  const ko = nameColOld !== -1 ? nameColOld : 0
  const kn = nameColNew !== -1 ? nameColNew : 0
  const keyOf = (row, nameCol) => {
    if (row[nameCol] && plain(row[nameCol])) return plain(row[nameCol])
    return '#' + hash32(row.map(plain).join('|'))
  }

  const oldMap = new Map()
  oldTable.rows.forEach((r, idx) => oldMap.set(keyOf(r, ko), { row: r, idx }))
  const newMap = new Map()
  newTable.rows.forEach((r, idx) => newMap.set(keyOf(r, kn), { row: r, idx }))

  /** @type {RowChange[]} */
  const rowChanges = []
  let hasMajor = false
  let hasMinor = false
  let reorderedRows = false

  for (const [key, { row: nr, idx: ni }] of newMap) {
    const hit = oldMap.get(key)
    if (!hit) {
      hasMajor = true
      rowChanges.push({ kind: 'added', oldRow: -1, newRow: ni + 1, key, cells: [] })
      continue
    }
    const or = hit.row
    if (hit.idx !== ni) reorderedRows = true
    /** @type {CellChange[]} */
    const cells = []
    for (let oc = 0; oc < oldTable.header.length; oc++) {
      const nc = colMap[oc]
      if (nc === -1 || nc >= newTable.header.length) continue
      const ov = or[oc] ?? ''
      const nv = nr[nc] ?? ''
      if (plain(ov) === plain(nv)) continue
      const role = newRoles[nc] !== 'other' ? newRoles[nc] : oldRoles[oc]
      const sim = textSimilarity(plain(ov), plain(nv))
      let severity = 'major'
      let kind = 'cell-change'
      if (role === 'default') {
        severity = 'major'
        kind = 'default-change'
      } else if (role === 'description') {
        // 描述润色：高相似度、无语义值改变 -> minor
        severity = sim >= 0.55 ? 'minor' : 'major'
        kind = 'description-polish'
      } else if (role === 'type') {
        severity = 'major'
        kind = 'type-change'
      } else if (role === 'required') {
        severity = 'major'
        kind = 'required-change'
      } else if (role === 'name') {
        severity = 'major'
        kind = 'name-change'
      } else {
        severity = sim >= 0.75 ? 'minor' : 'major'
      }
      if (severity === 'major') hasMajor = true
      else hasMinor = true
      cells.push({ col: nc, role, severity, kind, oldText: ov, newText: nv, inline: inlineDiff(ov, nv) })
    }
    if (cells.length) {
      rowChanges.push({ kind: 'changed', oldRow: hit.idx + 1, newRow: ni + 1, key, cells })
    }
  }
  for (const [key, { idx: oi }] of oldMap) {
    if (!newMap.has(key)) {
      hasMajor = true
      rowChanges.push({ kind: 'removed', oldRow: oi + 1, newRow: -1, key, cells: [] })
    }
  }

  const semantic = hasMajor || hasMinor
  // 列重排（同集合不同顺序）本身视为格式：阅读顺序变化在 UI 标注
  const formatOnly = !semantic && (reorderedColumns || alignmentOnly(oldTable, newTable, colMap))

  return {
    semantic,
    formatOnly: formatOnly && !semantic,
    reorderedRows,
    reorderedColumns,
    severity: hasMajor ? 'major' : hasMinor ? 'minor' : null,
    rowChanges,
    movedColumns
  }
}

/** 表格除顺序/空白外完全一致 */
function alignmentOnly(oldTable, newTable, colMap) {
  if (oldTable.rows.length !== newTable.rows.length) return false
  const normRows = (t, nameCol) =>
    [...t.rows]
      .map((r, i) => [keyOfLocal(r, nameCol), r.map(plain).join('|')])
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
  const roles = columnRoles(oldTable.header)
  const nc = roles.indexOf('name') !== -1 ? roles.indexOf('name') : 0
  const a = normRows(oldTable, nc)
  const b = normRows(newTable, nc)
  return JSON.stringify(a) === JSON.stringify(b)
}
function keyOfLocal(row, nameCol) {
  return row[nameCol] && plain(row[nameCol]) ? plain(row[nameCol]) : '#' + hash32(row.map(plain).join('|'))
}
