// 助手的模型通路 —— 与 dsh-media-desk 同一套宿主契约：
//   ctx.get('agentDefaultModel').currentSelection() → { provider, model }
//   ctx.get('llm').prepareCall(...) → call.stream(...) → text-delta
// 不自己配密钥、不直连任何厂商 API，模型由宿主提供；没有模型就如实报"未连接"。
//
// 模型只负责"想"：回一段中文 + 一组受限的 ops。执行发生在页面上（它拥有编辑器），
// 所以模型永远不会声称某个操作已经完成。

import { ALLOWED_COMMANDS } from './bridge.js';

export const OP_TYPES = ['generate', 'batch', 'import', 'insert', 'status', 'fontList', 'removeBackground', 'command', 'plan', 'photoshopAction'];

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
- {"type":"photoshopAction","action":"<固定action>","arguments":{…}} 仅当上下文说 Photoshop COM 已启用、且 action 在给出的清单内时才可用；它改的是 Photoshop 独立活动文档，不是这张画布，也不共享撤销栈。不许编 action，不许给 JSX/脚本；每轮最多 1 个，且不能和上面任何 miniPaint op 混在同一轮。
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
- layer.align: {layerId,h?:"left"|"center"|"right",v?:"top"|"middle"|"bottom",margin?:0..4096,to?:"canvas"}；h/v 至少给一个。坐标由编辑器算，套版时用它把元素对到槽位，不要靠反复 set_transform 试坐标。
- layer.duplicate: {layerId,offsetX?,offsetY?,name?}；复制一层（活蒙版配置会跟着复制），做多槽位变体时用。
- layer.rasterize: {layerId,name?}；文字/矢量层转像素并替换原层，旋转与活蒙版都烤进像素。替换/导出前用，之后不再依赖字体。
- layer.merge_down: {layerId,name?}；与该层下方那一层合并，层数减一，画面上看不出变化。最下层没有可合并对象时会回 NO_LAYER_BELOW。
- layer.paint_stroke: {layerId,points:[{x,y}|[x,y]] 2..200,color?:"#rrggbb",size? 1..200,opacity? 0..1}；把点连成一条线画进该层像素（图层本地坐标），一笔一步撤销。
- layer.set_effect: {layerId,effect:"blur"|"brightness"|"contrast"|"saturate"|"grayscale"|"sepia"|"invert"|"hueRotate"|"opacity",value:number|null}；非破坏调色（改 params 不改像素，撤销一步回原观感）。value:null 等于删掉这一项。取值范围：blur 0..50、brightness/contrast/saturate 0..3、grayscale/sepia/invert/opacity 0..1、hueRotate -180..180。
- layer.remove_effect: {layerId,effect?}；删一项，省略 effect 就清空整叠。
- layer.update_mask: {layerId,invert?,sourceLayerId?,remove?}；只改**活蒙版**（add_image 时用 maskRef:"layer:<id>" 建的那种）：反相、换蒙版源层、或 remove:true 整块摘掉。至少给一项，remove 不能和别人同时给。mode/featherPx **不接受**——活蒙版渲染不读它们；要羽化的成品请重新走 layer.add_image + maskRef + featherPx 烤一次。成环（A 拿 B 当蒙版、B 又拿 A）会被 MASK_CYCLE 拒绝。
- layer.reorder: {layerId,toIndex:非负整数}。只按图层顺序索引，不得虚构目标层。
- layer.remove: {layerId}，高影响，说明会删除哪个真实图层。
- layer.feather: {layerId,radiusPx:1..64}，仅羽化已有透明边缘。
- layer.color_match: {layerId,method:"reinhard",strength?:0..1,reference?:"canvas"|"below"|{x,y,width,height}}。
- layer.apply_grade: {layerId,grade:{exposure?(-5..5 EV),contrast?,highlights?,shadows?,whites?,blacks?(-100..100),curve?:[{x,y}],curveRed?/curveGreen?/curveBlue?,hsl?:{red|orange|yellow|green|aqua|blue|purple|magenta:{hue?,sat?,lum?}},splitTone?:{highlightHue?,highlightSat?,shadowHue?,shadowSat?}}}。这是像素分级（会改图层内容，可一步撤销），用来还原 Lightroom/Camera Raw 的曲线与分区 HSL；CLI 滤镜表达不了这些，别再拿 set_effect 近似。
- layer.remove_background: {layerId,tolerance?:0..100,featherPx?:0..64}；本地自动去背景，适合白底/纯色底商品图，无需外部服务；背景复杂时编辑器会回 BACKGROUND_NOT_DETECTED，别硬说成功。
- layer.magic_erase: {layerId,x,y,tolerance?:0..100,contiguous?:boolean}；等同于人类用魔棒点一下再删：只擦该点(x,y 为图层本地像素)同色且相连的一片。适合按区域逐块清背景，可反复调用；该点无可擦区域会回 MAGIC_ERASE_NO_MATCH。
- layer.add_mask_layer: {sourceLayerId,mode?:"subject"|"background",tolerance?:0..100,featherPx?:0..64,name?}；新建一张蒙版图层（白=保留、透明=挖掉），原图不动，返回的 changedObjectIds[0] 就是蒙版层 id。抠图标准路径：先它，再 layer.add_image {sourceRef:"layer:<源层>",maskRef:"layer:<蒙版层>",maskMode:"alpha"}。
- canvas.resize: {width:1..16384,height:1..16384}。
- canvas.crop: {x,y,width,height}，高影响，说明裁切范围。
- history.undo: {targetCommandId,afterDigest}；只撤销最近一条 Agent 改动，凭据必须来自 read_state.history，不得猜。
- history.redo: {}；先确认 read_state.history.canRedo 为真，否则会被 HISTORY_EMPTY 拒绝。
- history.batch: {steps:[{type,payload?}],name?}；1..12 条，不能含 history.*，不能含高危命令；整串合成**一步**撤销，任一步失败整串回滚。

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

