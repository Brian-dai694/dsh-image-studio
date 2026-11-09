// Same-origin routes served by ctx.webServer.register: boot token, relay transport and the
// packaged editor pages for this single editor kind. No separate HTTP server is started.
import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import { fetchRemoteBytes } from './remote.js';
import { MAX_FONT_BYTES } from './fonts.js';
import { psdToTemplate } from './psd.js';
import { compositePsdLayers } from './psd-composite.js';
import { planTemplateApply, planTemplateBatch } from './template.js';

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
const MAX_ASSET_BYTES = 32 * 1024 * 1024;const ASSET_HEADER = 'x-dsh-media-asset';

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
function authorizeSameOrigin(req, token, methods = ['POST'], { requireJson = true } = {}) {
  const h = req?.headers || {};
  const host = h.host;
  const origin = h.origin;
  const site = h['sec-fetch-site'];
  const mode = h['sec-fetch-mode'];
  const hasRelayHeader = h[RELAY_HEADER] === '1' || h[ASSET_HEADER] === '1';
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
  // 只对真正的 POST 要求 JSON：GET 没有请求体，浏览器也不会带 content-type。
  // 早先写成"方法白名单里含 POST 就要求"，导致 GET 列表接口（provider / batch 列表）被自己挡成 403。
  if (requireJson && req.method === 'POST' && h['content-type']?.split(';')[0] !== 'application/json') return { reason: 'content-type', message: 'JSON content type required', observed };
  if (!methods.includes(req.method)) return { reason: 'method', message: `${methods.join('/')} required`, observed };
  return null;
}

function authorizeRelay(req, token) { return authorizeSameOrigin(req, token, ['POST']); }

async function readBinaryBody(req, limit = MAX_ASSET_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error(`Image exceeds ${limit} byte limit.`), { code: 'PAYLOAD_TOO_LARGE' });
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

