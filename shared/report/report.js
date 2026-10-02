// 差异报告渲染：Markdown 文本 + 位置锚点。
// 硬性要求：报告中每处差异均可跳回两个原版位置（旧版 / 新版）。
// 分享 URL 只引用有访问权的发布版（权限校验在服务层完成，本模块只负责拼接）。

const KIND_LABELS = {
  identical: '无内容变化',
  'format-only': '纯格式变化',
  minor: '描述润色',
  major: '实质变更',
  removed: '删除',
  added: '新增',
  changed: '内容变更',
  reordered: '顺序重排',
  semantic: '代码语义变化',
  copy: '复制段落'
}

const STRUCT_LABELS = {
  modified: '修改',
  moved: '移动',
  copied: '复制',
  added: '新增',
  deleted: '删除'
}

const SEVERITY_LABELS = {
  major: '🔴 重要',
  minor: '🟡 润色',
  none: '⚪ 无内容差异'
}

/**
 * 原版位置链接：指向发布版文档的行号锚点（#L<n>），标题节点同时带 slug。
 * @param {{versionId:string, url?:string}} version
 * @param {{startLine:number,endLine:number,path:string,slug?:string}|null} loc
 */
export function anchorURL(version, loc) {
  if (!loc || !version) return null
  const base = version.url ?? `/p/${encodeURIComponent(version.versionId)}/doc`
  const slug = loc.slug ? `#${encodeURIComponent(loc.slug)}` : ''
  const line = `L${loc.startLine}`
  return slug ? `${base}${slug}~${line}` : `${base}#${line}`
}

const locText = (loc) => {
  if (!loc) return '—'
  const where = loc.path ? `${loc.path} ` : ''
  return `${where}第 ${loc.startLine}${loc.endLine > loc.startLine ? `-${loc.endLine}` : ''} 行`
}

/**
 * @param {object} params
 * @param {object} params.result          compareDocuments 的结果
 * @param {{versionId:string, url?:string, title?:string}} params.oldVersion
 * @param {{versionId:string, url?:string, title?:string}} params.newVersion
 * @param {boolean} [params.includeFormatOnly]  报告是否包含纯格式条目
 * @param {Date}   [params.generatedAt]
 */
export function renderMarkdownReport({ result, oldVersion, newVersion, includeFormatOnly = true, generatedAt = new Date() }) {
  const lines = []
  lines.push('# 语义差异报告')
  lines.push('')
  lines.push(`- 基线（旧版）：**${oldVersion.title || oldVersion.versionId}**`)
  lines.push(`- 目标（新版）：**${newVersion.title || newVersion.versionId}**`)
  lines.push(`- 差异规则版本：\`${result.ruleVersion}\``)
  lines.push(`- 生成时间：${generatedAt.toISOString()}`)
  lines.push(`- 统计：🔴 重要 ${result.stats.major} ｜ 🟡 润色 ${result.stats.minor} ｜ ⚪ 纯格式 ${result.stats.formatOnly} ｜ 移动 ${result.stats.moved} ｜ 复制 ${result.stats.copied} ｜ 新增 ${result.stats.added} ｜ 删除 ${result.stats.deleted}`)
  if (result.stats.degraded) {
    lines.push(`- ⚠️ **退化提示**：本次比较超出复杂度预算，部分匹配使用快速算法，结果可能不精确。`)
  }
  if (result.warnings.length) {
    lines.push('')
    lines.push('> ⚠️ 提示：')
    for (const w of result.warnings) lines.push(`> - ${w}`)
  }
  lines.push('')
  lines.push('---')
  lines.push('')

  const entries = includeFormatOnly ? result.entries : result.entries.filter((e) => !e.formatOnly)
  if (!entries.length) {
    lines.push('_两版没有可显示的差异。_')
    return lines.join('\n')
  }

  entries.forEach((e, i) => {
    const title = entryTitle(e)
    const sev = SEVERITY_LABELS[e.severity] ?? ''
    lines.push(`## ${i + 1}. [${STRUCT_LABELS[e.structural] || e.structural}] ${title} ${sev}`)
    lines.push('')
    lines.push(`- 类型：\`${e.type}\`${e.formatOnly ? ' · 仅格式变化（前端默认折叠）' : ''}`)
    const oldHref = anchorURL(oldVersion, e.anchors.old)
    const newHref = anchorURL(newVersion, e.anchors.new)
    lines.push(`- 旧版位置：${oldHref ? `[${locText(e.anchors.old)}](${oldHref})` : '—（新增节点）'}`)
    lines.push(`- 新版位置：${newHref ? `[${locText(e.anchors.new)}](${newHref})` : '—（删除节点）'}`)
    appendDetail(lines, e)
    lines.push('')
  })

  return lines.join('\n')
}

function entryTitle(e) {
  const d = e.detail || {}
  if (e.type === 'table') return '参数表'
  if (e.type === 'code') return `代码块（${d.lang || 'plain'} · 空白策略：${d.policy}）`
  if (e.type === 'heading') return `标题：${d.newText || d.oldText || ''}`
  const t = d.newText || d.oldText || ''
  return t.length > 48 ? t.slice(0, 48) + '…' : t
}

function appendDetail(lines, e) {
  const d = e.detail || {}
  if (e.type === 'table' && d.rowChanges) {
    if (d.reorderedRows) lines.push('- ℹ️ 表格行顺序重排（按参数名对齐，不影响语义）')
    if (d.reorderedColumns) lines.push('- ℹ️ 列顺序变化：' + d.movedColumns.map((c) => `列 ${c.from + 1}→${c.to + 1}`).join('，'))
    for (const rc of d.rowChanges) {
      if (rc.kind === 'added') lines.push(`- 🟢 新增参数 \`${rc.key}\`（新表第 ${rc.newRow} 行）`)
      else if (rc.kind === 'removed') lines.push(`- 🔴 删除参数 \`${rc.key}\`（旧表第 ${rc.oldRow} 行）`)
      else {
        for (const c of rc.cells) {
          const icon = c.severity === 'major' ? '🔴' : '🟡'
          const label = KIND_LABELS[c.kind] || c.kind
          lines.push(`- ${icon} 参数 \`${rc.key}\` ${label}：\`${c.oldText || '∅'}\` → \`${c.newText || '∅'}\``)
        }
      }
    }
    return
  }
  if (e.type === 'code') {
    if (d.kind === 'format-only') lines.push(`- ℹ️ ${d.note || '仅空白/排版变化'}`)
    if (d.note && d.kind === 'semantic') lines.push(`- ⚠️ ${d.note}`)
    for (const h of d.hunks || []) {
      lines.push(`- 代码块 @ 旧 ${h.oldStart},${h.oldCount} / 新 ${h.newStart},${h.newCount}`)
      for (const l of h.lines) {
        const mark = l.kind === 'eq' ? ' ' : l.kind === 'del' ? '-' : '+'
        lines.push('  ```')
        lines.push(`  ${mark} ${l.text.replace(/\n/g, '\\n')}`)
        lines.push('  ```')
      }
    }
    return
  }
  if (d.similarity !== undefined) lines.push(`- 相似度：${d.similarity.toFixed(2)}（${KIND_LABELS[d.kind] || d.kind}）`)
  if (d.kind === 'copy') lines.push(`- ℹ️ ${d.sourceNote}`)
}

export { KIND_LABELS, STRUCT_LABELS, SEVERITY_LABELS }
