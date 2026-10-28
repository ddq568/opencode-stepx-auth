# opencode-stepx-auth

把 StepFun Step Studio（studio.stepx.com）的聊天模型接入 magpie/OpenCode 的 provider 插件（非官方，逆向实现）。

**当前为未发布的合约核心重构工作树**（基于 v0.3.2，版本号未升级）。核心逻辑拆分到 `src/` 模块，通过离线 mock 传输层全回路测试（真实网络在测试中被禁用）；原生通道行为尚未上线验证，兼容性均为诚实仿真（见下文）。

## 安装

```bash
magpie plugin add ./magpie-plugin-stepx
```

## 登录

```bash
magpie plugin login stepx
```

唯一登录方式：自动打开 Chrome/Edge 访问 studio.stepx.com，完成登录（扫码或手机号）后窗口自动关闭，10 分钟内有效。站点轮换 Cookie 时插件只更新**本账号实例**持有的 Cookie 并回报宿主持久化。

## 使用

登录后选择 stepx provider 下的模型即可。模型列表来自站点的 `/chat-models` 接口（每账号实例独立缓存，失败时回退静态列表）。

## 模型能力说明

根据真实线上工具链（包含多轮对话、本地工具调用 `read_file` / `record_result`、JSON 载荷字节级精确校验）的实测验证：

- **`deepseek-flash[1m]`**：**推荐用于工具任务**。已通过真实工具链验证，具备准确的工具调用能力、参数构造精度以及多层 JSON 反转义推导能力（首轮实测全项通过 PASS）。
- **`step-5-preview`**：**仅推荐纯问答，不推荐用于工具任务**。在两轮真实线上实测中表现出两种典型失败模式：
  1. **过度转义错误（第一轮实测）**：在构建复杂 JSON 载荷时，将 Markdown 代码块外层的转义字符误判为字面量字符，导致实际提交的字符串包含了多余的字面反斜杠与转义引号，载荷字节比对失败，随后在续轮陷入死循环思考直至超时。
  2. **工具可用性幻觉拒答（第二轮实测）**：在首轮尚未发出任何工具调用的情况下，思考链内部产生严重幻觉，自行脑补"工具不可用报错"以及环境缺乏声明工具，进而单方面在可见回复中输出纯文本拒绝执行并提前终止。

基于上述实测结果，插件在构建模型条目时对 `step-5-preview` 默认设置 `tool_call: false`，并在模型名称后附加醒目标识 `（不推荐工具任务：实测存在工具可用性幻觉与转义错误，仅适合纯问答）`（无论 FALLBACK 静态目录还是 `/chat-models` 动态拉取均生效）。

若需要强制为 `step-5-preview` 开启工具能力，可在插件选项中配置 `enableStep5Tools: true`（当 `options.enableStep5Tools === true` 时恢复 `tool_call: true`）。

**实测报告路径**：
- 第一轮实测报告（含 `deepseek-flash[1m]` PASS 与 `step-5-preview` 过度转义失败）：
  - 权威交付报告：`C:\Users\dingdong\.pi\agent\sessions\--C--Users-dingdong--\subagent-artifacts\outputs\de06d04c-3591-45cb-ab35-660f586a456a\reviews\candidate-skill-live-first-attempt.md`
  - 仓库内实测产物：`artifacts/live-skill-first-attempt/`
- 第二轮实测报告（`step-5-preview` 幻觉拒答失败模式）：
  - 权威交付报告：`C:\Users\dingdong\.pi\agent\sessions\--C--Users-dingdong--\subagent-artifacts\outputs\a0f016d0-f312-40e3-8579-895a9b826d20\reviews\quirk-fixes-and-step5-retest.md`
  - 仓库内实测产物：`artifacts/live-skill-retest/`

## 架构（src/ 模块）

