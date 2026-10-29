# opencode-stepx-auth

把 StepFun Step Studio（studio.stepx.com）的聊天模型接入 magpie / OpenCode 的 provider 插件（非官方逆向实现）。

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

登录方式唯一：通过系统桌面浏览器（自动按系统查找 Chrome 或 Edge，或通过 `chromePath` 选项指定）打开 studio.stepx.com。用户在浏览器中完成扫码或验证码登录后，插件自动捕获会话 Cookie 并关闭窗口，凭据在有效周期内由插件管理并在站点轮换时自动更新持久化。

## 快速开始

完成登录后，在 OpenCode / magpie 中配置或选择模型：

```text
stepx/deepseek-flash[1m]  # 推荐：代码与工具调用任务
stepx/step-5-preview       # 纯问答与文本生成任务
```

## 模型能力

- **`stepx/deepseek-flash[1m]`**：推荐用于工具任务。通过真实工具链完整验证，具备可靠的指令遵循度、参数结构生成精度及多层反转义推导能力。
- **`stepx/step-5-preview`**：仅推荐纯问答，不推荐用于工具任务。实测表明其存在两种典型失败模式：
  1. **过度转义**：构造复杂参数时易将转义符当字面量字符重复转义，造成载荷不匹配与思考死循环；
  2. **工具可用性幻觉**：未调用工具时思考链脑补工具不可用或环境缺失，单方面在正文中拒绝执行。
  插件默认对其标记 `tool_call: false`；如确有需要，可通过配置 `enableStep5Tools: true` 强制恢复工具能力。

## 工作原理

1. **Cookie 会话认证与自动轮换**：利用桌面浏览器授权捕获会话 Cookie 与网页端接口通信，在收到站点 Set-Cookie 轮换事件时自动就地更新并回传宿主。
2. **会话映射与 Verified-Echo**：会话指纹映射至云端 Studio 独立项目，多轮续写实施严格的 verified-echo 回声校验；无法证明连续性的请求安全回退至新建项目。
3. **`<fn:invoke>` 文本协议仿真**：通过首轮注入提示词并在流式输出中解析 `<fn:invoke>` 标签驱动本地工具执行，回传 `[tool_result]`。明确标注：**非原生 tool calling，上游无该入口**。
4. **JSON 为主格式**：默认且推荐使用规范的标准 JSON 格式传递参数，移除不安全的模糊推断与宽松容错。
5. **错误 Fail-Closed**：遇到坏 JSON、未闭合标签、歧义参数或协议冲突时直接抛出类型化错误，绝不伪装成功 `stop`。

## 架构

| 模块 | 职责 |
| --- | --- |
| `src/errors.mjs` | 类型化协议/HTTP 错误；失败绝不伪装 `stop` |
| `src/ledger.mjs` | 规范化消息 ledger：结构只来自消息字段；内容逐字保留；tool_call/tool_result 按 id 精确关联 |
| `src/tools.mjs` | 工具白名单、m_ 双向别名表（按声明构造，无冲突前缀）、JSON-Schema 严格子集校验 |
| `src/parser.mjs` | 规范 `<fn:invoke>` 流式解析（fail-closed：坏 JSON/缺 name/未闭合 → 类型化错误） |
| `src/prompt.mjs` | 环境中性 + 用户机器执行锚点（跨平台探测式） |
| `src/transport.mjs` | 可注入 HTTP/WS 边界 + 单回合生命周期（取消/清理/只结算一次） |
| `src/stream.mjs` | SSE 渲染：工具调用整轮校验后才发送；上游失败发错误块、不发成功 finish |
| `src/session.mjs` | 账号级运行时：项目池/并发锁/Cookie 全部按账号实例隔离；整请求 UTF-8 预算 |
| `src/login.mjs` | 引导式浏览器登录与凭据拦截 |
| `src/models.mjs` | 模型目录拉取、缓存与模型名解析 |

## 从 v0.3.x 迁移

1. **工具解析收敛为规范 JSON**：默认采用 `<fn:invoke>{"name":...}</fn:invoke>`；移除一切非标准宽容修复，解析失败严格 fail-closed。
2. **工具名称严格别名映射**：仅允许声明白名单与无冲突别名前缀映射，彻底废弃模糊路由与盲猜。
3. **严格 Ajv Schema 校验**：不支持的关键字或外部引用直接拒绝，杜绝虚假校验。
4. **Tool Choice 协议约束**：协议违规抛出类型化 422 错误，不再静默降级或提前发送未校验调用。
5. **异常会话阻断复用**：请求异常中断后不再复用损坏的云端项目，保障多轮状态纯净。
6. **前置 UTF-8 预算防御**：网络请求前进行整请求字节预算预检，超限直接阻断返回 413。
7. **真实 Usage 诊断**：不伪造 token 计数，仅在诊断字段中按需提供上下文度量。
8. **跨平台探测式执行锚点**：移除系统偏见假设，提示词引导模型依赖用户环境探测而非主观推断。

## 选项

```bash
magpie plugin options stepx '{"persona": true, "maxProjects": 8, "maxTurnBytes": 786432, "elideToolResults": false, "enableStep5Tools": false, "chromePath": ""}'
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `persona` | `true` | 首轮注入环境中性与用户机器执行锚点说明 |
| `maxProjects` | `8` | 会话/项目池上限（仅回收本实例空闲项目；忙会话不回收） |
| `maxTurnBytes` | `786432` | 整请求 UTF-8 序列化字节的保守预算（约 768 KiB）；超限返回 413 |
| `elideToolResults` | `false` | 是否摘取过长工具结果（标注丢失范围；对话上下文永不截断） |
| `enableStep5Tools` | `false` | 强制为 `step-5-preview` 恢复 `tool_call: true`（实测不推荐用于工具任务） |
| `chromePath` | 自动查找 | 浏览器登录用的可执行文件路径 |

## 测试

测试套件采用全局拦截与离线 mock，完整覆盖 HTTP/WS、工具调用循环、协议校验与异常分支，不发起任何真实外部网络请求：

```bash
npm test
```

## 已知限制

- **仿真非原生**：工具调用完全基于提示词和文本块逆向仿真，非模型底层原生 function calling。
- **上游接口易变**：基于网页端无文档私有协议，接口规范可能随站点版本升级而发生变动或漂移。
- **可靠性依赖遵循度**：结构化调用的成功率高度依赖具体模型的提示词遵循能力，弱模型可能出现语法破损。
- **step-5 工具限制**：`step-5-preview` 存在转义与幻觉短板，默认禁用工具调用，仅推荐纯文本生成。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 401 / 登录过期 | 执行 `magpie plugin login stepx` 重新登录 |
| WebSocket 连接失败 | Cookie 失效或网络中断，重新执行登录 |
| `budget_exceeded` 413 | 缩短历史上下文、精简工具 schema，或调高 `maxTurnBytes`、开启 `elideToolResults` |
| `unsupported_tool_schema` | 简化 schema 到支持的关键字子集 |
| 找不到浏览器 | 安装 Chrome / Edge 或在选项中显式指定 `chromePath` |

## License

[MIT](LICENSE)
