// Local smoke test: mounts the plugin with a fake ctx and exercises the real defineTool,
// guard, relay and routes. No DSH profile is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, name, inject } from '../lib/index.js';

function makeContext() {
  const tools = new Map();
  const guards = [];
  const routes = [];
  const effects = [];
  const approvals = [];
  const ctx = {
    tools: {
      register: definition => { tools.set(definition.name, definition); return () => {}; },
      guard: guard => { guards.push(guard); return () => {}; },
    },
    webServer: {
      register: route => { routes.push(route); return () => {}; },
    },
    approval: {
      request: async request => { approvals.push(request); return 'allowed-once'; },
    },
    effect: (factory, label) => { effects.push(label); const dispose = factory(); return () => { if (typeof dispose === 'function') dispose(); }; },
  };
  return { ctx, tools, guards, routes, effects, approvals };
}

test('plugin exports the Host contract', () => {
  assert.equal(name, 'dsh-media-image');
  assert.deepEqual(inject, ['tools', 'webServer', 'approval']);
  assert.equal(typeof apply, 'function');
});

test('apply registers exactly the five image tools and one /media-image route', () => {
  const { ctx, tools, guards, routes } = makeContext();
  apply(ctx, { dataDir: 'C:/tmp/image-studio' });
  assert.equal(tools.size, 5);
  assert.deepEqual([...tools.keys()].sort(), [
    'media_image_apply_command',
    'media_image_export_start',
    'media_image_export_status',
    'media_image_get_command_result',
    'media_image_read_state',
  ]);
  assert.equal(guards.length, 1);
  assert.deepEqual(routes.map(route => [route.kind, route.path]), [['prefix', '/media-image']]);
  assert.equal(typeof routes[0].handler, 'function');
});

test('every tool declares a four-state output schema and a parameter table', () => {
  const { ctx, tools } = makeContext();
  apply(ctx, { dataDir: 'C:/tmp/media-studio' });
  for (const [toolName, definition] of tools) {
    assert.equal(typeof definition.output.render, 'function', toolName);
    assert.equal(definition.output.schema.type, 'object', toolName);
    assert.ok(definition.output.schema.properties.status, toolName);
    assert.deepEqual(definition.output.schema.properties.status.enum, ['applied', 'rejected', 'pending', 'unknown'], toolName);
    const wire = definition.parameters ?? {};
    assert.equal(wire.type, 'object', toolName);
    assert.ok(wire.properties && Object.keys(wire.properties).length > 0, toolName);
  }
});

test('guard denies cross-kind operations and unauthorized autonomous writes, allows low risk', () => {
  const { ctx, guards } = makeContext();
  apply(ctx, { dataDir: 'C:/tmp/media-image' });
  const guard = guards[0];
  assert.equal(guard({ name: 'unrelated_tool', arguments: {} }), undefined);
  assert.match(guard({ name: 'media_image_apply_command', arguments: { editorKind: 'video' } }), /targets the image editor/);
  assert.match(guard({ name: 'media_image_apply_command', arguments: { editorKind: 'image', operation: 'media.video.clip.move' } }), /layer\.\* operations/);
  assert.match(guard({ name: 'media_image_apply_command', arguments: { editorKind: 'image', operation: 'canvas.crop', mode: 'autonomous' } }), /not authorized/);
  assert.equal(guard({ name: 'media_image_apply_command', arguments: { editorKind: 'image', operation: 'layer.update_text', mode: 'autonomous' } }), undefined);
  assert.equal(guard({ name: 'media_image_apply_command', arguments: { editorKind: 'image', operation: 'layer.remove', mode: 'assist' } }), undefined);
});

test('router serves boot only to same-origin fetch and never exposes a tool HTTP surface', async () => {
  const { ctx, routes } = makeContext();
  apply(ctx, { dataDir: 'C:/tmp/media-studio' });
  const router = routes[0].handler;
  const respond = () => {
    const out = { status: 0, headers: {}, body: '' };
    const res = {
      writeHead(status, headers) { out.status = status; out.headers = headers ?? {}; return res; },
      end(chunk) { out.body = chunk === undefined ? '' : String(chunk); },
    };
    return { res, out };
  };
  const call = async ({ method = 'GET', url, headers = {} }) => {
    const { res, out } = respond();
    const handled = await router({ method, url, headers }, res);
    return { handled, ...out };
  };

  assert.equal((await call({ url: '/elsewhere' })).handled, false);
  // 缺自定义头一律拒绝；带自定义头且非跨站放行（桌面端不带 Sec-Fetch-* 也放行）。
  const noHeader = await call({ url: '/media-image/boot' });
  assert.equal(noHeader.status, 403);
  assert.match(noHeader.body, /Same-origin fetch required/);
  const desktopLike = await call({ url: '/media-image/boot', headers: { 'x-dsh-media-boot': '1' } });
  assert.equal(desktopLike.status, 200);
  const ok = await call({ url: '/media-image/boot', headers: { 'x-dsh-media-boot': '1', 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty' } });
  assert.equal(ok.status, 200);
  assert.match(ok.body, /accessToken/);

  const toolLike = await call({ method: 'POST', url: '/media-image/video-tools', headers: { 'content-type': 'application/json' } });
  assert.equal(toolLike.status, 405);
  assert.match(toolLike.body, /GET required/);

  // WHATWG URL normalization collapses encoded traversal before our handler; the request
  // must never reach a packaged file outside the video subtree.
  const traversal = await call({ url: '/media-image/video/%2e%2e/%2e%2e/host/relay.js' });
  assert.notEqual(traversal.status, 200);
  assert.ok(traversal.handled === false || traversal.status === 404);
});

test('relay route requires token and same-origin, and rejects unknown actions', async () => {
  const { ctx, routes } = makeContext();
  apply(ctx, { dataDir: 'C:/tmp/media-studio' });
  const router = routes[0].handler;
  const respond = () => {
    const out = { status: 0, body: '' };
    const res = { writeHead(status) { out.status = status; return res; }, end(chunk) { out.body = chunk === undefined ? '' : String(chunk); } };
    return { res, out };
  };
  const call = async ({ method = 'POST', url, headers = {} }) => {
    const { res, out } = respond();
    await router({ method, url, headers }, res);
    return out;
  };

  const noOrigin = await call({ url: '/media-image/relay/register', headers: { host: '127.0.0.1:1', 'content-type': 'application/json', authorization: 'Bearer x' } });
  assert.equal(noOrigin.status, 403);
  const crossOrigin = await call({ url: '/media-image/relay/register', headers: { host: '127.0.0.1:1', origin: 'http://evil.invalid', 'content-type': 'application/json', authorization: 'Bearer x' } });
  assert.equal(crossOrigin.status, 403);
  assert.match(crossOrigin.body, /Cross-origin/);
  const unknownAction = await call({ url: '/media-image/relay/nope', headers: { host: '127.0.0.1:1', origin: 'http://127.0.0.1:1', 'content-type': 'application/json', authorization: 'Bearer x' } });
  assert.equal(unknownAction.status, 404);
  // getPage is a Host-only liveness read: it must not be reachable as a relay action and
  // must never leak page ids or tokens over HTTP.
  const getPage = await call({ url: '/media-image/relay/getPage', headers: { host: '127.0.0.1:1', origin: 'http://127.0.0.1:1', 'content-type': 'application/json', authorization: 'Bearer x' } });
  assert.equal(getPage.status, 404);
  assert.doesNotMatch(getPage.body, /pageId|pageToken/);
});
