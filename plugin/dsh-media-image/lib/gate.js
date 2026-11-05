// Policy gate: synchronous static denials, plugin-owned capability table,
// and the plugin-side pending -> approvalId binding for high-risk writes.

const TTL_MS = 5 * 60_000;

// Identity comes only from ToolRunContext, never model arguments or an agent name.
// dsh-agent Agent.id is a SessionId; runtime Agent.session is its live Session.
export function trustedSessionId(exec) {
  const id = exec?.agent?.id;
  if (typeof id !== 'string' || !id || exec?.agent?.session?.id !== id) {
    throw Object.assign(new Error('A live, matching Host agent/session identity is required.'), { code: 'SESSION_IDENTITY_REQUIRED' });
  }
  return id;
}

// Host-only registry. authorize consumes a real native approval and verifies the
// exact live relay page/snapshot before recording a grant. No HTTP claim surface.
// register is a legacy Host integration seam requiring independently verified ownership.
export function createSessionBindings({ resolvePage } = {}) {
  const bindings = new Map();
  const invalid = new Set();
  const pending = new Set();
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  return {
    async authorize(exec, { editorKind, instanceId, projectId, readState, approve }) {
      const sessionId = trustedSessionId(exec);
      if (bindings.has(sessionId) || invalid.has(sessionId)) fail('SESSION_BINDING_STALE', 'Session already bound or expired; use a new dedicated session.');
      if (pending.has(sessionId)) fail('SESSION_BINDING_PENDING', 'A binding approval is already in progress.');
      if (!resolvePage) fail('SESSION_BINDING_UNAVAILABLE', 'Host page resolver is unavailable.');
      const signal = exec.signal;
      const checkActive = () => {
        if (signal?.aborted) fail('APPROVAL_CANCELLED', 'Request cancelled; explicitly start a new approval request.');
        if (invalid.has(sessionId)) fail('SESSION_BINDING_STALE', 'Binding request invalidated; use a new dedicated session.');
      };
      pending.add(sessionId);
      try {
        checkActive();
        const page = resolvePage(editorKind, instanceId);
        if (!page) fail('EDITOR_NOT_READY', 'The editor page is not connected.');
        const before = await readState();
        if (before.documentId !== projectId) fail('DOCUMENT_MISMATCH', 'Requested project does not match the editor.');
        const reason = `Authorize this session ${sessionId} to read, edit and export this exact editor project. editorKind=${editorKind}; documentId=${before.documentId}; instanceId=${instanceId}; pageId=${page.pageId}; revision=${before.revision}; digest=${before.stateDigest}. Destructive edits still require separate approval.`;
        checkActive();
        // approve is the caller's bounded native approval wait; it must honor the signal
        // so a host cancellation closes the pending approval instead of leaking it.
        const decision = await approve(reason, signal);
        checkActive();
        if (!decision.allowed) fail(decision.code, decision.message);
        const after = await readState();
        checkActive();
        const currentPage = resolvePage(editorKind, instanceId);
        if (!currentPage || currentPage.pageId !== page.pageId || after.documentId !== before.documentId || after.revision !== before.revision || after.stateDigest !== before.stateDigest) fail('SESSION_BINDING_STALE', 'Page or project changed during approval; no grant was registered.');
        const grantId = globalThis.crypto.randomUUID();
        const binding = Object.freeze({ sessionId, editorKind, instanceId, projectId, pageId: page.pageId, grantId });
        bindings.set(sessionId, binding);
        return binding;
      } finally { pending.delete(sessionId); }
    },
    register(exec, binding) {
      const sessionId = trustedSessionId(exec);
      if (!resolvePage) fail('SESSION_BINDING_UNAVAILABLE', 'Host page ownership resolver is not connected.');
      for (const key of ['projectId', 'instanceId', 'pageId']) if (typeof binding?.[key] !== 'string' || !binding[key]) fail('INVALID_REQUEST', `Binding ${key} is required.`);
      if (binding.editorKind !== 'image') fail('INVALID_REQUEST', 'Binding editorKind is invalid.');
      const page = resolvePage(binding.editorKind, binding.instanceId);
      if (!page || page.pageId !== binding.pageId || page.sessionId !== sessionId) fail('SESSION_BINDING_MISMATCH', 'Host has not verified session ownership of this page.');
      if (bindings.has(sessionId) || invalid.has(sessionId)) fail('SESSION_BINDING_STALE', 'Create a new dedicated session after changing the project.');
      bindings.set(sessionId, Object.freeze({ ...binding, sessionId }));
      return bindings.get(sessionId);
    },
    assert(exec, kind, args) {
      const sessionId = trustedSessionId(exec);
      const binding = bindings.get(sessionId);
      if (invalid.has(sessionId)) fail('SESSION_BINDING_STALE', 'The project/page binding expired; create a new dedicated session.');
      if (!binding) fail('SESSION_BINDING_REQUIRED', 'Host-verified editor/session registration is required.');
      if (kind !== binding.editorKind || args.instanceId !== binding.instanceId || args.projectId !== binding.projectId) fail('SESSION_BINDING_MISMATCH', 'Explicit projectId, instanceId and editor kind must match the Host binding.');
      const page = resolvePage?.(binding.editorKind, binding.instanceId);
      if (!page || page.pageId !== binding.pageId) {
        invalid.add(sessionId); bindings.delete(sessionId);
        fail('SESSION_BINDING_STALE', 'The bound page disconnected or changed.');
      }
      if (kind !== binding.editorKind || args.instanceId !== binding.instanceId || args.projectId !== binding.projectId) fail('SESSION_BINDING_MISMATCH', 'Explicit projectId, instanceId and editor kind must match the Host binding.');
      return binding;
    },
    invalidate(sessionId) { bindings.delete(sessionId); invalid.add(sessionId); },
  };
}

