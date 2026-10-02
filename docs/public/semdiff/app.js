// 语义差异前端：调用 /api，渲染分级报告，纯格式变化默认折叠。
const $ = (id) => document.getElementById(id)
const API = ''

const SEV_LABEL = { cosmetic: '纯格式', minor: '润色', major: '重要', critical: '破坏性' }
const TYPE_LABEL = {
  'format-only': '纯格式变化', 'whitespace-only': '仅空白变化', 'moved': '段落移动', 'copied': '段落复制',
  'description-polish': '描述润色', 'text-reword': '文本改写', 'code-comment-only': '仅注释变化',
  'param-default-changed': '参数默认值变更', 'param-description-changed': '参数描述变更', 'param-type-changed': '参数类型变更',
  'code-semantic-change': '代码语义变化', 'heading-title-changed': '标题变化',
  'heading-added': '新增标题', 'heading-removed': '删除标题', 'block-added': '新增段落', 'block-removed': '删除段落',
  'code-added': '新增代码块', 'code-removed': '删除代码块', 'table-added': '新增参数表', 'table-removed': '删除参数表',
  'param-row-added': '新增参数', 'param-row-removed': '删除参数', 'param-row-reordered': '参数行重排', 'table-column-reordered': '表格列重排',
}

let state = { report: null, docRaw: { A: null, B: null } }

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}
async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { 'content-type': 'application/json', 'x-user': 'public', ...(opts.headers || {}) },
    ...opts,
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(body.error || res.statusText), { body })
  return body
}

function notice(kind, msg) {
  const div = document.createElement('div')
  div.className = kind === 'error' ? 'err' : 'warn'
  div.textContent = msg
  $('notices').appendChild(div)
}
function clearNotices() { $('notices').innerHTML = '' }

function payload() {
  return {
    docId: $('docId').value.trim(),
    baselineId: $('baselineId').value.trim(),
    targetId: $('targetId').value.trim(),
    mode: $('mode').value || undefined,
    rulesVersion: $('rulesVersion').value.trim() || undefined,
  }
}

async function loadRawVersions(p) {
  try {
    const [a, b] = await Promise.all([
      api(`/api/versions/${p.docId}/${p.baselineId}`),
      api(`/api/versions/${p.docId}/${p.targetId}`),
    ])
    state.docRaw = { A: a.version?.content || '', B: b.version?.content || '' }
  } catch (e) {
    state.docRaw = { A: '', B: '' }
  }
}

async function compare() {
  clearNotices()
  $('results').innerHTML = ''
  $('summary').innerHTML = ''
  const p = payload()
  $('btnCompare').disabled = true
  $('btnCancel').disabled = false
  try {
    const r = await api('/api/compare', { method: 'POST', body: JSON.stringify(p) })
    if (r.stale) {
      notice('warn', `命中旧规则缓存（${r.cachedRulesVersion}），当前规则为 ${r.currentRulesVersion}；未静默使用。再次比较将按当前规则计算。`)
      $('btnShare').disabled = false
      $('btnExport').disabled = false
      return
    }
    state.report = r.report
    await loadRawVersions(p)
    renderReport(r.report, { cached: r.cached })
    $('btnShare').disabled = false
    $('btnExport').disabled = false
  } catch (e) {
    notice('error', `比较失败：${e.body?.error || e.message}`)
  } finally {
    $('btnCompare').disabled = false
    $('btnCancel').disabled = true
  }
}

function renderReport(rep, { cached } = {}) {
  const s = rep.stats
  const modeBadge = rep.degraded
    ? `<span class="badge-mode degraded" title="${esc(rep.warnings.join('；'))}">受限匹配（退化结果）⚠</span>`
    : `<span class="badge-mode">${rep.mode === 'global' ? '全文最优匹配' : '受限局部匹配'}</span>`
  $('summary').innerHTML = `
    <div class="card"><div class="bd">
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
        ${modeBadge}
        <span class="meta">规则版本 <code>${esc(rep.rulesVersion)}</code>${cached ? ' · 缓存命中' : ''} · 用时 ${s.durationMs}ms · ${s.blocksA}→${s.blocksB} 块</span>
        <div class="stats" style="margin-left:auto">
          <span class="pill critical">破坏性 ${s.bySeverity.critical}</span>
          <span class="pill major">重要 ${s.bySeverity.major}</span>
          <span class="pill minor">润色 ${s.bySeverity.minor}</span>
          <span class="pill cosmetic">纯格式 ${s.bySeverity.cosmetic}</span>
        </div>
      </div>
      ${rep.degraded ? rep.warnings.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join('') : ''}
    </div></div>`

  const groups = { critical: [], major: [], minor: [], cosmetic: [] }
  rep.items.forEach((it) => groups[it.severity].push(it))
  const html = ['critical', 'major', 'minor', 'cosmetic'].map((sev) => {
    const list = groups[sev]
    if (!list.length) return ''
    // 纯格式默认折叠
    const open = sev !== 'cosmetic' ? 'open' : ''
    return `<details class="group card" ${open}>
      <summary><span class="pill ${sev}">${SEV_LABEL[sev]}</span> ${esc(TYPE_LABEL[list[0].type] || list[0].type)} 等 <span class="count">${list.length} 处</span>${sev === 'cosmetic' ? '（默认折叠，前端可展开）' : ''}</summary>
      <div class="bd">${list.map(renderItem).join('')}</div>
    </details>`
  }).join('')
  $('results').innerHTML = html || '<div class="card"><div class="bd meta">没有差异。</div></div>'
}

