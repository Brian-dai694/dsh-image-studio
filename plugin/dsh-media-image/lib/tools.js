// The five model-facing image tools: read, apply, query plus the export start/status pair.
// Parameters are the 0.2.x schema DSL (property table), not raw JSON Schema.
import { defineTool } from '@deepseek-ai/dsh-tools';
import { MediaBridgeError, HIGH_RISK_COMMANDS } from './bridge.js';
import { describeCommands, summarize, suggestOperation } from './commands.js';
import { validateRecipeSteps, fillRecipeParams, recipeParamsOf } from './recipes.js';
import { reviewMeasurements, summarizeMeasurements } from './analyze.js';
import {
  HIGH_RISK_OPERATIONS, digestOf, requestHumanApproval, createSessionBindings, trustedSessionId, APPROVAL_WAIT_MS,
  AUTONOMOUS_CAPABILITIES, NEVER_AUTONOMOUS,
} from './gate.js';

// Host budget for a call that may wait for a human decision. It must sit above the
// plugin's own APPROVAL_WAIT_MS so the structured APPROVAL_TIMEOUT wins instead of the
// host's blunt TOOL_TIMEOUT, and it never applies to a plain media round trip, which
// bridge.js still bounds at 10s. No media command is extended to an unbounded wait.
const APPROVAL_BUDGET_MS = APPROVAL_WAIT_MS + 30_000;

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', required: true, enum: ['applied', 'rejected', 'pending', 'unknown'] },
    commandId: { type: 'string', required: true },
    editorKind: { type: 'string', enum: ['image'] },
    projectId: { type: 'string' },
    revision: { type: 'integer' },
    stateDigest: { type: 'string' },
    afterDigest: { type: 'string' },
    canUndo: { type: 'boolean' },
    canRedo: { type: 'boolean' },
    approvalId: { type: 'string' },
    auditRef: { type: 'string' },
    exportId: { type: 'string' },
    artifactRef: { type: 'string' },
    // 生成作业：assetRef 复用上面那个字段，这里只补作业自身的标识与阶段。
    jobId: { type: 'string' },
    provider: { type: 'string' },
    jobStatus: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed', 'unknown'] },
    providers: { type: 'array', items: { type: 'object', additionalProperties: true } },
    changedObjectIds: { type: 'array', items: { type: 'string' } },
    objectKind: { type: 'string', enum: ['layer', 'clip', 'overlay', 'track'] },
    // 编辑器算出来的结构化结果（当前用于 layer.align 的落点），供调用方核对而无需再读一次状态。
    detail: { type: 'object', additionalProperties: true },
    // 本次调用实际使用的授权（binding 是 Host 侧事实，模型只能读不能改）。
    grant: {
      type: 'object',
      additionalProperties: false,
      properties: {
        source: { type: 'string', enum: ['native', 'panel', 'verified-register', 'unknown'] },
        grantId: { type: 'string' },
        issuedAt: { type: 'integer' },
        expiresAt: { type: 'integer' },
        expiresInMs: { type: 'integer' },
      },
    },
    // 未授权时给模型的一句下一步（去面板点授权 / 去原生会话批准）。
    hint: { type: 'string' },
    // 命令目录（media_image_list_commands）：每条命令的契约与当前就绪度。
    commands: { type: 'array', items: { type: 'object', additionalProperties: true } },
    // 自检：测量值 + 可执行建议。
    analysis: { type: 'object', additionalProperties: true },
    findings: { type: 'array', items: { type: 'object', additionalProperties: true } },
    summary: { type: 'string' },
    note: { type: 'string' },
    // 预录流程
    recipe: { type: 'object', additionalProperties: true },
    recipeList: { type: 'array', items: { type: 'object', additionalProperties: true } },
    preview: {
      type: 'object',
      additionalProperties: false,
      properties: { dataUrl: { type: 'string' }, width: { type: 'integer' }, height: { type: 'integer' }, bytes: { type: 'integer' }, overlay: { type: 'object', additionalProperties: true } },
    },
    // 批量执行：逐步结果与回滚情况。
    steps: { type: 'array', items: { type: 'object', additionalProperties: true } },
    rolledBack: {
      type: 'object',
      additionalProperties: false,
      properties: { undone: { type: 'integer' }, restored: { type: 'boolean' } },
    },
    context: { type: 'object', additionalProperties: true },
    counts: { type: 'object', additionalProperties: true },
    stateUnavailable: {
      type: 'object',
      additionalProperties: false,
      properties: { code: { type: 'string' }, message: { type: 'string' } },
    },
    state: { type: 'json' },
    error: {
      type: 'object',
      additionalProperties: false,
      properties: {
        code: { type: 'string', required: true },
        message: { type: 'string', required: true },
        retryable: { type: 'boolean' },
      },
    },
  },
};

const READ_PARAMS = {
  editorKind: { type: 'string', enum: ['image'], description: 'Editor family; must match the tool.' },
  instanceId: { type: 'string', required: true, description: 'Connected editor instance id reported by the page.' },
  projectId: { type: 'string', required: true, description: 'Explicit project id from the editor panel; omission is rejected.' },
  bind: { type: 'boolean', description: 'First call only: true requests native human approval to bind this real session to this exact editor/page/project. Never bypass approval; subsequent calls omit bind.' },
};

const OPERATION_CONTRACT = {
  image: 'layer.add_text {text,x?,y?,style?:{size,family,fill_color,bold,italic},fontUrl?} (fontUrl must be /media-image/fonts/<48-char id> from POST /media-image/fonts, and needs style.family; the editor fetches the bytes with its token and registers a FontFace); layer.update_text {layerId,text,fontUrl?}; layer.add_image {sourceRef,x?,y?,width?,height?,fit?:"stretch"|"contain"|"cover",name?,maskRef?,maskMode?:"luminance"|"alpha",maskInvert?,featherPx?} (approval; keeps alpha, width/height as a pair or omitted for source size). sourceRef supports layer:<layerId> (copy an existing layer), uploaded asset:<48-char-id>, or data:image/(png|jpeg|webp);base64,... up to 256 KB decoded; read_state lists only asset metadata. maskRef clips the new layer by a mask and uses the same three forms plus "selection:" (the live marquee of the editor; requires the selection tool to be active, otherwise NO_SELECTION). maskRect {x,y,width,height} clips by an explicit canvas-space rectangle and needs no tool state; maskRef and maskRect are mutually exclusive. maskMode defaults to alpha for layer:<id>/selection: and luminance for assets, maskInvert flips coverage, featherPx 0..64 softens the edge (pixel math in dsh-pixel-ops.applyMask). read_state.selection reports the live marquee bounds (null when absent) so callers can choose between selection: and maskRect. Typical cut-out: insert a generated background with maskRef=layer:<product> so the product area stays transparent. layer.set_frame {layerId,x?,y?,width?,height?,fit?,anchor?:"top-left"|"center"} (pixel frame; one side derives the other from the layer ratio; at least one field); layer.align {layerId,h?:"left"|"center"|"right",v?:"top"|"middle"|"bottom",margin? 0..4096,to?:"canvas"} (align the layer frame to the canvas edges or centre with an optional inset; at least one of h/v; the editor computes x/y, so this is how you snap an element to a slot instead of guessing coordinates; the applied x/y come back in the result detail.aligned, and rotated layers are flagged because their real bounding box is larger than the frame); layer.feather {layerId,radiusPx 1..64} (alpha edge only, recomputed from the editor-internal pre-edit snapshot, idempotent); layer.color_match {layerId,method:"reinhard",strength? 0..1,reference?:"canvas"|"below"|{x,y,width,height}} (idempotent from the same snapshot; read_state exposes only colorMatch{applied,strength,fromDigest} and feather{radiusPx,fromDigest}); layer.set_transform {layerId,x?,y?,scaleX?,scaleY?,rotationDeg?} (flat fields, positive scales); layer.set_appearance {layerId,opacity?,blendMode?,name?} (at least one field; opacity 0..100, blendMode is a canvas globalCompositeOperation such as source-over/multiply/screen/overlay, name 1..120 chars; read_state echoes opacity and blendMode); layer.set_visibility {layerId,visible}; layer.reorder {layerId,toIndex}; layer.remove {layerId} (approval); canvas.resize {width,height} changes canvas bounds without scaling layers; canvas.crop {x,y,width,height} (approval), integer pixels, dimensions 1..16384; history.undo {} for global undo, or {targetCommandId,afterDigest} for guarded last-command undo; history.redo {} (empty history returns HISTORY_EMPTY). read_state layers carry sourceRef/frame/hasAlpha/maskSource plus the derived feather/colorMatch fields. Query read_state for ids. Commands require matching editor implementation; unsupported commands are rejected.',
};

