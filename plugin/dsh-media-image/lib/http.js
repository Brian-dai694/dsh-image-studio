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

// A relay request is accepted only from the same origin that serves this page, with the
// per-process bearer token. The iframe never sees the token; only the wrapper page does.
function authorizeRelay(req, token) {
  const host = req.headers.host;
  const origin = req.headers.origin;
  if (typeof host !== 'string' || typeof origin !== 'string') return 'Origin required';
  let originHost;
  try { originHost = new URL(origin).host; } catch { return 'Invalid Origin'; }
  if (originHost !== host) return 'Cross-origin relay request rejected';
  if (req.headers.authorization !== `Bearer ${token}`) return 'Relay authentication failed';
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') return 'JSON content type required';
  if (req.method !== 'POST') return 'POST required';
  return null;
}

async function handleRelay(req, res, { relay, prefix, token, pathname }) {
  const action = pathname.slice(prefix.length);
  if (!RELAY_ACTIONS.has(action)) { send(res, 404, { code: 'INVALID_REQUEST', message: 'Unknown relay route' }); return true; }
  const rejection = authorizeRelay(req, token);
  if (rejection) { send(res, 403, { code: 'INVALID_REQUEST', message: rejection }); return true; }
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
      if (req.headers['sec-fetch-site'] !== 'same-origin' || req.headers['sec-fetch-dest'] !== 'empty') {
        send(res, 403, { error: 'Same-origin fetch required' });
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