function renderItem(it) {
  const typeLabel = TYPE_LABEL[it.type] || it.type
  const jumpA = it.from ? `<a class="jump" data-side="A" data-id="${it.id}">基线 L${(it.from.startLine ?? 0) + 1}</a>` : '<span class="meta">—</span>'
  const jumpB = it.to ? `<a class="jump" data-side="B" data-id="${it.id}">目标 L${(it.to.startLine ?? 0) + 1}</a>` : '<span class="meta">—</span>'
  const movedTag = it.moved ? '<span class="pill cosmetic">移动</span>' : ''
  return `<div class="item ${it.severity}" data-id="${it.id}">
    <div class="row">
      <span class="caret" data-toggle="${it.id}">▶</span>
      <span class="pill ${it.severity}">${SEV_LABEL[it.severity]}</span>
      <span class="detail">${esc(typeLabel)} · ${esc(it.detail)} ${movedTag}</span>
      ${jumpA} ⇄ ${jumpB}
    </div>
    <div class="body">${renderDetail(it)}</div>
  </div>`
}

function renderDetail(it) {
  const rows = []
  if (it.before !== undefined || it.after !== undefined) {
    rows.push(`<div class="kv"><b>原值：</b><code>${esc(it.before)}</code> &nbsp;→&nbsp; <b>新值：</b><code>${esc(it.after)}</code></div>`)
  }
  if (it.param) rows.push(`<div class="kv"><b>参数：</b><code>${esc(it.param)}</code>${it.column ? ` · <b>列：</b>${esc(it.column)}` : ''}</div>`)
  if (it.language) rows.push(`<div class="kv"><b>语言：</b><code>${esc(it.language)}</code> · 空白策略：<code>${esc(it.whitespacePolicy)}</code>${it.strictWhitespace ? '（空白敏感，缩进差异计为语义）' : ''}</div>`)
  if (it.fromSection || it.toSection) rows.push(`<div class="kv">${esc(it.fromSection || '(根)')} → ${esc(it.toSection || '(根)')}</div>`)
  if (it.note) rows.push(`<div class="warn">${esc(it.note)}</div>`)
  if (it.polish) rows.push(`<div class="kv meta">相似度较高，按“描述润色”处理</div>`)
  if (it.hunks && it.hunks.length) rows.push(renderHunks(it))
  rows.push(`<div class="kv meta">from: ${it.from ? esc(it.from.versionId + ' / ' + it.from.blockId + ' / L' + ((it.from.startLine ?? 0) + 1)) : '无'} ｜ to: ${it.to ? esc(it.to.versionId + ' / ' + it.to.blockId + ' / L' + ((it.to.startLine ?? 0) + 1)) : '无'}</div>`)
  return rows.join('')
}

function renderHunks(it) {
  // 行级差异按变更块摘要展示（点击行号可在浮层查看原文上下文）
  return it.hunks.map((h, i) => `
    <div class="kv">变更块 ${i + 1}：基线 L${(h.aStart ?? 0) + 1}${h.aEnd !== h.aStart ? '-' + (h.aEnd + 1) : ''}，目标 L${(h.bStart ?? 0) + 1}${h.bEnd !== h.bStart ? '-' + (h.bEnd + 1) : ''}
      <a class="jump" data-side="A" data-id="${it.id}" data-hunk="${i}">查看基线原文</a>
      <a class="jump" data-side="B" data-id="${it.id}" data-hunk="${i}">查看目标原文</a>
    </div>`).join('')
}