/** 实测数值的打印：缺值就写"未知"，绝不补 0 冒充测量结果。 */
const num = value => (Number.isFinite(value) ? String(value) : '未知');
const percent = value => (Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '未知');

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

/** op 的形状校验：Photoshop 仅接受 runtime capability 允许的固定 action，不接受 script/JSX。 */
function validOp(op, photoshop = { enabled: false, actions: [] }) {
  if (!op || typeof op !== 'object' || Array.isArray(op) || typeof op.type !== 'string') return false;
  if (op.type === 'command') {
    const command = op.command;
    return !!command && typeof command.type === 'string' && ALLOWED_COMMANDS.image.has(command.type)
      && !!command.payload && typeof command.payload === 'object' && !Array.isArray(command.payload);
  }
  if (op.type === 'photoshopAction') {
    return photoshop?.enabled === true && Array.isArray(photoshop.actions) && photoshop.actions.includes(op.action)
      && Object.keys(op).every(key => ['type', 'action', 'arguments'].includes(key))
      && !!op.arguments && typeof op.arguments === 'object' && !Array.isArray(op.arguments);
  }
  if (op.type === 'plan') {
    if (!Array.isArray(op.steps) || op.steps.length < 1 || op.steps.length > 12) return false;
    return op.steps.every(step => step && typeof step === 'object' && !Array.isArray(step)
      && typeof step.operation === 'string' && ALLOWED_COMMANDS.image.has(step.operation)
      && (step.params === undefined || (typeof step.params === 'object' && step.params !== null && !Array.isArray(step.params))));
  }
  if (op.type === 'generate') return typeof op.prompt === 'string' && op.prompt.trim().length > 0;
  if (op.type === 'batch') return Array.isArray(op.prompts) && op.prompts.length > 0;
  if (op.type === 'import') return typeof op.url === 'string' && /^https?:\/\//i.test(op.url);
  if (op.type === 'insert') return op.assetRef === undefined || (typeof op.assetRef === 'string' && /^asset:[a-f0-9]{48}$/.test(op.assetRef));
  if (op.type === 'removeBackground') return typeof op.assetRef === 'string' && /^asset:[a-f0-9]{48}$/.test(op.assetRef);
  return op.type === 'status' || op.type === 'fontList';
}

