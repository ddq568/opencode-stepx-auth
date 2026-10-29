# opencode-stepx-auth

把 StepFun Step Studio（studio.stepx.com）的聊天模型接入 magpie / OpenCode 的 provider 插件（非官方，逆向实现）。

[![Version](https://img.shields.io/badge/version-v0.4.0-blue.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

## 安装

支持从 GitHub 仓库远程安装或本地路径安装：

```bash
# 从 GitHub 仓库安装
magpie plugin add github:ddq568/opencode-stepx-auth

# 从本地克隆目录安装
magpie plugin add ./magpie-plugin-stepx
```

## 登录

```bash
magpie plugin login stepx
```

唯一登录方式：自动调用系统浏览器（Chrome 或 Edge）打开 studio.stepx.com。用户在浏览器中完成登录（扫码或手机号验证码）后，插件自动捕获凭据并关闭窗口，会话凭据 10 分钟内有效。站点轮换 Cookie 时，插件会自动更新当前账号实例持有的 Cookie 并回传给宿主持久化。

## 快速开始

完成登录后，在 OpenCode / magpie 中选择 `stepx` provider 对应的模型即可开始会话：

- **代码与工具任务**：推荐选择 `stepx/deepseek-flash[1m]`。
- **日常纯问答任务**：可选择 `stepx/step-5-preview`。

模型目录默认从站点的 `/chat-models` 接口按账号独立拉取并缓存；网络异常时自动回退至静态内置目录。

## 模型能力说明

基于真实线上工具链（包含多轮对话、本地工具调用 `read_file` / `record_result` 及复杂 JSON 载荷字节级精确校验）的实测表现：

- **`deepseek-flash[1m]`**：**推荐用于工具任务**。已通过完整工具调用验证回路，具备出色的工具调用遵循度、参数构造精度以及多层 JSON 反转义推导能力。
- **`step-5-preview`**：**仅推荐纯问答，不推荐用于工具任务**。在多轮线上实测中表现出两种典型失败模式：
  1. **过度转义错误**：在构造复杂 JSON 载荷时，容易将代码块外层的转义字符误判为字面量字符，导致实际提交多余的反斜杠与引号，造成载荷比对失败并在后续续轮中陷入死循环思考直至超时。
  2. **工具可用性幻觉拒答**：在尚未发出任何工具调用的情况下，思考链内部可能产生严重幻觉，自行脑补"工具不可用报错"或"环境缺失工具声明"，进而单方面在可见回复中输出文本拒绝执行并提前终止。
- **`enableStep5Tools` 选项**：基于上述表现，插件对 `step-5-preview` 默认设置 `tool_call: false`，并在模型展示名称后附加醒目标识 `（不推荐工具任务：实测存在工具可用性幻觉与转义错误，仅适合纯问答）`。如确需为其强制开启工具能力，可在插件选项中配置 `"enableStep5Tools": true`。

## 工作原理

- **Cookie 认证与账号隔离**：基于浏览器捕获的会话 Cookie 与 Step Studio 网页端 API 通信。运行时内的项目池、会话锁、Cookie 状态均按账号实例严格隔离。
- **Verified-Echo 连续性映射**：上游网页端基于独立项目（Project）维护会话。插件通过严格的 verified-echo 校验机制管理多轮续写，通过本地 call ID 与上游调用的显式映射及消息对账确保上下文一致；无法证明连续性的请求将自动隔离并创建新项目。
- **`<fn:invoke>` 文本协议仿真（非原生 Tool Calling）**：Step Studio 网页端并未开放原生 function calling 接口。插件通过首轮提示词注入工具协议声明，流式解析模型输出中的 `<fn:invoke>` 文本块并触发本地工具执行，随后将 `[tool_result]` 回传给模型。这是端到端的结构化文本协议仿真，**不是**模型的原生工具调用通道。

## 架构（src/ 模块）

| 模块 | 职责 |
| --- | --- |
| `src/errors.mjs` | 类型化协议/HTTP 错误；失败绝不伪装 `stop` |
| `src/ledger.mjs` | 规范化消息 ledger：结构只来自消息字段；内容逐字保留（不 trim、不抹 ID）；tool_call/tool_result 按 id 精确关联；空回执保留 |
| `src/tools.mjs` | 工具白名单、m_ 双向别名表（按声明构造，无冲突前缀）、JSON-Schema 子集校验（不支持的关键字明确拒绝，不假校验） |
| `src/parser.mjs` | 规范 `<fn:invoke>` 流式解析（fail closed：坏 JSON/缺 name/未闭合/歧义/raw 冲突 → 类型化错误，绝不泄漏部分调用） |
| `src/prompt.mjs` | 环境中性+用户机器执行锚点（跨平台探测式） |
| `src/transport.mjs` | 可注入 HTTP/WS 边界 + 单回合生命周期（取消/清理/只结算一次） |
| `src/stream.mjs` | SSE 渲染：工具调用整轮校验后才发送；上游失败发错误块、不发成功 finish |
| `src/session.mjs` | 账号级运行时：项目池/锁/Cookie/Catalog 全部按账号实例隔离；整请求 UTF-8 预算；结构化连续性证据 |
| `src/login.mjs` | 引导式浏览器登录 |
| `src/models.mjs` | 模型目录与解析 |

## v0.3.2 → v0.4.0 迁移要点

1. **工具解析只认规范格式**：默认采用标准 JSON 格式（`<fn:invoke>{"name":...}`）；raw 参数块格式标记为实验性；坏 JSON 严格报错（fail-closed），移除一切宽松修复与非标准变体。
2. **工具名称严格映射**：仅接受白名单别名或无歧义原始名，内置冲突避让前缀机制，彻底移除模糊路由猜测与兜底。
3. **严格的 Schema 校验**：基于 Ajv 实现严格子集校验，不支持的高级关键字（如外部 `$ref`）直接拒绝，不进行不完整假校验。
4. **Tool Choice 与 Parallel 严格约束**：协议违规直接抛出类型化 422 错误；工具调用经整轮完整校验后才对外分发。
5. **移除自动补问与不安全复用**：异常中断后该云端会话不再盲目复用；仅保留项目创建阶段受 `Retry-After` 约束的重试。
6. **真实的 Usage 诊断口径**：不伪造 prompt/completion tokens 统计；站点上下文大小仅作为诊断信息输出在 `stepx_diagnostics`。
7. **整请求 UTF-8 预算前置校验**：在发起任何网络请求前预检序列化字节数，超限返回 413；支持可选的工具结果中段安全裁剪（`elideToolResults`）。
8. **规范化消息 Ledger**：完整保留原始 arguments 与 `[tool_call]`/`[tool_result]` 结构，不支持的角色或多媒体内容直接返回 400。
9. **保守安全的会话连续性判定**：基于 verified-echo 严密判定续写关系；仅安全回收本实例创建的空闲项目，绝不影响用户自建项目。
10. **显式会话隔离**：支持 `metadata.conversation_id`，在账号实例命名空间内受并发回合锁保护。
11. **环境中性与跨平台锚点**：移除固定平台假设，注入用户机器执行锚点提示，引导模型采用探测式命令与自适应路径。

## 选项

```bash
magpie plugin options stepx '{"persona": true, "maxProjects": 8, "maxTurnBytes": 786432, "elideToolResults": false, "enableStep5Tools": false, "chromePath": "C:/path/chrome.exe"}'
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `persona` | `true` | 首轮注入环境中性与用户机器执行锚点说明 |
| `maxProjects` | `8` | 会话/项目池上限（仅回收本实例空闲项目；忙会话不回收） |
| `maxTurnBytes` | `786432` | 整请求 UTF-8 序列化字节的保守预算（约 768 KiB）；超限返回 413 |
| `elideToolResults` | `false` | 是否摘取过长工具结果（标注丢失范围；system/user/assistant 永不截断） |
| `enableStep5Tools` | `false` | 强制为 `step-5-preview` 恢复 `tool_call: true`（默认 `false`；实测不推荐用于工具任务） |
| `chromePath` | 自动查找 | 浏览器登录用的浏览器路径 |

## 离线测试

```bash
npm test        # node --test "test/**/*.test.mjs"
```

包含 mock HTTP/WS 全回路测试：entry → loader.fetch → 非流式/SSE、工具调用回路、续写证据、预算 413、协议违规 422、取消传播、账号隔离与 Cookie 轮换、上游失败不伪装成功。测试进程内 `fetch` / `WebSocket` 全局被拦截替换，绝不发起任何真实外部网络请求。

## 已知限制（诚实声明）

- **工具调用是文本协议仿真**，不是站点原生能力；可靠性取决于模型对协议格式的遵循度，弱模型下格式或协议错误会**显式报错**（fail-closed）而非静默降级。
- 站点审核与单回合上下文大小上限并非精确公开；预算默认值为保守估计（768 KiB），不是对原生支持范围的承诺。
- 原生通道（站点自己的智能体/内置插件系统）未做反向集成，本插件不尝试占用它。
- 逆向私有协议仅供个人开发与学习研究使用，请遵守相关服务条款，切勿滥用。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 401 / 登录过期 | 执行 `magpie plugin login stepx` 重新登录 |
| WebSocket 连接失败 | Cookie 失效或网络中断，重新执行登录 |
| `budget_exceeded` 413 | 缩短历史上下文、精简工具 schema，或调高 `maxTurnBytes`、开启 `elideToolResults` |
| `unsupported_tool_schema` | 简化 schema 到支持的关键字子集（见 Schema 校验说明） |
| 找不到浏览器 | 安装 Chrome / Edge 或在选项中显式指定 `chromePath` |

## Schema 校验兼容性（Ajv v8.20.0，精确锁定）

工具 `parameters` 用 Ajv 严格校验（`coerceTypes`/`useDefaults`/`removeAdditional` 全部关闭：schema 与参数对象**永不被修改**，`"001"` 不会悄悄变成数字）：

- **方言**：draft-07（缺省）与 2020-12，按 schema 自身的 `$schema` 声明选择构造器；其他方言（draft-04/06、2019-09、OpenAPI 风格 `nullable`）→ 类型化 400。
- **支持**：`type`（含数组与 `"null"`）、`enum`、`const`、数值边界、字符串（`minLength`/`maxLength`、`pattern`）、数组（`items`/元组按方言、`prefixItems`、`contains`、`uniqueItems` 等）、对象（`properties`、`required`、`additionalProperties(bool|schema)`、`patternProperties`、`propertyNames`、`minProperties`/`maxProperties`）、组合（`allOf`/`anyOf`/`oneOf`/`not`、`if`/`then`/`else`）、本地 `$ref`（仅 `"#..."`，配合 `$defs`/`definitions`；**外部/跨文档引用拒绝**）。
- **不校验（仅注解）**：`format`（未实现 ajv-formats，`format` 不参与校验——不假装校验过）、`title`/`description`/`default`/`examples` 等纯注解。
- **明确拒绝**：未知校验关键字、不支持方言、外部 `$ref`、悬空本地 `$ref`、超资源上限（单 schema 64 KiB JSON、嵌套深度 48、pattern 256 字符上限）——全部类型化 400 `unsupported_tool_schema`，编译校验器缓存按 schema 精确 JSON 身份键控且有界（≤64 条）。
- **raw 格式**（格式A，实验性）：只有 schema 能**无歧义确定类型**（单一 string/number/integer/boolean、纯字符串 enum）才解析；组合/可空/数字 enum/未声明参数 → 类型化 `raw_form_ambiguous` 并指引用 JSON 格式，绝不猜类型，不做宽松 JSON 修复。

## 环境边界（诚实声明）

- **工具在用户本机执行、跨平台探测式锚点**：插件提示词明确声明工具是在**用户本机**运行（Windows、WSL、Linux 或 macOS），文件系统路径和执行结果全部来自用户本地机器；模型被引导直接使用用户提供的路径风格，在不确定时采用 `pwd`、`uname` 等轻量命令探测，不凭云端环境推断用户路径不存在。
- **代码实现环境中性**：插件底层不基于宿主平台推测 agent 环境，无硬编码操作系统分支，命令与路径完全以客户端声明和用户消息为准。
- **WSL/容器宿主分离**：浏览器唯一登录在**用户侧桌面浏览器**（Windows/macOS/Linux Chrome/Edge 候选列表，或显式 `chromePath`）完成；agent 侧运行环境与之完全分离，插件不做任何侵入式环境探测。
- **协议仿真与实验性边界**：本插件是对站点私有协议的**兼容仿真**，非官方集成，请在真实工作流中按需评估与小规模验证。

## License

[MIT](LICENSE)