const WRITE_PARAMS = kind => ({
  editorKind: { type: 'string', required: true, enum: [kind], description: `Must be "${kind}".` },
  projectId: { type: 'string', required: true, description: 'Explicit Host-bound project id; omission or another project is rejected.' },
  instanceId: { type: 'string', required: true, description: 'Connected editor instance id.' },
  commandId: { type: 'string', required: true, description: 'Idempotency key; a repeat returns the first outcome.' },
  expectedRevision: { type: 'integer', required: true, description: 'Revision from the latest read_state.' },
  mode: { type: 'string', enum: ['assist', 'autonomous'], description: 'assist writes directly for low risk; autonomous needs a plugin capability.' },
  operation: { type: 'string', required: true, description: 'layer.* or canvas.* or history.* operation name.' },
  targets: { type: 'array', items: { type: 'string' }, description: 'Affected object ids for the audit summary.' },
  params: { type: 'json', description: OPERATION_CONTRACT[kind] },
  approvalId: { type: 'string', description: 'Only for high-risk writes: the id returned by the earlier pending result.' },
});

const QUERY_PARAMS = {
  editorKind: { type: 'string', enum: ['image'] },
  instanceId: { type: 'string', required: true },
  commandId: { type: 'string', required: true, description: 'The original commandId to query.' },
  projectId: { type: 'string', required: true, description: 'Explicit Host-bound project id.' },
};

const EXPORT_START_PARAMS = kind => ({
  editorKind: { type: 'string', required: true, enum: [kind] },
  projectId: { type: 'string', required: true, description: 'Explicit Host-bound project id.' },
  instanceId: { type: 'string', required: true },
  commandId: { type: 'string', required: true, description: 'Idempotency key for the export request.' },
  expectedRevision: { type: 'integer', required: true, description: 'The exported artifact is traceable to this revision.' },
  format: { type: 'string', required: true, enum: ['png', 'jpeg'] },
});

const EXPORT_STATUS_PARAMS = kind => ({
  editorKind: { type: 'string', enum: [kind] },
  instanceId: { type: 'string', required: true },
  exportId: { type: 'string', required: true },
  projectId: { type: 'string', required: true, description: 'Explicit Host-bound project id.' },
});

// 生成工具：不带 instanceId/projectId —— 它不碰工程，只产出素材。
// 给 jobId 就是查询该作业，否则是提交新作业。
const GENERATE_PARAMS = {
  editorKind: { type: 'string', enum: ['image'] },
  provider: { type: 'string', description: 'Provider id (see the provider list). Required when submitting a new job.' },
  prompt: { type: 'string', description: 'Generation prompt used when submitting; keep it descriptive and concrete.' },
  width: { type: 'integer', description: 'Requested width 16..8192 when submitting.' },
  height: { type: 'integer', description: 'Requested height 16..8192 when submitting.' },
  idempotencyKey: { type: 'string', description: 'Optional key: the same key returns the same job instead of submitting twice.' },
  jobId: { type: 'string', description: 'Poll an existing job instead of submitting a new one.' },
};

// The model only ever sees this text, never the canonical value. An export therefore has
// to surface `exportId` (the only handle for the follow-up status call) and the finished
// `artifactRef`; writes keep the compact status/command/revision shape.
const renderSummary = (_args, value) => [{
  type: 'text',
  text: [
    `${value.status} · ${value.commandId}${value.revision === undefined ? '' : ` · R${value.revision}`}`,
    ...(value.exportId ? [`exportId ${value.exportId}`] : []),
    ...(value.artifactRef ? [`artifactRef ${value.artifactRef}`] : []),
    ...(value.jobId ? [`jobId ${value.jobId}${value.jobStatus ? ` (${value.jobStatus})` : ''}`] : []),
    // 编辑器算出来的落点等结构化结果：模型只看得到这段文本，所以必须写进正文。
    ...(value.detail && typeof value.detail === 'object' ? [`detail ${JSON.stringify(value.detail).slice(0, 2000)}`] : []),
    ...(value.error ? [value.error.code] : []),
  ].join(' · '),
}];

// read_state is the only way a model learns projectId / digest / history, so the render
// must carry them as text; the model never sees the tool's canonical JSON value.
const compactState = state => {
  const keys = ['editorKind', 'documentId', 'revision', 'canvas', 'history', 'selectedLayerId', 'selectedObjects', 'timeline', 'capabilities'];
  const result = Object.fromEntries(keys.filter(key => state[key] !== undefined).map(key => [key, state[key]]));
  // 只暴露素材元数据（id/名称/尺寸/字节/类型），像素与内部快照不在 read_state 里。
  for (const key of ['layers', 'assets', 'clips', 'overlays', 'tracks']) if (Array.isArray(state[key])) {
    result[key] = state[key].slice(0, 40);
    result[`${key}Count`] = state[key].length;
    result[`${key}Truncated`] = state[key].length > 40;
  }
  const text = JSON.stringify(result);
  return text.length <= 16000 ? text : JSON.stringify({ revision: state.revision, canvas: state.canvas, history: state.history, selectedObjects: state.selectedObjects?.slice(0, 1), truncated: true, message: 'State exceeds render budget; narrow selection in editor before editing.' }).slice(0, 16000);
};
const renderReadState = (_args, value) => [{
  type: 'text',
  text: value.status === 'applied'
    ? [
      `${value.editorKind} · R${value.revision}`,
      `projectId ${value.projectId}`,
      `stateDigest ${value.stateDigest ?? 'unknown'}`,
      `undo ${value.canUndo === true ? 'yes' : 'no'} · redo ${value.canRedo === true ? 'yes' : 'no'}`,
      `objects ${compactState(value.state ?? {})}`,
    ].join(' · ')
    : `${value.status} · ${value.commandId}${value.error ? ` · ${value.error.code}` : ''}`,
}];
// 被修改对象的 id 只来自编辑器回执，不猜、不拿"选中"凑数；撤销/重做同样照回执如实反映。
// objectKind 优先取回执里的值（撤销时命令前缀看不出类型），否则按命令前缀推断。
const OBJECT_KINDS = ['layer', 'clip', 'overlay', 'track'];
const objectKindOf = (operation, result) => {
  if (OBJECT_KINDS.includes(result?.objectKind)) return result.objectKind;
  if (typeof operation !== 'string') return undefined;
  if (operation.startsWith('layer.')) return 'layer';
  if (operation.startsWith('media.video.clip.')) return 'clip';
  if (operation.startsWith('media.video.overlay.')) return 'overlay';
  if (operation.startsWith('media.video.track.')) return 'track';
  return undefined;
};

