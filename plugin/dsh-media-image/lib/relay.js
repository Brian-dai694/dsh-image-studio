import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';

const DEFAULT_TYPES = ['editor.read_state', 'editor.apply_command', 'editor.get_command_result'];
const fail = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });
const opaque = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256;

// Stores routing and request outcomes only; never owns or writes editor document state.
export function createEditorRelay({ timeoutMs = 10000, leaseMs = 15000, maxPending = 128, maxPages = 8,
  minPollIntervalMs = 50, maxMessageBytes = 65536, maxResponseBytes = 262144, allowedTypes = DEFAULT_TYPES,
  editorKind = 'image' } = {}) {
  const types = new Set(allowedTypes);
  if (!['image', 'video'].includes(editorKind) || !types.has('editor.read_state') || !types.has('editor.apply_command') || !types.has('editor.get_command_result')) {
    throw new TypeError('Relay requires a supported editorKind and the three core editor request types');
  }
  const pages = new Map();
  const pending = new Map();
  let closed = false;
  function authenticate(pageId, pageToken) {
    const page = pages.get(pageId);
    if (!page || typeof pageToken !== 'string' || pageToken.length !== page.token.length ||
      !timingSafeEqual(Buffer.from(pageToken), Buffer.from(page.token))) throw fail('EDITOR_NOT_READY', '页面连接不存在或认证失败');
    return page;
  }
  function rejectEntry(entry, reason) {
    clearTimeout(entry.timer);
    pending.delete(entry.message.requestId);
    const mutation = entry.message.type === 'editor.apply_command';
    entry.reject(fail(mutation ? 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN' : 'EDITOR_NOT_READY', reason,
      { commandId: entry.message.commandId, outcomeUnknown: mutation }));
  }
  function dropPage(page, reason) {
    pages.delete(page.id);
    for (const entry of pending.values()) if (entry.pageId === page.id) rejectEntry(entry, reason);
  }
  function expirePages() {
    const now = Date.now();
    for (const page of pages.values()) if (now - page.lastSeen > leaseMs) dropPage(page, '页面心跳过期；未完成命令的结果未知');
  }
  const sweep = setInterval(expirePages, Math.max(10, Math.min(1000, leaseMs)));
  sweep.unref?.();

  return {
    // Host-only liveness lookup. Never grants session ownership or returns credentials.
    getPage(editorInstanceId) {
      if (closed) return null;
      expirePages();
      const page = [...pages.values()].find(item => item.editorInstanceId === editorInstanceId && item.kind === editorKind);
      return page ? Object.freeze({ pageId: page.id, editorInstanceId: page.editorInstanceId, kind: page.kind }) : null;
    },
    register({ editorInstanceId, kind = editorKind }) {
      if (closed) throw fail('EDITOR_NOT_READY', '中继已关闭');
      if (kind !== editorKind) throw fail('EDITOR_KIND_MISMATCH', '编辑器类型与此中继绑定不匹配');
      if (!opaque(editorInstanceId)) throw fail('INVALID_REQUEST', '无效 editorInstanceId');
      expirePages();
      if ([...pages.values()].some((p) => p.editorInstanceId === editorInstanceId)) throw fail('EDITOR_INSTANCE_MISMATCH', '此编辑器实例已有页面绑定');
      if (pages.size >= maxPages) throw fail('EDITOR_NOT_READY', '页面连接数达到上限');
      const page = { id: randomUUID(), token: randomBytes(32).toString('hex'), editorInstanceId, kind, lastSeen: Date.now() };
      pages.set(page.id, page);
      return { pageId: page.id, pageToken: page.token, editorInstanceId, kind, leaseMs };
    },
    poll({ pageId, pageToken }) {
      expirePages();
      const page = authenticate(pageId, pageToken);
      const now = Date.now();
      if (page.lastPoll !== undefined && now - page.lastPoll < minPollIntervalMs) {
        throw fail('RATE_LIMITED', '轮询过于频繁，请稍后重试', { retryAfterMs: minPollIntervalMs - (now - page.lastPoll) });
      }
      page.lastPoll = now;
      page.lastSeen = now;
      const messages = [];
      let bytes = Buffer.byteLength('{"messages":[]}');
      for (const entry of pending.values()) {
        if (entry.pageId === page.id && !entry.dispatched) {
          const size = Buffer.byteLength(JSON.stringify(entry.message)) + (messages.length ? 1 : 0);
          if (bytes + size > maxResponseBytes) break;
          bytes += size;
          entry.dispatched = true;
          messages.push(entry.message);
        }
      }
      return { messages };
    },
    respond({ pageId, pageToken, response }) {
      expirePages();
      const page = authenticate(pageId, pageToken);
      page.lastSeen = Date.now();
      if (!response || !opaque(response.requestId) || typeof response.ok !== 'boolean') throw fail('INVALID_REQUEST', '无效应答');
      const entry = pending.get(response.requestId);
      // Late/duplicate replies cannot complete another request.
      if (!entry) return { accepted: false };
      if (entry.pageId !== page.id || entry.message.editorInstanceId !== page.editorInstanceId || entry.message.editorKind !== undefined && entry.message.editorKind !== page.kind || !entry.dispatched) throw fail('EDITOR_INSTANCE_MISMATCH', '应答与请求页面/编辑器类型不匹配');
      if (Buffer.byteLength(JSON.stringify(response)) > maxResponseBytes) {
        if (entry.message.type === 'editor.apply_command') {
          rejectEntry(entry, '编辑器应答超出大小上限；命令结果未知');
        } else {
          clearTimeout(entry.timer);
          pending.delete(response.requestId);
          entry.reject(fail('PAYLOAD_TOO_LARGE', '结果过大，无法确认原命令结果；不得推断未执行或重放', { outcomeUnknown: true, commandId: entry.message.commandId }));
        }
        throw fail('PAYLOAD_TOO_LARGE', '编辑器应答超出大小上限');
      }
      clearTimeout(entry.timer);
      pending.delete(response.requestId);
      if (response.ok) entry.resolve(response.result);
      else entry.reject(fail(response.error?.code || 'EDITOR_ERROR', response.error?.message || '编辑器拒绝请求', { revision: response.error?.revision, outcomeUnknown: response.error?.outcomeUnknown }));
      return { accepted: true };
    },
    disconnect({ pageId, pageToken }) {
      const page = authenticate(pageId, pageToken);
      dropPage(page, '页面连接已断开；未完成命令的结果未知');
      return { disconnected: true };
    },
    request(message, options = {}) {
      if (closed) return Promise.reject(fail('EDITOR_NOT_READY', '中继已关闭'));
      expirePages();
      if (!message || !types.has(message.type) || !opaque(message.requestId) || !opaque(message.editorInstanceId)) return Promise.reject(fail('INVALID_REQUEST', '无效中继请求'));
      if (message.editorKind !== undefined && message.editorKind !== editorKind) return Promise.reject(fail('EDITOR_KIND_MISMATCH', '请求编辑器类型与中继绑定不匹配'));
      if (pending.has(message.requestId)) return Promise.reject(fail('INVALID_REQUEST', 'requestId 重复'));
      const page = [...pages.values()].find((p) => p.editorInstanceId === message.editorInstanceId && p.kind === editorKind);
      if (!page && message.type === 'editor.get_command_result') {
        // A missing route is never evidence that a command was not applied.
        return Promise.resolve({ status: 'unknown', originalResult: null });
      }
      if (!page) return Promise.reject(fail('EDITOR_NOT_READY', '指定编辑器实例未连接'));
      if (pending.size >= maxPending) return Promise.reject(fail('EDITOR_NOT_READY', '待应答请求达到上限'));
      const ms = Math.min(timeoutMs, options.timeoutMs ?? timeoutMs);
      if (!Number.isFinite(ms) || ms <= 0) return Promise.reject(fail('INVALID_REQUEST', '无效 timeoutMs'));
      const copied = structuredClone({ ...message, editorKind });
      if (Buffer.byteLength(JSON.stringify(copied)) > Math.min(maxMessageBytes, maxResponseBytes - 32)) {
        return Promise.reject(fail('PAYLOAD_TOO_LARGE', '中继请求超出大小上限'));
      }
      return new Promise((resolve, reject) => {
        const entry = { pageId: page.id, message: copied, resolve, reject, dispatched: false };
        entry.timer = setTimeout(() => {
          if (message.type === 'editor.apply_command') rejectEntry(entry, '命令应答超时，执行结果未知；查询原 commandId');
          else {
            pending.delete(message.requestId);
            reject(fail('EDITOR_TIMEOUT', '页面应答超时'));
          }
        }, ms);
        pending.set(message.requestId, entry);
      });
    },
    close() {
      closed = true;
      clearInterval(sweep);
      for (const page of pages.values()) dropPage(page, '中继关闭；未完成命令的结果未知');
    },
  };
}

