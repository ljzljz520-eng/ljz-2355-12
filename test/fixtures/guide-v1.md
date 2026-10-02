# 按钮 Button

按钮用于开始一个即时操作。

## 基础用法

使用 `type` 属性选择按钮类型。

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

## API

### Attributes

| 参数 | 说明 | 类型 | 可选值 | 默认值 |
| --- | --- | --- | --- | --- |
| type | 按钮类型 | string | primary / success | default |
| size | 按钮尺寸 | string | large / small | — |
| disabled | 是否禁用 | boolean | — | false |
| plain | 是否朴素按钮 | boolean | — | false |
| loading | 是否加载中 | boolean | — | false |

### Events

| 参数 | 说明 | 参数类型 |
| --- | --- | --- |
| click | 点击时触发 | event |

## 注意事项

请勿在表单未初始化时点击提交，这会导致校验异常。这一段在两个版本中完全相同，用于测试重复片段的稳定匹配。

操作完成后请及时关闭弹窗，避免遮罩层遮挡后续操作。
