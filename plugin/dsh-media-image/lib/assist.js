// 助手的模型通路 —— 与 dsh-media-desk 同一套宿主契约：
//   ctx.get('agentDefaultModel').currentSelection() → { provider, model }
//   ctx.get('llm').prepareCall(...) → call.stream(...) → text-delta
// 不自己配密钥、不直连任何厂商 API，模型由宿主提供；没有模型就如实报"未连接"。
//
// 模型只负责"想"：回一段中文 + 一组受限的 ops。执行发生在页面上（它拥有编辑器），
// 所以模型永远不会声称某个操作已经完成。

export const OP_TYPES = ['generate', 'batch', 'import', 'insert', 'status', 'fontList'];

const SYSTEM = `你是 DeepSeek Harness 图片编辑器插件里的助手。用户用一句话让你在这张画布上做事或回答问题。

只输出一个 JSON 对象，不要输出别的内容：
{"reply":"给用户的中文回复，简短，不超过 80 字","ops":[]}

ops 只允许这几种（不认识的不要编）：
- {"type":"generate","prompt":"英文画面描述","width":1024,"height":1024}  生成一张图（会进素材库，不自动落到画布）
- {"type":"batch","prompts":["英文画面描述","…"]}                        批量生成（并发 2）
- {"type":"import","url":"https://…/a.png"}                            导入远程素材（禁用内网地址）
- {"type":"insert"}                                                     把最近一次生成的图插成图层
- {"type":"status"}                                                     读一次编辑器状态（版本/图层数/选区）
- {"type":"fontList"}                                                   列出已登记字体

规则：
- 你**不执行**任何操作，只提议。绝不要说"已经生成/已经插入"；reply 里用"我来生成…""要我插入就说插入图层"。
- 用户问的是画布以外的问题（概念、建议）时 ops 为空，直接用 reply 回答。
- 用户描述模糊但意图清楚时自己补全合理参数，不要反问一堆问题；真的不清楚才在 reply 里问一句。
- 不要把 Markdown、代码块、列表写进 reply（界面只显示纯文本）。
- 用户提到"当这张图/刚才那张"时，指最近一次生成的结果（对应 insert）。`;

const JSON_HINT = '只输出 JSON：{"reply":"…","ops":[…]}.';

/** 读取当前可用的默认模型；没有就返回 null（不抛错，便于 UI 显示"未连接"）。 */
export function modelInfo(ctx) {
  try {
    const selection = ctx.get('agentDefaultModel')?.currentSelection();
    if (!ctx.get('llm') || !selection?.provider || !selection?.model) return null;
    return { provider: selection.provider, model: selection.model, label: selection.model };
  } catch {
    return null;
  }
}

export class AssistError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AssistError';
    this.code = code;
  }
}

/**
 * 调一次模型，收完整文本。返回 { text, model }。
 * signal 由调用方给（超时/中断都由调用方决定，这里不吞）。
 */
export async function callModel(ctx, { system, user, maxTokens = 1200, signal, onText } = {}) {
  const info = modelInfo(ctx);
  if (!info) throw new AssistError('ASSIST_UNAVAILABLE', '当前没有可用的默认模型');
  const llm = ctx.get('llm');
  try {
    const call = await llm.prepareCall({ provider: info.provider, model: info.model, maxTokens }, signal);
    let text = '';
    for await (const chunk of call.stream({
      ...call.config,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }], source: { kind: 'dsh-media-image' } }],
      signal,
    })) {
      if (chunk.type === 'text-delta') {
        text += chunk.text;
        onText?.(chunk.text);
      } else if (chunk.type === 'finish' && ['error', 'aborted'].includes(chunk.reason?.kind)) {
        throw new AssistError('ASSIST_FAILED', chunk.reason.failure?.message || '模型调用失败');
      }
    }
    return { text, model: info.label };
  } catch (error) {
    if (error instanceof AssistError) throw error;
    throw new AssistError('ASSIST_FAILED', error?.message || '模型调用失败');
  }
}

/** 从模型文本里取出 JSON；取不到就把整段当 reply（不算失败）。 */
export function parsePlan(text) {
  const raw = String(text || '').trim();
  if (!raw) return { reply: '我没有听到内容，再说一次？', ops: [] };
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1));
      const reply = typeof parsed.reply === 'string' && parsed.reply.trim() ? parsed.reply.trim() : '处理好了。';
      const ops = Array.isArray(parsed.ops) ? parsed.ops.filter(op => op && OP_TYPES.includes(op.type)) : [];
      return { reply, ops, droppedOps: Array.isArray(parsed.ops) ? parsed.ops.length - ops.length : 0 };
    } catch {
      // 落到下面的纯文本分支
    }
  }
  return { reply: raw.slice(0, 1200), ops: [] };
}

/**
 * 一轮对话：给定用户消息 + 可选上下文（画布摘要、最近对话），拿到 reply 与 ops。
 * 不落任何状态 —— 执行由页面负责，这样"提议"和"已执行"不会混为一谈。
 */
export async function chatTurn(ctx, { message, history = [], context = null, timeoutMs = 90_000 } = {}) {
  const text = String(message || '').trim();
  if (!text) throw new AssistError('ASSIST_INVALID', '消息为空');
  if (text.length > 4000) throw new AssistError('ASSIST_INVALID', '消息过长（上限 4000 字符）');
  const info = modelInfo(ctx);
  if (!info) throw new AssistError('ASSIST_UNAVAILABLE', '当前没有可用的默认模型');

  const contextLine = context
    ? `画布：${context.width}×${context.height}；图层 ${context.layers} 个；有选区 ${context.hasSelection ? '是' : '否'}；最近结果 ${context.lastAssetRef || '无'}。`
    : '画布信息未知（页面还没连上编辑器）。';
  const historyLine = history.length
    ? `最近对话：${history.slice(-6).map(row => `${row.role === 'user' ? '用户' : '助手'}：${row.text}`).join(' / ')}`
    : '';
  const user = `${contextLine}${historyLine ? `\n${historyLine}` : ''}\n用户说：${text}`;

  const { text: answer, model } = await callModel(ctx, {
    system: `${SYSTEM}\n${JSON_HINT}`,
    user,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const plan = parsePlan(answer);
  return { reply: plan.reply, ops: plan.ops, droppedOps: plan.droppedOps || 0, engine: model, model: model, provider: info.provider };
}
