// Editor adapter for the image editor.
// Owns validation, idempotency, expectedRevision and unknown-outcome semantics.
// It never stores document state: the editor page is the only state owner.

const DEFAULT_TIMEOUT_MS = 10_000;

export class MediaBridgeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MediaBridgeError';
    this.code = code;
    Object.assign(this, details);
  }
}

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const opaqueId = (value, name) => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) {
    throw new MediaBridgeError('INVALID_REQUEST', `${name} must be a non-empty string up to 256 characters.`);
  }
};
const finite = (value, name, { min = -Infinity, max = Infinity } = {}) => {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new MediaBridgeError('INVALID_REQUEST', `${name} is outside the supported range.`);
  }
};

const IMAGE_COMMANDS = new Set(['layer.add_text', 'layer.update_text', 'layer.set_transform', 'layer.set_visibility', 'layer.reorder', 'layer.remove', 'canvas.resize', 'canvas.crop', 'history.undo', 'history.redo']);
const fieldsOnly = (payload, fields) => {
  const unknown = Object.keys(payload).find(key => !fields.includes(key));
  if (unknown) throw new MediaBridgeError('INVALID_REQUEST', `Unsupported payload field: ${unknown}. Read the operation parameter contract.`);
};

export const ALLOWED_COMMANDS = { image: IMAGE_COMMANDS };

function validateImageCommand(command) {
  const p = command.payload;
  if (!IMAGE_COMMANDS.has(command.type)) throw new MediaBridgeError('UNSUPPORTED_COMMAND', 'Command is not in the image allowlist.');
  if (!isObject(p)) throw new MediaBridgeError('INVALID_REQUEST', 'Command payload must be an object.');
  const fields = {
    'history.undo': ['targetCommandId', 'afterDigest'], 'history.redo': [], 'canvas.resize': ['width', 'height'],
    'canvas.crop': ['x', 'y', 'width', 'height'], 'layer.remove': ['layerId'],
    'layer.add_text': ['text', 'x', 'y', 'style'], 'layer.update_text': ['layerId', 'text'],
    'layer.set_transform': ['layerId', 'x', 'y', 'scaleX', 'scaleY', 'rotationDeg'],
    'layer.set_visibility': ['layerId', 'visible'], 'layer.reorder': ['layerId', 'toIndex'],
  };
  fieldsOnly(p, fields[command.type]);
  if (command.type === 'history.undo' && (p.targetCommandId !== undefined || p.afterDigest !== undefined)) {
    opaqueId(p.targetCommandId, 'targetCommandId'); opaqueId(p.afterDigest, 'afterDigest');
  }
  if (command.type.startsWith('canvas.')) {
    for (const key of ['width', 'height']) {
      if (!Number.isSafeInteger(p[key]) || p[key] < 1 || p[key] > 16384) throw new MediaBridgeError('INVALID_REQUEST', `${key} must be an integer between 1 and 16384 pixels.`);
    }
    if (command.type === 'canvas.crop') for (const key of ['x', 'y']) {
      if (!Number.isSafeInteger(p[key]) || p[key] < 0) throw new MediaBridgeError('INVALID_REQUEST', `${key} must be a non-negative pixel integer.`);
    }
  }
  if (command.type === 'layer.remove') opaqueId(p.layerId, 'layerId');
  if (command.type === 'layer.add_text' || command.type === 'layer.update_text') {
    if (typeof p.text !== 'string' || p.text.length > 4000) throw new MediaBridgeError('INVALID_REQUEST', 'text must be a string up to 4000 characters.');
    if (command.type === 'layer.update_text') opaqueId(p.layerId, 'layerId');
    // The image editor requires an explicit insertion point; reject it here so the model
    // gets a field-level error instead of a late editor failure.
    // x/y are optional: the editor centers the text when omitted. If one is supplied it
    // must be a number, so a typo still fails at the plugin instead of inside the editor.
    if (command.type === 'layer.add_text') {
      if ((p.x === undefined) !== (p.y === undefined)) {
        throw new MediaBridgeError('INVALID_REQUEST', 'layer.add_text needs both x and y, or neither (the editor centers the text).');
      }
      if (p.x !== undefined) { finite(p.x, 'x'); finite(p.y, 'y'); }
    }
  }
  if (command.type === 'layer.set_transform') {
    opaqueId(p.layerId, 'layerId');
    const keys = ['x', 'y', 'scaleX', 'scaleY', 'rotationDeg'].filter(key => p[key] !== undefined);
    if (!keys.length) throw new MediaBridgeError('INVALID_REQUEST', 'Provide x/y/scaleX/scaleY/rotationDeg as flat params, not transform.');
    for (const key of keys) finite(p[key], key, key.startsWith('scale') ? { min: Number.MIN_VALUE } : {});
  }
  if (command.type === 'layer.set_visibility') {
    opaqueId(p.layerId, 'layerId');
    if (typeof p.visible !== 'boolean') throw new MediaBridgeError('INVALID_REQUEST', 'visible must be boolean.');
  }
  if (command.type === 'layer.reorder') {
    opaqueId(p.layerId, 'layerId');
    if (!Number.isSafeInteger(p.toIndex) || p.toIndex < 0) throw new MediaBridgeError('INVALID_REQUEST', 'toIndex must be a non-negative integer.');
  }
}

