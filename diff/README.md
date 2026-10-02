# 语义差异子系统（Semantic Diff）

为产品文档平台提供「理解结构」的版本差异能力：解析标题、参数表、代码块与段落，
做分级差异报告，支持稳定身份移动匹配、复制认定、分块二次匹配、复杂度预算与取消代数、
基于发布版的分享与冻结导出。

## 目录结构

```
diff/
  engine/
    parser.mjs       # Markdown -> 带稳定身份的块节点（heading/table/code/paragraph/list/container）
    whitespace.mjs   # 语言敏感的空白策略 + 逐行 LCS（保留原始行号）
    rules.mjs        # 差异规则集（版本化）、差异类型 -> 严重级分级
    matcher.mjs      # 主比较器：身份配对、序列对齐、分块、跨块二次匹配、复制/移动、冻结快照
  store/
    db.mjs           # JSON 文档库（versions/runs/shares/exports/rules/cache）
    repository.mjs   # 发布/撤回、比较编排、取消代数、规则钉版缓存、分享授权、冻结导出
  server/
    http.mjs         # 无依赖 HTTP API + 静态托管
  public/            # 独立前端（折叠纯格式、分级展示、双端跳回、分享/导出）
docs/public/semdiff/ # 同一份前端，随 VitePress 站点发布到 /semdiff/
test/
  run.mjs            # 引擎 + 仓储单测（19 项）
  e2e.mjs            # HTTP 端到端（15 项）
  fixtures/          # guide / dup / huge 两版夹具
```

## 核心设计

### 1. 解析与稳定身份（parser.mjs）

| 节点 | 稳定身份 |
| --- | --- |
| heading | 显式 `{#id}` 或章节路径 slug（同父重名加序号） |
| table（参数表） | 表 id + 行按**参数名**（首列，可识别「参数/属性/名称/name…」） |
| code | 章节 + 语言 + 可选标题 + 章内序号（可被 `{#id}` 覆盖） |
| paragraph / list / container | **内容指纹**（sha1）+ 同内容出现序号；身份不含章节，移动后仍稳定 |

段落身份刻意不含章节路径，否则「移动到别的章节」会让身份失效；同内容多份用 `#序号` 区分。

### 2. 语言敏感空白（whitespace.mjs）

- `strict`（python/make/yaml/haskell/pug/coffeescript…）：保留行首空白，tab/空格不可互换；
- `free`（js/ts/java/go/rust/c…）：去缩进、折叠行内连续空白、忽略空行；
- `relaxed`（shell…）：去缩进但保留行内空白；
- **未知语言默认 strict**（不假设空白无语义）。
- 规范化只用于比较；`entries[].idx` 记录原始行号，行级 hunk 的定位始终指回未规范化原文。

### 3. 匹配（matcher.mjs）

1. **身份配对**：
   - 结构身份（标题/代码/表）按 id；
   - 内容身份（段落/列表/容器）按「指纹分组 + 同序 1:1」——重复内容有序对齐，
     既不会占用两次，也天然识别跨章节移动。
2. **序列对齐（Needleman–Wunsch 打分）**只处理未被身份占用的块：
   - `global`：全文最优（能自然发现长距离移动）；
   - `local`：章节分块内对齐，再对剩余块做一次**跨块二次匹配**（按类型分池 + 相似度贪心 + 扫描预算）。
3. **复制 vs 移动**：同指纹两侧 1:1 配对后，目标侧多出的副本 => `copied`（另行认定）；
   已配对块指纹变化 => 内容修改，绝不重复计删除。
4. **参数表**：行按参数名匹配（重排不报错），默认值变更 `major`、描述变化 `minor`（高相似标注“润色”）、
   类型变更 `major`、行/列纯重排 `cosmetic`。
5. **代码**：纯空白（语言相关）`cosmetic`；仅注释 `minor`；其余 `major`，超 LCS 预算则粗粒度并标 `degraded`。
6. **段落**：去掉 Markdown 标记后一致 => `format-only`（cosmetic）；高相似改写 => `description-polish`（minor）。

### 4. 复杂度预算与退化（rules.mjs budget）

- `maxGlobalCells`：全文对齐单元上限；超出则自动 `global -> local` 并在报告里 `degraded=true` + 中文原因；
- 显式请求 `global` 且 `fallbackToLocal:false` 时，超预算抛 `COMPLEXITY_BUDGET_EXCEEDED`；
- `maxShinglePairs`：跨块二次匹配扫描上限，超出停止并提示可能漏移动；
- `maxCodeLinesLcs`：单代码块逐行比对上限。
- 比较是**异步分块**的，块边界 `setImmediate` 让出事件循环，使 `AbortSignal` 及时生效。

### 5. 取消代数（repository.mjs）

- 每文档一个 generation；`startRun` 与 `cancel` 都递增；
- 完成回写时若代数已过期 => 运行置 `stale-discarded`，结果丢弃，**迟到块不混进新比较**。

### 6. 规则版本与缓存

- 每次比较记录 `rulesVersion`；规则可注册/激活（`POST /api/admin/rules`）。
- 缓存键 = `doc::baseline::target`（**不含**规则版本），命中后比较缓存内 `rulesVersion`
  与期望值：不同则返回 `stale`，不静默复用；显式指定旧版本则按该版本重算。
- 导出强制用**当前规则**重算（`useCache:false`），旧规则导出返回 `STALE_RULES_CANNOT_EXPORT`。

### 7. 分享与导出

- 版本三态：`draft`（仅作者/编辑可比较）/ `published`（按 ACL）/ `withdrawn`（任何人不可见）。
- 分享只接受双方都 `published` 且当前用户在 ACL 内；记录 revision 与规则版本；
  解析时再次确认未撤回、未过期、访问未变，否则 410/403。
- 导出为 `semdiff-export/v1` 自包含快照：两版原文、规则、报告、全部 from/to 定位；
  `includeCosmetic:false` 可冻结“纯格式折叠”的所见视图。

## 运行与测试

```bash
npm run semdiff:server          # 启动比较服务（PORT / DB_FILE 可覆盖）
npm test                        # 引擎+仓储单测
BASE=http://localhost:5174 npm run test:e2e   # HTTP 端到端（先启动服务）
```

## 需求场景到测试的映射

| 场景 | 覆盖 |
| --- | --- |
| 重复片段 | `dup-*` 夹具 + 单测「重复片段…copied」 |
| 表格重排 | `guide-*` 参数表 + 「表格重排…」单测 |
| 语言敏感空白 | whitespace 单测（js/python/make/未知语言）+ 「代码块…」单测 |
| 一个版本撤回 | 「版本撤回后…」单测 + e2e |
| 缓存命中旧规则 | 「缓存命中旧规则…」单测 + e2e |
| 每处差异跳回两版位置 | 「所有 item 携带 from/to…」单测 + e2e |
| 分块二次匹配 | 「受限局部模式…」「复杂度预算…」单测 + huge 夹具 e2e |
| 取消与迟到块 | 「异步分块比较…」「取消代数…」「迟到结果防护…」单测 |
