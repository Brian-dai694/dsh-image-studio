// Same-origin routes served by ctx.webServer.register: boot token, relay transport and the
// packaged editor pages for this single editor kind. No separate HTTP server is started.
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
function authorizeRelay(req, token) {
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
  if (h['content-type']?.split(';')[0] !== 'application/json') return { reason: 'content-type', message: 'JSON content type required', observed };
  if (req.method !== 'POST') return { reason: 'method', message: 'POST required', observed };
  return null;
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

export function createMediaRouter({ relay, editorKind, prefix, token, publicDir, editorRoot = null }) {
  const hostRoot = resolve(publicDir, 'host');
  const relayPrefix = `${prefix}/relay/`;
  const editorPrefix = `${prefix}/${editorKind}/`;
  const bootPath = `${prefix}/boot`;
  const missing = () => send(null, 0, null);

  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://dsh.local');
    const pathname = url.pathname;
    if (!pathname.startsWith(prefix)) return false;

    if (pathname.startsWith(relayPrefix)) return handleRelay(req, res, { relay, prefix: relayPrefix, token, pathname });

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