export const COMMAND_VALIDATORS = { image: validateImageCommand };

function validateImageState(state, instanceId) {
  if (!isObject(state) || state.editorKind !== 'image' || state.editorInstanceId !== instanceId ||
      typeof state.documentId !== 'string' || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
      !isObject(state.canvas) || !Number.isFinite(state.canvas.width) || !Number.isFinite(state.canvas.height) ||
      !Array.isArray(state.layers)) {
    throw new MediaBridgeError('EDITOR_ERROR', 'Image editor returned an invalid state.');
  }
  return state;
}

export const STATE_VALIDATORS = { image: validateImageState };

export function createMediaBridge({ relay, editorKind = 'image', timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!relay || typeof relay.request !== 'function') throw new TypeError('relay.request is required');
  if (editorKind !== 'image') throw new TypeError('editorKind must be "image"');
  const completed = new Map();
  const inFlight = new Map();
  const uncertain = new Map();
  const validateState = STATE_VALIDATORS[editorKind];
  const validateCommand = COMMAND_VALIDATORS[editorKind];
  const keyOf = (instanceId, commandId) => `${instanceId}\0${commandId}`;

  async function request(type, payload, mutation = false) {
    const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    let timer;
    const send = Promise.resolve().then(() => relay.request({ type, requestId, editorKind, ...payload }, { timeoutMs }));
    try {
      return await Promise.race([
        send,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new MediaBridgeError(
            mutation ? 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN' : 'EDITOR_TIMEOUT',
            mutation ? 'Command outcome is unknown; query the original commandId.' : `${editorKind} editor did not respond in time.`,
            { commandId: payload.commandId, outcomeUnknown: mutation },
          )), timeoutMs);
        }),
      ]);
    } catch (error) {
      if (error instanceof MediaBridgeError) throw error;
      if (error?.code) throw new MediaBridgeError(error.code, error.message || 'Editor request failed.', { revision: error.revision, outcomeUnknown: error.outcomeUnknown, commandId: error.commandId });
      throw new MediaBridgeError('EDITOR_ERROR', error?.message || 'Editor request failed.');
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    editorKind,
    getPage(instanceId) { return relay.getPage?.(instanceId) ?? null; },
    async readState(input) {
      opaqueId(input?.instanceId, 'instanceId');
      const state = validateState(await request('editor.read_state', { editorInstanceId: input.instanceId }), input.instanceId);
      if (input.projectId && state.documentId !== input.projectId) throw new MediaBridgeError('DOCUMENT_MISMATCH', 'The active project changed.');
      return state;
    },
    async getCommandResult(input) {
      opaqueId(input?.instanceId, 'instanceId');
      opaqueId(input.commandId, 'commandId');
      const result = await request('editor.get_command_result', { editorInstanceId: input.instanceId, commandId: input.commandId });
      if (!isObject(result) || !['applied', 'rejected', 'unknown'].includes(result.status)) {
        throw new MediaBridgeError('EDITOR_ERROR', 'Editor returned an invalid command result.');
      }
      const key = keyOf(input.instanceId, input.commandId);
      if (result.status === 'applied' && result.originalResult) { completed.set(key, result.originalResult); uncertain.delete(key); }
      return result;
    },
    async startExport(input) {
      opaqueId(input?.instanceId, 'instanceId');
      opaqueId(input.projectId, 'projectId');
      opaqueId(input.commandId, 'commandId');
      const formats = ['png', 'jpeg'];
      if (!formats.includes(input.format)) throw new MediaBridgeError('INVALID_REQUEST', `Export format for ${editorKind} must be one of ${formats.join(', ')}.`);
      const key = keyOf(input.instanceId, input.commandId);
      if (completed.has(key)) return completed.get(key);
      if (uncertain.has(key)) throw uncertain.get(key);
      const result = await request('editor.export_start', {
        editorInstanceId: input.instanceId,
        documentId: input.projectId,
        expectedRevision: input.expectedRevision,
        commandId: input.commandId,
        format: input.format,
      }, true).catch(error => {
        if (error.code === 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN') uncertain.set(key, error);
        throw error;
      });
      if (!isObject(result) || result.editorKind !== editorKind || result.commandId !== input.commandId ||
          typeof result.exportId !== 'string' || !result.exportId ||
          !['queued', 'running', 'ready', 'completed', 'failed'].includes(result.status)) {
        throw new MediaBridgeError('EDITOR_ERROR', `${editorKind} editor returned an invalid export job.`);
      }
      completed.set(key, result);
      return result;
    },
    async getExportStatus(input) {
      opaqueId(input?.instanceId, 'instanceId');
      opaqueId(input.exportId, 'exportId');
      const result = await request('editor.export_status', { editorInstanceId: input.instanceId, exportId: input.exportId });
      if (!isObject(result) || result.editorKind !== editorKind || result.exportId !== input.exportId ||
          !['queued', 'running', 'ready', 'completed', 'failed', 'unknown'].includes(result.status)) {
        throw new MediaBridgeError('EDITOR_ERROR', `${editorKind} editor returned an invalid export status.`);
      }
      if (['ready', 'completed'].includes(result.status) && typeof result.artifactRef !== 'string') {
        throw new MediaBridgeError('EDITOR_ERROR', 'Finished export is missing artifactRef.');
      }
      return result;
    },
    async applyCommand(input) {
      opaqueId(input?.instanceId, 'instanceId');
      opaqueId(input.projectId, 'projectId');
      opaqueId(input.commandId, 'commandId');
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
        throw new MediaBridgeError('INVALID_REQUEST', 'expectedRevision must be a non-negative integer.');
      }
      validateCommand(input.command);
      const key = keyOf(input.instanceId, input.commandId);
      if (completed.has(key)) return completed.get(key);
      if (inFlight.has(key)) return inFlight.get(key);
      if (uncertain.has(key)) throw uncertain.get(key);
      const operation = (async () => {
        const result = await request('editor.apply_command', {
          editorInstanceId: input.instanceId,
          documentId: input.projectId,
          expectedRevision: input.expectedRevision,
          commandId: input.commandId,
          command: structuredClone(input.command),
        }, true);
        // Contract: {editorKind, documentId, commandId, revision, changedObjectIds}.
        // `changedLayerIds` is accepted as a legacy alias so an editor that renamed the
        // field does not look like a failure after it already wrote.
        const changed = Array.isArray(result?.changedObjectIds)
          ? result.changedObjectIds
          : Array.isArray(result?.changedLayerIds) ? result.changedLayerIds : null;
        const revisionAdvanced = Number.isSafeInteger(result?.revision) && result.revision > input.expectedRevision;
        const shapeValid = isObject(result) &&
          (result.editorKind === undefined || result.editorKind === editorKind) &&
          result.documentId === input.projectId && result.commandId === input.commandId &&
          revisionAdvanced && changed !== null;
        if (!shapeValid) {
          // The revision advanced, so the write may have landed. Never report that as a
          // clean rejection: the caller must query by commandId instead of retrying.
          if (revisionAdvanced) {
            throw new MediaBridgeError(
              'EDITOR_RESULT_INVALID_OUTCOME_UNKNOWN',
              'The editor reported a new revision but the mutation result shape was invalid; the write may have landed. Query this commandId instead of retrying.',
              { outcomeUnknown: true, commandId: input.commandId, revision: result?.revision },
            );
          }
          throw new MediaBridgeError('EDITOR_ERROR', 'Editor returned an invalid mutation result.');
        }
        return { ...result, editorKind, changedObjectIds: changed };
      })();
      inFlight.set(key, operation);
      try {
        const result = await operation;
        let state;
        try {
          const audit = await request('editor.read_state', { editorInstanceId: input.instanceId });
          state = validateState(audit, input.instanceId);
          if (state.documentId !== input.projectId || state.revision !== result.revision) throw new Error('Audit project/revision changed after mutation.');
        } catch (error) {
          throw new MediaBridgeError('EDITOR_AUDIT_OUTCOME_UNKNOWN', `Mutation returned but audit could not verify it: ${error.message}. Query the original commandId.`, { outcomeUnknown: true, commandId: input.commandId });
        }
        const withAudit = {
          ...result,
          stateDigest: state.stateDigest,
          history: isObject(state.history) ? { canUndo: !!state.history.canUndo, canRedo: !!state.history.canRedo } : undefined,
        };
        completed.set(key, withAudit);
        return withAudit;
      } catch (error) {
        // Both a timeout and an unverifiable-but-possibly-applied result block replay.
        if (error.code === 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN' || error.outcomeUnknown === true) uncertain.set(key, error);
        throw error;
      } finally {
        inFlight.delete(key);
      }
    },
  };
}
