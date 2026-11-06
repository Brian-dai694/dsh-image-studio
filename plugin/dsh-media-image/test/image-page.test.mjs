// Verifies the packaged image page is self-contained: the entry page and every runtime
// asset it references must be served from public/image/ without touching the miniPaint
// source checkout. Runs against the real artifact, not a mock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from '../lib/index.js';
import { createMediaRouter } from '../lib/http.js';
import { createAssetStore } from '../lib/assets.js';

const publicImage = resolve(dirname(fileURLToPath(import.meta.url)), '../public/image');

function makeContext() {
  const routes = [];
  const assets = createAssetStore();
  const ctx = {
    tools: { register: () => () => {}, guard: () => () => {} },
    webServer: { register: route => { routes.push(route); return () => {}; } },
    approval: { request: async () => 'allowed-once' },
    effect: factory => { const dispose = factory(); return () => { if (typeof dispose === 'function') dispose(); }; },
  };
  return { ctx, routes, assets };
}

function caller(router) {
  const respond = () => {
    const out = { status: 0, headers: {}, body: '' };
    const res = {
      writeHead(status, headers) { out.status = status; out.headers = headers ?? {}; return res; },
      end(chunk) { out.body = chunk === undefined ? '' : Buffer.isBuffer(chunk) && /^image\//.test(String(out.headers['content-type'] || '')) ? Buffer.from(chunk) : String(chunk); },
    };
    return { res, out };
  };
  return async ({ method = 'GET', url, headers = {}, body, rawBody }) => {
    const { res, out } = respond();
    const req = { method, url, headers, async *[Symbol.asyncIterator]() { if (rawBody !== undefined) yield rawBody; else if (body !== undefined) yield Buffer.from(JSON.stringify(body)); } };
    const handled = await router(req, res);
    return { handled, ...out };
  };
}

test('packaged image page ships an entry, a bundle and its favicon', async () => {
  for (const file of ['index.html', 'dist/bundle.js', 'images/favicon.png', 'BUILD.json']) {
    assert.ok((await stat(join(publicImage, file))).isFile(), `${file} 未打包`);
  }
  const build = JSON.parse(await readFile(join(publicImage, 'BUILD.json'), 'utf8'));
  assert.equal(build.format, 'dsh-media-studio-image-page');
  assert.equal(build.entry, 'index.html');
  assert.match(build.bundleSha256, /^[0-9a-f]{64}$/);
});

test('BUILD.json lists every packaged file so the artifact stays auditable', async () => {
  const build = JSON.parse(await readFile(join(publicImage, 'BUILD.json'), 'utf8'));
  const paths = new Set(build.files.map(item => item.path));
  for (const required of ['index.html', 'dist/bundle.js', 'images/favicon.png', 'images/logo.svg']) {
    assert.ok(paths.has(required), `${required} 不在 BUILD.json 清单里`);
  }
  assert.equal(build.fileCount, build.files.length);
  assert.ok(build.totalBytes > 0);
});

test('router serves /media/image/ from the packaged tree without config', async () => {
  const { ctx, routes, assets } = makeContext();
  apply(ctx, { assets });
  const call = caller(routes[0].handler);

  const page = await call({ url: '/media-image/image/' });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.body, /id="canvas_minipaint"/);
  assert.match(page.body, /dist\/bundle\.js/);

  const bundle = await call({ url: '/media-image/image/dist/bundle.js' });
  assert.equal(bundle.status, 200);
  assert.match(bundle.headers['content-type'], /javascript/);
  assert.match(bundle.body, /dsh\.editor\.connect/);
  // The Host validator requires editorKind, and a laid-out-less iframe must not publish a
  // negative canvas size. Both regressions shipped together once; pin them here.
  assert.match(bundle.body, /editorKind:"image"/);
  assert.match(bundle.body, />100\?/, 'canvas 尺寸需要正数兜底');
  assert.match(bundle.body, /Math\.max\(1,/, 'readState 需要钳制非正尺寸');
  // A write used to land in the canvas while the tool reported rejected, because the
  // mutation result lacked the fields the Host validates.
  assert.match(bundle.body, /layer.add_image/, '打包编辑器必须实现生成图回流为图层');
  assert.match(bundle.body, /ASSET_FETCH_FAILED|ASSET_NOT_FOUND/, '素材获取失败必须返回明确错误');
  assert.match(bundle.body, /changedObjectIds/, 'mutation 结果需要 changedObjectIds');
  assert.equal(/changedLayerIds/.test(bundle.body), false, '旧字段名不应再出现');
  assert.match(bundle.body, /redo_button/, '页面需要可点击的重做控件');
  // Apple theme layer: one accent, neutral canvas, SF-style stack.
  assert.match(bundle.body, /--apple-accent:\s*#0071e3/);
  assert.match(bundle.body, /--background:\s*#f5f5f7/);
  assert.match(bundle.body, /-apple-system/, '需要 SF 风格字体栈');

  const icon = await call({ url: '/media-image/image/images/favicon.png' });
  assert.equal(icon.status, 200);
  assert.match(icon.headers['content-type'], /image\/png/);
});

test('same-origin asset route uploads bounded real image bytes and serves them by random id', async () => {
  const assets = createAssetStore();
  const router = createMediaRouter({ relay: { request: async () => ({}) }, editorKind: 'image', prefix: '/media-image', token: 'secret-token', publicDir: '.', assets });
  const call = caller(router);
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
  const headers = { host: 'localhost', origin: 'http://localhost', 'x-dsh-media-asset': '1', authorization: 'Bearer secret-token', 'content-type': 'image/png', 'content-length': String(png.length) };
  const uploaded = await call({ method: 'POST', url: '/media-image/assets/upload', headers, rawBody: png });
  assert.equal(uploaded.status, 201, uploaded.body);
  const uploadValue = JSON.parse(uploaded.body);
  assert.match(uploadValue.sourceRef, /^asset:[a-f0-9]{48}$/);
  assert.equal(uploadValue.asset.mime, 'image/png');
  const id = uploadValue.asset.id;
  const fetched = await call({ method: 'GET', url: `/media-image/assets/${id}`, headers: { host: 'localhost', origin: 'http://localhost', authorization: 'Bearer secret-token', 'x-dsh-media-asset': '1' } });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.headers['content-type'], 'image/png');
  assert.deepEqual(Buffer.from(fetched.body, 'binary'), png);
  assert.equal(assets.get(id).bytes.length, png.length);

  const spoofed = await call({ method: 'POST', url: '/media-image/assets/upload', headers: { ...headers, 'content-type': 'image/png' }, rawBody: Buffer.from('not a png') });
  assert.equal(spoofed.status, 400);
  assert.equal(JSON.parse(spoofed.body).code, 'UNSUPPORTED_IMAGE_TYPE');
  const cross = await call({ method: 'POST', url: '/media-image/assets/upload', headers: { ...headers, origin: 'http://evil.example' }, rawBody: png });
  assert.equal(cross.status, 403);
  const invalid = await call({ method: 'GET', url: '/media-image/assets/%2e%2e%2fpackage.json', headers: { host: 'localhost', origin: 'http://localhost', authorization: 'Bearer secret-token' } });
  assert.equal(invalid.status, 404);
});

test('packaged wrapper binds the editor to the image relay only', async () => {
  const { ctx, routes } = makeContext();
  apply(ctx, {});
  const call = caller(routes[0].handler);

  const page = await call({ url: '/media-image/image/host.html' });
  assert.equal(page.status, 200);
  assert.match(page.body, /src="index.html"/);
  assert.match(page.body, /media\/boot/);

  const script = await call({ url: '/media-image/image/host.js' });
  assert.equal(script.status, 200);
  assert.match(script.body, /baseUrl: '\/media-image\/relay'/);
  assert.match(script.body, /editorKind: 'image'/);
  // 桌面端（Electron）不带 Sec-Fetch-*：取令牌必须自己带同源自定义头，
  // 并且 403 时把服务端观测字段显示出来，否则用户只能看到一个状态码。
  assert.match(script.body, /'x-dsh-media-boot': '1'/, '取令牌需要带同源自定义头');
  assert.match(script.body, /body\.reason/, '403 正文的 reason 要显示');
  assert.match(script.body, /body\.observed/, '403 正文的观测字段要显示');
  assert.match(script.body, /BOOT_FAILED/);
  // The page must not pretend it can call the model tool surface.
  assert.equal(/\/media\/(?:image-)?tools/.test(script.body), false);
});

test('packaged wrapper stays byte-identical to its source (no stale copy)', () => {
  // 这个坑真踩过：源码改了 highlight 转发，包内 public/image/host.js 还是旧副本，
  // 部署后页面行为与仓库对不上。两边必须逐字节相同。
  const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/image-page/host.js'));
  const packaged = readFileSync(join(publicImage, 'host.js'));
  assert.deepEqual(packaged, source, 'public/image/host.js 必须与 scripts/image-page/host.js 一致（跑 pack:image 或同步复制）');
});

test('packaged wrapper is valid ESM (node --check on .js would miss it)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'image-host-'));
  try {
    const target = join(dir, 'host.mjs');
    writeFileSync(target, readFileSync(join(publicImage, 'host.js')));
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('packaged image route keeps traversal and source files out', async () => {
  const { ctx, routes } = makeContext();
  apply(ctx, {});
  const call = caller(routes[0].handler);

  for (const url of ['/media-image/image/../lib/index.js', '/media-image/image/BUILD.json.map', '/media-image/image/%2e%2e/host/relay.js']) {
    const response = await call({ url });
    assert.notEqual(response.status, 200, `${url} 不应可读`);
  }
});
