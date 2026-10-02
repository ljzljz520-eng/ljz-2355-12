# 按钮 Button

按钮用于开始一个**即时操作**。

## 基础用法

使用 `type` 属性选择按钮类型，也可搭配 plain。

::: demo 基础按钮用法
examples/button/basic.vue
:::

```vue
<template>
    <el-button>默认按钮</el-button>
</template>
```

```python
def render():
  return {
      "type": "default"
  }
```

```js
const btn = document.createElement('button')
btn.textContent = '默认按钮'
```

## API

### Attributes

| 参数 | 说明 | 类型 | 可选值 | 默认值 |
| --- | --- | --- | --- | --- |
| size | 按钮尺寸 | string | large / small | — |
| type | 按钮的类型 | string | primary / success / warning | primary |
| loading | 是否加载中状态 | boolean | — | false |
| disabled | 是否禁用按钮 | boolean | — | false |
| plain | 是否朴素按钮 | boolean | — | false |
| icon | 图标类名 | string | — | — |

### Events

| 参数 | 说明 | 参数类型 |
| --- | --- | --- |
| click | 点击时触发 | event |

## 最佳实践

请勿在表单未初始化时点击提交，这会导致校验异常。这一段在两个版本中完全相同，用于测试重复片段的稳定匹配。

## 注意事项

操作完成后请及时关闭弹窗，避免遮罩层遮挡后续操作。
