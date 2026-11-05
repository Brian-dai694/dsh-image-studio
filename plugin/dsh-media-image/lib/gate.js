// Policy gate: synchronous static denials, plugin-owned capability table,
// and the plugin-side pending -> approvalId binding for high-risk writes.

const TTL_MS = 5 * 60_000;

// 会话身份的唯一来源：真实 ToolRunContext。
// 只认 exec.agent.id，并要求它与运行中的 exec.agent.session.id 一致；
// 模型参数、Agent 名称或客户端自报的 sessionId 一律不接受。
export function trustedSessionId(exec) {
  const id = exec?.agent?.id;
  if (typeof id !== 'string' || !id || exec?.agent?.session?.id !== id) {
    throw Object.assign(new Error('A live, matching Host agent/session identity is required.'), { code: 'SESSION_IDENTITY_REQUIRED' });
  }
  return id;
}

// Host 内部的会话↔页面授权登记表。不暴露任何 HTTP 认领接口，也没有客户端自报入口。
// 两条授权来源：
//   native —— 真实会话身份 + 原生人工审批 + 页面/快照复验后才登记（宿主 approval=ask 时可用）；
//   panel  —— 本人在编辑器面板点一次「授权此会话读写本工程」，消费一次性 bindTicket 后登记。
// 两条都必须本人发起：模型没有签发票据的调用面，也不能代点。
// register 只是给宿主集成留的旧接口，要求调用方已独立核实页面归属。
export function createSessionBindings({ resolvePage, tickets = null, now = () => Date.now() } = {}) {
  const bindings = new Map();
  const invalid = new Set();
  const pending = new Set();
  const audit = [];
  const recordAudit = entry => { audit.push(Object.freeze({ at: now(), ...entry })); if (audit.length > 200) audit.shift(); };
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  const registerGrant = (binding) => {
    bindings.set(binding.sessionId, Object.freeze(binding));
    recordAudit({ action: 'grant', sessionId: binding.sessionId, editorKind: binding.editorKind, projectId: binding.projectId, instanceId: binding.instanceId, pageId: binding.pageId, source: binding.source, grantId: binding.grantId, ticketId: binding.ticketId ?? null, expiresAt: binding.expiresAt ?? null });
    return bindings.get(binding.sessionId);
  };

  async function authorizeNative(exec, { editorKind, instanceId, projectId, readState, approve }) {
    // 流程：取可信 session → 锁定 relay 实时页面 → 读文档快照 → 原生审批
    // → 复验信号/失效/页面/工程/快照 → 原子登记。任一步变化都不登记。
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
      return registerGrant({ sessionId, editorKind, instanceId, projectId, pageId: page.pageId, grantId: globalThis.crypto.randomUUID(), source: 'native', grantedAt: now(), expiresAt: null, ticketId: null });
    } finally { pending.delete(sessionId); }
  }

  // 面板授权：认领一张本人签发的票据后登记 grant。不调用宿主审批，因此 approval=never 的
  // 桌面端也能用。票据按 (editorKind, projectId, instanceId, pageId) 匹配，会话身份由
  // trustedSessionId(exec) 当场补上——面板从不自报 sessionId。
  const GRANT_SOFT_TTL_MS = 8 * 60 * 60_000;
  async function bindWithTicket(exec, { editorKind, instanceId, projectId, readState }) {
    const sessionId = trustedSessionId(exec);
    if (invalid.has(sessionId)) fail('SESSION_BINDING_STALE', 'The project/page binding expired; create a new dedicated session.');
    if (bindings.has(sessionId)) return bindings.get(sessionId);
    const page = resolvePage?.(editorKind, instanceId);
    if (!page) fail('SESSION_BINDING_REQUIRED', '编辑器页面还没有连上；先打开编辑器，再由本人在面板点“授权此会话读写本工程”。');
    if (!tickets) fail('SESSION_BINDING_REQUIRED', 'This deployment has no panel bind tickets.');
    const verdict = tickets.redeem({ editorKind, projectId, editorInstanceId: instanceId, pageId: page.pageId });
    if (!verdict.ok) fail('SESSION_BINDING_REQUIRED', `${verdict.message}（${verdict.code}）`);
    const before = await readState();
    if (before.documentId !== projectId) fail('DOCUMENT_MISMATCH', 'Requested project does not match the editor.');
    const grantedAt = now();
    return registerGrant({
      sessionId, editorKind, instanceId, projectId, pageId: page.pageId,
      grantId: globalThis.crypto.randomUUID(), source: 'panel',
      issuedAt: verdict.ticket.issuedAt, grantedAt,
      expiresAt: grantedAt + GRANT_SOFT_TTL_MS,
      ticketId: verdict.ticket.ticketId,
    });
  }

  // 统一绑定入口：先认领面板票据，再走原生审批；两条都没有就明确回未授权，
  // 不复用 EDITOR_NOT_READY（那会让人一直去查连接）。
  async function bind(exec, { editorKind, instanceId, projectId, readState, approve }) {
    const sessionId = trustedSessionId(exec);
    const existing = bindings.get(sessionId);
    if (existing) {
      if (Number.isFinite(existing.expiresAt) && existing.expiresAt <= now()) {
        bindings.delete(sessionId);
        recordAudit({ action: 'expired', sessionId, editorKind: existing.editorKind, projectId: existing.projectId, instanceId: existing.instanceId, source: existing.source, grantId: existing.grantId, reason: 'grant-soft-ttl' });
        fail('SESSION_BINDING_EXPIRED', '授权已过期（软上限 8 小时）；请本人在面板重新授权。');
      }
      return existing;
    }
    try {
      return await bindWithTicket(exec, { editorKind, instanceId, projectId, readState });
    } catch (ticketError) {
      if (ticketError?.code !== 'SESSION_BINDING_REQUIRED') throw ticketError;
      if (typeof approve !== 'function') throw ticketError;
      try {
        return await authorizeNative(exec, { editorKind, instanceId, projectId, readState, approve });
      } catch (error) {
        // 策略 never 下「审批被拒绝」根本不是用户拒绝，必须与「纯未授权」分开报。
        if (error?.code === 'APPROVAL_UNAVAILABLE' || error?.code === 'APPROVAL_DENIED' || error?.code === 'APPROVAL_FAILED') {
          fail('SESSION_APPROVAL_UNAVAILABLE', `宿主审批不可用或策略为 never（${error.code}），这不是你拒绝了审批。请本人在编辑器面板点“授权此会话读写本工程”。`);
        }
        if (error?.code === 'SESSION_BINDING_REQUIRED') throw error;
        throw error;
      }
    }
  }

  return {
    authorize: authorizeNative,
    bind,
    bindWithTicket,
    // 旧宿主集成入口：调用方必须已独立证明该页面属于本会话，否则拒绝。
    register(exec, binding) {
      const sessionId = trustedSessionId(exec);
      if (!resolvePage) fail('SESSION_BINDING_UNAVAILABLE', 'Host page ownership resolver is not connected.');
      for (const key of ['projectId', 'instanceId', 'pageId']) if (typeof binding?.[key] !== 'string' || !binding[key]) fail('INVALID_REQUEST', `Binding ${key} is required.`);
      if (binding.editorKind !== 'image') fail('INVALID_REQUEST', 'Binding editorKind is invalid.');
      const page = resolvePage(binding.editorKind, binding.instanceId);
      if (!page || page.pageId !== binding.pageId || page.sessionId !== sessionId) fail('SESSION_BINDING_MISMATCH', 'Host has not verified session ownership of this page.');
      if (bindings.has(sessionId) || invalid.has(sessionId)) fail('SESSION_BINDING_STALE', 'Create a new dedicated session after changing the project.');
      return registerGrant({ ...binding, sessionId, source: 'verified-register', grantedAt: now(), expiresAt: null });
    },
    // 每次工具调用前校验：会话已绑定、kind/实例/工程一致、页面仍存活；
    // 页面断开或换页即作废绑定（保活切页不算断开）。
    assert(exec, kind, args) {
      const sessionId = trustedSessionId(exec);
      const binding = bindings.get(sessionId);
      if (invalid.has(sessionId)) fail('SESSION_BINDING_STALE', 'The project/page binding expired; create a new dedicated session.');
      if (!binding) fail('SESSION_BINDING_REQUIRED', 'Host-verified editor/session registration is required.');
      // 授权软上限：8 小时，或页面/工程变化，任一不满足立即作废。
      if (Number.isFinite(binding.expiresAt) && binding.expiresAt <= now()) {
        bindings.delete(sessionId);
        recordAudit({ action: 'expired', sessionId, editorKind: binding.editorKind, projectId: binding.projectId, instanceId: binding.instanceId, source: binding.source, grantId: binding.grantId, reason: 'grant-soft-ttl' });
        fail('SESSION_BINDING_EXPIRED', '授权已过期（软上限 8 小时）；请本人在面板重新授权。');
      }
      if (kind !== binding.editorKind || args.instanceId !== binding.instanceId || args.projectId !== binding.projectId) fail('SESSION_BINDING_MISMATCH', 'Explicit projectId, instanceId and editor kind must match the Host binding.');
      const page = resolvePage?.(binding.editorKind, binding.instanceId);
      if (!page || page.pageId !== binding.pageId) {
        invalid.add(sessionId); bindings.delete(sessionId);
        recordAudit({ action: 'revoked', sessionId, editorKind: binding.editorKind, projectId: binding.projectId, instanceId: binding.instanceId, pageId: binding.pageId, source: binding.source, grantId: binding.grantId, reason: 'page-disconnected-or-changed' });
        fail('SESSION_BINDING_STALE', 'The bound page disconnected or changed.');
      }
      if (kind !== binding.editorKind || args.instanceId !== binding.instanceId || args.projectId !== binding.projectId) fail('SESSION_BINDING_MISMATCH', 'Explicit projectId, instanceId and editor kind must match the Host binding.');
      return binding;
    },
    invalidate(sessionId) {
      const binding = bindings.get(sessionId);
      bindings.delete(sessionId); invalid.add(sessionId);
      recordAudit({ action: 'revoked', sessionId, editorKind: binding?.editorKind ?? null, projectId: binding?.projectId ?? null, instanceId: binding?.instanceId ?? null, source: binding?.source ?? null, grantId: binding?.grantId ?? null, reason: 'invalidated-by-host' });
    },
    bindingOf(sessionId) { return bindings.get(sessionId) ?? null; },
    // 面板「撤销授权」：按页面+工程撤掉所有相关 grant（本人点击才走到这里）。
    revokeByTarget({ editorKind, projectId, pageId }) {
      let revoked = 0;
      for (const [sessionId, binding] of [...bindings]) {
        if (binding.editorKind !== editorKind) continue;
        if (binding.projectId !== projectId) continue;
        if (pageId && binding.pageId !== pageId) continue;
        bindings.delete(sessionId);
        revoked += 1;
        recordAudit({ action: 'revoked', sessionId, editorKind: binding.editorKind, projectId: binding.projectId, instanceId: binding.instanceId, pageId: binding.pageId, source: binding.source, grantId: binding.grantId, reason: 'panel-unbind' });
      }
      return revoked;
    },
    auditLog() { return audit.slice(); },
  };
}

