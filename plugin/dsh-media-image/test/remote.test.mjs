// 受控远程拉取 + 素材 URL 导入 + 字体登记：守卫必须真的挡住，而不是写在注释里。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchRemoteBytes } from '../lib/remote.js';
import { createAssetStore } from '../lib/assets.js';
import { createFontStore, normalizeFamily, sniffFont, splitFontName } from '../lib/fonts.js';
import { createMediaRouter } from '../lib/http.js';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const WOFF2 = Buffer.concat([Buffer.from('wOF2', 'ascii'), Buffer.alloc(28, 7)]);

const okResponse = (bytes, headers = {}) => ({
  ok: true, status: 200,
  headers: { get: name => headers[name.toLowerCase()] ?? null },
  body: { getReader: () => { let sent = false; return { read: async () => sent ? { done: true } : (sent = true, { done: false, value: new Uint8Array(bytes) }), cancel: async () => {} }; } },
  arrayBuffer: async () => bytes,
});

test('远程拉取守卫：拦内网/回环、拦非 http、遵守清单、跳转逐跳复核', async () => {
  const never = async () => { throw new Error('不应发起请求'); };
  await assert.rejects(() => fetchRemoteBytes('http://127.0.0.1/a.png', { fetchImpl: never }), { code: 'URL_FORBIDDEN' });
  await assert.rejects(() => fetchRemoteBytes('http://localhost:8080/a.png', { fetchImpl: never }), { code: 'URL_FORBIDDEN' });
  await assert.rejects(() => fetchRemoteBytes('http://192.168.1.9/a.png', { fetchImpl: never }), { code: 'URL_FORBIDDEN' });
  await assert.rejects(() => fetchRemoteBytes('http://169.254.169.254/latest/meta-data', { fetchImpl: never }), { code: 'URL_FORBIDDEN' });
  await assert.rejects(() => fetchRemoteBytes('file:///etc/passwd', { fetchImpl: never }), { code: 'URL_INVALID' });
  await assert.rejects(() => fetchRemoteBytes('https://cdn.example.com/a.png', { fetchImpl: never, allowHosts: ['other.example.com'] }), { code: 'URL_FORBIDDEN' });

  const bytes = await fetchRemoteBytes('https://cdn.example.com/a.png', { fetchImpl: async () => okResponse(PNG) });
  assert.deepEqual(bytes.bytes, PNG);

  // 跳转到内网：必须按跳转目标重新判定，不能因为首发是公网就放行。
  const redirectToPrivate = async () => ({
    ok: false, status: 302, headers: { get: name => name.toLowerCase() === 'location' ? 'http://169.254.169.254/secret' : null },
  });
  await assert.rejects(() => fetchRemoteBytes('https://cdn.example.com/a.png', { fetchImpl: redirectToPrivate }), { code: 'URL_FORBIDDEN' });
});

test('远程拉取守卫：声明长度与实际读取都卡上限', async () => {
  const declared = async () => okResponse(PNG, { 'content-length': String(1024 * 1024) });
  await assert.rejects(() => fetchRemoteBytes('https://cdn.example.com/a.png', { fetchImpl: declared, maxBytes: 1024 }), { code: 'PAYLOAD_TOO_LARGE' });
  const big = Buffer.alloc(2048, 1);
  await assert.rejects(() => fetchRemoteBytes('https://cdn.example.com/a.png', { fetchImpl: async () => okResponse(big), maxBytes: 1024 }), { code: 'PAYLOAD_TOO_LARGE' });
  // 没有 content-length 也要在流式读取时停下。
  await assert.rejects(() => fetchRemoteBytes('https://cdn.example.com/a.png', { fetchImpl: async () => okResponse(big), maxBytes: 100 }), { code: 'PAYLOAD_TOO_LARGE' });
});

test('字体名解析：PSD 的 Family-Style 能对上已登记字体，对不上就返回 null（不编造）', () => {
  const fonts = createFontStore();
  fonts.add({ bytes: WOFF2, family: 'Poppins' });
  const roboto = fonts.add({ bytes: WOFF2, family: 'Roboto Bold' });

  // 精确 / 拆家族 / 前缀三种命中
  assert.equal(fonts.matchFontName('Poppins').match, 'exact');
  assert.equal(fonts.matchFontName('Poppins-Medium').family, 'Poppins');
  assert.equal(fonts.matchFontName('poppins').family, 'Poppins');
  assert.equal(fonts.matchFontName('Roboto-Bold').id, roboto.id);
  // 登记族名更长时按前缀命中
  assert.equal(fonts.matchFontName('Roboto').family, 'Roboto Bold');
  // 没登记的一律 null —— 绝不返回一个假字体让编辑器静默回退
  assert.equal(fonts.matchFontName('Arial-Bold'), null);
  assert.equal(fonts.matchFontName(''), null);
  assert.equal(fonts.matchFontName(undefined), null);
  // 命中结果必须带可加载的 URL（编辑器只认 /media-image/fonts/<48 位 id>）
  assert.match(fonts.matchFontName('Poppins-Medium').url, /^\/media-image\/fonts\/[a-f0-9]{48}$/);

  // 家族/样式拆分：样式词才拆，普通双词族名不拆
  assert.deepEqual(splitFontName('Poppins-Medium'), { family: 'Poppins', style: 'Medium' });
  assert.deepEqual(splitFontName('Roboto-Bold'), { family: 'Roboto', style: 'Bold' });
  assert.deepEqual(splitFontName('Helvetica Neue'), { family: 'Helvetica Neue', style: null });
  assert.deepEqual(splitFontName(''), { family: null, style: null });
});