// Autonomous mode may only run reversible, low-risk edits on the current revision.
export const AUTONOMOUS_CAPABILITIES = {
  image: new Set(['layer.update_text']),
};

// Always human-confirmed: importing local media, destructive deletes, overwrite export.
export const HIGH_RISK_OPERATIONS = {
  image: new Set(['layer.remove', 'canvas.crop']),
};

export const TOOL_KINDS = {
  media_image_read_state: 'image',
  media_image_apply_command: 'image',
  media_image_get_command_result: 'image',
  media_image_export_start: 'image',
  media_image_export_status: 'image',
};

export function digestOf(value) {
  let hash = 0x811c9dc5;
  const text = JSON.stringify(value ?? null);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32-${hash.toString(16).padStart(8, '0')}`;
}

/** Synchronous guard: runs after tools/pre-execute and may only deny. */
export function createGuard() {
  return execution => {
    const name = typeof execution?.name === 'string' ? execution.name : '';
    const expectedKind = TOOL_KINDS[name];
    if (!expectedKind) return undefined;
    const args = execution?.arguments;
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return `${name}: arguments must be an object.`;
    if (args.editorKind !== undefined && args.editorKind !== expectedKind) {
      return `${name} targets the ${expectedKind} editor; editorKind="${String(args.editorKind)}" is not accepted.`;
    }
    if (expectedKind === 'video' && name === 'media_video_apply_command' && typeof args.operation === 'string' && !args.operation.startsWith('media.video.')) {
      return 'media_video_apply_command accepts only media.video.* operations.';
    }
    if (expectedKind === 'image' && name === 'media_image_apply_command' && typeof args.operation === 'string' && !['layer.', 'canvas.', 'history.'].some(prefix => args.operation.startsWith(prefix))) {
      return 'media_image_apply_command accepts only layer.* operations, canvas.* or history.* operations.';
    }
    if (args.mode === 'autonomous') {
      const allowed = AUTONOMOUS_CAPABILITIES[expectedKind];
      if (!allowed.has(args.operation)) return `Autonomous execution is not authorized for ${String(args.operation)}.`;
    }
    return undefined;
  };
}

/**
 * Plugin-side approval binding. A pending record is issued once per commandId and must
 * match projectId, operation, params digest, revision and state digest when consumed.
 */
export function createApprovalStore({ ttlMs = TTL_MS, now = () => Date.now() } = {}) {
  const byId = new Map();
  const byCommand = new Map();
  const key = (agentId, commandId) => `${agentId}\0${commandId}`;

  return {
    issue(binding) {
      const existingId = byCommand.get(key(binding.agentId, binding.commandId));
      const existing = existingId && byId.get(existingId);
      if (existing && existing.expiresAt > now()) return { reused: true, record: existing };
      const approvalId = globalThis.crypto?.randomUUID?.() ?? `approval-${now()}-${Math.random()}`;
      const record = { ...binding, approvalId, expiresAt: now() + ttlMs, used: false };
      byId.set(approvalId, record);
      byCommand.set(key(binding.agentId, binding.commandId), approvalId);
      return { reused: false, record };
    },
    /** Returns { ok } or { ok:false, code, message }. A failed check consumes the record. */
    take({ approvalId, agentId, projectId, commandId, operation, paramsDigest, revision, stateDigest }) {
      const record = byId.get(approvalId);
      if (!record) return { ok: false, code: 'APPROVAL_NOT_FOUND', message: 'Approval is missing; request a new pending result.' };
      if (record.used) return { ok: false, code: 'APPROVAL_CONSUMED', message: 'Approval was already used once.' };
      if (record.expiresAt <= now()) { record.used = true; return { ok: false, code: 'APPROVAL_EXPIRED', message: 'Approval expired; request a new pending result.' }; }
      const mismatch =
        record.agentId !== agentId ? 'agent' :
        record.projectId !== projectId ? 'project' :
        record.commandId !== commandId ? 'command' :
        record.operation !== operation ? 'operation' :
        record.paramsDigest !== paramsDigest ? 'params' :
        record.revision !== revision ? 'revision' :
        record.stateDigest !== stateDigest ? 'stateDigest' : null;
      if (mismatch) {
        record.used = true;
        return { ok: false, code: mismatch === 'revision' || mismatch === 'stateDigest' ? 'REVISION_CONFLICT' : 'APPROVAL_MISMATCH', message: `Approval does not match the current ${mismatch}; request a new pending result.` };
      }
      record.used = true;
      return { ok: true, record };
    },
    size() { return byId.size; },
  };
}

/**
 * Plugin-side bound for a human decision. The host enforces `ToolDefinition.timeoutMs`
 * over the whole call and turns expiry into TOOL_TIMEOUT, so the approval wait must be
 * shorter than the tool budget (tools.js declares APPROVAL_WAIT_MS + headroom) and much
 * longer than a media round trip (bridge.js keeps 10s). Not infinite, never auto-retried.
 */
export const APPROVAL_WAIT_MS = 5 * 60_000;

/**
 * Only `allowed-once` proceeds; every other outcome (including `unavailable`) is a denial.
 * The wait is bounded: on expiry the approval signal is aborted (the host resolves it as
 * `cancelled`), APPROVAL_TIMEOUT is returned, and a late grant can never reach the caller.
 */
export async function requestHumanApproval(ctx, { agent, toolName, callId, reason, signal, timeoutMs = APPROVAL_WAIT_MS }) {
  if (!ctx?.approval?.request) return { allowed: false, code: 'APPROVAL_UNAVAILABLE', message: 'Approval service is not available in this deployment.' };
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) controller.abort(signal.reason);
  else signal?.addEventListener('abort', forwardAbort, { once: true });
  let timedOut = false;
  let expire;
  const expired = new Promise(resolve => { expire = resolve; });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); expire(undefined); }, timeoutMs);
  // Cancellation must win even when it lands before the native request is dispatched
  // (then the host listener would never fire and the call would sit until the deadline).
  const aborted = new Promise(resolve => {
    const onAbort = () => resolve(undefined);
    if (controller.signal.aborted) resolve(undefined);
    else controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  // A settlement that arrives after cancellation must not surface as this call's outcome.
  const request = Promise.resolve()
    .then(() => ctx.approval.request({ agent, toolName, callId, reason, signal: controller.signal }))
    .then(decision => ({ decision }), error => ({ error }));
  request.then(() => {}, () => {});
  try {
    const settled = await Promise.race([request, expired, aborted]);
    if (timedOut) return { allowed: false, code: 'APPROVAL_TIMEOUT', message: `No approval decision within ${Math.round(timeoutMs / 1000)}s; the request was cancelled. Ask the user to explicitly start a new approval.` };
    if (!settled) return { allowed: false, code: 'APPROVAL_CANCELLED', message: 'Approval was cancelled; ask the user to explicitly start a new request.' };
    if (settled.error) return { allowed: false, code: 'APPROVAL_FAILED', message: settled.error?.message || 'Approval request failed.' };
    if (signal?.aborted) return { allowed: false, code: 'APPROVAL_CANCELLED', message: 'Approval was cancelled by the caller; ask the user to explicitly start a new request.' };
    if (settled.decision !== 'allowed-once') return { allowed: false, code: 'APPROVAL_DENIED', message: `Approval outcome was ${String(settled.decision)}.` };
    return { allowed: true };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}
