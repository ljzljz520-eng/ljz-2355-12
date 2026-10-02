# 语义差异（Semantic Diff）

产品文档平台提供**结构化的语义差异**能力：比较两个文档版本时，不只是逐字符 diff，而是理解标题层级、参数表、代码块与段落，给出分级、可折叠、可跳回原文的差异报告。

## 能力概览

- **结构解析**：比较服务解析 Markdown 标题、GFM 参数表、围栏代码块、自定义容器（`::: demo`）与普通段落。
- **语言敏感的空白策略**：代码块空白可能携带语义，**不统一忽略**。
  - `python` / `make` / `yaml` / `haskell` 等采用 `strict`：缩进即语义，缩进变化计为语义改动。
  - `javascript` / `java` / `go` 等采用 `free`：缩进、连续空白变化折叠为「仅空白」。
  - 未知语言默认保守按 `strict` 处理。
- **差异分级**（前端默认折叠纯格式项）：
  - `cosmetic` 纯格式：Markdown 标记变化、代码空白变化、参数行/列重排、纯移动、复制
  - `minor` 描述润色、注释变化、新增标题/段落
  - `major` 参数默认值变更、参数类型变更、代码语义变化、新增参数
  - `critical` 删除标题/代码块/参数
- **稳定身份匹配**：标题按章节路径 slug（支持 `{#id}` 显式锚点）、参数行按参数名、代码块按章节+语言+标题、段落按内容指纹。移动段落沿稳定身份跨章节匹配；**复制段落单独认定为 copied**，区别于普通新增。
- **分块与二次匹配**：大章节按 `##` 分块。默认优先全文最优对齐；超复杂度预算时退化为受限局部匹配，并先在块内对齐、再对未匹配块做一次跨块二次匹配以发现跨块移动。退化结果在报告中显式 `degraded` 告警。
- **取消代数**：新比较开始即提升代数；取消后才完成的迟到块/迟到结果被丢弃，不会混进新比较。
- **分享与导出**：
  - 分享 URL 只引用**你有访问权的发布版**（revision 钉版）；版本被撤回，分享即时失效。
  - 导出为自包含冻结快照（两版原文 + 规则版本 + 全量定位），即“所见差异”的冻结副本。

## 规则版本与缓存

每次比较都记录所用**差异规则版本**。比较缓存以「文档 + 基线 + 目标」为键，缓存内容携带规则版本：

- 请求当前规则而命中旧规则缓存时，结果标记 `stale`，**不会静默复用**，也不能据此导出；
- 可显式以某规则版本重算；规则注册/激活通过 `POST /api/admin/rules`。

## 每处差异都可跳回两个原版位置

报告中的每个 item 都包含 `from` / `to` 定位：

```json
{
  "type": "param-default-changed",
  "severity": "major",
  "param": "type",
  "before": "default",
  "after": "primary",
  "from": { "versionId": "v1.0", "blockId": "table:attributes:1", "startLine": 30, "endLine": 30 },
  "to":   { "versionId": "v1.1", "blockId": "table:attributes:1", "startLine": 33, "endLine": 33 }
}
```

前端点击「基线 / 目标」行号即可在浮层中打开对应版本原文并高亮变更行。

## 使用

- 可视化页面：部署比较服务后访问 `/semdiff/`（静态资源位于 `docs/public/semdiff/`，API 默认同源，经反向代理到比较服务）。
- 独立运行服务：`npm run semdiff:server`（默认端口 5174，可用 `PORT` / `DB_FILE` 覆盖）。
- 测试：`npm test`（引擎与仓储 19 项）、`npm run test:e2e`（HTTP 端到端，需先启动服务并设置 `BASE`）。

## HTTP API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/versions/:doc/:ver` | 保存版本（draft） |
| POST | `/api/versions/:doc/:ver/publish` | 发布（body 可带 `acl`） |
| POST | `/api/versions/:doc/:ver/withdraw` | 撤回发布版 |
| POST | `/api/compare` | 比较（`docId/baselineId/targetId/mode?/rulesVersion?`） |
| POST | `/api/cancel` | 取消当前文档的比较代数 |
| POST | `/api/shares` | 创建分享（仅发布版、需访问权） |
| GET | `/api/shares/:token` | 解析分享（撤回即 410） |
| POST | `/api/export` | 导出冻结快照（默认当前规则） |
