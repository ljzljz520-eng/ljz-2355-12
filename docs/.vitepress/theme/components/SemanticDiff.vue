<script setup>
import { computed, ref, shallowRef } from 'vue'
import { compareDocuments } from '../../../../shared/semantic/diff.js'
import { renderMarkdownReport } from '../../../../shared/report/report.js'
import { FIXTURES } from '../fixtures/diffDocs.js'
import DiffEntry from './DiffEntry.vue'

const fixtureId = ref('button')
const ruleVersion = ref('rule-v2')
const budgetCells = ref(40000)
const crossChunkBudget = ref(200000)
const hideFormatOnly = ref(true)
const computed_ = shallowRef(null)
const errorMsg = ref('')

const fixture = computed(() => FIXTURES.find((f) => f.id === fixtureId.value) || FIXTURES[0])

function run() {
  errorMsg.value = ''
  try {
    const f = fixture.value
    computed_.value = compareDocuments(f.old, f.new, {
      ruleVersion: ruleVersion.value,
      budgetCells: Number(budgetCells.value),
      crossChunkBudget: Number(crossChunkBudget.value)
    })
  } catch (e) {
    errorMsg.value = String(e && e.message || e)
    computed_.value = null
  }
}
run()

const visibleEntries = computed(() => {
  if (!computed_.value) return []
  return hideFormatOnly.value ? computed_.value.entries.filter((e) => !e.formatOnly) : computed_.value.entries
})

const groups = computed(() => {
  const g = [
    { key: 'major', title: '🔴 重要变更（默认值/删除/新增/实质改写）', entries: [] },
    { key: 'minor', title: '🟡 描述润色（措辞调整，无语义增删）', entries: [] },
    { key: 'moved', title: '🔁 移动 / 复制（稳定身份匹配）', entries: [] },
    { key: 'format', title: '⚪ 纯格式变化（空白/排版，已折叠）', entries: [] }
  ]
  for (const e of visibleEntries.value) {
    if (e.structural === 'moved' || e.structural === 'copied') g[2].entries.push(e)
    else if (e.formatOnly) g[3].entries.push(e)
    else if (e.severity === 'minor') g[1].entries.push(e)
    else if (e.severity === 'major') g[0].entries.push(e)
  }
  return g.filter((x) => x.entries.length)
})

const shareUrl = computed(() => {
  if (!computed_.value) return ''
  const f = fixture.value
  // 分享 URL 只引用有访问权的发布版（此处演示用发布版 id）
  const params = new URLSearchParams({
    share: 'sh-demo',
    base: f.oldId,
    target: f.newId,
    rule: computed_.value.ruleVersion
  })
  return `/diff?${params.toString()}`
})

function exportFrozen() {
  const f = fixture.value
  const md = renderMarkdownReport({
    result: computed_.value,
    oldVersion: { versionId: f.oldId, title: f.oldId },
    newVersion: { versionId: f.newId, title: f.newId }
  })
  const payload = {
    frozenAt: new Date().toISOString(),
    ruleVersion: computed_.value.ruleVersion,
    base: { versionId: f.oldId, source: f.old },
    target: { versionId: f.newId, source: f.new },
    result: computed_.value,
    reportMarkdown: md
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `semantic-diff-${f.oldId}-vs-${f.newId}.frozen.json`
  a.click()
  URL.revokeObjectURL(a.href)
}

function copyShare() {
  navigator.clipboard?.writeText(new URL(shareUrl.value, window.location.origin).href)
}
</script>

<template>
  <div class="semdiff">
    <div class="sd-toolbar">
      <label>
        文档对：
        <select v-model="fixtureId" @change="run">
          <option v-for="f in FIXTURES" :key="f.id" :value="f.id">{{ f.label }}</option>
        </select>
      </label>
      <label>
        规则版：
        <select v-model="ruleVersion" @change="run">
          <option value="rule-v1">rule-v1（预算 40k / 润色 0.72）</option>
          <option value="rule-v2">rule-v2（预算 25k / 润色 0.68）</option>
        </select>
      </label>
      <label class="sd-check"><input type="checkbox" v-model="hideFormatOnly" /> 折叠纯格式变化</label>
    </div>

    <div class="sd-toolbar sd-toolbar-secondary">
      <label>
        复杂度预算（对齐 DP 单元）：
        <input v-model.number="budgetCells" type="number" min="1" step="1" style="width: 110px" />
      </label>
      <label>
        跨块匹配预算：
        <input v-model.number="crossChunkBudget" type="number" min="1" step="1" style="width: 120px" />
      </label>
      <button class="sd-btn" @click="run">重新比较</button>
      <button class="sd-btn" @click="exportFrozen">导出冻结差异</button>
      <button class="sd-btn" @click="copyShare">复制分享 URL</button>
      <code class="sd-share">{{ shareUrl }}</code>
    </div>

    <p v-if="errorMsg" class="sd-error">{{ errorMsg }}</p>

    <template v-if="computed_">
      <div class="sd-summary" :class="{ 'is-degraded': computed_.stats.degraded }">
        <div class="sd-stat"><strong>{{ computed_.stats.major }}</strong><span>重要</span></div>
        <div class="sd-stat"><strong>{{ computed_.stats.minor }}</strong><span>润色</span></div>
        <div class="sd-stat"><strong>{{ computed_.stats.formatOnly }}</strong><span>纯格式</span></div>
        <div class="sd-stat"><strong>{{ computed_.stats.moved }}</strong><span>移动</span></div>
        <div class="sd-stat"><strong>{{ computed_.stats.copied }}</strong><span>复制</span></div>
        <div class="sd-stat"><strong>{{ computed_.stats.added }}/{{ computed_.stats.deleted }}</strong><span>新增/删除</span></div>
        <div class="sd-stat sd-stat-meta">
          <span>规则版 <code>{{ computed_.ruleVersion }}</code></span>
          <span>DP 单元 {{ computed_.stats.totalCells }}</span>
        </div>
      </div>

      <div v-if="computed_.stats.degraded" class="sd-warning">
        ⚠️ 本次比较超出复杂度预算，已对部分匹配使用快速算法，结果可能不精确（退化提示）。
      </div>
      <ul v-if="computed_.warnings.length" class="sd-warnings">
        <li v-for="(w, i) in computed_.warnings" :key="i">⚠️ {{ w }}</li>
      </ul>

      <section v-for="g in groups" :key="g.key" class="sd-group">
        <h3 class="sd-group-title">{{ g.title }} <span class="sd-count">{{ g.entries.length }}</span></h3>
        <DiffEntry v-for="e in g.entries" :key="e.id" :entry="e" :old-id="fixture.oldId" :new-id="fixture.newId" />
      </section>

      <p v-if="!visibleEntries.length" class="sd-empty">两版没有可显示的语义差异。</p>
    </template>
  </div>
</template>
