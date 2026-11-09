// 助手的模型通路 —— 与 dsh-media-desk 同一套宿主契约：
//   ctx.get('agentDefaultModel').currentSelection() → { provider, model }
//   ctx.get('llm').prepareCall(...) → call.stream(...) → text-delta
// 不自己配密钥、不直连任何厂商 API，模型由宿主提供；没有模型就如实报"未连接"。
//
// 模型只负责"想"：回一段中文 + 一组受限的 ops。执行发生在页面上（它拥有编辑器），
// 所以模型永远不会声称某个操作已经完成。

import { ALLOWED_COMMANDS } from './bridge.js';

export const OP_TYPES = ['generate', 'batch', 'import', 'insert', 'status', 'fontList', 'removeBackground', 'command'];

/** 模型可以提议的编辑命令 —— 直接取编辑器白名单，避免两处各写一份而漂移。 */
export const PROPRIETABLE_COMMANDS = [...ALLOWED_COMMANDS.image].sort();

const SYSTEM = `你是 DeepSeek Harness 图片编辑器插件里的助手。用户用一句话让你在这张画布上做事或回答问题。

只输出一个 JSON 对象，不要输出别的内容：
{"reply":"给用户的中文回复，简短，不超过 80 字","ops":[]}

ops 只允许这几种（不认识的不要编）：
- {"type":"generate","prompt":"英文画面描述","width":1024,"height":1024}  生成一张图（会进素材库，不自动落到画布）
- {"type":"batch","prompts":["英文画面描述","…"]}                        批量生成（并发 2）
- {"type":"import","url":"https://…/a.png"}                            导入远程素材（禁用内网地址）
- {"type":"insert"}                                                     把最近可插入素材插成图层
- {"type":"insert","assetRef":"asset:<48位十六进制>"}                   指定某个已有素材插成图层
- {"type":"status"}                                                     读一次编辑器状态（版本/图层数/选区）
- {"type":"fontList"}                                                   列出已登记字体
- {"type":"removeBackground","assetRef":"asset:<48位十六进制>"}      对指定上传素材调用配置的背景移除服务
- 用户说“局部重绘：...”时，需要选择图片层并有真实选区，或选择带 mask.sourceLayerId 绑定的蒙版层；只有 GET /media-image/inpaint 声明 inpaint=true 的 provider 才可提交，其他情况应说清缺输入/后端，不提议不支持的操作。
- {"type":"command","command":{"type":"<命令名>","payload":{…}}}        提议一次画布编辑（用户确认后才执行）
- {"type":"plan","steps":[{"operation":"<命令名>","params":{…}}]}        提议一串编辑（1..12 步；用户一次确认后按顺序执行，任一步失败整体回滚）。高危命令 layer.remove / canvas.crop / layer.add_image 不能进 plan。

command 的 type 只能取下面这些（编辑器白名单，别的会被拒）：
${PROPRIETABLE_COMMANDS.join('、')}

command 命令名必须属于编辑器白名单。参数契约：
- layer.add_text: {text,x?,y?,style?:{size?,family?,fill_color?,bold?,italic?},fontUrl?}; x/y 同时给或都省略。
- layer.update_text: {layerId,text,fontUrl?}; 仅用于真实 text 图层。
- layer.add_image: {sourceRef,x?,y?,width?,height?,fit?,name?,maskRef?,maskRect?,maskMode?,maskInvert?,featherPx?}; sourceRef 用已有 asset:<id> 或 layer:<id>；width/height 成对；maskRef 与 maskRect 互斥。
- layer.set_appearance: {layerId,opacity?:0..100,blendMode?,name?}; 至少一项。
- layer.set_visibility: {layerId,visible:boolean}。
- layer.set_transform: {layerId,x?,y?,scaleX?,scaleY?,rotationDeg?}; 至少一项，scale 为正数。
- layer.set_frame: {layerId,x?,y?,width?,height?,fit?,anchor?}; width/height 成对，至少给位置或尺寸。
- layer.reorder: {layerId,toIndex:非负整数}。只按图层顺序索引，不得虚构目标层。
- layer.remove: {layerId}，高影响，说明会删除哪个真实图层。
- layer.feather: {layerId,radiusPx:1..64}，仅羽化已有透明边缘。
- layer.color_match: {layerId,method:"reinhard",strength?:0..1,reference?:"canvas"|"below"|{x,y,width,height}}。
- layer.remove_background: {layerId,tolerance?:0..100,featherPx?:0..64}；本地自动去背景，适合白底/纯色底商品图，无需外部服务；背景复杂时编辑器会回 BACKGROUND_NOT_DETECTED，别硬说成功。
- layer.magic_erase: {layerId,x,y,tolerance?:0..100,contiguous?:boolean}；等同于人类用魔棒点一下再删：只擦该点(x,y 为图层本地像素)同色且相连的一片。适合按区域逐块清背景，可反复调用；该点无可擦区域会回 MAGIC_ERASE_NO_MATCH。
- layer.add_mask_layer: {sourceLayerId,mode?:"subject"|"background",tolerance?:0..100,featherPx?:0..64,name?}；新建一张蒙版图层（白=保留、透明=挖掉），原图不动，返回的 changedObjectIds[0] 就是蒙版层 id。抠图标准路径：先它，再 layer.add_image {sourceRef:"layer:<源层>",maskRef:"layer:<蒙版层>",maskMode:"alpha"}。
- canvas.resize: {width:1..16384,height:1..16384}。
- canvas.crop: {x,y,width,height}，高影响，说明裁切范围。
- history.undo: {targetCommandId,afterDigest}；只撤销最近一条 Agent 改动，凭据必须来自 read_state.history，不得猜。
- history.redo: {}；先确认 read_state.history.canRedo 为真，否则会被 HISTORY_EMPTY 拒绝。

每个 command 由用户逐项确认，最多连续提议 3 个；上一项完成后会重新读取 revision，再显示下一项确认。

规则：
- 你**不执行**任何操作，只提议。绝不要说"已经生成/已经插入/已经改好"；reply 里用"我来生成…""要我插入就说插入图层"
  "我会把不透明度调到 60%，你确认后生效"这类说法。
- 破坏性命令（layer.remove / canvas.crop / layer.add_image）也允许提议，但 reply 里必须明确说它会删/裁什么。
- 一次最多提议 1 个 command，不要连着改好几层。
- 用户问的是画布以外的问题（概念、建议）时 ops 为空，直接用 reply 回答。
- 用户描述模糊但意图清楚时自己补全合理参数；涉及真实图层/坐标/历史凭据必须只用 <context> 提供的真实数据；不能满足字段时先问一句。
- 可用最多 3 个 ops 表达一项短工作流（例如新增文字→调外观），页面会按顺序每项单独确认；不要把互不相关的大任务串成批。
- 用户要求绘画笔刷/平移/缩放时，说明这些高频指针操作需在编辑器里直接完成；当前没有安全的远程 pointer 命令，不要假装能自动代拖。
- 不要把 Markdown、代码块、列表写进 reply（界面只显示纯文本）。
- 用户说“刚才那张/刚上传的/刚导入的”时，优先看 <context> 里的 assetList 与 lastAssetRef；它们包含上传、导入、生成的全部本页素材。不要把“最近可插入素材”缩窄成“最近生成的素材”。
- 用户明确说“插入图层/把它放到画布上”时，如果 context.lastAssetRef 存在，提议 {"type":"insert","assetRef":"<该引用>"}；页面会弹确认框，用户确认前不改画布。
- 用户问“生成”时，如果已有上传或导入素材，除非明确说要新图，不要把它说成不存在；可建议插入，或在用户明确要新图时生成。
- 用户明确说“抠图/去背景”时，如果 context.assetList 有素材，用 removeBackground 并选择用户刚提到的素材；没有素材时先请用户上传（不要声称已抠图）。
- 抠图结果是一个新的透明 PNG 素材，不会自动改画布；回复告诉用户可以再说“插入图层”，并等待确认。
- 用户表达长期偏好（以后、标准、都要）时只在 reply 里建议记录，本插件不维护持久记忆。
- 用户提到画布图层时，只能从 context.layerList 选择真实 id，不得编造。`;

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

