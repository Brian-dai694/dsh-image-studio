// Same-origin routes served by ctx.webServer.register: boot token, relay transport and the
// packaged editor pages for this single editor kind. No separate HTTP server is started.
import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

const SAFE = /^[a-zA-Z0-9._/-]+$/;
const RELAY_ACTIONS = new Set(['register', 'poll', 'respond', 'disconnect']);

/**
 * boot 令牌的同源校验（与视频包同形）。
 *
 * 只信 `Sec-Fetch-*` 会误伤桌面端（Electron 经常不带这两个头），所以主判据改成**自定义请求头**：
 * 跨源页面想带 `x-dsh-media-boot` 必须先过 CORS 预检，而本服务不响应预检 ⇒ 只有同源页能带。
 * 辅以 `Sec-Fetch-Site`：显式拒绝 `cross-site` / `same-site`；缺失或 `same-origin` / `none` 都放行。
 * 403 正文带观测值（site/dest/mode/origin），便于下次一眼定位。
 */
const BOOT_HEADER = 'x-dsh-media-boot';

export function bootAllowed(req) {
  const h = req?.headers || {};
  const site = h['sec-fetch-site'];
  const dest = h['sec-fetch-dest'];
  const mode = h['sec-fetch-mode'];
  const origin = h.origin;
  const observed = { site: site ?? null, dest: dest ?? null, mode: mode ?? null, origin: origin ?? null };
  if (h[BOOT_HEADER] !== '1') return { ok: false, reason: 'missing-boot-header', observed };
  if (site === 'cross-site' || site === 'same-site') return { ok: false, reason: 'sec-fetch-site', observed };
  return { ok: true, observed };
}

const send = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
};

async function readJsonBody(req, limit = 262144) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Payload too large'), { code: 'PAYLOAD_TOO_LARGE' });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function serveFile(res, root, name) {
  if (typeof name !== 'string' || name.includes('..') || name.startsWith('/') || name.endsWith('.map') || !SAFE.test(name)) {
    send(res, 404, { error: 'Not found' });
    return;
  }
  try {
    const canonicalRoot = await realpath(root);
    const path = await realpath(resolve(root, name));
    const rel = relative(canonicalRoot, path);
    if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || resolve(canonicalRoot, rel) !== path || !(await stat(path)).isFile()) {
      send(res, 404, { error: 'Not found' });
      return;
    }
    const bytes = await readFile(path);
    res.writeHead(200, {
      'content-type': MIME[extname(path)] || 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin',
    });
    res.end(bytes);
  } catch {
    send(res, 404, { error: 'Not found' });
  }
}

const RELAY_HEADER = 'x-dsh-media-relay';

/**
 * 接力请求（relay）的同源判据，与 boot 同一思路：不依赖桌面端拿不到的 `Origin`。
 *
 * - `Sec-Fetch-Site` 显式为 `cross-site` / `same-site` → 拒；
 * - 带 `Origin` 时仍要求与 `Host` 一致（普通浏览器路径）；
 * - 缺 `Origin`（桌面 Electron 的真实形状）→ 要求自定义头 `x-dsh-media-relay: 1`：
 *   跨源页面想带自定义头必先过 CORS 预检，本服务不响应预检 ⇒ 只有同源页能带；
 * - 令牌仍走 `Authorization: Bearer`，页面之外的源读不到。
 *
 * 返回 `null` 表示放行，否则返回 `{ reason, message, observed }`，403 正文原样带出。
 */
function authorizeSameOrigin(req, token, methods = ['POST']) {
  const h = req?.headers || {};
  const host = h.host;
  const origin = h.origin;
  const site = h['sec-fetch-site'];
  const mode = h['sec-fetch-mode'];
  const hasRelayHeader = h[RELAY_HEADER] === '1';
  const observed = { origin: origin ?? null, site: site ?? null, mode: mode ?? null, hasRelayHeader };
  if (site === 'cross-site' || site === 'same-site') return { reason: 'sec-fetch-site', message: 'Cross-site relay request rejected', observed };
  if (typeof host !== 'string') return { reason: 'missing-host', message: 'Host required', observed };
  if (typeof origin === 'string') {
    let originHost;
    try { originHost = new URL(origin).host; } catch { return { reason: 'invalid-origin', message: 'Invalid Origin', observed }; }
    if (originHost !== host) return { reason: 'origin-mismatch', message: 'Cross-origin relay request rejected', observed };
  } else if (!hasRelayHeader) {
    return { reason: 'missing-relay-header', message: 'Relay header required when Origin is absent', observed };
  }
  if (h.authorization !== `Bearer ${token}`) return { reason: 'relay-auth-failed', message: 'Relay authentication failed', observed };
  if (methods.includes('POST') && h['content-type']?.split(';')[0] !== 'application/json') return { reason: 'content-type', message: 'JSON content type required', observed };
  if (!methods.includes(req.method)) return { reason: 'method', message: `${methods.join('/')} required`, observed };
  return null;
}

