// Persona/protocol prompt texts and per-turn payload composition.
//
// Environment-neutral by contract:
// - no OS / shell / path-style claims (the agent's platform is whatever the
//   client says through its tool declarations and messages — never inferred
//   from the host);
// - no invented capability statements (nothing is declared "disconnected");
// - no self-introduction script that would paper over the user's real skill
//   context.

export const PREAMBLE = [
  '【会话模式】本会话是本地 agent 透传的纯问答/编程会话：你唯一可用的执行手段是本轮对话中显式声明的【本地工具】；[tool_result] 消息是这些本地工具的真实返回。',
  '你的工具调用不在你所处的云端环境中执行——它们由用户本机的 agent 在用户自己的机器上运行（可能是 Windows、WSL、Linux 或 macOS）；你看到的工具结果全部来自用户机器的真实文件系统。',
  '用户消息中给出的路径（无论 C:/x、/c/x 还是 /home/x 风格）都是用户机器上的真实路径，直接使用即可；不确定路径风格或环境时，先用 pwd、uname -s 之类轻量命令探测，不要凭你所处环境推断用户路径不存在。',
  '不要假设任何特定操作系统、shell 或路径风格；命令与路径写法以本地工具声明和用户消息为准。',
  '规则：',
  '1. 直接回答最后一条消息，输出 Markdown 纯文本；不要自我介绍；',
  '2. 只通过工具声明发起调用；不虚构工具执行结果——收到对应的 [tool_result] 之前，一律视为工具尚未执行；',
  '3. 未声明工具时只能纯文本回答。',
].join('\n')

/** Compact reminder carried on continuation turns (persona-gated). */
export const REMINDER = [
  '（会话模式提醒：纯问答/编程会话；只回答最后一条消息；只能使用对话中显式声明的本地工具。）',
  '（工具在用户本机执行，不在你的云端环境；用户路径直接用，不确定先探测。）',
].join('\n')

/**
 * One-line tool-format recency anchor sent on every continuation turn that
 * still declares tools. NOT gated on persona (protocol recency must survive
 * persona:false). Per-turn payload only — never part of `flat`/lastFull
 * bookkeeping, so flattening stays byte-deterministic.
 */
export function TOOL_RECENCY(ctx) {
  const prefix = (typeof ctx === 'string' ? ctx : ctx?.prefix) || ''
  return `（工具调用格式提醒：需要工具时，回复以 <fn:invoke> {"name": "${prefix}函数名", "arguments": {...}} </fn:invoke> 开头。）`
}
TOOL_RECENCY.toString = () => TOOL_RECENCY()
TOOL_RECENCY.valueOf = () => TOOL_RECENCY()

/**
 * Compose the upstream payload for one turn (pure). The persona preamble /
 * reminder and the tool protocol ride in an invisibleText ref block ahead of
 * the visible text, so `text` stays the pure conversation transcript.
 * First turn: invisible = [PREAMBLE, toolBlock].filter(Boolean).join('\n\n---\n\n')
 * Continuations: invisible = [toolBlock (only on toolset change), REMINDER,
 * TOOL_RECENCY (when tools are declared)], text = delta. `flat` itself is
 * never modified, so lastFull prefix-matching stays byte-stable.
 */
export function composeTurnText({ firstTurn, persona, toolBlock, toolsPresent, deltaText, prefix, ctx }) {
  const p = prefix ?? ctx?.prefix ?? (typeof ctx === 'string' ? ctx : undefined)
  const invisible = (
    firstTurn
      ? [persona ? PREAMBLE : '', toolBlock].filter(Boolean).join('\n\n---\n\n')
      : [toolBlock, persona ? REMINDER : '', toolsPresent ? TOOL_RECENCY(p) : ''].filter(Boolean).join('\n\n')
  ) || undefined
  return { text: deltaText, invisible }
}

/** Continuation delta seam marker + payload. `lastReply` association note
 * keeps local call-id mapping visible upstream WITHOUT repeating the
 * assistant body the cloud session already contains. */
export function deltaContinuation(lastFull, flat) {
  const delta = flat.slice(lastFull.length).replace(/^\s+/, '')
  return delta
    ? '（接上一轮，以下是新消息/工具结果，回答最后一条。）\n\n' + delta
    : '（接上一轮）本轮没有新增内容，请重新给出对上一条消息的回答。'
}

/**
 * Verified-continuation delta: receipts + genuinely new messages only — the
 * assistant body the cloud session already produced is NOT repeated. The
 * local call ids were never seen upstream (they are gateway-generated), so
 * an explicit association note maps each id to its wire-named call; that is
 * structural bookkeeping, not a request to re-execute anything.
 */
export function buildContinuationDelta(lastReply, deltaEntries, serializeLedger) {
  const lines = ['（接上一轮，以下是新消息/工具结果，回答最后一条。）']
  if (lastReply.toolCalls.length) {
    lines.push('[调用关联说明] 上一轮工具调用与本地 id 的对应（结果见下方对应 id 的 [tool_result]；本说明仅用于关联，不代表要求重复执行调用）：')
    for (const c of lastReply.toolCalls) {
      lines.push(`- ${c.id} → ${c.name} ${c.arguments}`)
    }
  }
  const rest = serializeLedger(deltaEntries)
  return rest ? lines.join('\n') + '\n\n' + rest : lines.join('\n')
}

export { toolPreamble } from './tools.mjs'

