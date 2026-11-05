// 接力请求（relay）同源判据：桌面端不带 Origin，改用自定义头 x-dsh-media-relay。
// 与 boot 同一思路——不依赖 Electron 不发的 Origin / Sec-Fetch-*。
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

function makeContext() {
  const routes = [];
  const ctx = {
    tools: { register: () => () => {}, guard: () => () => {} },
    webServer: { register: route => { routes.push(route); return () => {}; } },
    approval: { request: async () => 'allowed-once' },
    effect: factory => { const dispose = factory(); return () => { if (typeof dispose === 'function') dispose(); }; },
  };
  return { ctx, routes };
}

// The router generates a random per-process token; read it back through the boot route
// (which is the only place it is handed out) instead of reaching into the plugin.
async function harness() {
  const { ctx, routes } = makeContext();
  apply(ctx, { dataDir: 'C:/tmp/image-studio' });
  const router = routes[0].handler;
  const respond = () => {
    const out = { status: 0, body: '' };
    const res = {
      writeHead(status) { out.status = status; return res; },
      end(chunk) { out.body = chunk === undefined ? '' : String(chunk); },
    };
    return { res, out };
  };
  const call = async ({ method = 'POST', url, headers = {}, body }) => {
    const { res, out } = respond();
    const req = {
      method, url, headers,
      async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); },
    };
    await router(req, res);
    try { out.value = JSON.parse(out.body); } catch { out.value = null; }
    return out;
  };
  const boot = await call({ method: 'GET', url: '/media-image/boot', headers: { 'x-dsh-media-boot': '1' } });
  assert.equal(boot.status, 200);
  const token = boot.value.accessToken;
  assert.equal(typeof token, 'string');
  return { call, token };
}

test('缺 Origin 但带自定义头 → 放行（桌面端真实形状）', async () => {
  const { call, token } = await harness();
  const res = await call({
    url: '/media-image/relay/register',
    headers: {
      host: '127.0.0.1:1',
      'x-dsh-media-relay': '1',
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: { editorInstanceId: 'desktop-like' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.value.editorInstanceId, 'desktop-like');
  assert.equal(typeof res.value.pageId, 'string');
});

test('缺 Origin 且缺自定义头 → 403', async () => {
  const { call, token } = await harness();
  const res = await call({
    url: '/media-image/relay/register',
    headers: { host: '127.0.0.1:1', 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: { editorInstanceId: 'no-header' },
  });
  assert.equal(res.status, 403);
  assert.equal(res.value.reason, 'missing-relay-header');
  assert.equal(res.value.observed.hasRelayHeader, false);
});

test('Origin 与 Host 不一致 → 403（跨源仍然挡）', async () => {
  const { call, token } = await harness();
  const res = await call({
    url: '/media-image/relay/register',
    headers: {
      host: '127.0.0.1:1',
      origin: 'http://evil.invalid',
      'x-dsh-media-relay': '1',
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: { editorInstanceId: 'cross-origin' },
  });
  assert.equal(res.status, 403);
  assert.equal(res.value.reason, 'origin-mismatch');
  assert.equal(res.value.observed.origin, 'http://evil.invalid');
});

test('Sec-Fetch-Site 为 cross-site / same-site → 403', async () => {
  const { call, token } = await harness();
  for (const site of ['cross-site', 'same-site']) {
    const res = await call({
      url: '/media-image/relay/register',
      headers: {
        host: '127.0.0.1:1',
        'sec-fetch-site': site,
        'x-dsh-media-relay': '1',
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: { editorInstanceId: `site-${site}` },
    });
    assert.equal(res.status, 403, site);
    assert.equal(res.value.reason, 'sec-fetch-site', site);
    assert.equal(res.value.observed.site, site);
  }
});

test('普通浏览器路径（Origin 与 Host 一致、不带自定义头）仍放行', async () => {
  const { call, token } = await harness();
  const res = await call({
    url: '/media-image/relay/register',
    headers: {
      host: '127.0.0.1:1',
      origin: 'http://127.0.0.1:1',
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: { editorInstanceId: 'browser-like' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.value.editorInstanceId, 'browser-like');
});
