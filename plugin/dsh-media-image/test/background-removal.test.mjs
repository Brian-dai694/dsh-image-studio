import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssetStore } from '../lib/assets.js';
import { createBackgroundRemovalService, BackgroundRemovalError } from '../lib/background-removal.js';
import { createMediaRouter } from '../lib/http.js';

// 1x1 RGBA PNG (color type 6), with valid chunk CRCs, generated inline for a tiny fixture.
const TRANSPARENT_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
const RGB_PNG = Buffer.from(TRANSPARENT_PNG);
RGB_PNG[25] = 2; // IHDR color type truecolor, no alpha; signature is enough for source fixture.

test('service uploads source bytes, requires alpha PNG, and stores output as a new asset', async () => {
  const assets = createAssetStore();
  const source = assets.add({ bytes: RGB_PNG, name: '0A9A7668.JPG' });
  let seen;
  const service = createBackgroundRemovalService({
    endpoint: 'http://127.0.0.1:5000/api/remove',
    apiKey: 'secret',
    assets,
    fetchImpl: async (url, init) => {
      seen = { url: String(url), init };
      const file = init.body.get('image_file');
      assert.equal(file.name, '0A9A7668.JPG');
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), RGB_PNG);
      assert.equal(init.headers['x-api-key'], 'secret');
      return new Response(TRANSPARENT_PNG, { status: 200, headers: { 'content-type': 'image/png' } });
    },
  });
  const result = await service.remove({ assetRef: `asset:${source.id}` });
  assert.equal(seen.url, 'http://127.0.0.1:5000/api/remove');
  assert.match(result.sourceRef, /^asset:[a-f0-9]{48}$/);
  assert.notEqual(result.asset.id, source.id);
  assert.match(result.asset.name, /background-removed\.png$/);
  assert.equal(assets.get(result.asset.id).bytes.equals(TRANSPARENT_PNG), true);
});

test('service rejects RGB PNG, JPEG, and non-image output rather than claiming transparent cutout', async () => {
  for (const bytes of [RGB_PNG, Buffer.from('not png')]) {
    const assets = createAssetStore();
    const source = assets.add({ bytes: RGB_PNG, name: 'source.png' });
    const service = createBackgroundRemovalService({ endpoint: 'https://remove.example/api', assets, fetchImpl: async () => new Response(bytes, { status: 200 }) });
    await assert.rejects(() => service.remove({ assetRef: `asset:${source.id}` }), { code: 'BACKGROUND_REMOVAL_INVALID_OUTPUT' });
    assert.equal(assets.list().length, 1, 'invalid output must not enter the asset store');
  }
});

test('service fails with stable codes for missing source, invalid ref, bad endpoint, and unreachable backend', async () => {
  const assets = createAssetStore();
  const service = createBackgroundRemovalService({ endpoint: 'https://remove.example/api', assets, fetchImpl: async () => { throw new Error('socket hang up'); } });
  await assert.rejects(() => service.remove({ assetRef: 'asset:short' }), { code: 'INVALID_ASSET_REF' });
  await assert.rejects(() => service.remove({ assetRef: `asset:${'a'.repeat(48)}` }), { code: 'ASSET_NOT_FOUND' });
  assert.throws(() => createBackgroundRemovalService({ endpoint: 'file:///etc/passwd', assets }), { code: 'BACKGROUND_REMOVAL_CONFIG' });
  const source = assets.add({ bytes: RGB_PNG, name: 'source.png' });
  await assert.rejects(() => service.remove({ assetRef: `asset:${source.id}` }), { code: 'BACKGROUND_REMOVAL_UNREACHABLE' });
});

test('HTTP GET 状态返回抠图能力是否可用及配置提示', async () => {
  const token = 'remove-status-token';
  const caller = router => async ({ method = 'GET', url, headers = {} }) => {
    const out = { status: 0, body: '' };
    const res = { writeHead(status) { out.status = status; return res; }, end(chunk) { out.body = String(chunk ?? ''); } };
    const req = { method, url, headers };
    await router(req, res);
    return { status: out.status, value: JSON.parse(out.body) };
  };
  const router = createMediaRouter({ relay: { request: async () => ({}) }, editorKind: 'image', prefix: '/media-image', token, publicDir: '.' });
  const call = caller(router);
  const headers = { host: 'localhost', origin: 'http://localhost', authorization: `Bearer ${token}`, 'x-dsh-media-relay': '1' };
  const status = await call({ url: '/media-image/background-removal', headers });
  assert.equal(status.status, 200);
  assert.equal(status.value.available, false);
  assert.match(status.value.hint, /backgroundRemoval\.endpoint/);
});

test('HTTP background removal route enforces same-origin auth and reports unconfigured service', async () => {
  const token = 'remove-token';
  const caller = router => async ({ method = 'POST', url, headers = {} }) => {
    const out = { status: 0, body: '' };
    const res = { writeHead(status) { out.status = status; return res; }, end(chunk) { out.body = String(chunk ?? ''); } };
    const req = { method, url, headers, async *[Symbol.asyncIterator]() { yield Buffer.from('{}'); } };
    await router(req, res);
    let value = null; try { value = JSON.parse(out.body); } catch { /* noop */ }
    return { ...out, value };
  };
  const base = { relay: { request: async () => ({}) }, editorKind: 'image', prefix: '/media-image', token, publicDir: '.' };
  const call = caller(createMediaRouter(base));
  const headers = { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-dsh-media-relay': '1' };
  const unavailable = await call({ url: `/media-image/background-removal/${'a'.repeat(48)}`, headers });
  assert.equal(unavailable.status, 501);
  assert.equal(unavailable.value.code, 'BACKGROUND_REMOVAL_UNAVAILABLE');
  assert.match(unavailable.value.hint, /backgroundRemoval\.endpoint/);
  const denied = await call({ url: `/media-image/background-removal/${'a'.repeat(48)}`, headers: { ...headers, authorization: 'Bearer wrong' } });
  assert.equal(denied.status, 403);
});