async function handleAssets(req, res, { assets, token, prefix, pathname }) {
  const assetPrefix = `${prefix}/assets/`;
  const rawId = pathname.slice(assetPrefix.length);
  const upload = rawId === 'upload' && req.method === 'POST';
  const id = rawId;
  if (!upload && !/^[a-f0-9]{48}$/.test(id)) { send(res, 404, { code: 'ASSET_NOT_FOUND', message: 'Image asset not found.' }); return true; }
  const rejection = authorizeSameOrigin(req, token, ['GET', 'POST'], { requireJson: false });
  if (rejection) { send(res, 403, { code: 'INVALID_REQUEST', message: rejection.message, reason: rejection.reason, observed: rejection.observed }); return true; }
  if (req.method === 'GET' && (req.headers?.[ASSET_HEADER] !== '1' || req.headers?.authorization !== `Bearer ${token}`)) { send(res, 403, { code: 'INVALID_REQUEST', message: 'Asset authentication failed.' }); return true; }
  const asset = assets?.get(id);
  if (req.method === 'GET') {
    if (!asset) { send(res, 404, { code: 'ASSET_NOT_FOUND', message: 'Image asset not found.' }); return true; }
    res.writeHead(200, { 'content-type': asset.mime, 'content-length': asset.bytes.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' });
    res.end(asset.bytes);
    return true;
  }
  if (req.method !== 'POST') { send(res, 405, { code: 'INVALID_REQUEST', message: 'GET or POST required.' }); return true; }
  const length = Number(req.headers?.['content-length']);
  if (Number.isFinite(length) && length > MAX_ASSET_BYTES) { send(res, 413, { code: 'PAYLOAD_TOO_LARGE', message: 'Image exceeds upload limit.' }); return true; }
  if (req.headers?.[ASSET_HEADER] !== '1') { send(res, 403, { code: 'INVALID_REQUEST', message: 'Asset upload header required.' }); return true; }
  if (req.headers?.authorization !== `Bearer ${token}`) { send(res, 403, { code: 'INVALID_REQUEST', message: 'Asset authentication failed.' }); return true; }
  const contentType = req.headers?.['content-type']?.split(';')[0]?.toLowerCase();
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(contentType)) { send(res, 415, { code: 'UNSUPPORTED_IMAGE_TYPE', message: 'Only PNG, JPEG and WebP uploads are supported.' }); return true; }
  try {
    const bytes = await readBinaryBody(req);
    let assetName = req.headers?.['x-dsh-media-name'] || `generated-${Date.now()}`;
    try { assetName = decodeURIComponent(assetName); } catch { send(res, 400, { code: 'INVALID_REQUEST', message: 'Invalid asset name encoding.' }); return true; }
    const uploaded = assets.add({ bytes, name: assetName });
    send(res, 201, { ok: true, asset: uploaded, sourceRef: `asset:${uploaded.id}` });
  } catch (error) {
    const status = error.code === 'PAYLOAD_TOO_LARGE' ? 413 : error.code === 'ASSET_STORE_FULL' ? 507 : 400;
    send(res, status, { code: error.code || 'INVALID_IMAGE', message: error.message });
  }
  return true;
}

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

async function handleFonts(req, res, { fonts, token, prefix, pathname, remoteFetch }) {
  const base = `${prefix}/fonts`;
  const id = pathname.startsWith(`${base}/`) ? pathname.slice(base.length + 1) : '';
  const rejection = authorizeSameOrigin(req, token, id ? ['GET'] : ['GET', 'POST'], { requireJson: false });
  if (rejection) { send(res, 403, { code: 'INVALID_REQUEST', message: rejection.message, reason: rejection.reason, observed: rejection.observed }); return true; }
  if (!fonts) { send(res, 501, { code: 'FONT_UNAVAILABLE', message: 'This deployment has no font store.' }); return true; }
  if (!id && req.method === 'GET') { send(res, 200, { ok: true, fonts: fonts.list() }); return true; }
  if (!id) {
    const body = await readJsonBody(req).catch(() => null);
    if (!body || typeof body !== 'object') { send(res, 400, { code: 'INVALID_REQUEST', message: 'JSON body is required.' }); return true; }
    if (typeof body.url !== 'string' || !body.url) { send(res, 400, { code: 'INVALID_REQUEST', message: 'url is required.' }); return true; }
    try {
      const fetched = await fetchRemoteBytes(body.url, { maxBytes: MAX_FONT_BYTES, fetchImpl: remoteFetch });
      const font = fonts.add({ bytes: fetched.bytes, family: body.family });
      send(res, 201, { ok: true, font });
    } catch (error) { send(res, remoteStatus(error), { code: error.code || 'INVALID_REQUEST', message: error.message }); }
    return true;
  }
  const font = fonts.get(id);
  if (!font) { send(res, 404, { code: 'FONT_NOT_FOUND', message: 'Font not found.' }); return true; }
  res.writeHead(200, {
    'content-type': font.mime, 'content-length': font.bytes.length,
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin',
  });
  res.end(font.bytes);
  return true;
}

// 素材 URL 导入：把远程图片拉进素材库，后续照常 asset:<id> 使用。
async function handleAssetImport(req, res, { assets, token, prefix, remoteFetch }) {
  if (!assets) { send(res, 501, { code: 'ASSET_UNAVAILABLE', message: 'This deployment has no asset store.' }); return true; }
  const body = await readJsonBody(req).catch(() => null);
  if (!body || typeof body !== 'object') { send(res, 400, { code: 'INVALID_REQUEST', message: 'JSON body is required.' }); return true; }
  if (typeof body.url !== 'string' || !body.url) { send(res, 400, { code: 'INVALID_REQUEST', message: 'url is required.' }); return true; }
  try {
    const fetched = await fetchRemoteBytes(body.url, { maxBytes: MAX_ASSET_BYTES, fetchImpl: remoteFetch });
    // 内容类型不信任响应头：assets.add 按文件签名判定，伪装扩展名会被拒。
    const asset = assets.add({ bytes: fetched.bytes, name: typeof body.name === 'string' && body.name ? body.name : 'remote-import' });
    send(res, 201, { ok: true, asset, sourceRef: `asset:${asset.id}` });
  } catch (error) { send(res, remoteStatus(error), { code: error.code || 'INVALID_REQUEST', message: error.message }); }
  return true;
}

const remoteStatus = error => error?.code === 'PAYLOAD_TOO_LARGE' ? 413
  : error?.code === 'URL_FORBIDDEN' ? 403
    : error?.code === 'URL_UNREACHABLE' ? 502
      : error?.code === 'FONT_STORE_FULL' || error?.code === 'ASSET_STORE_FULL' ? 507 : 400;

async function handleGenerate(req, res, { generation, token, prefix, pathname }) {
  const base = `${prefix}/generate`;
  const jobId = pathname.startsWith(`${base}/`) ? pathname.slice(base.length + 1) : '';
  const rejection = authorizeSameOrigin(req, token, jobId ? ['GET'] : ['GET', 'POST']);
  if (rejection) { send(res, 403, { code: 'INVALID_REQUEST', message: rejection.message, reason: rejection.reason, observed: rejection.observed }); return true; }
  if (!generation) { send(res, 501, { code: 'PROVIDER_UNAVAILABLE', message: 'This deployment has no generation backends configured.' }); return true; }
  if (!jobId && req.method === 'GET') { send(res, 200, { ok: true, providers: generation.list() }); return true; }
  if (!jobId) {
    const body = await readJsonBody(req).catch(() => null);
    if (!body || typeof body !== 'object') { send(res, 400, { code: 'INVALID_REQUEST', message: 'JSON body is required.' }); return true; }
    try {
      const job = await generation.submit(body);
      send(res, 202, { ok: true, job });
    } catch (error) { send(res, generationStatus(error), { code: error.code || 'GENERATION_FAILED', message: error.message }); }
    return true;
  }
  try {
    send(res, 200, { ok: true, job: await generation.status(jobId) });
  } catch (error) { send(res, generationStatus(error), { code: error.code || 'GENERATION_FAILED', message: error.message }); }
  return true;
}

async function handleBatch(req, res, { batchQueue, token, prefix, pathname }) {
  const base = `${prefix}/generate/batch`;
  const batchId = pathname.startsWith(`${base}/`) ? pathname.slice(base.length + 1) : '';
  const rejection = authorizeSameOrigin(req, token, batchId ? ['GET'] : ['GET', 'POST']);
  if (rejection) { send(res, 403, { code: 'INVALID_REQUEST', message: rejection.message, reason: rejection.reason, observed: rejection.observed }); return true; }
  if (!batchQueue) { send(res, 501, { code: 'PROVIDER_UNAVAILABLE', message: 'This deployment has no generation backends configured.' }); return true; }
  if (!batchId && req.method === 'GET') { send(res, 200, { ok: true, batches: batchQueue.list() }); return true; }
  if (!batchId) {
    const body = await readJsonBody(req).catch(() => null);
    if (!body || typeof body !== 'object') { send(res, 400, { code: 'INVALID_REQUEST', message: 'JSON body is required.' }); return true; }
    try {
      send(res, 202, { ok: true, batch: await batchQueue.submit(body) });
    } catch (error) {
      send(res, error?.code === 'BATCH_BUSY' ? 429 : 400, { code: error.code || 'INVALID_REQUEST', message: error.message });
    }
    return true;
  }
  try {
    send(res, 200, { ok: true, batch: await batchQueue.status(batchId) });
  } catch (error) {
    send(res, error?.code === 'BATCH_NOT_FOUND' ? 404 : 502, { code: error.code || 'BATCH_FAILED', message: error.message });
  }
  return true;
}

async function handleInpaint(req, res, { generation, token, prefix, pathname }) {
  const jobId = pathname.startsWith(`${prefix}/inpaint/`) ? pathname.slice(`${prefix}/inpaint/`.length) : '';
  const rejection = authorizeSameOrigin(req, token, jobId ? ['GET'] : ['GET', 'POST']);
  if (rejection) { send(res, 403, { code: 'INVALID_REQUEST', message: rejection.message, reason: rejection.reason, observed: rejection.observed }); return true; }
  if (!generation) { send(res, 501, { code: 'PROVIDER_UNAVAILABLE', message: '没有配置图像生成后端，局部重绘不可用。' }); return true; }
  if (!jobId && req.method === 'GET') { send(res, 200, { ok: true, providers: generation.list().map(p => ({ ...p, capabilities: p.capabilities || { textToImage: true, inpaint: false } })) }); return true; }
  if (!jobId) {
    const body = await readJsonBody(req).catch(() => null);
    if (!body || typeof body !== 'object') { send(res, 400, { code: 'INVALID_REQUEST', message: 'JSON body is required.' }); return true; }
    try { send(res, 202, { ok: true, job: await generation.submitInpaint(body) }); }
    catch (error) {
      const code = error?.code || 'INPAINT_FAILED';
      const status = code === 'PROVIDER_UNAVAILABLE' || code === 'INPAINT_UNSUPPORTED' ? 501 : code === 'ASSET_NOT_FOUND' ? 404 : code === 'GENERATION_BUSY' ? 429 : 400;
      send(res, status, { code, message: error.message, hint: code === 'INPAINT_UNSUPPORTED' ? '配置支持 load_image、mask 输入和局部采样的 ComfyUI API workflow，并为该 provider 声明 editImageNode/editMaskNode。' : undefined });
    }
    return true;
  }
  try { send(res, 200, { ok: true, job: await generation.status(jobId) }); }
  catch (error) { send(res, generationStatus(error), { code: error.code || 'INPAINT_FAILED', message: error.message }); }
  return true;
}

async function handleBackgroundRemoval(req, res, { backgroundRemoval, token, prefix, pathname }) {
  const assetId = pathname.startsWith(`${prefix}/background-removal/`)
    ? pathname.slice(`${prefix}/background-removal/`.length)
    : '';
  const rejection = authorizeSameOrigin(req, token, assetId ? ['POST'] : ['GET']);
  if (rejection) { send(res, 403, { code: 'INVALID_REQUEST', message: rejection.message, reason: rejection.reason, observed: rejection.observed }); return true; }
  if (!assetId && req.method === 'GET') {
    send(res, 200, { ok: true, available: !!backgroundRemoval, ...(backgroundRemoval ? backgroundRemoval.describe() : { code: 'BACKGROUND_REMOVAL_UNAVAILABLE', hint: 'Configure backgroundRemoval.endpoint to a trusted rembg-compatible service.' }) });
    return true;
  }
  if (!backgroundRemoval) {
    send(res, 501, { code: 'BACKGROUND_REMOVAL_UNAVAILABLE', message: 'No background-removal service is configured.', hint: 'Configure backgroundRemoval.endpoint to a trusted rembg-compatible service.' });
    return true;
  }
  try {
    const result = await backgroundRemoval.remove({ assetRef: `asset:${assetId}` });
    send(res, 200, { ok: true, ...result });
  } catch (error) {
    const code = error?.code || 'BACKGROUND_REMOVAL_FAILED';
    const status = code === 'ASSET_NOT_FOUND' ? 404 : code === 'INVALID_ASSET_REF' ? 400 : code === 'BACKGROUND_REMOVAL_CONFIG' ? 503 : 502;
    send(res, status, { code, message: error.message, hint: '确认源图仍在临时素材库中，并检查配置的背景移除服务。' });
  }
  return true;
}

async function handleTemplatePlan(req, res, { token }) {
  const rejection = authorizeSameOrigin(req, token, ['POST']);
  if (rejection) { send(res, 403, { code: 'INVALID_REQUEST', message: rejection.message, reason: rejection.reason, observed: rejection.observed }); return true; }
  try {
    const body = await readJsonBody(req, 4 * 1024 * 1024);
    if (!body || typeof body !== 'object' || Array.isArray(body)) { send(res, 400, { code: 'TEMPLATE_INVALID', message: '请求体必须是 JSON 对象' }); return true; }
    const plan = planTemplateApply(body.template, {
      background: body.background,
      product: body.product,
      texts: body.texts || {},
      textStyle: body.textStyle || {},
    });
    send(res, 200, { ok: true, plan });
  } catch (error) {
    const code = error?.code || 'TEMPLATE_FAILED';
    const status = code === 'PAYLOAD_TOO_LARGE' || code === 'REQUEST_TOO_LARGE' ? 413 : String(code).startsWith('TEMPLATE_') ? 400 : 500;
    send(res, status, { code, message: error.message });
  }
  return true;
}

/**
 * PSD 直套：一次上传完成「解析 → 逐层合成底图 → 规划」。
 * 先用不含底图的方式规划一次，拿到真正选中的商品槽，再把它和文字层从底图里挖掉，
 * 这样底图保留装饰、商品槽留空给商品图、文字留空给 layer.add_text。
 */
/** 合成模板底图：排除文字层与选定商品槽。失败时返回 baseError，调用方可用纯色背景降级。 */
function buildTemplateBase(bytes, template, slotId, assets) {
  const probe = planTemplateApply(template, { product: { assetRef: `asset:${'0'.repeat(48)}`, ...(slotId ? { slotId } : {}) } });
  const textLayerIndices = template.slots.filter(slot => slot.type === 'text').map(slot => Number(String(slot.id).replace('slot-', '')) - 1);
  const productLayerIndex = probe.summary.productSlot ? Number(String(probe.summary.productSlot).replace('slot-', '')) - 1 : null;
  const exclude = textLayerIndices.concat(productLayerIndex === null ? [] : [productLayerIndex]);
  try {
    const composite = compositePsdLayers(bytes, { excludeLayerIndices: exclude });
    const stored = assets.add({ bytes: composite.png, name: `psd-base-${template.name}.png` });
    return {
      base: { assetRef: `asset:${stored.id}`, width: composite.width, height: composite.height, composited: composite.composited, skipped: composite.skipped.length, approximated: composite.approximated },
      baseError: null,
      probe,
    };
  } catch (error) {
    return { base: null, baseError: { code: error?.code || 'PSD_COMPOSITE_FAILED', message: error.message }, probe };
  }
}

/**
 * 批量套版：一次上传 PSD，合成一次底图，为多个商品各出一份规划。
 * 只返回规划，不写画布；页面逐份执行并导出，保证可回退。
 */
async function handleTemplateBatch(req, res, { token, assets }) {
  const rejection = authorizeSameOrigin(req, token, ['POST'], { requireJson: false });
  if (rejection) { send(res, 403, { code: 'INVALID_REQUEST', message: rejection.message, reason: rejection.reason, observed: rejection.observed }); return true; }
  if (!assets) { send(res, 501, { code: 'ASSET_UNAVAILABLE', message: 'This deployment has no asset store.' }); return true; }
  try {
    const body = await readBinaryBody(req, MAX_ASSET_BYTES);
    if (!body.length) { send(res, 400, { code: 'PSD_EMPTY', message: '请求体是空的，请直接上传 .psd 文件字节。' }); return true; }
    const header = key => { const value = req.headers?.[key]; return typeof value === 'string' && value ? decodeURIComponent(value) : undefined; };
    const template = psdToTemplate(body, { name: String(header('x-psd-name') || 'uploaded.psd').slice(0, 120) });
    const slotId = header('x-psd-slot');
    const background = header('x-psd-background');
    let products = [];
    try { products = JSON.parse(header('x-psd-products') || '[]'); } catch { send(res, 400, { code: 'TEMPLATE_BAD_PRODUCTS', message: 'x-psd-products 必须是 JSON 数组' }); return true; }
    let texts = {};
    const textsRaw = header('x-psd-texts');
    if (textsRaw) { try { texts = JSON.parse(textsRaw); } catch { send(res, 400, { code: 'TEMPLATE_BAD_TEXTS', message: 'x-psd-texts 必须是 JSON 对象' }); return true; } }

    const built = buildTemplateBase(body, template, slotId, assets);
    const batch = planTemplateBatch(template, { baseAssetRef: built.base?.assetRef, background, products, texts, textStyle: { fill_color: '#15181f' } });
    send(res, 200, { ok: true, base: built.base, baseError: built.baseError, variants: batch.variants, summary: batch.summary,
      template: { name: template.name, canvas: template.canvas, summary: template.summary } });
  } catch (error) {
    const code = error?.code || 'TEMPLATE_FAILED';
    const status = code === 'PAYLOAD_TOO_LARGE' ? 413 : String(code).startsWith('PSD_') || String(code).startsWith('TEMPLATE_') ? 400 : 500;
    send(res, status, { code, message: error.message });
  }
  return true;
}

async function handleTemplateApply(req, res, { token, assets }) {
  const rejection = authorizeSameOrigin(req, token, ['POST'], { requireJson: false });
  if (rejection) { send(res, 403, { code: 'INVALID_REQUEST', message: rejection.message, reason: rejection.reason, observed: rejection.observed }); return true; }
  if (!assets) { send(res, 501, { code: 'ASSET_UNAVAILABLE', message: 'This deployment has no asset store.' }); return true; }
  try {
    const body = await readBinaryBody(req, MAX_ASSET_BYTES);
    if (!body.length) { send(res, 400, { code: 'PSD_EMPTY', message: '请求体是空的，请直接上传 .psd 文件字节。' }); return true; }
    const header = key => { const value = req.headers?.[key]; return typeof value === 'string' && value ? decodeURIComponent(value) : undefined; };
    const template = psdToTemplate(body, { name: String(header('x-psd-name') || 'uploaded.psd').slice(0, 120) });
    const productAsset = header('x-psd-product-asset');
    const slotId = header('x-psd-slot');
    const background = header('x-psd-background');
    let texts = {};
    const textsRaw = header('x-psd-texts');
    if (textsRaw) {
      try { texts = JSON.parse(textsRaw); } catch { send(res, 400, { code: 'TEMPLATE_BAD_TEXTS', message: 'x-psd-texts 必须是 JSON 对象' }); return true; }
    }

    const probe = planTemplateApply(template, { product: productAsset ? { assetRef: productAsset, ...(slotId ? { slotId } : {}) } : undefined, texts, background });
    const textLayerIndices = template.slots.filter(slot => slot.type === 'text').map(slot => Number(String(slot.id).replace('slot-', '')) - 1);
    const productLayerIndex = probe.summary.productSlot ? Number(String(probe.summary.productSlot).replace('slot-', '')) - 1 : null;
    const exclude = textLayerIndices.concat(productLayerIndex === null ? [] : [productLayerIndex]);

    let base = null;
    let baseError = null;
    try {
      const composite = compositePsdLayers(body, { excludeLayerIndices: exclude });
      const stored = assets.add({ bytes: composite.png, name: `psd-base-${template.name}.png` });
      base = { assetRef: `asset:${stored.id}`, width: composite.width, height: composite.height, composited: composite.composited, skipped: composite.skipped.length, approximated: composite.approximated };
    } catch (error) {
      // 合成失败不该毁掉套版：退回纯色背景，并如实说明为什么没有底图。
      baseError = { code: error?.code || 'PSD_COMPOSITE_FAILED', message: error.message };
    }

    const plan = planTemplateApply(template, {
      baseAssetRef: base?.assetRef,
      background,
      product: productAsset ? { assetRef: productAsset, ...(slotId ? { slotId } : {}) } : undefined,
      texts,
      textStyle: { fill_color: '#15181f' },
    });
    send(res, 200, { ok: true, plan, base, baseError, template: { name: template.name, canvas: template.canvas, summary: template.summary } });
  } catch (error) {
    const code = error?.code || 'TEMPLATE_FAILED';
    const status = code === 'PAYLOAD_TOO_LARGE' ? 413 : String(code).startsWith('PSD_') || String(code).startsWith('TEMPLATE_') ? 400 : 500;
    send(res, status, { code, message: error.message });
  }
  return true;
}

async function handlePsdSlots(req, res, { token, assets }) {
  const rejection = authorizeSameOrigin(req, token, ['POST'], { requireJson: false });
  if (rejection) { send(res, 403, { code: 'INVALID_REQUEST', message: rejection.message, reason: rejection.reason, observed: rejection.observed }); return true; }
  try {
    // 只解析结构、不落盘：PSD 不进素材库（素材库只收 PNG/JPEG/WebP）。
    const body = await readBinaryBody(req, MAX_ASSET_BYTES);
    if (!body.length) { send(res, 400, { code: 'PSD_EMPTY', message: '请求体是空的，请直接上传 .psd 文件字节。' }); return true; }
    const template = psdToTemplate(body, { name: String(req.headers['x-psd-name'] || 'uploaded.psd').slice(0, 120) });
    send(res, 200, { ok: true, template, assetCount: assets ? assets.list().length : 0 });
  } catch (error) {
    const code = error?.code || 'PSD_FAILED';
    const status = code === 'PAYLOAD_TOO_LARGE' ? 413 : String(code).startsWith('PSD_') ? 400 : 500;
    send(res, status, {
      code,
      message: error.message,
      ...(code === 'PSD_BAD_SIGNATURE' ? { hint: '请上传 .psd（Photoshop）文件；PNG/JPG 请走素材上传。' } : {}),
    });
  }
  return true;
}

async function handleAssist(req, res, { assist, ctx, token, prefix }) {
  const rejection = authorizeSameOrigin(req, token, req.method === 'GET' ? ['GET'] : ['POST']);
  if (rejection) { send(res, 403, { code: 'INVALID_REQUEST', message: rejection.message, reason: rejection.reason, observed: rejection.observed }); return true; }
  if (!assist) {
    send(res, 501, { code: 'ASSIST_UNAVAILABLE', message: 'This deployment has no assistant wired to the host model service.' });
    return true;
  }
  if (req.method === 'GET') {
    // UI 用它决定标题显示模型名还是"本地指令"
    send(res, 200, { ok: true, ...assist.status() });
    return true;
  }
  const body = await readJsonBody(req).catch(() => null);
  if (!body || typeof body !== 'object') { send(res, 400, { code: 'ASSIST_INVALID', message: 'JSON body is required.' }); return true; }
  try {
    const result = await assist.chat({ message: body.message, history: body.history, context: body.context });
    send(res, 200, { ok: true, ...result });
  } catch (error) {
    const code = error?.code || 'ASSIST_FAILED';
    const status = code === 'ASSIST_INVALID' ? 400 : code === 'ASSIST_UNAVAILABLE' ? 503 : 502;
    send(res, status, { code, message: error.message });
  }
  return true;
}

const generationStatus = error => error?.code === 'JOB_NOT_FOUND' ? 404
  : error?.code === 'INVALID_REQUEST' || error?.code === 'PROVIDER_UNKNOWN' ? 400
    : error?.code === 'PROVIDER_UNAVAILABLE' ? 501
      : error?.code === 'GENERATION_BUSY' ? 429 : 502;

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

export function createMediaRouter({ relay, editorKind, prefix, token, publicDir, editorRoot = null, tickets = null, bindings = null, assets = null, generation = null, fonts = null, batchQueue = null, assist = null, backgroundRemoval = null, ctx = null, remoteFetch = undefined }) {
  const hostRoot = resolve(publicDir, 'host');
  const relayPrefix = `${prefix}/relay/`;
  const assetsPrefix = `${prefix}/assets/`;
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

    if (pathname.startsWith(assetsPrefix)) {
      if (pathname === `${assetsPrefix}import` && req.method === 'POST') {
        const rejection = authorizeSameOrigin(req, token, ['POST']);
        if (rejection) { send(res, 403, { code: 'INVALID_REQUEST', message: rejection.message, reason: rejection.reason, observed: rejection.observed }); return true; }
        return handleAssetImport(req, res, { assets, token, prefix, remoteFetch });
      }
      return handleAssets(req, res, { assets, token, prefix, pathname });
    }
    if (pathname === `${prefix}/fonts` || pathname.startsWith(`${prefix}/fonts/`)) {
      return handleFonts(req, res, { fonts, token, prefix, pathname, remoteFetch });
    }
    if (pathname === `${prefix}/template/plan`) {
      return handleTemplatePlan(req, res, { token });
    }
    if (pathname === `${prefix}/template/apply`) {
      return handleTemplateApply(req, res, { token, assets });
    }
    if (pathname === `${prefix}/template/batch`) {
      return handleTemplateBatch(req, res, { token, assets });
    }
    if (pathname === `${prefix}/psd/slots`) {
      return handlePsdSlots(req, res, { token, assets });
    }
    if (pathname === `${prefix}/assist`) {
      return handleAssist(req, res, { assist, ctx, token, prefix });
    }
    if (pathname === `${prefix}/background-removal` || pathname.startsWith(`${prefix}/background-removal/`)) {
      return handleBackgroundRemoval(req, res, { backgroundRemoval, token, prefix, pathname });
    }
    if (pathname === `${prefix}/inpaint` || pathname.startsWith(`${prefix}/inpaint/`)) {
      return handleInpaint(req, res, { generation, token, prefix, pathname });
    }
    if (pathname === `${prefix}/generate` || pathname.startsWith(`${prefix}/generate/`)) {
      // 批量路由必须在单作业路由之前匹配，否则 /generate/batch 会被当成 jobId。
      if (pathname === `${prefix}/generate/batch` || pathname.startsWith(`${prefix}/generate/batch/`)) {
        return handleBatch(req, res, { batchQueue, token, prefix, pathname });
      }
      return handleGenerate(req, res, { generation, token, prefix, pathname });
    }
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
