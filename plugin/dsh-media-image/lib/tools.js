// The five model-facing image tools: read, apply, query plus the export start/status pair.
// Parameters are the 0.2.x schema DSL (property table), not raw JSON Schema.
import { defineTool } from '@deepseek-ai/dsh-tools';
import { MediaBridgeError } from './bridge.js';
import {
  HIGH_RISK_OPERATIONS, digestOf, requestHumanApproval, createSessionBindings, trustedSessionId, APPROVAL_WAIT_MS,
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
  image: 'layer.add_text {text,x?,y?,style?:{size,family,fill_color,bold,italic},fontUrl?} (fontUrl must be /media-image/fonts/<48-char id> from POST /media-image/fonts, and needs style.family; the editor fetches the bytes with its token and registers a FontFace); layer.update_text {layerId,text,fontUrl?}; layer.add_image {sourceRef,x?,y?,width?,height?,fit?:"stretch"|"contain"|"cover",name?,maskRef?,maskMode?:"luminance"|"alpha",maskInvert?,featherPx?} (approval; keeps alpha, width/height as a pair or omitted for source size). sourceRef supports layer:<layerId> (copy an existing layer), uploaded asset:<48-char-id>, or data:image/(png|jpeg|webp);base64,... up to 256 KB decoded; read_state lists only asset metadata. maskRef clips the new layer by a mask and uses the same three forms plus "selection:" (the live marquee of the editor; requires the selection tool to be active, otherwise NO_SELECTION). maskRect {x,y,width,height} clips by an explicit canvas-space rectangle and needs no tool state; maskRef and maskRect are mutually exclusive. maskMode defaults to alpha for layer:<id>/selection: and luminance for assets, maskInvert flips coverage, featherPx 0..64 softens the edge (pixel math in dsh-pixel-ops.applyMask). read_state.selection reports the live marquee bounds (null when absent) so callers can choose between selection: and maskRect. Typical cut-out: insert a generated background with maskRef=layer:<product> so the product area stays transparent. layer.set_frame {layerId,x?,y?,width?,height?,fit?,anchor?:"top-left"|"center"} (pixel frame; one side derives the other from the layer ratio; at least one field); layer.feather {layerId,radiusPx 1..64} (alpha edge only, recomputed from the editor-internal pre-edit snapshot, idempotent); layer.color_match {layerId,method:"reinhard",strength? 0..1,reference?:"canvas"|"below"|{x,y,width,height}} (idempotent from the same snapshot; read_state exposes only colorMatch{applied,strength,fromDigest} and feather{radiusPx,fromDigest}); layer.set_transform {layerId,x?,y?,scaleX?,scaleY?,rotationDeg?} (flat fields, positive scales); layer.set_appearance {layerId,opacity?,blendMode?,name?} (at least one field; opacity 0..100, blendMode is a canvas globalCompositeOperation such as source-over/multiply/screen/overlay, name 1..120 chars; read_state echoes opacity and blendMode); layer.set_visibility {layerId,visible}; layer.reorder {layerId,toIndex}; layer.remove {layerId} (approval); canvas.resize {width,height} changes canvas bounds without scaling layers; canvas.crop {x,y,width,height} (approval), integer pixels, dimensions 1..16384; history.undo {} for global undo, or {targetCommandId,afterDigest} for guarded last-command undo; history.redo {} (empty history returns HISTORY_EMPTY). read_state layers carry sourceRef/frame/hasAlpha/maskSource plus the derived feather/colorMatch fields. Query read_state for ids. Commands require matching editor implementation; unsupported commands are rejected.',
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

function failure(kind, commandId, error) {
  const code = error?.code || 'EDITOR_ERROR';
  // 未授权必须说清楚怎么授权，且不能和「编辑器未就绪」混在一起。
  const hint = code === 'SESSION_BINDING_REQUIRED'
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
export function registerMediaTools(ctx, { bridge, approvals, bindings = createSessionBindings({ resolvePage: (_kind, instanceId) => bridge.getPage?.(instanceId) ?? null }), assets = null, generation = null }) {
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

  // 写入工具主体：绑定门禁 → 指纹去重 → revision 前置检查 → 高风险审批 → 提交。
  // 回执带 commandId/revision/afterDigest，供模型做后续定向撤销与冲突判断。
  const applyCommand = (kind, bridge, toolName) => async (args, exec) => {
    const commandId = args.commandId;
    const operation = args.operation;
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
      if (state.revision !== args.expectedRevision) {
        return envelope(kind, { commandId, revision: state.revision, stateDigest: state.stateDigest, error: { code: 'REVISION_CONFLICT', message: `Project is at revision ${state.revision}; read_state again before writing.`, retryable: true } });
      }

      // projectId may be omitted: the instance's current document is authoritative.
      const projectId = args.projectId ?? state.documentId;
      const paramsDigest = digestOf(args.params ?? null);
      const highRisk = HIGH_RISK_OPERATIONS[kind]?.has(operation) === true;
      let approvalId;

      if (highRisk) {
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
        ...(approvalId ? { approvalId } : {}),
        auditRef: `audit-${commandId}`,
      };
      appliedCommands.set(key, { fingerprint, value });
      return value;
    } catch (error) {
      return failure(kind, commandId, error instanceof MediaBridgeError ? error : error);
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