function showSource(side, it, hunkIdx) {
  const loc = side === 'A' ? it.from : it.to
  const raw = state.docRaw[side]
  if (!raw || !loc) {
    $('floatTitle').textContent = '原文不可用'
    $('floatBody').innerHTML = '<div class="kv" style="padding:12px">未取到该版本原文（可能无访问权）。</div>'
    $('float').classList.add('show')
    return
  }
  const lines = raw.split('\n')
  let start = loc.startLine ?? 0
  let end = loc.endLine ?? start
  if (hunkIdx !== undefined && it.hunks?.[hunkIdx]) {
    const h = it.hunks[hunkIdx]
    if (side === 'A' && h.aStart != null) { start = Math.max(0, h.aStart - 2); end = h.aEnd + 2 }
    if (side === 'B' && h.bStart != null) { start = Math.max(0, h.bStart - 2); end = h.bEnd + 2 }
  } else {
    start = Math.max(0, start - 3)
    end = Math.min(lines.length - 1, end + 3)
  }
  const changeLinesA = new Set()
  const changeLinesB = new Set()
  ;(it.hunks || []).forEach((h) => {
    h.changes.forEach((c) => {
      if (c.aLine !== undefined) changeLinesA.add(c.aLine + (it.from.blockId.startsWith('code') ? it.from.startLine + 1 : 0))
      if (c.bLine !== undefined) changeLinesB.add(c.bLine + (it.to.blockId.startsWith('code') ? it.to.startLine + 1 : 0))
    })
  })
  const changeSet = side === 'A' ? changeLinesA : changeLinesB
  const rows = []
  for (let i = start; i <= end && i < lines.length; i++) {
    const cls = changeSet.has(i) ? 'mark' : ''
    rows.push(`<tr class="${cls}"><td class="ln">${i + 1}</td><td>${esc(lines[i] || ' ')}</td></tr>`)
  }
  $('floatTitle').textContent = `${side === 'A' ? '基线' : '目标'} ${loc.versionId} · ${loc.blockId}`
  $('floatBody').innerHTML = `<div class="codeview"><table>${rows.join('')}</table></div>`
  $('float').classList.add('show')
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-toggle]')
  if (t) {
    const item = document.querySelector(`.item[data-id="${t.dataset.toggle}"]`)
    item.classList.toggle('open')
    t.textContent = item.classList.contains('open') ? '▼' : '▶'
  }
  const j = e.target.closest('a.jump[data-id]')
  if (j) {
    const it = state.report?.items.find((x) => x.id === j.dataset.id)
    if (it) showSource(j.dataset.side, it, j.dataset.hunk !== undefined ? Number(j.dataset.hunk) : undefined)
  }
})

$('btnCompare').onclick = compare
$('btnCancel').onclick = async () => {
  const p = payload()
  await api('/api/cancel', { method: 'POST', body: JSON.stringify({ docId: p.docId }) })
  notice('warn', '已取消当前比较；后完成的迟到结果将被丢弃，不会混入新比较。')
}
$('btnShare').onclick = async () => {
  const p = payload()
  try {
    const r = await api('/api/shares', { method: 'POST', body: JSON.stringify({ docId: p.docId, baselineId: p.baselineId, targetId: p.targetId }) })
    // viewerUrl 打开差异视图；底层 /api/shares/:token 仍负责撤回/ACL 校验
    const url = `${location.origin}${r.share.viewerUrl}`
    await navigator.clipboard?.writeText(url).catch(() => {})
    notice('warn', `分享链接（只引用有访问权的发布版；版本撤回即失效）：${url}`)
  } catch (e) {
    notice('error', `分享失败：${e.body?.error || e.message}（仅已发布且有访问权的版本可分享）`)
  }
}
$('btnExport').onclick = async () => {
  const p = payload()
  const res = await fetch('/api/export', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user': 'public' },
    body: JSON.stringify({ docId: p.docId, baselineId: p.baselineId, targetId: p.targetId, rulesVersion: p.rulesVersion }),
  })
  if (!res.ok) {
    const b = await res.json().catch(() => ({}))
    return notice('error', `导出失败：${b.error}${b.error === 'STALE_RULES_CANNOT_EXPORT' ? '（旧规则结果不可导出，请用当前规则重新比较）' : ''}`)
  }
  const blob = await res.blob()
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `semdiff-${p.baselineId}-${p.targetId}.json`
  a.click()
}

// 分享/深链：打开页面时读取查询参数，自动加载对应比较。
// 支持两种形式：
//   /semdiff/?doc=guide&from=g1&to=g2            直接比较（仍受访问权约束）
//   /semdiff/?share=<token>                      先解析分享（撤回/越权即报错）
;(async function initFromQuery() {
  const q = new URLSearchParams(location.search)
  const share = q.get('share')
  try {
    if (share) {
      const r = await api(`/api/shares/${share}`)
      const s = r.share
      $('docId').value = s.docId
      $('baselineId').value = s.baselineId
      $('targetId').value = s.targetId
      $('rulesVersion').value = s.rulesVersion || ''
      notice('warn', `已通过分享打开（发布版 ${s.baselineId} → ${s.targetId}，规则 ${s.rulesVersion}）；版本撤回则链接失效。`)
      await compare()
      return
    }
    if (q.get('doc') && q.get('from') && q.get('to')) {
      $('docId').value = q.get('doc')
      $('baselineId').value = q.get('from')
      $('targetId').value = q.get('to')
      if (q.get('rules')) $('rulesVersion').value = q.get('rules')
      await compare()
    }
  } catch (e) {
    notice('error', `无法打开分享：${e.body?.error || e.message}（可能已撤回、过期或无访问权）`)
  }
})()