| 模块 | 职责 |
| --- | --- |
| `src/errors.mjs` | 类型化协议/HTTP 错误；失败绝不伪装 `stop` |
| `src/ledger.mjs` | 规范化消息 ledger：结构只来自消息字段；内容逐字保留（不 trim、不抹 ID）；tool_call/tool_result 按 id 精确关联；空回执保留 |
| `src/tools.mjs` | 工具白名单、m_ 双向别名表（按声明构造，无冲突前缀）、JSON-Schema 子集校验（不支持的关键字明确拒绝，不假校验） |
| `src/parser.mjs` | 规范 `<fn:invoke>` 流式解析（fail closed：坏 JSON/缺 name/未闭合/歧义/raw 冲突 → 类型化错误，绝不泄漏部分调用） |
| `src/prompt.mjs` | 环境中性的会话/协议提示（不声明操作系统，不断言"云端已断开"，无自我介绍脚本） |
| `src/transport.mjs` | 可注入 HTTP/WS 边界 + 单回合生命周期（取消/清理/只结算一次） |
| `src/stream.mjs` | SSE 渲染：工具调用整轮校验后才发送；上游失败发错误块、不发成功 finish |
| `src/session.mjs` | 账号级运行时：项目池/锁/Cookie/Catalog 全部按账号实例隔离；整请求 UTF-8 预算；结构化连续性证据 |
| `src/login.mjs` | 引导式浏览器登录 |
| `src/models.mjs` | 模型目录与解析 |

`legacy/index-v0.3.2.mjs` 是旧单文件实现的备份，**不**包含在 npm files 里。

## 相对 v0.3.2 的破坏性/行为变更（迁移说明）

1. **工具解析只认规范格式**：JSON 格式（`<fn:invoke>{"name":...}`）为规范格式；raw 参数块格式（`<fn:invoke name="..."><key>value</key>`）保留但**显式标注为实验性**（不是原生通道）。模糊触发器、DSML 变体、方括号变体、代码围栏容忍全部移除。坏 JSON 不再修复（避免改变 shell 语义）；raw 值中出现 `</fn:invoke>` 时整个调用明确拒绝（改用 JSON 格式）。弱模型可靠性会下降——这是有意为之的 fail closed。
2. **工具名严格映射**：只接受声明表中的线上名（`m_xxx`）或无歧义原始名；参数形状猜路由与 bash 兜底猜测已删除。声明名本身以 `m_` 开头时自动选用无冲突前缀，不再碰撞。
3. **schema 校验为有限子集**：schema 使用不支持的关键字（allOf/anyOf/oneOf/$ref/patternProperties 等）时整个请求以 `unsupported_tool_schema` 拒绝，不做部分校验。
4. **tool_choice/parallel 真实验证**：`required` 未调用、指定函数不匹配、`parallel_tool_calls=false` 却多次调用、`none` 却调用 → 类型化 422 协议错误；工具调用在整轮校验完成前不发给客户端（流式下同样缓冲）。
5. **不再自动重发**：删除"空回复自动补问"；上游失败/取消/协议错误后该云端会话标记不可续用，下次请求新建项目（同幂等 clientRequestId 重试仅保留在项目创建的 429/5xx 场景，且尊重 Retry-After 并验证响应）。
6. **usage 不再伪造**：`context.update` 只是会话上下文诊断（`stepx_diagnostics.session_context_tokens`），绝不冒充 prompt/completion tokens 或缓存命中；响应省略 `usage` 字段。
7. **大输入预算**：按整请求序列化后 UTF-8 字节（含 JSON 转义、WS 帧、工具 schema、隐式提示块）在**任何 HTTP 调用之前**检查；超限返回 413 并附大小与缩减建议。默认 768 KiB 保守值（站点上限并非精确已知，不再以固定 1MB 声称原生全支持），可用 `maxTurnBytes` 调整。默认**不截断任何原文**；`elideToolResults: true` 才对过长工具结果做 Unicode 安全的中段摘取（明确标注丢失范围，保留回执 id 与空值）。
8. **消息 ledger**：新增 developer 角色区分、`[tool_call id=…]`/`[tool_result id=…]` 结构块、原始 arguments JSON 逐字保留；不再对历史内容做标记字符替换；未知 role 与非文本 content（图片等）明确 400。
9. **会话映射更保守**：连续性要求"严格扩展上一回合的完整历史 + 本插件输出的真实 call id 以结构化形式出现"；同首句但无法证明连续性的对话**新建项目**（不再盲目共享）。删除启动时按 `^magpie-` 批量删除项目的逻辑——只回收本实例创建且空闲的项目，删除失败保留待清队列，绝不触碰用户自建项目。
10. **显式会话 id**：可选 `metadata.conversation_id` 在账号实例内命名空间化并受同一把回合锁保护。
11. **环境中性**：删除 Windows/Git Bash 固定声明与"云端已断开"断言；不依据宿主平台推测 agent 环境；删除【标准自我介绍】脚本。

## 选项

