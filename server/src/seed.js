// 初始化演示数据：基线/目标版本、两个差异规则版本、访问授权。
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JsonDB } from './db.js'
import { RuleRegistry } from './rules.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const BUTTON_V1 = `# Button 按钮

常用的操作按钮。

## 基础用法

使用 \`type\` 属性来定义按钮的样式。

| 参数 | 说明 | 类型 | 默认值 |
| --- | --- | --- | --- |
| size | 按钮尺寸 | string | md |
| type | 按钮类型 | string | default |
| disabled | 是否禁用按钮 | boolean | false |

注意：请保持按钮文案简短。

\`\`\`json
{ "type": "primary" }
\`\`\`
`

export const BUTTON_V2 = `# Button 按钮

常用的操作按钮。

## 基础用法

使用 \`type\` 属性来定义按钮的样式类型。

| 参数 | 说明 | 类型 | 默认值 |
| --- | --- | --- | --- |
| type | 按钮类型 | string | primary |
| size | 按钮的尺寸大小 | string | md |
| disabled | 是否禁用按钮 | boolean | false |
| loading | 是否加载中 | boolean | false |

注意：请保持按钮文案简短。

\`\`\`json
{
  "type": "primary"
}
\`\`\`
`

export function buttonVersions() {
  return {
    'doc-button-v1': { docId: 'doc-button', title: 'Button v1（基线）', source: BUTTON_V1 },
    'doc-button-v2': { docId: 'doc-button', title: 'Button v2（目标）', source: BUTTON_V2 },
    'doc-button-v3': { docId: 'doc-button', title: 'Button v3（撤回版）', source: BUTTON_V2 + '\n未发布完成的草稿。\n' }
  }
}

export async function seed(dbFile = path.join(__dirname, '..', 'data', 'db.json')) {
  const db = new JsonDB(dbFile)
  const rules = new RuleRegistry(db)
  await rules.publish('rule-v1', { budgetCells: 40000, polishThreshold: 0.72 })
  await rules.publish('rule-v2', { budgetCells: 25000, polishThreshold: 0.68 })

  for (const [id, v] of Object.entries(buttonVersions())) {
    await db.putVersion({
      id,
      docId: v.docId,
      title: v.title,
      source: v.source,
      status: id === 'doc-button-v3' ? 'withdrawn' : 'published',
      createdAt: Date.now(),
      publishedAt: Date.now()
    })
  }
  // 演示主体 alice 有 v1/v2 访问权；bob 只有 v1
  await db.grant('alice', 'doc-button-v1')
  await db.grant('alice', 'doc-button-v2')
  await db.grant('bob', 'doc-button-v1')
  return db
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seed().then(() => console.log('seeded'))
}
