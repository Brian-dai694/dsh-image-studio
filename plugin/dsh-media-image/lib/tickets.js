// 面板授权票据（bind ticket）——按 project-grant-v1 契约：
//
// - 票据**不带 sessionId**：面板不知道真实会话，也不该知道。票据只绑
//   `(editorKind, projectId, instanceId, pageId)`；会话身份由工具调用当场用
//   `trustedSessionId(exec)` 补上，杜绝把「自报身份」再请回来。
// - 票据由 Host 签发，绑 pageId：否则一次同意会被拿到别的页面/工程重放。
// - 票据走「待认领槽位」：面板签完票就结束，Agent 下次 `read_state {bind:true}` 不带参数即可认领；
//   没有 pending 票据时 `bind:true` 直接回未授权——人没点，就永远没有票据。
// - 一次性、5 分钟过期；用第二次必须 `BIND_TICKET_CONSUMED`。
const DEFAULT_TTL_MS = 5 * 60_000;

const fail = (code, message) => Object.assign(new Error(message), { code });

export function createBindTickets({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
  // 键：pageId\0projectId —— 一张票据只属于「这一个页面上的这一个工程」。
  const byTarget = new Map();
  const keyOf = ({ pageId, projectId }) => `${pageId}\0${projectId}`;

  return {
    /** 签发一张待认领票据；同一目标重签只保留最新一张。 */
    issue({ editorKind, projectId, editorInstanceId, pageId, issuedBy = 'panel', reason = null }) {
      if (typeof editorKind !== 'string' || !editorKind) throw fail('INVALID_REQUEST', 'editorKind 是签发票据的必填项。');
      if (typeof projectId !== 'string' || !projectId) throw fail('INVALID_REQUEST', 'projectId 是签发票据的必填项。');
      if (typeof pageId !== 'string' || !pageId) throw fail('INVALID_REQUEST', 'pageId 是签发票据的必填项（否则票据可能被重放到别的页面）。');
      const issuedAt = now();
      // 存可变记录（要标 consumedAt），对外给冻结副本。
      const record = {
        ticketId: globalThis.crypto?.randomUUID?.() ?? `ticket-${issuedAt}-${Math.random().toString(16).slice(2)}`,
        editorKind,
        projectId,
        instanceId: editorInstanceId ?? null,
        pageId,
        issuedBy,
        reason,
        issuedAt,
        expiresAt: issuedAt + ttlMs,
        ttlMs,
        consumedAt: null,
      };
      byTarget.set(keyOf(record), record);
      return Object.freeze({ ...record });
    },

    /** 该目标当前待认领的票据（过期即清），供面板显示「已签发票据、等待激活」。 */
    pendingFor({ pageId, projectId }) {
      const ticket = byTarget.get(keyOf({ pageId, projectId }));
      if (!ticket) return null;
      if (ticket.consumedAt) return { ...ticket, state: 'consumed' };
      if (ticket.expiresAt <= now()) { byTarget.delete(keyOf({ pageId, projectId })); return null; }
      return { ...ticket, state: 'pending' };
    },

    /**
     * 认领票据：成功或失败都作废（用第二次必须 CONSUMED，不能重放）。
     * 校验维度与签发一致，另外要求实例（若签发时记了）也相同。
     */
    redeem({ editorKind, projectId, editorInstanceId, pageId }) {
      const key = keyOf({ pageId, projectId });
      const ticket = byTarget.get(key);
      if (!ticket) return { ok: false, code: 'BIND_TICKET_REQUIRED', message: '还没有面板授权：请本人在编辑器面板点一次“授权此会话读写本工程”。' };
      if (ticket.consumedAt) return { ok: false, code: 'BIND_TICKET_CONSUMED', message: '该授权票据已经用过一次；请本人重新签发票据。' };
      if (ticket.expiresAt <= now()) {
        ticket.consumedAt = now();
        return { ok: false, code: 'BIND_TICKET_EXPIRED', message: '授权票据已过期（有效期 5 分钟）；请本人重新签发票据。' };
      }
      if (ticket.editorKind !== editorKind) {
        ticket.consumedAt = now();
        return { ok: false, code: 'BIND_TICKET_MISMATCH', message: `票据授权的编辑器类型是 ${ticket.editorKind}，与本次 ${editorKind} 不符。` };
      }
      if (ticket.instanceId && editorInstanceId && ticket.instanceId !== editorInstanceId) {
        ticket.consumedAt = now();
        return { ok: false, code: 'BIND_TICKET_MISMATCH', message: '票据绑定的编辑器实例与当前实例不一致（页面可能已重开）。' };
      }
      ticket.consumedAt = now();
      return { ok: true, ticket };
    },

    /** 解绑/撤票：本人点击「撤销授权」。 */
    revokeTarget({ pageId, projectId }) { return byTarget.delete(keyOf({ pageId, projectId })); },
    size() { return byTarget.size; },
  };
}