/** op 的形状校验：命令类必须命中编辑器白名单且带 payload，其它类型只认已知字段。 */
function validOp(op) {
  if (op.type === 'command') {
    const command = op.command;
    if (!command || typeof command.type !== 'string') return false;
    if (!ALLOWED_COMMANDS.image.has(command.type)) return false;
    if (!command.payload || typeof command.payload !== 'object' || Array.isArray(command.payload)) return false;
    return true;
  }
  if (op.type === 'generate') return typeof op.prompt === 'string' && op.prompt.trim().length > 0;
  if (op.type === 'batch') return Array.isArray(op.prompts) && op.prompts.length > 0;
  if (op.type === 'import') return typeof op.url === 'string' && /^https?:\/\//i.test(op.url);
  if (op.type === 'insert') return op.assetRef === undefined || (typeof op.assetRef === 'string' && /^asset:[a-f0-9]{48}$/.test(op.assetRef));
  if (op.type === 'removeBackground') return typeof op.assetRef === 'string' && /^asset:[a-f0-9]{48}$/.test(op.assetRef);
  return true;
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
      const accepted = Array.isArray(parsed.ops) ? parsed.ops.filter(op => op && OP_TYPES.includes(op.type) && validOp(op)) : [];
      // 每个画布写入都要人逐项确认，所以链路有上限：最多 3 个 command，其余连同不认识的都计入 droppedOps。
      let commands = 0;
      const ops = [];
      for (const op of accepted) {
        if (op.type === 'command') {
          if (commands >= 3) continue;
          commands += 1;
        }
        if (ops.length >= 8) break;
        ops.push(op);
      }
      const droppedOps = (Array.isArray(parsed.ops) ? parsed.ops.length : 0) - ops.length;
      return { reply, ops, droppedOps, commandCount: commands };
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

  const layerLine = Array.isArray(context?.layerList) && context.layerList.length
    ? `图层清单：${context.layerList.map(layer => `${layer.id}=${layer.name || layer.type}${layer.visible === false ? '(隐藏)' : ''}`).join(' / ')}。`
    : '';
  const assetLine = Array.isArray(context?.assetList) && context.assetList.length
    ? `已有素材：${context.assetList.map(item => `${item.id}(${item.name})`).join(' / ')}。`
    : '';
  const contextLine = context
    ? `画布：${context.width}×${context.height}；图层 ${context.layers} 个；有选区 ${context.hasSelection ? '是' : '否'}；最近可插入素材 ${context.lastAssetRef || '无'}。${layerLine}${assetLine}`
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