function authorizeRelay(req, token) { return authorizeSameOrigin(req, token, ['POST']); }

// 只有本人能在面板上点这一下：入口要求同源（自定义头）+ 页面令牌，Agent 没有 HTTP 调用面。
// 契约（project-grant-v1）：票据只绑 (editorKind, projectId, instanceId, pageId)，
// 面板只发 {instanceId}，**不接受 sessionId**；会话身份由 Host 在工具调用时用真实 exec 补上。
async function handleBind(req, res, { tickets, bindings, relay, editorKind, prefix, token, pathname }) {
  const isStatus = pathname.endsWith('/bind-status');
  const isUnbind = pathname.endsWith('/grant/unbind');
  const rejection = authorizeSameOrigin(req, token, isStatus ? ['GET'] : ['POST']);
  if (rejection) {
    send(res, 403, { code: 'INVALID_REQUEST', message: rejection.message, reason: rejection.reason, observed: rejection.observed });
    return true;
  }
  const url = new URL(req.url ?? '/', 'http://dsh.local');
  const pageOf = editorInstanceId => {
    const page = relay?.getPage?.(editorInstanceId) ?? null;
    return page && page.kind === editorKind ? page : null;
  };
  const stateOf = async editorInstanceId => {
    const state = await relay.request({ type: 'editor.read_state', requestId: randomUUID(), editorInstanceId });
    if (!state?.documentId) throw Object.assign(new Error('编辑器没有返回工程 id'), { code: 'EDITOR_NOT_READY' });
    return state;
  };
  try {
    if (isStatus) {
      // instanceId 优先；为了兼容旧面板，允许只传 sessionId（此时只能看 grant，没有 pending 票据）。
      const editorInstanceId = url.searchParams.get('instanceId') || url.searchParams.get('instanceIdOrNull');
      const sessionId = url.searchParams.get('sessionId');
      let page = editorInstanceId ? pageOf(editorInstanceId) : null;
      let pending = null;
      let projectId = null;
      if (page) {
        try { projectId = (await stateOf(editorInstanceId)).documentId; } catch { projectId = null; }
        if (projectId) pending = tickets?.pendingFor({ pageId: page.pageId, projectId }) ?? null;
      }
      const grant = sessionId && bindings?.bindingOf ? bindings.bindingOf(sessionId) : null;
      send(res, 200, {
        ok: true,
        editorKind,
        projectId: projectId ?? grant?.projectId ?? null,
        ticket: pending && pending.state === 'pending' ? { ticketId: pending.ticketId, projectId: pending.projectId, issuedAt: pending.issuedAt, expiresAt: pending.expiresAt, ttlMs: pending.ttlMs, state: pending.state } : null,
        grant: grant ? { source: grant.source || 'unknown', grantId: grant.grantId ?? null, projectId: grant.projectId, issuedAt: grant.issuedAt ?? grant.grantedAt ?? null, expiresAt: grant.expiresAt ?? null, expiresInMs: Number.isFinite(grant.expiresAt) ? Math.max(0, grant.expiresAt - Date.now()) : null } : null,
      });
      return true;
    }
    const body = await readJsonBody(req).catch(() => null);
    if (!body || typeof body !== 'object') { send(res, 400, { code: 'INVALID_REQUEST', message: 'JSON body is required.' }); return true; }
    const editorInstanceId = typeof body.instanceId === 'string' ? body.instanceId : null;
    if (!editorInstanceId) { send(res, 400, { code: 'INVALID_REQUEST', message: 'instanceId is required.' }); return true; }
    const page = pageOf(editorInstanceId);
    if (!page) { send(res, 409, { code: 'EDITOR_NOT_READY', message: '编辑器页面还没有连上，先打开编辑器再授权。' }); return true; }
    const state = await stateOf(editorInstanceId);
    if (isUnbind || body.action === 'revoke') {
      tickets?.revokeTarget({ pageId: page.pageId, projectId: state.documentId });
      const revokedGrants = bindings?.revokeByTarget?.({ editorKind, projectId: state.documentId, pageId: page.pageId }) ?? 0;
      send(res, 200, { ok: true, revoked: true, revokedGrants });
      return true;
    }
    if (!tickets) { send(res, 501, { code: 'BIND_UNAVAILABLE', message: 'This deployment has no panel grant tickets.' }); return true; }
    const ticket = tickets.issue({ editorKind, projectId: state.documentId, editorInstanceId, pageId: page.pageId, issuedBy: 'panel' });
    send(res, 200, {
      ok: true,
      ticket: { ticketId: ticket.ticketId, editorKind, projectId: ticket.projectId, instanceId: editorInstanceId, pageId: ticket.pageId, issuedAt: ticket.issuedAt, expiresAt: ticket.expiresAt, ttlMs: ticket.ttlMs },
    });
  } catch (error) {
    send(res, error.code === 'PAYLOAD_TOO_LARGE' ? 413 : error.code === 'EDITOR_NOT_READY' ? 409 : 400, { code: error.code || 'INVALID_REQUEST', message: error.message });
  }
  return true;
}