test('字体库：按签名认类型、家族名只收安全字符、按 id 取回', () => {
  assert.equal(sniffFont(WOFF2).mime, 'font/woff2');
  assert.equal(sniffFont(PNG), null);
  const fonts = createFontStore();
  const font = fonts.add({ bytes: WOFF2, family: 'Source Han Sans' });
  assert.match(font.id, /^[a-f0-9]{48}$/);
  assert.equal(font.url, `/media-image/fonts/${font.id}`);
  assert.equal(font.mime, 'font/woff2');
  assert.deepEqual(fonts.get(font.id).bytes, WOFF2);
  assert.equal(fonts.list().length, 1);
  assert.throws(() => fonts.add({ bytes: Buffer.from('not a font'), family: 'X' }), { code: 'UNSUPPORTED_FONT_TYPE' });
  assert.throws(() => normalizeFamily('bad;family: red'), { code: 'INVALID_REQUEST' });
  assert.throws(() => normalizeFamily('   '), { code: 'INVALID_REQUEST' });
  assert.throws(() => normalizeFamily('x'.repeat(65)), { code: 'INVALID_REQUEST' });
});

test('路由：素材 URL 导入入素材库；字体登记后可同源取回；内网 URL 被拒', async () => {
  const assets = createAssetStore();
  const fonts = createFontStore();
  const token = 'remote-token';
  const remoteFetch = async url => {
    if (String(url).includes('font.example.com')) return okResponse(WOFF2);
    return okResponse(PNG);
  };
  const router = createMediaRouter({
    relay: { request: async () => ({}) }, editorKind: 'image', prefix: '/media-image', token, publicDir: '.',
    assets, fonts, remoteFetch,
  });
  const call = async ({ method = 'GET', url, headers = {}, body }) => {
    const out = { status: 0, headers: {}, body: '' };
    const res = { writeHead(status, h) { out.status = status; out.headers = h ?? {}; return res; }, end(chunk) { out.body = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : String(chunk ?? ''); return res; } };
    const req = { method, url, headers, async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); } };
    await router(req, res);
    let value = null;
    try { value = JSON.parse(out.body.toString()); } catch { value = null; }
    return { ...out, value };
  };
  const auth = { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json', authorization: `Bearer ${token}` };

  const imported = await call({ method: 'POST', url: '/media-image/assets/import', headers: auth, body: { url: 'https://cdn.example.com/a.png' } });
  assert.equal(imported.status, 201);
  assert.match(imported.value.sourceRef, /^asset:[a-f0-9]{48}$/);
  assert.equal(assets.get(imported.value.asset.id).mime, 'image/png');

  const blocked = await call({ method: 'POST', url: '/media-image/assets/import', headers: auth, body: { url: 'http://127.0.0.1/secret.png' } });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.value.code, 'URL_FORBIDDEN');

  const font = await call({ method: 'POST', url: '/media-image/fonts', headers: auth, body: { url: 'https://font.example.com/x.woff2', family: 'Source Han Sans' } });
  assert.equal(font.status, 201);
  assert.equal(font.value.font.family, 'Source Han Sans');
  const served = await call({ url: `/media-image/fonts/${font.value.font.id}`, headers: { ...auth, 'x-dsh-media-asset': '1' } });
  assert.equal(served.status, 200);
  assert.equal(served.headers['content-type'], 'font/woff2');
  assert.deepEqual(served.body, WOFF2);

  const listed = await call({ url: '/media-image/fonts', headers: auth });
  assert.equal(listed.value.fonts.length, 1);
  const noAuth = await call({ method: 'POST', url: '/media-image/fonts', headers: { ...auth, authorization: 'Bearer nope' }, body: { url: 'https://font.example.com/x.woff2', family: 'A' } });
  assert.equal(noAuth.status, 403);
});