// 面板不解析那行人读文本：凭据同时以结构化字段进 meta，且与文本行同源同值。
// 写命令/查询带 commandId、写命令带 appliedRevision（= 新 revision）、afterDigest；
// 导出带 exportId/artifactRef/format；失败带 errorCode（沿用 REVISION_CONFLICT 等稳定码）。
const presentationMeta = (args, value) => ({
  operation: args.operation,
  status: value.status,
  editorKind: value.editorKind,
  projectId: value.projectId,
  stateDigest: value.stateDigest,
  approvalId: value.approvalId,
  auditRef: value.auditRef,
  ...(typeof args.commandId === 'string' ? { commandId: value.commandId ?? args.commandId } : {}),
  ...(Number.isSafeInteger(value.revision) ? { appliedRevision: value.revision } : {}),
  ...(typeof value.afterDigest === 'string' && value.afterDigest ? { afterDigest: value.afterDigest } : {}),
  ...(typeof value.exportId === 'string' && value.exportId ? { exportId: value.exportId } : {}),
  ...(typeof value.artifactRef === 'string' && value.artifactRef ? { artifactRef: value.artifactRef } : {}),
  ...(typeof value.jobId === 'string' && value.jobId ? { jobId: value.jobId } : {}),
  ...(typeof value.provider === 'string' && value.provider ? { provider: value.provider } : {}),
  ...(typeof value.jobStatus === 'string' && value.jobStatus ? { jobStatus: value.jobStatus } : {}),
  ...(typeof args.format === 'string' ? { format: args.format } : {}),
  ...(value.error?.code ? { errorCode: value.error.code } : {}),
  ...(Array.isArray(value.changedObjectIds) && value.changedObjectIds.length
    ? { changedObjectIds: value.changedObjectIds, ...(value.objectKind ? { objectKind: value.objectKind } : {}) }
    : {}),
});

const envelope = (kind, extra) => ({ status: 'rejected', commandId: 'unknown', editorKind: kind, ...extra });

function failure(kind, commandId, error, context = {}) {
  const code = error?.code || 'EDITOR_ERROR';
  // 命令名写错是最常见的失败（名字长、点号多）：给出近似名，别让调用方反复试。
  const suggestions = code === 'UNSUPPORTED_COMMAND' && context.operation ? suggestOperation(context.operation) : [];
  // 未授权必须说清楚怎么授权，且不能和「编辑器未就绪」混在一起。
  const hint = code === 'UNSUPPORTED_COMMAND' && suggestions.length
    ? `未知命令 ${String(context.operation ?? '')}。相近的有：${suggestions.join('、')}；完整目录见 media_image_list_commands。`
    : code === 'SESSION_BINDING_REQUIRED'
    ? '请本人在编辑器面板点“授权此会话读写本工程”（不依赖宿主审批；票据 5 分钟一次性）。'
    : code === 'SESSION_APPROVAL_UNAVAILABLE'
      ? '宿主审批不可用（策略可能是 never，这不是你拒绝了）。请改用编辑器面板的“授权此会话读写本工程”。'
      : code === 'SESSION_BINDING_EXPIRED'
        ? '授权已到期（软上限 8 小时）；请本人在面板重新授权。'
        : undefined;
  return envelope(kind, {
    commandId,
    error: {
      code,
      message: error?.message || 'Editor request failed.',
      retryable: error?.code === 'EDITOR_TIMEOUT' || error?.code === 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN' || code === 'SESSION_BINDING_REQUIRED' || code === 'SESSION_APPROVAL_UNAVAILABLE'
        || code === 'GENERATION_UNREACHABLE' || code === 'GENERATION_BUSY',
    },
    ...(hint ? { hint } : {}),
    // Any error that may have landed a write is `unknown`, never `rejected`.
    ...(error?.code === 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN' || error?.outcomeUnknown === true ? { status: 'unknown' } : {}),
  });
}

const agentKey = trustedSessionId;

// DSH requires every tool value and presentationMeta to be lossless JSON:
// no undefined, no NaN/Infinity, no functions. Optional fields are dropped instead
// of leaking `undefined`, which is what tripped `output.presentationMeta returned
// non-lossless JSON` on every successful path.
// DSH validates execute value, output.render and output.presentationMeta through the same
// walkJsonValue snapshot: it reads every enumerable property and never skips `undefined`.
// Optional fields are therefore OMITTED rather than set to null (a null in a `type:'string'`
// schema field would fail output.schema next). Non-finite numbers become null, -0 becomes 0,
// and non-plain values are normalized instead of leaking into the snapshot.
export function toLosslessJson(value) {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') {
    if (!Number.isFinite(value)) return null;
    return Object.is(value, -0) ? 0 : value;
  }
  if (type === 'bigint') return String(value);
  if (type === 'undefined') return null;
  if (type === 'function' || type === 'symbol') return null;
  if (Array.isArray(value)) return value.map(item => toLosslessJson(item));
  // Non-plain objects are not lossless JSON; normalize the common ones instead of
  // letting them reach the snapshot validator.
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, code: value.code ?? null, message: value.message };
  if (value instanceof Map) return toLosslessJson(Object.fromEntries(value));
  if (value instanceof Set) return toLosslessJson([...value]);
  if (value instanceof RegExp) return value.source;
  if (ArrayBuffer.isView(value)) return toLosslessJson([...value]);
  if (type === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
      out[key] = toLosslessJson(item);
    }
    return out;
  }
  return null;
}