// 自主执行白名单：只放行可逆的低风险编辑；其余必须走人工确认。
export const AUTONOMOUS_CAPABILITIES = {
  image: new Set(['layer.update_text']),
};

// 高风险操作：导媒体、删数据、覆盖式导出等破坏性动作，必须逐次人工审批。
// layer.add_image 会导入外部图像并保留 alpha，属于"新增外部素材"，因此要求审批；
// 其后基于已有图层的羽化/调色/阴影都是可撤销的属性编辑，走普通写入。
export const HIGH_RISK_OPERATIONS = {
  image: new Set(['layer.remove', 'canvas.crop', 'layer.add_image']),
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

// 同步守卫：在 tools/pre-execute 阶段运行，只能拒绝、不能放行或改写参数。
// 负责本包能静态判断的三件事：工具归属编辑器、operation 前缀、自主模式白名单；
// 会话绑定与审批属于状态检查，不在这里做。
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
 * 插件侧的高风险写审批凭据：先返回 pending + approvalId，用户批准后模型带同一 approvalId 再来。
 * issue 按 agentId+commandId 去重；take 必须逐项匹配工程、操作、参数摘要、revision 与 digest，
 * 一次性消费，任何不匹配都作废该凭据，避免批准 A 却执行 B。
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
    /** 校验并消费凭据；失败也消费，返回 { ok:false, code, message }。 */
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

// 人工审批的最长等待（5 分钟）。宿主的 timeoutMs 是整次工具调用的预算，
// 所以工具侧预算必须高于它（tools.js 加 30 秒余量），而媒体往返仍保持 10 秒；
// 两者都不允许无限延长，也不自动重试。
export const APPROVAL_WAIT_MS = 5 * 60_000;

/**
 * 请求一次原生人工审批，只接受 `allowed-once`。
 * 等待有上限（APPROVAL_WAIT_MS）：到期主动中止审批请求并返回 APPROVAL_TIMEOUT，
 * 迟到放行不会生效；调用方取消同样立即返回 APPROVAL_CANCELLED，均不自动重试。
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
