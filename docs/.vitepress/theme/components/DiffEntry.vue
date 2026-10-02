<script setup>
import { computed, ref } from 'vue'
import { anchorURL } from '../../../../shared/report/report.js'

const props = defineProps({
  entry: { type: Object, required: true },
  oldId: { type: String, required: true },
  newId: { type: String, required: true }
})

const expanded = ref(false)
const STRUCT = { modified: '修改', moved: '移动', copied: '复制', added: '新增', deleted: '删除' }

const oldHref = computed(() => anchorURL({ versionId: props.oldId }, props.entry.anchors.old))
const newHref = computed(() => anchorURL({ versionId: props.newId }, props.entry.anchors.new))

const locText = (loc) => {
  if (!loc) return '—'
  return `${loc.path ? loc.path + ' ' : ''}第 ${loc.startLine}${loc.endLine > loc.startLine ? '-' + loc.endLine : ''} 行`
}

const title = computed(() => {
  const d = props.entry.detail || {}
  if (props.entry.type === 'table') return '参数表'
  if (props.entry.type === 'code') return `代码块 · ${d.lang || 'plain'} · 空白策略 ${d.policy}`
  if (props.entry.type === 'heading') return `标题：${d.newText || d.oldText || ''}`
  const t = d.newText || d.oldText || ''
  return t.length > 60 ? t.slice(0, 60) + '…' : t
})

const severityClass = computed(() => {
  if (props.entry.formatOnly) return 'sd-sev-none'
  return props.entry.severity === 'major' ? 'sd-sev-major' : props.entry.severity === 'minor' ? 'sd-sev-minor' : 'sd-sev-none'
})
</script>

<template>
  <div class="sd-entry" :class="[severityClass, { 'is-format': entry.formatOnly, 'is-struct': entry.structural !== 'modified' }]">
    <div class="sd-entry-head" @click="expanded = !expanded">
      <span class="sd-caret">{{ expanded ? '▾' : '▸' }}</span>
      <span class="sd-struct-badge">{{ STRUCT[entry.structural] || entry.structural }}</span>
      <span class="sd-type-badge">{{ entry.type }}</span>
      <span class="sd-entry-title">{{ title }}</span>
      <span v-if="entry.formatOnly" class="sd-flag">纯格式</span>
      <span v-else-if="entry.severity === 'major'" class="sd-flag sd-flag-major">重要</span>
      <span v-else-if="entry.severity === 'minor'" class="sd-flag sd-flag-minor">润色</span>
    </div>

    <div class="sd-anchors">
      <span class="sd-anchor-label">原版位置：</span>
      <a v-if="oldHref" :href="oldHref" target="_blank" rel="noopener" @click.stop>旧 · {{ locText(entry.anchors.old) }} ↩</a>
      <span v-else class="sd-na">旧 · —（新增节点）</span>
      <span class="sd-anchor-sep">⇄</span>
      <a v-if="newHref" :href="newHref" target="_blank" rel="noopener" @click.stop>新 · {{ locText(entry.anchors.new) }} ↩</a>
      <span v-else class="sd-na">新 · —（删除节点）</span>
    </div>

    <div v-if="expanded" class="sd-entry-body" @click.stop>
      <!-- 表格 -->
      <template v-if="entry.type === 'table'">
        <p v-if="entry.detail.reorderedRows" class="sd-note">ℹ️ 行顺序重排（按参数名对齐）</p>
        <p v-if="entry.detail.reorderedColumns" class="sd-note">
          ℹ️ 列顺序变化：
          <span v-for="c in entry.detail.movedColumns" :key="c.from">列 {{ c.from + 1 }}→{{ c.to + 1 }} </span>
        </p>
        <table class="sd-table">
          <thead>
            <tr><th>参数</th><th>变化</th><th>旧</th><th>新</th><th>分级</th></tr>
          </thead>
          <tbody>
            <template v-for="rc in entry.detail.rowChanges" :key="rc.kind + rc.key">
              <tr v-if="rc.kind === 'added'"><td>{{ rc.key }}</td><td class="sd-cell-add">新增参数</td><td>∅</td><td>新表第 {{ rc.newRow }} 行</td><td><span class="sd-flag sd-flag-major">重要</span></td></tr>
              <tr v-else-if="rc.kind === 'removed'"><td>{{ rc.key }}</td><td class="sd-cell-del">删除参数</td><td>旧表第 {{ rc.oldRow }} 行</td><td>∅</td><td><span class="sd-flag sd-flag-major">重要</span></td></tr>
              <tr v-for="c in rc.cells" :key="c.kind + c.col">
                <td>{{ rc.key }}</td>
                <td :class="c.severity === 'major' ? 'sd-cell-del' : 'sd-cell-minor'">
                  {{ { 'default-change': '默认值变更', 'description-polish': '描述润色', 'type-change': '类型变更', 'required-change': '必填变更', 'name-change': '参数名变更', 'cell-change': '内容变更' }[c.kind] || c.kind }}
                </td>
                <td class="sd-oldv">{{ c.oldText || '∅' }}</td>
                <td class="sd-newv">{{ c.newText || '∅' }}</td>
                <td>
                  <span v-if="c.severity === 'major'" class="sd-flag sd-flag-major">重要</span>
                  <span v-else class="sd-flag sd-flag-minor">润色</span>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </template>

      <!-- 代码 -->
      <template v-else-if="entry.type === 'code'">
        <p v-if="entry.detail.kind === 'format-only'" class="sd-note">ℹ️ {{ entry.detail.note || '仅空白/排版变化' }}</p>
        <p v-else class="sd-note">
          空白策略 <code>{{ entry.detail.policy }}</code>
          <span v-if="entry.detail.policy === 'exact'">：该语言空白可能有语义，未做统一忽略</span>
        </p>
        <div v-for="(h, hi) in entry.detail.hunks" :key="hi" class="sd-hunk">
          <div class="sd-hunk-meta">@@ 旧 {{ h.oldStart }},{{ h.oldCount }} / 新 {{ h.newStart }},{{ h.newCount }} @@</div>
          <pre v-for="(l, li) in h.lines" :key="li" class="sd-code-line" :class="'sd-code-' + l.kind"><span class="sd-code-mark">{{ l.kind === 'eq' ? ' ' : l.kind === 'del' ? '-' : '+' }}</span>{{ l.text }}</pre>
        </div>
      </template>

      <!-- 段落 / 标题：行内高亮 -->
      <template v-else>
        <p v-if="entry.detail.kind === 'copy'" class="sd-note">ℹ️ {{ entry.detail.sourceNote }}（源对象仍保留在原位置）</p>
        <p v-if="entry.detail.similarity !== undefined" class="sd-note">相似度 {{ entry.detail.similarity.toFixed(2) }} · {{ { minor: '描述润色', major: '实质变更', 'format-only': '仅格式变化' }[entry.detail.kind] || entry.detail.kind }}</p>
        <div v-if="entry.detail.inline && entry.detail.inline.length" class="sd-inline">
          <template v-for="(p, i) in entry.detail.inline" :key="i">
            <del v-if="p.kind === 'del'" class="sd-inline-del">{{ p.text }}</del>
            <ins v-else-if="p.kind === 'ins'" class="sd-inline-ins">{{ p.text }}</ins>
            <span v-else>{{ p.text }}</span>
          </template>
        </div>
      </template>
    </div>
  </div>
</template>