// Mount under an isolated same-origin server or a future explicitly approved Host route.
// A per-server random bearer token authenticates the trusted parent page, not iframe content.
export function createRelayHttpHandler({ relay, origin, accessToken, prefix = '/editor-relay' }) {
  const expectedOrigin = new URL(origin).origin;
  if (typeof accessToken !== 'string' || accessToken.length < 32) throw new TypeError('Use a random accessToken of at least 32 characters');
  return async (req, res) => {
    const path = new URL(req.url, expectedOrigin).pathname;
    if (!path.startsWith(`${prefix}/`)) return false;
    const send = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'POST') { send(405, { code: 'INVALID_REQUEST', message: 'POST required' }); return true; }
    if (req.headers.host !== new URL(expectedOrigin).host ||
      req.headers.origin !== expectedOrigin || req.headers.authorization !== `Bearer ${accessToken}` ||
      req.headers['content-type']?.split(';')[0] !== 'application/json') {
      send(403, { code: 'INVALID_REQUEST', message: 'Origin or relay authentication failed' }); return true;
    }
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 262144) { send(413, { code: 'INVALID_REQUEST', message: 'Payload too large' }); return true; }
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const action = path.slice(prefix.length + 1);
      if (!['register', 'poll', 'respond', 'disconnect'].includes(action)) { send(404, { code: 'INVALID_REQUEST', message: 'Unknown relay route' }); return true; }
      send(200, relay[action](body));
    } catch (error) { send(error.code === 'RATE_LIMITED' ? 429 : error.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400, { code: error.code || 'INVALID_REQUEST', message: error.message, retryAfterMs: error.retryAfterMs }); }
    return true;
  };
}