// 注册本包的全部模型工具（图片 5 个 / 视频 5 个）。
// 每个 execute 先过 toLosslessJson 再做 schema 快照校验，避免 undefined 导致
// "non-lossless JSON"；binding 校验与审批在各自 execute 内完成。
export function registerMediaTools(ctx, { bridge, approvals, bindings = createSessionBindings({ resolvePage: (_kind, instanceId) => bridge.getPage?.(instanceId) ?? null }), assets = null, generation = null, recipes = null, photoshop = null }) {
  const appliedCommands = new Map();
  const verify = async (kind, bridge, args, exec) => {
    const binding = bindings.assert(exec, kind, args);
    try {
      const state = await bridge.readState({ instanceId: binding.instanceId, projectId: binding.projectId });
      if (state.documentId !== binding.projectId) throw new MediaBridgeError('DOCUMENT_MISMATCH', 'The editor document changed; create a new dedicated session.');
      return state;
    } catch (error) {
      if (['DOCUMENT_MISMATCH', 'EDITOR_NOT_READY', 'EDITOR_INSTANCE_MISMATCH'].includes(error.code)) bindings.invalidate(binding.sessionId);
      throw error;
    }
  };
  // Wrap once here so every tool (current and future) is covered, instead of
  // depending on each execute() remembering to strip undefined. `render` needs the
  // same treatment: its ContentBlocks go through the identical snapshot validator.
  const register = definition => {
    const originalMeta = definition.output?.presentationMeta;
    const originalRender = definition.output?.render;
    return ctx.tools.register({
      ...definition,
      execute: async (args, exec) => toLosslessJson(await definition.execute(args, exec)),
      output: {
        ...definition.output,
        ...(originalRender ? { render: (args, value) => toLosslessJson(originalRender(args, value)) } : {}),
        ...(originalMeta ? { presentationMeta: (args, value) => toLosslessJson(originalMeta(args, value)) } : {}),
      },
    });
  };

  // 首次调用带 bind:true 时登记授权：先面板票据（不依赖宿主审批），再原生审批；
  // 之后每次读取都复核绑定与工程一致，并把授权来源如实回读。
  const readState = (kind, bridge) => async (args, exec) => {
    try {
      if (args.bind === true) await bindings.bind(exec, {
        editorKind: kind, instanceId: args.instanceId, projectId: args.projectId,
        readState: () => bridge.readState({ instanceId: args.instanceId, projectId: args.projectId }),
        approve: (reason, signal) => requestHumanApproval(ctx, { agent: exec.agent, toolName: `media_${kind}_read_state`, callId: exec.callId, reason, signal: signal ?? exec.signal }),
      });
      const state = await verify(kind, bridge, args, exec);
      if (kind === 'image' && assets) state.assets = assets.list();
      const binding = bindings.bindingOf?.(agentKey(exec)) ?? null;
      // 契约 §4：grant:{source,grantId,issuedAt,expiresAt,expiresInMs}|null
      const grant = binding ? {
        source: binding.source || 'unknown',
        grantId: binding.grantId ?? null,
        issuedAt: Number.isFinite(binding.issuedAt) ? binding.issuedAt : (Number.isFinite(binding.grantedAt) ? binding.grantedAt : null),
        expiresAt: Number.isFinite(binding.expiresAt) ? binding.expiresAt : null,
        expiresInMs: Number.isFinite(binding.expiresAt) ? Math.max(0, binding.expiresAt - Date.now()) : null,
      } : null;
      return {
        status: 'applied',
        commandId: 'read_state',
        editorKind: kind,
        projectId: state.documentId,
        revision: state.revision,
        stateDigest: state.stateDigest,
        canUndo: !!state.history?.canUndo,
        canRedo: !!state.history?.canRedo,
        ...(grant ? { grant } : {}),
        state,
      };
    } catch (error) {
      return failure(kind, 'read_state', error);
    }
  };

  const getCommandResult = (kind, bridge) => async (args, exec) => {
    try {
      await verify(kind, bridge, args, exec);
      const result = await bridge.getCommandResult({ instanceId: args.instanceId, commandId: args.commandId });
      const original = result.originalResult;
      return {
        status: result.status === 'applied' ? 'applied' : result.status,
        commandId: args.commandId,
        editorKind: kind,
        ...(original?.revision !== undefined ? { revision: original.revision } : {}),
        ...(original?.stateDigest ? { stateDigest: original.stateDigest } : {}),
      };
    } catch (error) {
      return failure(kind, args.commandId, error);
    }
  };

  // 写入工具主体：绑定门禁 → 指纹去重 → revision 前置检查 → 重复失败熔断 → 高风险审批 → 提交。
  // 回执带 commandId/revision/afterDigest，供模型做后续定向撤销与冲突判断。
  //
  // 熔断（借鉴 LayerShop 的「同一调用失败两次就拒」）：同一个 operation+params 连续失败两次，
  // 第三次直接拒绝并要求改参数——否则模型会在同一个错误上反复重试。
  const repeatedFailures = new Map();
  const failureKeyOf = (kind, operation, params) => `${kind}\0${operation}\0${digestOf(params ?? null)}`;
  const applyCommand = (kind, bridge, toolName) => async (args, exec) => {
    const commandId = args.commandId;
    const operation = args.operation;
    const failKey = failureKeyOf(kind, operation, args.params);
    try {
      const binding = bindings.assert(exec, kind, args);
      const key = `${binding.sessionId}\0${kind}\0${args.instanceId}\0${commandId}`;
      const fingerprint = digestOf({ projectId: args.projectId, operation, params: args.params ?? {}, expectedRevision: args.expectedRevision });
      const state = await verify(kind, bridge, args, exec);
      const cached = appliedCommands.get(key);
      if (cached) {
        if (cached.fingerprint !== fingerprint) throw new MediaBridgeError('COMMAND_ID_REUSED', 'This commandId is already bound to different arguments.');
        return cached.value;
      }
      const failedTimes = repeatedFailures.get(failKey) || 0;
      if (failedTimes >= 2) {
        return envelope(kind, {
          commandId,
          revision: state.revision,
          stateDigest: state.stateDigest,
          error: {
            code: 'REPEATED_FAILURE',
            message: `This exact ${operation} call already failed ${failedTimes} times; change the parameters or ask the user instead of retrying it.`,
            retryable: false,
          },
          hint: '读一次 read_state 确认前提（图层/选区/蒙版是否还在），再换参数或换做法。',
        });
      }
      if (state.revision !== args.expectedRevision) {
        return envelope(kind, { commandId, revision: state.revision, stateDigest: state.stateDigest, error: { code: 'REVISION_CONFLICT', message: `Project is at revision ${state.revision}; read_state again before writing.`, retryable: true } });
      }

      // projectId may be omitted: the instance's current document is authoritative.
      const projectId = args.projectId ?? state.documentId;
      const paramsDigest = digestOf(args.params ?? null);
      const highRisk = HIGH_RISK_OPERATIONS[kind]?.has(operation) === true;
      // 本人已授权 autonomous 模式执行全部内置命令（含破坏性/烤平/外部像素类），
      // 因此自主模式下不再等人工审批；assist 模式保持原样（逐次审批）。
      const autonomous = exec?.mode === 'autonomous' || exec?.autonomous === true;
      let approvalId;

      if (highRisk && !autonomous) {
        const agent = agentKey(exec);
        if (!args.approvalId) {
          const issued = approvals.issue({ agentId: agent, projectId, commandId, operation, paramsDigest, revision: state.revision, stateDigest: state.stateDigest });
          return envelope(kind, {
            status: 'pending',
            commandId,
            revision: state.revision,
            stateDigest: state.stateDigest,
            approvalId: issued.record.approvalId,
            error: { code: 'HUMAN_CONFIRMATION_REQUIRED', message: `High-risk ${operation} needs human approval; call again with approvalId after the user approves.`, retryable: true },
          });
        }
        const taken = approvals.take({ approvalId: args.approvalId, agentId: agent, projectId, commandId, operation, paramsDigest, revision: state.revision, stateDigest: state.stateDigest });
        if (!taken.ok) {
          return envelope(kind, { commandId, revision: state.revision, stateDigest: state.stateDigest, error: { code: taken.code, message: taken.message, retryable: taken.code === 'APPROVAL_EXPIRED' } });
        }
        const decision = await requestHumanApproval(ctx, {
          agent: exec?.agent,
          toolName,
          callId: commandId,
          reason: `Approve ${operation} on ${projectId} at revision ${state.revision}.`,
          signal: exec?.signal,
        });
        if (!decision.allowed) {
          return envelope(kind, { commandId, revision: state.revision, stateDigest: state.stateDigest, error: { code: decision.code, message: decision.message, retryable: false } });
        }
        approvalId = args.approvalId;
      }

      const result = await bridge.applyCommand({
        instanceId: args.instanceId,
        projectId,
        expectedRevision: args.expectedRevision,
        commandId,
        command: { type: operation, payload: args.params ?? {} },
      });
      const value = {
        status: 'applied',
        commandId,
        editorKind: kind,
        projectId,
        revision: result.revision,
        ...(result.stateDigest ? { stateDigest: result.stateDigest } : {}),
        ...(result.afterDigest ? { afterDigest: result.afterDigest } : {}),
        ...(Array.isArray(result.changedObjectIds) && result.changedObjectIds.length
          ? {
            changedObjectIds: result.changedObjectIds.filter(id => typeof id === 'string' && id),
            ...(objectKindOf(operation, result) ? { objectKind: objectKindOf(operation, result) } : {}),
          }
          : {}),
        ...(result.history?.canUndo !== undefined ? { canUndo: result.history.canUndo } : {}),
        ...(result.history?.canRedo !== undefined ? { canRedo: result.history.canRedo } : {}),
        // 编辑器算出来的结果（如 layer.align 落点）如实带回，省一次 read_state，也让"对到哪"可核对。
        ...(result.commandDetail && typeof result.commandDetail === 'object' ? { detail: result.commandDetail } : {}),
        ...(approvalId ? { approvalId } : {}),
        // 自主模式执行了平时需要审批的命令：在回执里如实标注，别让人以为它走过人工确认。
        ...(highRisk && autonomous ? {
          autonomous: true,
          note: `${operation} 通常需要人工确认，本次按本人授权在 autonomous 模式下直接执行；它在 miniPaint 里仍是一条可撤销的历史记录（不适用于 Photoshop）。`,
        } : {}),
        auditRef: `audit-${commandId}`,
      };
      appliedCommands.set(key, { fingerprint, value });
      repeatedFailures.delete(failKey);
      return value;
    } catch (error) {
      // 只有真的失败才计数；成功一次就把该参数组合的计数清零。
      repeatedFailures.set(failKey, (repeatedFailures.get(failKey) || 0) + 1);
      return failure(kind, commandId, error instanceof MediaBridgeError ? error : error, { operation, params: args.params });
    }
  };

  // 生成：不碰工程，因此不做会话绑定、不要 expectedRevision。成功只产出 asset:<id>，
  // 由模型再用 layer.add_image 显式落层 —— 生成永远不能自己改画布。
  const mapJob = (kind, job) => {
    const base = {
      commandId: job.jobId,
      editorKind: kind,
      jobId: job.jobId,
      provider: job.provider,
      jobStatus: job.status,
      ...(job.assetRef ? { artifactRef: job.assetRef } : {}),
    };
    if (job.status === 'succeeded') return { status: 'applied', ...base };
    if (job.status === 'failed') return { ...base, status: 'rejected', error: { code: 'GENERATION_FAILED', message: job.error || '生成失败', retryable: false } };
    if (job.status === 'unknown') return { ...base, status: 'unknown', error: { code: 'GENERATION_UNKNOWN', message: job.error || '生成结果未知，请再次查询该 jobId', retryable: true } };
    return { status: 'pending', ...base };
  };

  const generate = (kind, generation) => async args => {
    const commandId = args.jobId || 'generate';
    if (!generation || !generation.configured()) {
      return envelope(kind, {
        commandId,
        error: { code: 'PROVIDER_UNAVAILABLE', message: '未配置任何生成后端。', retryable: false },
        hint: '设置插件配置 generation.providers 或环境变量 DSH_MEDIA_IMAGE_PROVIDERS（JSON 数组）后重载插件。',
      });
    }
    try {
      if (args.jobId) return mapJob(kind, await generation.status(args.jobId));
      if (typeof args.prompt !== 'string' || !args.prompt.trim()) {
        // 没给 prompt 也没给 jobId：只做能力发现，列一下可用的 provider。
        return { status: 'applied', commandId, editorKind: kind, providers: generation.list() };
      }
      if (typeof args.provider !== 'string' || !args.provider) {
        return envelope(kind, {
          commandId,
          error: { code: 'INVALID_REQUEST', message: '提交生成任务必须指定 provider。', retryable: false },
          hint: '省略 prompt 调用本工具可列出已配置的 provider。',
        });
      }
      return mapJob(kind, await generation.submit({
        provider: args.provider, prompt: args.prompt, width: args.width, height: args.height, idempotencyKey: args.idempotencyKey,
      }));
    } catch (error) {
      return failure(kind, commandId, error);
    }
  };

  // 命令目录：让调用方在写入前知道「有哪些命令、现在能不能用、为什么不能」。
  // 绑定可用时顺手读一次状态算出就绪度；状态读不到就如实回 enabled:null，不假装可用。
  const listCommands = (kind, bridge) => async (args, exec) => {
    // 身份/绑定缺失必须 fail closed：目录工具也是工具，不能因为"只是列个目录"就跳过门禁。
    try { bindings.assert(exec, kind, args); }
    catch (error) { return failure(kind, 'list_commands', error); }
    let state = null;
    let stateError = null;
    try { state = await verify(kind, bridge, args, exec); }
    catch (error) {
      if (String(error?.code || '').startsWith('SESSION_')) return failure(kind, 'list_commands', error);
      stateError = { code: error?.code || 'STATE_UNAVAILABLE', message: error?.message || '状态不可用' };
    }
    const commands = describeCommands(state);
    const summary = state ? summarize(state) : null;
    return {
      status: 'applied',
      commandId: 'list_commands',
      editorKind: kind,
      ...(state?.documentId ? { projectId: state.documentId } : {}),
      ...(Number.isSafeInteger(state?.revision) ? { revision: state.revision } : {}),
      commands,
      ...(summary ? { context: summary } : {}),
      ...(stateError ? { stateUnavailable: stateError, hint: '先确认编辑器已连接并完成授权，再调用本工具可获得 enabled/disabledReason。' } : {}),
      counts: {
        total: commands.length,
        enabled: commands.filter(item => item.enabled === true).length,
        disabled: commands.filter(item => item.enabled === false).length,
        unknown: commands.filter(item => item.enabled === null).length,
      },
    };
  };

  register(defineTool({
    name: 'media_image_list_commands',
    description: 'List the allowlisted image commands with their parameter contract and, when the editor is reachable, whether each one can run now (enabled) and why not (disabledReason: no-document / no-selected-layer / selected-layer-is-text-not-image / ...). Read-only: it never writes. Call it before composing a sequence so you do not discover preconditions by failing a write.',
    parameters: READ_PARAMS,
    output: { schema: RESULT_SCHEMA, render: renderSummary, presentationMeta },
    execute: listCommands('image', bridge),
    timeoutMs: 10_000,
  }));

  if (photoshop?.describe?.().enabled === true) {
    const photoshopDescription = photoshop.describe();
    const photoshopWrites = new Set(photoshopDescription.writeActions || []);
    const photoshopReads = new Set(photoshopDescription.readActions || ['status']);
    const executePhotoshopAction = async (action, rawArguments, exec, { approved = false, confirm = false, timeoutMs, progId } = {}) => {
      const commandId = `photoshop-${exec?.callId || globalThis.crypto.randomUUID()}`;
      // 只把 action 自己声明的参数转过去；confirm/timeoutMs 走独立通道，
      // 免得 validate() 把 confirm 当成不支持的参数拒绝掉整次调用。
      const actionArguments = rawArguments && typeof rawArguments === 'object' && !Array.isArray(rawArguments)
        ? { ...rawArguments } : {};
      const { confirm: nestedConfirm, ...rest } = actionArguments;
      // timeoutMs / progId 是每个 action 都支持的公共字段，但来自工具层而不是 action 参数体。
      if (timeoutMs !== undefined) rest.timeoutMs = timeoutMs;
      if (progId !== undefined) rest.progId = progId;
      try {
        trustedSessionId(exec);
        const autonomous = exec?.mode === 'autonomous' || exec?.autonomous === true;
        const writes = photoshopWrites.has(action);
        const reads = photoshopReads.has(action);
        if (!writes && !reads) throw new MediaBridgeError('PHOTOSHOP_ACTION_INVALID', `不支持的 Photoshop action: ${action}`);
        const confirmed = confirm === true || nestedConfirm === true;
        // 本人已授权 autonomous 模式执行任何内置 Photoshop action，因此自主模式不再等人工审批，
        // 但 confirm 仍然要求：它是调用方对"这次会改外部应用"的显式声明，不是安全门。
        if (writes && !approved && !confirmed) throw new MediaBridgeError('PHOTOSHOP_CONFIRM_REQUIRED', 'Photoshop 写操作必须在参数里显式 confirm:true。');
        if (exec?.signal?.aborted) throw new MediaBridgeError('APPROVAL_CANCELLED', '请求已取消。');
        if (writes && !approved && !autonomous) {
          let currentDocument = null;
          try { currentDocument = photoshop.runAction({ action: 'status', arguments: {} }).document; } catch { /* still approve with explicitly unknown target doc */ }
          const activeName = currentDocument?.activeDocument?.name;
          const summary = JSON.stringify({ action, arguments: rest }).slice(0, 4000);
          const decision = await requestHumanApproval(ctx, {
            agent: exec?.agent, toolName: 'media_image_photoshop_action', callId: commandId,
            reason: `目标编辑器：Adobe Photoshop（独立于 miniPaint）。写操作 ${action} 将作用于 Photoshop 当前活动文档${activeName ? `「${activeName}」` : '（文档信息未知）'}，不会写入或共享 miniPaint 工程/撤销栈。请核对结构化 action 参数：${summary}`,
            signal: exec?.signal,
          });
          if (!decision.allowed) throw new MediaBridgeError(decision.code || 'APPROVAL_DENIED', decision.message || 'Photoshop 操作未获批准。');
        }
        const result = photoshop.runAction({ action, arguments: rest, confirm: writes ? true : undefined });
        return {
          status: 'applied', commandId, editorKind: 'image',
          photoshop: result,
          ...(autonomous && writes ? { autonomous: true } : {}),
          note: writes
            ? (autonomous
              ? `Photoshop ${action} 按本人授权在 autonomous 模式下直接执行；Photoshop 不在 miniPaint 的撤销栈里，回退要在 Photoshop 内手动做。`
              : 'Photoshop action 完成；操作的是 Photoshop 活动文档及其历史记录，不修改 miniPaint revision。')
            : 'Photoshop 状态查询完成；没有修改文档。',
        };
      } catch (error) {
        const value = failure('image', commandId, error);
        if (error?.outcomeUnknown) value.status = 'unknown';
        return value;
      }
    };

    register(defineTool({
      name: 'media_image_photoshop_action',
      description: 'Perform a fixed structured action in local Windows Photoshop through COM. Available to the same DSH assistant as miniPaint tools. Write actions need confirm:true; in assist mode they also require per-call DSH human approval, while autonomous mode runs them directly (the result is then flagged autonomous:true). Photoshop has its own active document/history, separate from miniPaint — actions here are NOT undoable through miniPaint history. Arbitrary JSX is not exposed.',
      parameters: {
        action: { type: 'string', required: true, enum: photoshopDescription.actions, description: 'Allowlisted Photoshop action.' },
        arguments: { type: 'object', required: true, additionalProperties: true, description: 'Action-specific structured arguments.' },
        confirm: { type: 'boolean', description: 'Required true for Photoshop write actions.' },
        timeoutMs: { type: 'integer', description: '1000..300000 milliseconds.' },
        progId: { type: 'string', description: 'Optional registered Photoshop COM ProgID.' },
      },
      output: { schema: RESULT_SCHEMA, render: renderSummary, presentationMeta },
      execute: (args, exec) => executePhotoshopAction(args.action, args.arguments, exec, {
        confirm: args.confirm === true,
      }),
      timeoutMs: APPROVAL_BUDGET_MS,
    }));

    // 任意 ExtendScript（本人明确要求暴露给 Agent）。
    // 与固定 action 的区别只有一点：脚本内容由调用方给，不再受 action 枚举约束。
    // 必须 confirm:true；assist 模式仍逐次人工审批，autonomous 模式按授权直接执行。
    register(defineTool({
      name: 'media_image_photoshop_run_jsx',
      description: 'Run arbitrary Adobe ExtendScript (JSX) in the active Photoshop document through COM. The script is handed to Photoshop\'s own DoJavaScript engine verbatim, so it can do anything Photoshop scripting can do, including reading/writing local files and closing the app. There is no sandbox and no automatic rollback, and it is NOT covered by miniPaint history. Requires confirm:true; assist mode additionally requires per-call DSH human approval, autonomous mode runs it directly and flags the result. If the call times out the outcome is unknown: inspect Photoshop and never blindly replay.',
      parameters: {
        jsx: { type: 'string', required: true, description: 'ExtendScript source, 1..65536 bytes. Passed through verbatim; no templating.' },
        confirm: { type: 'boolean', required: true, description: 'Must be true: this declares you intend to run a script with unrestricted Photoshop capabilities. A false value is rejected with PHOTOSHOP_CONFIRM_REQUIRED.' },
        timeoutMs: { type: 'integer', description: '1000..300000 milliseconds.' },
        progId: { type: 'string', description: 'Optional registered Photoshop COM ProgID.' },
      },
      output: { schema: RESULT_SCHEMA, render: renderSummary, presentationMeta },
      execute: (args, exec) => executePhotoshopAction('run_jsx', { jsx: args.jsx }, exec, {
        confirm: args.confirm === true,
        timeoutMs: args.timeoutMs,
        progId: args.progId,
      }),
      timeoutMs: APPROVAL_BUDGET_MS,
    }));

    // Shared assistant can route to Photoshop, but the model still emits only a fixed action enum + args.
    // UI shows an action-level review card and calls the same approved tool path.
    register(defineTool({
      name: 'media_image_assistant_photoshop_action',
      description: 'Internal shared-assistant Photoshop handoff. It runs one fixed structured action under the same policy as direct Photoshop writes (assist: human approval; autonomous: direct, flagged autonomous:true). Photoshop remains a separate document/history from miniPaint. Never accepts JSX.',
      parameters: {
        action: { type: 'string', required: true, enum: photoshopDescription.actions },
        arguments: { type: 'object', required: true, additionalProperties: true },
        confirm: { type: 'boolean', required: true, const: true },
      },
      output: { schema: RESULT_SCHEMA, render: renderSummary, presentationMeta },
      execute: (args, exec) => executePhotoshopAction(args.action, args.arguments, exec, { confirm: true }),
      timeoutMs: APPROVAL_BUDGET_MS,
    }));
  }

  // 批量执行 = 编辑器里的**一条**历史记录（history.batch → Bundle_action，自带"任一步失败就回滚已做的"）。
  // 所以工具层不再自己做 N 次写入 + N 次撤销：一次命令、一次 revision、一步撤销。
  const runPlan = (kind, bridge) => async (args, exec) => {
    const commandId = args.commandId;
    const steps = Array.isArray(args.steps) ? args.steps : [];
    try {
      bindings.assert(exec, kind, args);
      if (steps.length < 1 || steps.length > 12) throw new MediaBridgeError('INVALID_REQUEST', 'steps 必须是 1..12 条命令');
      const risky = steps.filter(step => HIGH_RISK_COMMANDS.has(step?.operation)).map(step => step.operation);
      if (risky.length) throw new MediaBridgeError('HIGH_RISK_IN_PLAN', `${risky.join('、')} 需要单独人工确认，不能放进批量计划`);
      // 自主模式下的批量：每一步都必须在可逆白名单内，且不在显式黑名单里。
      // 否则模型就能把一条被 guard 拒掉的命令塞进 history.batch 里绕过去。
      if (exec?.mode === 'autonomous' || exec?.autonomous === true) {
        const allowed = AUTONOMOUS_CAPABILITIES[kind] || new Set();
        const denied = NEVER_AUTONOMOUS[kind] || new Set();
        const forbidden = steps
          .map(step => step?.operation)
          .filter(operation => denied.has(operation) || !allowed.has(operation));
        if (forbidden.length) {
          throw new MediaBridgeError('AUTONOMOUS_STEP_DENIED', `自主模式只能执行可逆属性编辑；这些步骤不在允许范围：${[...new Set(forbidden)].join('、')}。请改成人工确认后执行。`);
        }
      }
      const state = await verify(kind, bridge, args, exec);
      if (state.revision !== args.expectedRevision) {
        return envelope(kind, { commandId, revision: state.revision, stateDigest: state.stateDigest, error: { code: 'REVISION_CONFLICT', message: `Project is at revision ${state.revision}; read_state again before writing.`, retryable: true } });
      }
      const projectId = args.projectId ?? state.documentId;
      const result = await bridge.applyCommand({
        instanceId: args.instanceId, projectId, expectedRevision: args.expectedRevision, commandId,
        command: { type: 'history.batch', payload: { steps: steps.map(step => ({ type: step.operation, payload: step.params ?? {} })) } },
      });
      return {
        status: 'applied', commandId, editorKind: kind, projectId,
        revision: result.revision,
        ...(result.stateDigest ? { stateDigest: result.stateDigest } : {}),
        ...(result.afterDigest ? { afterDigest: result.afterDigest } : {}),
        ...(Array.isArray(result.changedObjectIds) && result.changedObjectIds.length ? { changedObjectIds: result.changedObjectIds, objectKind: 'layer' } : {}),
        ...(result.history?.canUndo !== undefined ? { canUndo: result.history.canUndo } : {}),
        steps: steps.map((step, index) => ({ step: index + 1, operation: step.operation })),
        auditRef: `audit-${commandId}`,
      };
    } catch (error) {
      return failure(kind, commandId, error, { operation: 'history.batch' });
    }
  };

  register(defineTool({
    name: 'media_image_run_plan',
    description: 'Execute an ordered list of NON-high-risk image commands in one call (1..12 steps). Each step runs as its own idempotent command derived from commandId. If any step fails, the steps already applied are undone and the result reports how many were rolled back and whether the document content digest returned to its pre-plan value. High-risk operations (layer.remove, canvas.crop, layer.add_image) are rejected here: they must go through media_image_apply_command one at a time, so a batch can never hide a destructive step. In autonomous mode every step must also be allowed by AUTONOMOUS_CAPABILITIES and not re-blocked in NEVER_AUTONOMOUS, otherwise the whole plan is rejected with AUTONOMOUS_STEP_DENIED before anything is sent.',
    parameters: {
      editorKind: { type: 'string', required: true, enum: ['image'] },
      projectId: { type: 'string', required: true, description: 'Explicit Host-bound project id.' },
      instanceId: { type: 'string', required: true, description: 'Connected editor instance id.' },
      commandId: { type: 'string', required: true, description: 'Idempotency key for the whole plan; per-step ids are derived from it.' },
      expectedRevision: { type: 'integer', required: true, description: 'Revision from the latest read_state.' },
      steps: { type: 'array', required: true, items: { type: 'object', additionalProperties: true }, description: 'Ordered [{operation, params}] steps; each operation must be in the allowlist and not high risk.' },
    },
    output: { schema: RESULT_SCHEMA, render: renderSummary, presentationMeta },
    execute: runPlan('image', bridge),
    timeoutMs: APPROVAL_BUDGET_MS,
  }));

  // 只读自检：在降采样合成图上量曝光/裁切/偏色/清晰度，外加图层体检。
  // 让调用方"量一遍再改"，而不是做完就宣称完成。绝不改画布。
  const analyze = (kind, bridge) => async (args, exec) => {
    try {
      bindings.assert(exec, kind, args);
      const state = await verify(kind, bridge, args, exec);
      const analysis = await bridge.analyze({ instanceId: args.instanceId, ...(args.maxSide === undefined ? {} : { maxSide: args.maxSide }) });
      const findings = reviewMeasurements(analysis);
      return {
        status: 'applied', commandId: 'analyze', editorKind: kind,
        projectId: state.documentId, revision: state.revision,
        ...(state.stateDigest ? { stateDigest: state.stateDigest } : {}),
        analysis,
        findings,
        summary: summarizeMeasurements(analysis),
        counts: { findings: findings.length, high: findings.filter(item => item.severity === 'high').length, warn: findings.filter(item => item.severity === 'warn').length },
        note: '只测量、不改画布；findings 里的 suggestedCommand 都是白名单命令，仍需另行提交。',
      };
    } catch (error) {
      return failure(kind, 'analyze', error);
    }
  };

  register(defineTool({
    name: 'media_image_analyze',
    description: 'Measure the shared image without changing it: mean luminance, 8-bucket histogram, shadow/highlight clipping ratios, colour cast (mean R/G/B spread), sharpness (Laplacian variance on a downsampled composite), plus layer checks (off-canvas, zero size, estimated text overflow). Returns findings[] where each item names a real allowlisted command that could address it. Read-only: revision does not change. Measure before claiming a correction worked.',
    parameters: {
      ...READ_PARAMS,
      maxSide: { type: 'integer', description: 'Downsample long edge (64..640, default 320). Lower is faster and coarser.' },
    },
    output: { schema: RESULT_SCHEMA, render: renderSummary, presentationMeta },
    execute: analyze('image', bridge),
    timeoutMs: 10_000,
  }));

  // 缩略预览：只读。能不能"看见"取决于宿主是否渲染 tool 结果里的图，这里不做任何承诺。
  const preview = (kind, bridge) => async (args, exec) => {
    try {
      bindings.assert(exec, kind, args);
      const state = await verify(kind, bridge, args, exec);
      const image = await bridge.preview({
        instanceId: args.instanceId,
        ...(args.maxWidth === undefined ? {} : { maxWidth: args.maxWidth }),
        ...(args.grid === undefined ? {} : { grid: args.grid }),
        ...(args.gridStep === undefined ? {} : { gridStep: args.gridStep }),
        ...(args.layerId === undefined ? {} : { layerId: args.layerId }),
        ...(args.crop === undefined ? {} : { crop: args.crop }),
        ...(args.overlayLayerId === undefined && args.overlaySelection !== true ? {} : { overlay: { ...(args.overlayLayerId === undefined ? {} : { layerId: args.overlayLayerId }), ...(args.overlaySelection === true ? { selection: true } : {}), ...(args.overlayColor === undefined ? {} : { color: args.overlayColor }), ...(args.overlayOpacity === undefined ? {} : { opacity: args.overlayOpacity }) } }),
      });
      return {
        status: 'applied', commandId: 'preview', editorKind: kind,
        projectId: state.documentId, revision: state.revision,
        preview: {
          dataUrl: image.dataUrl, width: image.width, height: image.height, bytes: image.bytes,
          ...(image.overlay ? { overlay: image.overlay } : {}),
          ...(image.crop ? { crop: image.crop } : {}),
          ...(image.scale !== undefined ? { scale: image.scale } : {}),
          ...(image.layerId ? { layerId: image.layerId } : {}),
          ...(image.gridStep ? { gridStep: image.gridStep } : {}),
        },
        note: '这是降采样缩略图，不推进 revision；能否看到画面取决于宿主是否渲染 tool 结果里的图片。crop/scale 是把预览上的位置换算回画布坐标的依据。',
      };
    } catch (error) {
      return failure(kind, 'preview', error);
    }
  };

  register(defineTool({
    name: 'media_image_preview',
    description: 'Return a downsampled PNG preview of the shared image as a data URL (long edge 64..1024, default 640, max 256 KB). Read-only: revision does not change. Whether the caller can actually see the picture depends on whether its host renders images carried in tool results; when it does not, this is just a thumbnail you can save. Use crop to zoom into one slot and layerId to see a single layer on its own; the returned crop/scale map preview positions back to canvas coordinates.',
    parameters: {
      ...READ_PARAMS,
      maxWidth: { type: 'integer', description: 'Long-edge pixel cap (64..1024, default 640). Larger means more detail and more bytes.' },
      grid: { type: 'boolean', description: 'Draw a coordinate grid with source-pixel labels so positions can be checked numerically (default step 100px).' },
      gridStep: { type: 'integer', description: 'Grid step in source pixels, 8..2000 (implies grid). Use a smaller step when zoomed into a slot.' },
      layerId: { type: 'string', description: 'Render ONLY this layer (everything else transparent). The fastest way to see what one layer actually looks like, or to check whether it is being covered by a layer above it.' },
      crop: {
        type: 'object',
        additionalProperties: false,
        description: 'Render only this canvas-space rectangle, scaled up to maxWidth. Out-of-canvas parts are clamped and reported in the result crop; nothing is silently invented.',
        properties: {
          x: { type: 'integer', required: true },
          y: { type: 'integer', required: true },
          width: { type: 'integer', required: true },
          height: { type: 'integer', required: true },
        },
      },
      overlayLayerId: { type: 'string', description: 'Tint this layer\'s alpha over the preview so the affected region is visible before/after an edit.' },
      overlaySelection: { type: 'boolean', description: 'Tint the current marquee selection over the preview (used when an edit is scoped to a selection).' },
      overlayColor: { type: 'string', description: 'Overlay tint as #rrggbb (default #ff00ff).' },
      overlayOpacity: { type: 'number', description: 'Overlay opacity 0.05..0.85 (default 0.35).' },
    },
    output: { schema: RESULT_SCHEMA, render: renderSummary, presentationMeta },
    execute: preview('image', bridge),
    timeoutMs: 10_000,
  }));

  // 预录流程：人先定义并审阅一串命令，模型只负责挑选与填参（对应 PS 的 .atn 思路）。
  // 执行仍走 history.batch：一条历史、失败整串回滚。
  const recipeTool = () => async (args, exec) => {
    try {
      if (!recipes) throw new MediaBridgeError('RECIPE_UNAVAILABLE', '流程库未启用：需要在插件配置里设置 dataDir');
      const action = args.action;
      if (action === 'list') {
        return { status: 'applied', commandId: 'recipe-list', editorKind: 'image', recipeList: recipes.list(), counts: { recipes: recipes.list().length } };
      }
      if (action === 'get') {
        const recipe = recipes.get(args.name);
        if (!recipe) throw new MediaBridgeError('RECIPE_NOT_FOUND', `没有名为 ${args.name} 的流程`);
        return { status: 'applied', commandId: 'recipe-get', editorKind: 'image', recipe: { name: recipe.name, description: recipe.description, steps: recipe.steps, params: recipeParamsOf(recipe.steps) } };
      }
      if (action === 'save') {
        const saved = recipes.save({ name: args.name, description: args.description, steps: args.steps });
        return { status: 'applied', commandId: 'recipe-save', editorKind: 'image', recipe: saved, note: saved.replaced ? '同名流程已更新（替换，不是新增）' : '流程已保存' };
      }
      if (action === 'delete') {
        const removed = recipes.remove(args.name);
        if (!removed) throw new MediaBridgeError('RECIPE_NOT_FOUND', `没有名为 ${args.name} 的流程`);
        return { status: 'applied', commandId: 'recipe-delete', editorKind: 'image', note: `已删除流程 ${args.name}` };
      }
      if (action !== 'run') throw new MediaBridgeError('INVALID_REQUEST', 'action 必须是 list/get/save/delete/run');

      const commandId = args.commandId;
      bindings.assert(exec, 'image', args);
      const recipe = recipes.get(args.name);
      if (!recipe) throw new MediaBridgeError('RECIPE_NOT_FOUND', `没有名为 ${args.name} 的流程`);
      const steps = fillRecipeParams(recipe.steps, args.params ?? {});
      const state = await verify('image', bridge, args, exec);
      if (state.revision !== args.expectedRevision) {
        return envelope('image', { commandId, revision: state.revision, stateDigest: state.stateDigest, error: { code: 'REVISION_CONFLICT', message: `Project is at revision ${state.revision}; read_state again before writing.`, retryable: true } });
      }
      const projectId = args.projectId ?? state.documentId;
      const result = await bridge.applyCommand({
        instanceId: args.instanceId, projectId, expectedRevision: args.expectedRevision, commandId,
        command: { type: 'history.batch', payload: { steps: steps.map(step => ({ type: step.operation, payload: step.params })) } },
      });
      return {
        status: 'applied', commandId, editorKind: 'image', projectId,
        revision: result.revision,
        ...(result.stateDigest ? { stateDigest: result.stateDigest } : {}),
        ...(result.afterDigest ? { afterDigest: result.afterDigest } : {}),
        recipe: { name: recipe.name, stepCount: steps.length },
        steps: steps.map((step, index) => ({ step: index + 1, operation: step.operation })),
        note: '整串作为一条历史执行；任一步失败会整体回滚。',
      };
    } catch (error) {
      return failure('image', args.commandId || `recipe-${args.action}`, error);
    }
  };

  register(defineTool({
    name: 'media_image_recipe',
    description: 'Store and run named, parameterised command recipes (the .atn idea): a human reviews the steps once, then any caller can replay them with parameters. Steps must be 1..12 allowlisted commands, cannot contain history.* or high-risk operations. Running uses history.batch, so the whole recipe is ONE undo step and rolls back as a whole. Actions: list, get, save, delete, run.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'get', 'save', 'delete', 'run'] },
      name: { type: 'string', description: 'Recipe name (1..40 chars; letters, digits, CJK, space, dot, dash, underscore).' },
      description: { type: 'string', description: 'save: short human description.' },
      steps: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'save: [{operation, params}] with ${param} placeholders allowed in string values.' },
      params: { type: 'object', additionalProperties: true, description: 'run: values for ${param} placeholders.' },
      // list/get/save/delete 不碰编辑器，所以这三个字段在 schema 上不是必填；
      // run 分支会自己校验（缺 projectId/instanceId 时明确报错）。
      editorKind: { type: 'string', enum: ['image'], description: 'Only the image editor is supported.' },
      projectId: { type: 'string', description: 'run: explicit Host-bound project id.' },
      instanceId: { type: 'string', description: 'run: connected editor instance id.' },
      commandId: { type: 'string', description: 'run: idempotency key.' },
      expectedRevision: { type: 'integer', description: 'run: revision from the latest read_state.' },
    },
    output: { schema: RESULT_SCHEMA, render: renderSummary, presentationMeta },
    execute: recipeTool(),
    timeoutMs: APPROVAL_BUDGET_MS,
  }));

  register(defineTool({
    name: 'media_image_read_state',
    description: 'Read the shared image project: revision, digest, canvas, layers and native undo history. Call this before any write.',
    parameters: READ_PARAMS,
    output: { schema: RESULT_SCHEMA, render: renderReadState, presentationMeta },
    execute: readState('image', bridge),
    timeoutMs: APPROVAL_BUDGET_MS,
  }));

  register(defineTool({
    name: 'media_image_apply_command',
    description: 'Apply one allowlisted layer.* command to the shared image project with expectedRevision and an idempotent commandId.',
    parameters: WRITE_PARAMS('image'),
    output: { schema: RESULT_SCHEMA, render: renderSummary, presentationMeta },
    execute: applyCommand('image', bridge, 'media_image_apply_command'),
    timeoutMs: APPROVAL_BUDGET_MS,
  }));

  register(defineTool({
    name: 'media_image_get_command_result',
    description: 'Query the outcome of an earlier image command by its original commandId. Use after a timeout; never replay the write.',
    parameters: QUERY_PARAMS,
    output: { schema: RESULT_SCHEMA, render: renderSummary, presentationMeta },
    execute: getCommandResult('image', bridge),
    timeoutMs: 10_000,
  }));

  const startExport = (kind, bridge) => async (args, exec) => {
    try {
      const state = await verify(kind, bridge, args, exec);
      if (state.revision !== args.expectedRevision) {
        return envelope(kind, { commandId: args.commandId, revision: state.revision, stateDigest: state.stateDigest, error: { code: 'REVISION_CONFLICT', message: `Project is at revision ${state.revision}; export that revision instead.`, retryable: true } });
      }
      const projectId = args.projectId ?? state.documentId;
      const job = await bridge.startExport({
        instanceId: args.instanceId,
        projectId,
        expectedRevision: args.expectedRevision,
        commandId: args.commandId,
        format: args.format,
      });
      return {
        status: 'applied',
        commandId: args.commandId,
        editorKind: kind,
        projectId,
        revision: state.revision,
        stateDigest: state.stateDigest,
        exportId: job.exportId,
        ...(job.artifactRef ? { artifactRef: job.artifactRef } : {}),
      };
    } catch (error) {
      return failure(kind, args.commandId, error);
    }
  };

  const exportStatus = (kind, bridge) => async (args, exec) => {
    try {
      await verify(kind, bridge, args, exec);
      const job = await bridge.getExportStatus({ instanceId: args.instanceId, exportId: args.exportId });
      return {
        status: job.status === 'failed' ? 'rejected' : job.status === 'unknown' ? 'unknown' : 'applied',
        commandId: job.exportId,
        editorKind: kind,
        exportId: job.exportId,
        ...(job.stateDigest ? { stateDigest: job.stateDigest } : {}),
        ...(job.artifactRef ? { artifactRef: job.artifactRef } : {}),
      };
    } catch (error) {
      return failure(kind, args.exportId, error);
    }
  };

  register(defineTool({
    name: 'media_image_export_start',
    description: 'Export the current image project to png or jpeg. Export is not an edit: it does not bump revision or enter undo history.',
    parameters: EXPORT_START_PARAMS('image'),
    output: { schema: RESULT_SCHEMA, render: renderSummary, presentationMeta },
    execute: startExport('image', bridge),
    timeoutMs: 10_000,
  }));

  register(defineTool({
    name: 'media_image_export_status',
    description: 'Read an image export job status and its artifact reference. A small export may already be ready.',
    parameters: EXPORT_STATUS_PARAMS('image'),
    output: { schema: RESULT_SCHEMA, render: renderSummary, presentationMeta },
    execute: exportStatus('image', bridge),
    timeoutMs: 10_000,
  }));

  register(defineTool({
    name: 'media_image_generate',
    description: 'Submit or poll an image generation job against a configured backend. On success it returns assetRef (asset:<id>) which layer.add_image can insert; generation never edits the project by itself. Use jobId to poll; a running job returns pending, and an unverifiable poll returns unknown (poll again, do not resubmit).',
    parameters: GENERATE_PARAMS,
    output: { schema: RESULT_SCHEMA, render: renderSummary, presentationMeta },
    execute: generate('image', generation),
    timeoutMs: 10_000,
  }));

  return { bindings };
}
