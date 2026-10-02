# VitePress 文档系统 + 语义差异平台

基于 VitePress 的组件库文档站，并内置一套**语义差异（Semantic Diff）**能力：比较文档两个已发布版本在标题、参数表、代码块、段落上的语义变化。

## ✨ 语义差异能力

- **结构化解析**：比较服务解析标题、GFM 参数表、代码节点、段落与列表。
- **前端折叠纯格式变化**：默认隐藏纯空白/排版差异，可一键展开。
- **语言敏感空白**：Python/YAML/Makefile 等缩进有语义的语言逐字符比较；JSON/JS 等基于语言词法 token 判定纯美化；字符串内部空白始终保留语义。
- **参数表分级**：默认值/类型/必填/参数增删为 🔴 重要，描述润色为 🟡 润色；行按参数名对齐（支持行重排），列重排单独标注。
- **移动 vs 复制**：移动段落沿稳定身份（标题 slug、章道路径+指纹、参数名）匹配；原对象仍在原处的多余相同副本认定为「复制」。
- **大章节分块**：章节内做受限局部匹配，跨块移动由二次匹配识别；比较可中途取消（epoch 纪元），取消后的迟到块一律拒绝，不混入新比较。
- **全文最优 vs 受限局部 + 复杂度预算**：章节间与章节内均用 LCS 加权 DP，受预算约束；超预算退化为快速贪心匹配并给出退化提示。
- **分享 / 导出**：分享 URL 只引用有访问权的发布版，版本撤回则链接失效；导出冻结写入时所见差异（两侧原文+结果+规则版+带双位置链接的报告）。
- **规则版本化**：差异规则以版本发布、可撤回；缓存条目带规则版本，命中旧规则缓存时丢弃并重算。
- **可溯源**：报告中每处差异都带旧版/新版两个精确位置链接（行号 + 标题 slug）。

## 📂 结构

- `shared/`：同构语义差异引擎（浏览器与服务端共用）
  - `markdown/` 解析器；`semantic/` 身份、分块、对齐、空白策略、代码/段落/表格比较、主编排；`report/` 报告
- `server/`：比较服务（Node 内置 http，零额外依赖）
  - `src/db.js` JSON 文件库（版本/访问权/规则/缓存/分享/冻结快照）
  - `src/rules.js` 规则版本与撤回、旧规则缓存防护
  - `src/compareService.js` 会话 epoch、分块、访问控制、分享、冻结导出
  - `src/httpServer.js` HTTP API；`src/cli.js` 命令行报告；`src/seed.js` 演示数据
  - `test/` node:test 测试（引擎 + 服务 + HTTP，共 21 例）
- `docs/.vitepress/theme/components/SemanticDiff.vue`：语义差异页；`DiffEntry.vue`：条目渲染

## 🚀 使用

```bash
npm test                 # 运行全部语义差异测试
npm run server:seed       # 初始化演示数据
npm run server:start      # 启动比较服务 http://localhost:5174
npm run docs:dev          # 文档站（侧边栏「指南 → 语义差异」）
npm run docs:build        # 构建
```

主要 HTTP 接口：`POST /api/compare`、`/api/compare/sessions` + `/chunks` + `/cancel` + `/restart` + `/finalize`、`POST /api/shares`、`GET /api/shares/:token`、`POST /api/exports`、`GET /api/snapshots/:id`，管理端 `POST /api/admin/rules/:v/withdraw`、`/api/admin/versions/:id/withdraw`（访问主体通过 `x-subject` 头传递）。

```bash
node server/src/cli.js old.md new.md --rule rule-v2   # 生成 Markdown 差异报告
```
