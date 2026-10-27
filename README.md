# opencode-stepx-auth

把 StepFun Step Studio（studio.stepx.com）的聊天模型（Step 5 Preview / DeepSeek V4.1 Flash / Auto）接入 magpie/OpenCode 的 provider 插件（非官方，逆向实现）。

## 安装

```bash
magpie plugin add ./magpie-plugin-stepx
# 发布后可用包名安装：
# magpie plugin add <包名>
```

## 登录

```bash
magpie plugin login stepx
```

会自动打开 Chrome 访问 studio.stepx.com，登录（扫码或手机号）后窗口自动关闭并回到 magpie，全程无需其他操作；10 分钟内有效。

## 使用

登录后在 magpie 里直接选择 stepx provider 下的模型即可。

模型列表来自 Step Studio 的 `/api/chat-models` 接口，即站点上可用的聊天模型（Step 5 Preview、DeepSeek V4.1 Flash、Auto 等）。

## 工作原理（简述）

- **Cookie 认证**：复用 Step Studio 网站自身的 web session（Cookie）调用其 HTTP API 与 WebSocket；
- **会话映射**：每个对话（按首条消息的指纹）映射为一个 Step Studio 项目（project），会话与项目一一对应；
- **消息转发**：OpenAI 格式的 messages 被确定性地扁平化为纯文本，通过 `wss://studio-api.stepx.com/ws` 发送；
- **思考过程**：站点返回的 `thinking` 流式增量映射为 `reasoning_content`，`text` 增量映射为 `content`；
- **增量对话**：追加式对话只发送新增的增量消息，与 Studio 会话保持同步，不重复发送历史。

## 选项

```bash
magpie plugin options stepx '{"…"}'
```

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `chromePath` | 空（自动查找 Chrome/Edge） | 引导式浏览器登录使用的浏览器可执行文件路径，例如 `"C:/Program Files/Google/Chrome/Application/chrome.exe"` |
| `persona` | `true` | 是否在首轮注入「纯文本编程助手」前导词，缓解站点自身人设的影响；设为 `false` 可关闭 |
| `maxProjects` | `8` | 会话/项目池上限（LRU），超出后自动删除最旧的项目 |

## 已知限制

- **工具调用为仿真实现**：studio 后端不接收 OpenAI tools 参数，插件通过提示词协议（`<fn:invoke>` 标记）仿真 tool_calls（流式解析、支持并行调用与 tool_choice）；不能用 `<tool_call>` 标记（会被 studio 后端当作其内部语法拦截）；复杂多工具编排的可靠性取决于模型遵循度；
- **项目堆积**：每次新会话都会在你的 Step Studio 账号里创建一个 `magpie-*` 项目；LRU 上限默认 8 个，超出后自动删除最旧的（best-effort）；
- **滥用风险**：本插件逆向了站点的私有协议，请仅用于个人学习，勿滥用；
- **人设影响**：模型输出受 Step Studio 站点自身人设影响（已通过注入纯文本助手前导词缓解）。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 401 / 认证过期 | 重新登录：`magpie plugin login stepx` |
| WebSocket 连接失败 | Cookie 过期，重新登录 |
| 找不到浏览器 | 安装 Chrome，或设置 `chromePath` 选项指向可执行文件 |

## v0.2.7

- **m_ 前缀工具名隔离**：向模型声明的工具名统一加 `m_` 前缀（如 `m_read`、`m_bash`），返回给 API 客户端时自动还原为原始名。修复与 Step Studio 原生工具名（`Read`/`Bash` 等）冲突时，模型误走原生工具通道收到 "No such tool available"、进而泛化为「工具已坏」并停止输出 `<fn:invoke>` 的幻觉链；
- **成功前例注入**：首轮工具声明（及【工具列表更新】块）末尾附一段「上一轮你成功调用过工具」的完整示例往返，锚定文本协议格式；
- **逐轮格式锚点**：工具集未变时，后续每轮仍附带一行 `<fn:invoke>` 格式提醒（不受 `persona` 选项影响），缓解超长上下文（~40k tokens）下的格式遗忘；
- **清理诱发幻觉的示例错误文本**：移除反虚构规则中枚举的示例报错文案（如 "No such tool"），避免模型在幻觉中原样引用。