```bash
magpie plugin options stepx '{"persona": true, "maxProjects": 8, "maxTurnBytes": 786432, "elideToolResults": false, "enableStep5Tools": false, "chromePath": "C:/path/chrome.exe"}'
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `persona` | `true` | 首轮注入环境中性的会话说明 |
| `maxProjects` | `8` | 会话/项目池上限（仅回收本实例空闲项目；忙会话不回收） |
| `maxTurnBytes` | 786432 | 整请求 UTF-8 序列化字节的保守预算；超限 413 |
| `elideToolResults` | `false` | 是否摘取过长工具结果（标注丢失范围；system/user/assistant 永不截断） |
| `enableStep5Tools` | `false` | 强制为 `step-5-preview` 恢复 `tool_call: true`（默认 `false`；实测不推荐用于工具任务） |
| `chromePath` | 自动查找 | 浏览器登录用的浏览器路径 |

## 离线测试

```bash
npm test        # node --test "test/**/*.test.mjs"
```

mock HTTP/WS 全回路：entry → loader.fetch → 非流式/SSE、工具调用回路、续写证据、预算 413、协议违规 422、取消传播、账号隔离与 Cookie 轮换、上游失败不伪装成功。测试进程内 `fetch`/`WebSocket` 全局被替换为拒绝函数，无任何真实网络。

## 已知限制（诚实声明）

- **工具调用是文本协议仿真**，不是站点原生能力；可靠性取决于模型遵循度，弱模型下失败会**显式报错**而非静默降级。
- 站点审核大小上限并非精确已知；预算默认值为保守估计，不是对原生支持范围的承诺。
- 原生通道（site 自己的 agent/工具系统）未验证，本插件不尝试占用它。
- 逆向私有协议仅供个人学习，勿滥用。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 401 / 登录过期 | `magpie plugin login stepx` |
| WebSocket 连接失败 | Cookie 失效，重新登录 |
| `budget_exceeded` 413 | 缩短历史/精简工具 schema，或调高 `maxTurnBytes`、开启 `elideToolResults` |
| `unsupported_tool_schema` | 简化 schema 到支持的关键字子集 |
| 找不到浏览器 | 安装 Chrome 或设置 `chromePath` |

## Schema 校验兼容性（Ajv v8.20.0，精确锁定）

工具 `parameters` 用 Ajv 校验（`coerceTypes`/`useDefaults`/`removeAdditional` 全部关闭：schema 与参数对象**永不被修改**，`"001"` 不会悄悄变数字）：

- **方言**：draft-07（缺省）与 2020-12，按 schema 自身的 `$schema` 声明选择构造器；其他方言（draft-04/06、2019-09、OpenAPI 风格 `nullable`）→ 类型化 400。
- **支持**：`type`（含数组与 "null"）、`enum`、`const`、数值边界、字符串（min/Length、`pattern`）、数组（items/元组按方言、prefixItems、contains、uniqueItems 等）、对象（properties、required、additionalProperties(bool|schema)、patternProperties、propertyNames、min/maxProperties）、组合（`allOf`/`anyOf`/`oneOf`/`not`、`if`/`then`/`else`）、本地 `$ref`（仅 `"#..."`，配合 `$defs`/`definitions`；**外部/跨文档引用拒绝**）。
- **不校验（仅注解）**：`format`（未实现 ajv-formats，`format` 不参与校验——不假装校验过）、`title`/`description`/`default`/`examples` 等纯注解。
- **明确拒绝**：未知校验关键字、不支持方言、外部 `$ref`、悬空本地 `$ref`、超资源上限（单 schema 64KiB JSON、嵌套深度 48、pattern 256 字符上限）——全部类型化 400 `unsupported_tool_schema`，编译校验器缓存按 schema 精确 JSON 身份键控且有界（≤64 条）。
- **raw 格式**（格式A，实验性）：只有 schema 能**无歧义确定类型**（单一 string/number/integer/boolean、纯字符串 enum）才解析；组合/可空/数字 enum/未声明参数 → 类型化 `raw_form_ambiguous` 并指引用 JSON 格式，绝不猜类型，不做宽松 JSON 修复。

## 环境边界（诚实声明）

- 插件**不基于宿主平台推测 agent 环境**：命令/shell/路径风格完全由客户端的工具声明与消息内容决定；代码中无 OS 分支假设。
- WSL/容器宿主分离：浏览器唯一登录在**用户侧浏览器**（Windows/macOS/Linux Chrome/Edge 均在候选列表，或显式 `chromePath`）完成；agent 侧运行环境与之完全分离。插件不做任何真实 skill 执行/WSL 探测。
- 本插件是对站点私有协议的**兼容仿真**，非官方集成、未宣称生产稳定；上线前请在真实流量中小规模验证。
