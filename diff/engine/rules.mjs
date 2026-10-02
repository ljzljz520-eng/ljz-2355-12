// 差异规则集：规则版本化，数据库保存每次比较实际使用的规则版本。
// 缓存按规则版本区分；旧规则缓存命中时结果会被标记 stale，不静默用于分享/导出。

export const RULES_VERSION = '2024.01.01-semdiff-v1'

export const DEFAULT_RULES = {
  rulesVersion: RULES_VERSION,
  // 全文最优匹配的复杂度预算
  budget: {
    maxGlobalCells: 40_000, // O(n*m) 序列比对单元数
    maxShinglePairs: 12_000, // 相似度对扫描上限
    maxCodeLinesLcs: 4_000, // 单代码块 LCS 行对
    fallbackToLocal: true, // 超预算时退化为受限局部匹配
  },
  match: {
    strongIdentity: 0.98,
    duplicateIdentity: 0.98, // 内容指纹相同 => 复制候选
    modifySimilarity: 0.55, // 序列对齐内：同位置内容改写的配对阈值（较低，避免小改写被误判删除+新增）
    moveSimilarity: 0.72, // 跨块移动的模糊匹配阈值（较高，避免远距离错配）
    copySimilarity: 0.90, // 判定"复制"（两处以上同源）阈值
    paramRowKeyMatch: true, // 参数行按参数名匹配（表格重排不影响）
  },
  severity: {
    levels: ['cosmetic', 'minor', 'major', 'critical'],
  },
  whitespace: {
    // 语言策略实际表在 whitespace.mjs；这里记录版本元数据
    profileVersion: 'lang-profile-v1',
    unknownLanguageDefault: 'strict', // 未知语言保守处理：空白可能有语义
  },
}

// 差异类型分级
// cosmetic : 纯格式（前端默认折叠）
// minor    : 描述润色等措辞变化
// major    : 参数默认值变更、类型变更、语义代码改动
// critical : 删除/新增 API 参数、标题结构变化、代码块删除（可配置升级）
export const TYPE_SEVERITY = {
  'format-only': 'cosmetic',
  'whitespace-only': 'cosmetic',
  'description-polish': 'minor',
  'code-comment-only': 'minor',
  'text-reword': 'minor',
  'param-default-changed': 'major',
  'param-description-changed': 'minor',
  'param-type-changed': 'major',
  'code-semantic-change': 'major',
  'heading-title-changed': 'major',
  'heading-added': 'minor',
  'heading-removed': 'critical',
  'block-added': 'minor',
  'block-removed': 'critical',
  'code-added': 'minor',
  'code-removed': 'critical',
  'table-added': 'minor',
  'table-removed': 'critical',
  'param-row-added': 'major',
  'param-row-removed': 'critical',
  'param-row-reordered': 'cosmetic',
  'table-column-reordered': 'cosmetic',
  'moved': 'cosmetic', // 移动本身无内容变化，默认折叠
  'copied': 'cosmetic', // 复制（同源多处）另行认定，默认折叠但独立类型
}

export function severityOf(type) {
  return TYPE_SEVERITY[type] || 'minor'
}

export function withVersion(extra = {}) {
  return {
    ...DEFAULT_RULES,
    ...extra,
    rulesVersion: extra.rulesVersion || RULES_VERSION,
  }
}
