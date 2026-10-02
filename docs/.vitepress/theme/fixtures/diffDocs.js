// 语义差异页演示数据（与服务端种子一致的两份 Button 文档，以及专门的场景夹具）。

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

// 场景：跨章节移动 + 复制 + Python 敏感空白
export const SCENARIO_OLD = `# 组件参考

开篇的说明段落。

## 安装

通过包管理器安装。

| 参数 | 默认值 | 描述 |
| --- | --- | --- |
| timeout | 3000 | 请求超时毫秒数 |
| retries | 2 | 失败重试次数 |

安装完成后请重启服务。

## 配置

请参考下方示例。

\`\`\`python
def configure(env):
    if env == "prod":
        return 443
    return 80
\`\`\`

这段是会被复制到别处的通用声明。
`

export const SCENARIO_NEW = `# 组件参考

开篇的说明段落。

## 安装

通过包管理器安装依赖。

| 描述 | 参数 | 默认值 |
| --- | --- | --- |
| 失败重试次数 | retries | 3 |
| 请求超时毫秒数 | timeout | 3000 |
| 启用调试模式 | debug | false |

安装完成后请重启服务。

这段是会被复制到别处的通用声明。

## 配置

请参考下方示例。

\`\`\`python
def configure(env):
  if env == "prod":
      return 443
  return 80
\`\`\`

这段是会被复制到别处的通用声明。
`

export const FIXTURES = [
  { id: 'button', label: 'Button 默认值变更（v1 → v2）', old: BUTTON_V1, new: BUTTON_V2, oldId: 'doc-button-v1', newId: 'doc-button-v2' },
  { id: 'scenario', label: '综合场景：移动/复制/表格重排/敏感空白', old: SCENARIO_OLD, new: SCENARIO_NEW, oldId: 'doc-scenario-v1', newId: 'doc-scenario-v2' }
]