/** 从模型文本里取出 JSON；取不到就把整段当 reply（不算失败）。 */
export function parsePlan(text, { photoshop = { enabled: false, actions: [] } } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return { reply: '我没有听到内容，再说一次？', ops: [] };
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1));
      const reply = typeof parsed.reply === 'string' && parsed.reply.trim() ? parsed.reply.trim() : '已整理操作建议。';
      const offered = Array.isArray(parsed.ops) ? parsed.ops : [];
      const accepted = offered.filter(op => OP_TYPES.includes(op?.type) && validOp(op, photoshop));
      const hasPhotoshop = accepted.some(op => op.type === 'photoshopAction');
      const mixedApps = hasPhotoshop && accepted.some(op => op.type !== 'photoshopAction');
      // Photoshop and miniPaint have separate documents and histories; never imply cross-app atomicity.
      const selected = mixedApps ? [] : hasPhotoshop ? accepted.filter(op => op.type === 'photoshopAction').slice(0, 1) : accepted;
      let commands = 0;
      const ops = [];
      for (const op of selected) {
        if (op.type === 'command') {
          if (commands >= 3) continue;
          commands += 1;
        }
        if (ops.length >= 8) break;
        ops.push(op);
      }
      return { reply, ops, droppedOps: offered.length - ops.length, commandCount: commands };
    } catch {
      // 落到下面的纯文本分支。
    }
  }
  return { reply: raw.slice(0, 1200), ops: [] };
}

/**
 * 一轮对话：给定用户消息 + 可选上下文（画布摘要、最近对话），拿到 reply 与 ops。
 * 不落任何状态 —— 执行由页面负责，这样"提议"和"已执行"不会混为一谈。
 */
export async function chatTurn(ctx, { message, history = [], context = null, observation = null, photoshop = { enabled: false, actions: [] }, timeoutMs = 90_000 } = {}) {
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
  const historyLine = history.length    ? `最近对话：${history.slice(-6).map(row => `${row.role === 'user' ? '用户' : '助手'}：${row.text}`).join(' / ')}`
    : '';
  // 画面实测：页面用 editor.analyze 在真实像素上量出来的数字。
  // 这不是"看见了图"，是"量过了图" —— 措辞上必须区分，不能让它冒充视觉理解。
  const observed = observation && typeof observation === 'object' ? observation : null;
  const observationLine = observed
    ? [
      `画面实测（来自画布像素，非猜测）：平均亮度 ${num(observed.luminance?.mean)}（标准差 ${num(observed.luminance?.stdDev)}）`,
      `高光裁切 ${percent(observed.clipping?.highlights)} / 暗部裁切 ${percent(observed.clipping?.shadows)}`,
      `主色 ${(Array.isArray(observed.palette) ? observed.palette : []).slice(0, 4).map(item => `${item.hex}(${percent(item.share)})`).join(' ') || '无'}`,
      `平均 RGB ${num(observed.colourCast?.r)}/${num(observed.colourCast?.g)}/${num(observed.colourCast?.b)}（色偏 ${num(observed.colourCast?.spread)}）`,
      `清晰度 Laplacian 方差 ${num(observed.sharpness?.laplacianVariance)}`,
      `不透明像素占比 ${percent(observed.opaqueRatio)}`,
    ].join('；')
    : '';
  const observationRule = observed
    ? '上一条"画面实测"是你唯一关于画面内容的依据：可以据此回答亮度/对比/色偏/裁切/清晰度/主色/留白这类问题，并给出具体数值与改动建议。'
      + '但它**不是视觉**——你无法识别画面里的物体、人物、文字、场景或构图含义。'
      + '用户问"图里有什么/画的是什么"时，直说你能给的是实测数值，请对方说明画面内容或上传原图，不要猜，也不要说"我看到了"。'
    : '你没有画面像素信息；涉及画面内容时不要猜测，请对方说明或上传原图。';
  const photoshopLine = photoshop?.enabled === true && Array.isArray(photoshop.actions) && photoshop.actions.length
    ? `Photoshop COM 已启用（Windows）；可用固定 action：${photoshop.actions.join('、')}。它操作 Photoshop 独立活动文档。写操作由页面预览目标文档并确认，再经 DSH 原生审批。每轮只提议一个 Photoshop action，不与 miniPaint 命令混成事务。`
    : 'Photoshop COM 未启用；不要提议 Photoshop action。';
  const user = `${photoshopLine}\n${contextLine}${observationLine ? `\n${observationLine}` : ''}\n${observationRule}${historyLine ? `\n${historyLine}` : ''}\n用户说：${text}`;

  const { text: answer, model } = await callModel(ctx, {
    system: `${SYSTEM}\n${JSON_HINT}`,
    user,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const plan = parsePlan(answer, { photoshop });
  return { reply: plan.reply, ops: plan.ops, droppedOps: plan.droppedOps || 0, engine: model, model: model, provider: info.provider };
}