async function handleRelay(req, res, { relay, prefix, token, pathname }) {
  const action = pathname.slice(prefix.length);
  if (!RELAY_ACTIONS.has(action)) { send(res, 404, { code: 'INVALID_REQUEST', message: 'Unknown relay route' }); return true; }
  const rejection = authorizeRelay(req, token);
  if (rejection) { send(res, 403, { code: 'INVALID_REQUEST', message: rejection.message, reason: rejection.reason, observed: rejection.observed }); return true; }
  try {
    const body = await readJsonBody(req);
    send(res, 200, relay[action](body));
  } catch (error) {
    send(res, error.code === 'RATE_LIMITED' ? 429 : error.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400,
      { code: error.code || 'INVALID_REQUEST', message: error.message, retryAfterMs: error.retryAfterMs, revision: error.revision });
  }
  return true;
}

export function createMediaRouter({ relay, editorKind, prefix, token, publicDir, editorRoot = null, tickets = null, bindings = null }) {
  const hostRoot = resolve(publicDir, 'host');
  const relayPrefix = `${prefix}/relay/`;
  const editorPrefix = `${prefix}/${editorKind}/`;
  const bootPath = `${prefix}/boot`;
  const bindPath = `${prefix}/bind`;
  const bindStatusPath = `${prefix}/bind-status`;
  // 契约 §6 的正式路由；/bind 保留为同义旧路径，等面板全部切换后删。
  const grantTicketPath = `${prefix}/grant/ticket`;
  const grantUnbindPath = `${prefix}/grant/unbind`;

  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://dsh.local');
    const pathname = url.pathname;
    if (!pathname.startsWith(prefix)) return false;

    if (pathname.startsWith(relayPrefix)) return handleRelay(req, res, { relay, prefix: relayPrefix, token, pathname });
    // 面板授权入口在 GET 拦截之前：签发/解绑是 POST。
    if (pathname === bindPath || pathname === bindStatusPath || pathname === grantTicketPath || pathname === grantUnbindPath) {
      return handleBind(req, res, { tickets, bindings, relay, editorKind, prefix, token, pathname });
    }

    if (req.method !== 'GET') { send(res, 405, { error: 'GET required' }); return true; }

    if (pathname === bootPath) {
      const verdict = bootAllowed(req);
      if (!verdict.ok) {
        send(res, 403, { error: 'Same-origin fetch required', reason: verdict.reason, observed: verdict.observed });
        return true;
      }
      send(res, 200, { accessToken: token, editorKinds: [editorKind] });
      return true;
    }

    if (pathname === `${prefix}/host` || pathname === `${prefix}/host/`) {
      await serveFile(res, hostRoot, 'host.html');
      return true;
    }
    if (pathname.startsWith(`${prefix}/host/`)) {
      await serveFile(res, hostRoot, decodeURIComponent(pathname.slice(`${prefix}/host/`.length)));
      return true;
    }
    if (pathname === `${prefix}/${editorKind}`) { res.writeHead(302, { Location: editorPrefix }); res.end(); return true; }
    if (pathname.startsWith(editorPrefix)) {
      if (!editorRoot) { send(res, 503, { error: 'Editor page is not packaged in this build.', code: 'EDITOR_PAGE_UNAVAILABLE' }); return true; }
      await serveFile(res, editorRoot, decodeURIComponent(pathname.slice(editorPrefix.length)) || 'index.html');
      return true;
    }
    return false;
  };
}
