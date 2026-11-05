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
  image: 'layer.add_text {text,x?,y?,style?:{size,family,fill_color,bold,italic}}; layer.update_text {layerId,text}; layer.set_transform {layerId,x?,y?,scaleX?,scaleY?,rotationDeg?} (flat fields, positive scales); layer.set_visibility {layerId,visible}; layer.reorder {layerId,toIndex}; layer.remove {layerId} (approval); canvas.resize {width,height} changes canvas bounds without scaling layers; canvas.crop {x,y,width,height} (approval), integer pixels, dimensions 1..16384; history.undo {} for global undo, or {targetCommandId,afterDigest} for guarded last-command undo; history.redo {} (empty history returns HISTORY_EMPTY). Query read_state for ids. Commands require matching editor implementation; unsupported commands are rejected.',
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

const renderSummary = (_args, value) => [{ type: 'text', text: `${value.status} · ${value.commandId}${value.revision === undefined ? '' : ` · R${value.revision}`}${value.error ? ` · ${value.error.code}` : ''}` }];

// read_state is the only way a model learns projectId / digest / history, so the render
// must carry them as text; the model never sees the tool's canonical JSON value.
const compactState = state => {
  const keys = ['editorKind', 'documentId', 'revision', 'canvas', 'history', 'selectedLayerId', 'selectedObjects', 'timeline', 'capabilities'];
  const result = Object.fromEntries(keys.filter(key => state[key] !== undefined).map(key => [key, state[key]]));
  for (const key of ['layers', 'clips', 'overlays', 'tracks']) if (Array.isArray(state[key])) {
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
const presentationMeta = (args, value) => ({
  operation: args.operation,
  status: value.status,
  editorKind: value.editorKind,
  projectId: value.projectId,
  stateDigest: value.stateDigest,
  approvalId: value.approvalId,
  auditRef: value.auditRef,
});

const envelope = (kind, extra) => ({ status: 'rejected', commandId: 'unknown', editorKind: kind, ...extra });

function failure(kind, commandId, error) {
  return envelope(kind, {
    commandId,
    error: {
      code: error?.code || 'EDITOR_ERROR',
      message: error?.message || 'Editor request failed.',
      retryable: error?.code === 'EDITOR_TIMEOUT' || error?.code === 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN',
    },
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

export function registerMediaTools(ctx, { bridge, approvals, bindings = createSessionBindings({ resolvePage: (_kind, instanceId) => bridge.getPage?.(instanceId) ?? null }) }) {
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

  const readState = (kind, bridge) => async (args, exec) => {
    try {
      if (args.bind === true) await bindings.authorize(exec, {
        editorKind: kind, instanceId: args.instanceId, projectId: args.projectId,
        readState: () => bridge.readState({ instanceId: args.instanceId, projectId: args.projectId }),
        approve: (reason, signal) => requestHumanApproval(ctx, { agent: exec.agent, toolName: `media_${kind}_read_state`, callId: exec.callId, reason, signal: signal ?? exec.signal }),
      });
      const state = await verify(kind, bridge, args, exec);
      return {
        status: 'applied',
        commandId: 'read_state',
        editorKind: kind,
        projectId: state.documentId,
        revision: state.revision,
        stateDigest: state.stateDigest,
        canUndo: !!state.history?.canUndo,
        canRedo: !!state.history?.canRedo,
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

  return { bindings };
}
