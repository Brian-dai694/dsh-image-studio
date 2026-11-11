// 产物路由契约：鉴权、类型、上限、取回、未配置时诚实 501。
// 用直接的 req/res 替身走同一个 router，不启真实端口——与其余路由测试保持一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMediaRouter } from '../lib/http.js';
import { createArtifactStore } from '../lib/artifacts.js';

const TOKEN = 'secret-token';
const BASE_HEADERS = {
  host: 'localhost',
  origin: 'http://localhost',
  authorization: `Bearer ${TOKEN}`,
  'x-dsh-media-artifact': '1',
  'x-dsh-media-relay': '1',
  'x-dsh-media-name': encodeURIComponent('product.psd'),
  'content-type': 'image/vnd.adobe.photoshop',
};

function caller(router) {
  const respond = () => {
    const out = { status: 0, headers: {}, body: '' };
    const res = {
      writeHead(status, headers) { out.status = status; out.headers = headers ?? {}; return res; },
      end(chunk) {
        if (chunk === undefined) { out.body = ''; return; }
        out.body = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : String(chunk);
      },
    };
    return { res, out };
  };
  return async ({ method = 'GET', url, headers = {}, body, rawBody }) => {
    const { res, out } = respond();
    const req = {
      method, url, headers,
      async *[Symbol.asyncIterator]() {
        if (rawBody !== undefined) yield rawBody;
        else if (body !== undefined) yield Buffer.from(JSON.stringify(body));
      },
    };
    const handled = await router(req, res);
    return { handled, ...out };
  };
}

function harness({ withStore = true, storeOptions = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-art-route-'));
  const artifacts = withStore
    ? createArtifactStore({ dir, ...storeOptions })
    : createArtifactStore({ dir: null });
  const router = createMediaRouter({
    relay: { request: async () => ({}) }, editorKind: 'image', prefix: '/media-image',
    token: TOKEN, publicDir: '.', artifacts,
  });
  return { call: caller(router), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('缺令牌或缺产物头：403', async () => {
  const { call, cleanup } = harness();
  try {
    const noToken = await call({ method: 'POST', url: '/media-image/artifacts', headers: { ...BASE_HEADERS, authorization: undefined }, rawBody: Buffer.from('x') });
    assert.equal(noToken.status, 403, noToken.body);
    const noHeader = await call({ method: 'POST', url: '/media-image/artifacts', headers: { ...BASE_HEADERS, 'x-dsh-media-artifact': undefined }, rawBody: Buffer.from('x') });
    assert.equal(noHeader.status, 403, noHeader.body);
  } finally { cleanup(); }
});

test('正常落盘：回 artifactId/path/sha256，GET 取回同样字节', async () => {
  const { call, cleanup } = harness();
  try {
    const payload = Buffer.from('8BPS-route-test');
    const created = await call({ method: 'POST', url: '/media-image/artifacts', headers: BASE_HEADERS, rawBody: payload });
    assert.equal(created.status, 201, created.body);
    const body = JSON.parse(created.body);
    assert.match(body.artifact.artifactId, /^[a-f0-9]{32}$/);
    assert.equal(body.artifact.bytes, payload.length);
    assert.ok(body.artifact.path.endsWith('.psd'));

    const fetched = await call({
      method: 'GET', url: `/media-image/artifacts/${body.artifact.artifactId}`,
      headers: { ...BASE_HEADERS, 'content-type': undefined },
    });
    assert.equal(fetched.status, 200);
    assert.equal(fetched.headers['x-dsh-media-sha256'], body.artifact.sha256);
    assert.deepEqual(Buffer.from(fetched.body), payload);
  } finally { cleanup(); }
});

test('错类型 415；超过单文件上限 413', async () => {
  const bad = harness();
  try {
    const response = await bad.call({ method: 'POST', url: '/media-image/artifacts', headers: { ...BASE_HEADERS, 'content-type': 'application/pdf' }, rawBody: Buffer.from('x') });
    assert.equal(response.status, 415);
  } finally { bad.cleanup(); }

  const capped = harness({ storeOptions: { maxArtifactBytes: 8 } });
  try {
    const response = await capped.call({ method: 'POST', url: '/media-image/artifacts', headers: BASE_HEADERS, rawBody: Buffer.alloc(32, 1) });
    assert.equal(response.status, 413);
  } finally { capped.cleanup(); }
});

test('未配置 dataDir：501 ARTIFACTS_UNAVAILABLE', async () => {
  const { call, cleanup } = harness({ withStore: false });
  try {
    const response = await call({ method: 'POST', url: '/media-image/artifacts', headers: BASE_HEADERS, rawBody: Buffer.from('x') });
    assert.equal(response.status, 501);
    assert.equal(JSON.parse(response.body).code, 'ARTIFACTS_UNAVAILABLE');
  } finally { cleanup(); }
});

test('GET 未知 id / 坏 id 都是 404', async () => {
  const { call, cleanup } = harness();
  try {
    const headers = { ...BASE_HEADERS, 'content-type': undefined };
    assert.equal((await call({ method: 'GET', url: `/media-image/artifacts/${'a'.repeat(32)}`, headers })).status, 404);
    assert.equal((await call({ method: 'GET', url: '/media-image/artifacts/not-an-id', headers })).status, 404);
  } finally { cleanup(); }
});

