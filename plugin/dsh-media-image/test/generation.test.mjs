// 生成后端接口层：用假 fetch 跑真实的提交→轮询→入库协议。
// 不打真实网络：ComfyUI 与云端 API 的实际行为未在本机验证，这里只验证本插件自己这一侧的契约。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssetStore } from '../lib/assets.js';
import { createGenerationService, GenerationError } from '../lib/generation.js';
import { createMediaRouter } from '../lib/http.js';
import { registerMediaTools } from '../lib/tools.js';
import { createApprovalStore } from '../lib/gate.js';

// 最小合法 PNG 签名 + 几个字节：assets.add 只看文件签名。
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
const WORKFLOW = { '6': { class_type: 'CLIPTextEncode', inputs: { text: 'placeholder' } } };

function comfyFetch({ history = [], capture } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (capture) capture(url, init);
    if (url.endsWith('/prompt')) {
      const body = JSON.parse(init.body);
      assert.ok(body.prompt && body.client_id, '提交体必须带 prompt 与 client_id');
      return { ok: true, status: 200, json: async () => ({ prompt_id: 'pid-1' }) };
    }
    if (url.includes('/history/')) {
      const next = history.shift();
      return { ok: true, status: 200, json: async () => next };
    }
    if (url.includes('/view?')) {
      return { ok: true, status: 200, arrayBuffer: async () => PNG };
    }
    throw new Error(`未预期的请求：${url}`);
  };
  return { fetchImpl, calls };
}

test('ComfyUI: 提交 → 轮询 running → 取图入素材库，给出 asset: 引用', async () => {
  const assets = createAssetStore();
  const { fetchImpl, calls } = comfyFetch({
    history: [null, { 'pid-1': { outputs: { '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } } } }],
  });
  const service = createGenerationService({
    providers: [{ id: 'local', kind: 'comfyui', baseUrl: 'http://127.0.0.1:8188/', workflow: WORKFLOW, promptNode: { nodeId: '6', field: 'text' } }],
    assets, fetchImpl,
  });
  const job = await service.submit({ provider: 'local', prompt: '极简办公室背景', width: 1024, height: 1024 });
  assert.equal(job.status, 'running');
  assert.equal(job.assetRef, undefined);

  const stillRunning = await service.status(job.jobId);
  assert.equal(stillRunning.status, 'running');

  const done = await service.status(job.jobId);
  assert.equal(done.status, 'succeeded');
  assert.match(done.assetRef, /^asset:[a-f0-9]{48}$/);
  const id = done.assetRef.slice('asset:'.length);
  assert.equal(assets.get(id).mime, 'image/png');
  assert.deepEqual(assets.get(id).bytes, PNG);
  // 基地址尾部斜杠被归一化，提示词被注入到配置指定的节点。
  assert.ok(calls[0].url.startsWith('http://127.0.0.1:8188/prompt'));
  assert.equal(JSON.parse(calls[0].init.body).prompt['6'].inputs.text, '极简办公室背景');
  // 终态不再重复轮询。
  const again = await service.status(job.jobId);
  assert.equal(again.status, 'succeeded');
  assert.equal(calls.filter(call => call.url.includes('/history/')).length, 2);
});

test('轮询遇到传输错误记为 unknown 而不是 failed，恢复后仍能成功', async () => {
  let failNext = true;
  const assets = createAssetStore();
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith('/prompt')) return { ok: true, status: 200, json: async () => ({ prompt_id: 'pid-2' }) };
    if (url.includes('/history/')) {
      if (failNext) { failNext = false; throw new Error('socket hang up'); }
      return { ok: true, status: 200, json: async () => ({ 'pid-2': { outputs: { '9': { images: [{ filename: 'b.png' }] } } } }) };
    }
    return { ok: true, status: 200, arrayBuffer: async () => PNG };
  };
  const service = createGenerationService({
    providers: [{ id: 'local', kind: 'comfyui', baseUrl: 'http://x', workflow: WORKFLOW }], assets, fetchImpl,
  });
  const job = await service.submit({ provider: 'local', prompt: 'p' });
  const ambiguous = await service.status(job.jobId);
  assert.equal(ambiguous.status, 'unknown');
  assert.match(ambiguous.error, /socket hang up/);
  const recovered = await service.status(job.jobId);
  assert.equal(recovered.status, 'succeeded');
  assert.match(recovered.assetRef, /^asset:/);
});

test('后端明确失败 → failed；提交阶段失败也是 failed，且不写素材库', async () => {
  const assets = createAssetStore();
  const failingWorkflow = async (url) => {
    if (url.endsWith('/prompt')) return { ok: true, status: 200, json: async () => ({ prompt_id: 'pid-3' }) };
    return { ok: true, status: 200, json: async () => ({ 'pid-3': { status: { status_str: 'error' } } }) };
  };
  const service = createGenerationService({
    providers: [{ id: 'local', kind: 'comfyui', baseUrl: 'http://x', workflow: WORKFLOW }], assets, fetchImpl: failingWorkflow,
  });
  const job = await service.submit({ provider: 'local', prompt: 'p' });
  const failed = await service.status(job.jobId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.assetRef, undefined);
  assert.equal(assets.list().length, 0);

  const rejectFetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const service2 = createGenerationService({
    providers: [{ id: 'local', kind: 'comfyui', baseUrl: 'http://x', workflow: WORKFLOW }], assets, fetchImpl: rejectFetch,
  });
  const rejected = await service2.submit({ provider: 'local', prompt: 'p' });
  assert.equal(rejected.status, 'failed');
  assert.match(rejected.error, /HTTP 500/);
});

test('云端 http-json：同步返回 base64 直接成功；异步 job_id 走轮询', async () => {
  const assets = createAssetStore();
  const inline = async url => {
    if (url.endsWith('/generate')) return { ok: true, status: 200, json: async () => ({ image_base64: PNG.toString('base64') }) };
    throw new Error('同步出图不应再轮询');
  };
  const sync = createGenerationService({
    providers: [{ id: 'cloud', kind: 'http-json', baseUrl: 'https://api.example.com' }], assets, fetchImpl: inline,
  });
  const done = await sync.submit({ provider: 'cloud', prompt: 'p' });
  assert.equal(done.status, 'succeeded');
  assert.match(done.assetRef, /^asset:/);

  const polled = async url => {
    if (url.endsWith('/generate')) return { ok: true, status: 200, json: async () => ({ job_id: 'j-9' }) };
    return { ok: true, status: 200, json: async () => ({ status: 'succeeded', image_base64: PNG.toString('base64') }) };
  };
  const async2 = createGenerationService({
    providers: [{ id: 'cloud', kind: 'http-json', baseUrl: 'https://api.example.com', pollPath: '/jobs/{jobId}' }], assets, fetchImpl: polled,
  });
  const started = await async2.submit({ provider: 'cloud', prompt: 'p' });
  assert.equal(started.status, 'running');
  const finished = await async2.status(started.jobId);
  assert.equal(finished.status, 'succeeded');
});

test('未配置 / 未知 provider / 参数越界都给出可操作的错误码', async () => {
  const assets = createAssetStore();
  const empty = createGenerationService({ providers: [], assets });
  assert.equal(empty.configured(), false);
  await assert.rejects(() => empty.submit({ provider: 'x', prompt: 'p' }), { code: 'PROVIDER_UNAVAILABLE' });

  const service = createGenerationService({
    providers: [{ id: 'local', kind: 'comfyui', baseUrl: 'http://x', workflow: WORKFLOW }], assets, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ prompt_id: 'p' }) }),
  });
  await assert.rejects(() => service.submit({ provider: 'nope', prompt: 'p' }), { code: 'PROVIDER_UNKNOWN' });
  await assert.rejects(() => service.submit({ provider: 'local', prompt: '   ' }), { code: 'INVALID_REQUEST' });
  await assert.rejects(() => service.submit({ provider: 'local', prompt: 'p', width: 8 }), { code: 'INVALID_REQUEST' });
  await assert.rejects(() => service.submit({ provider: 'local', prompt: 'p', width: 9000 }), { code: 'INVALID_REQUEST' });
  await assert.rejects(() => service.status('missing'), { code: 'JOB_NOT_FOUND' });
  assert.throws(() => createGenerationService({ providers: [{ id: 'x', kind: 'nope' }], assets }), GenerationError);
  assert.throws(() => createGenerationService({ providers: [{ id: 'x', kind: 'comfyui' }], assets }), /workflow/);
});

test('HTTP 路由：未配置 501、鉴权 403、提交 202、未知作业 404', async () => {
  const assets = createAssetStore();
  const token = 'gen-token';
  const caller = router => async ({ method = 'GET', url, headers = {}, body }) => {
    const out = { status: 0, headers: {}, body: '' };
    const res = { writeHead(status, h) { out.status = status; out.headers = h ?? {}; return res; }, end(chunk) { out.body = chunk === undefined ? '' : String(chunk); } };
    const req = { method, url, headers, async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); } };
    await router(req, res);
    let value = null;
    try { value = JSON.parse(out.body); } catch { value = null; }
    return { ...out, value };
  };
  const auth = { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json', authorization: `Bearer ${token}` };

  const withoutBackend = caller(createMediaRouter({ relay: { request: async () => ({}) }, editorKind: 'image', prefix: '/media-image', token, publicDir: '.', assets, generation: null }));
  const notConfigured = await withoutBackend({ url: '/media-image/generate', headers: auth });
  assert.equal(notConfigured.status, 501);
  assert.equal(notConfigured.value.code, 'PROVIDER_UNAVAILABLE');

  const service = createGenerationService({
    providers: [{ id: 'local', kind: 'comfyui', baseUrl: 'http://127.0.0.1:8188', workflow: WORKFLOW, apiKey: 'k' }],
    assets, fetchImpl: async url => url.endsWith('/prompt')
      ? { ok: true, status: 200, json: async () => ({ prompt_id: 'pid-http' }) }
      : { ok: true, status: 200, json: async () => null },
  });
  const router = createMediaRouter({ relay: { request: async () => ({}) }, editorKind: 'image', prefix: '/media-image', token, publicDir: '.', assets, generation: service });
  const call = caller(router);

  const noAuth = await call({ method: 'POST', url: '/media-image/generate', headers: { ...auth, authorization: 'Bearer wrong' }, body: { provider: 'local', prompt: 'p' } });
  assert.equal(noAuth.status, 403);

  const listed = await call({ url: '/media-image/generate', headers: auth });
  assert.equal(listed.status, 200);
  assert.equal(listed.value.providers[0].id, 'local');
  assert.equal(JSON.stringify(listed.value).includes('"k"'), false, '凭据不得出现在列表里');

  const submitted = await call({ method: 'POST', url: '/media-image/generate', headers: auth, body: { provider: 'local', prompt: '极简背景' } });
  assert.equal(submitted.status, 202);
  assert.equal(submitted.value.job.status, 'running');

  const missing = await call({ url: '/media-image/generate/does-not-exist', headers: auth });
  assert.equal(missing.status, 404);
  assert.equal(missing.value.code, 'JOB_NOT_FOUND');

  const unknownProvider = await call({ method: 'POST', url: '/media-image/generate', headers: auth, body: { provider: 'nope', prompt: 'p' } });
  assert.equal(unknownProvider.status, 400);
  assert.equal(unknownProvider.value.code, 'PROVIDER_UNKNOWN');
});

test('media_image_generate：未配置拒绝 → 发现列后端 → 提交 pending → 轮询 applied', async () => {
  const register = generation => {
    const tools = new Map();
    registerMediaTools({ tools: { register: d => tools.set(d.name, d), guard: () => {} } }, {
      bridge: {}, approvals: createApprovalStore(), generation,
    });
    return tools.get('media_image_generate');
  };
  const noBackend = register(null);
  const refused = await noBackend.execute({ editorKind: 'image', provider: 'x', prompt: 'p' }, {});
  assert.equal(refused.status, 'rejected');
  assert.equal(refused.error.code, 'PROVIDER_UNAVAILABLE');
  assert.match(refused.hint, /DSH_MEDIA_IMAGE_PROVIDERS/);

  const assets = createAssetStore();
  const service = createGenerationService({
    providers: [{ id: 'local', kind: 'comfyui', baseUrl: 'http://x', workflow: WORKFLOW }],
    assets,
    fetchImpl: async url => {
      if (url.endsWith('/prompt')) return { ok: true, status: 200, json: async () => ({ prompt_id: 'pid-tool' }) };
      if (url.includes('/history/')) return { ok: true, status: 200, json: async () => ({ 'pid-tool': { outputs: { '9': { images: [{ filename: 'c.png' }] } } } }) };
      return { ok: true, status: 200, arrayBuffer: async () => PNG };
    },
  });
  const tool = register(service);

  const discovered = await tool.execute({ editorKind: 'image' }, {});
  assert.equal(discovered.status, 'applied');
  assert.equal(discovered.providers[0].id, 'local');

  const missingProvider = await tool.execute({ editorKind: 'image', prompt: 'p' }, {});
  assert.equal(missingProvider.status, 'rejected');
  assert.equal(missingProvider.error.code, 'INVALID_REQUEST');

  const submitted = await tool.execute({ editorKind: 'image', provider: 'local', prompt: '极简背景' }, {});
  assert.equal(submitted.status, 'pending');
  assert.equal(submitted.jobStatus, 'running');
  assert.ok(submitted.jobId);

  const done = await tool.execute({ editorKind: 'image', provider: 'local', jobId: submitted.jobId }, {});
  assert.equal(done.status, 'applied');
  assert.equal(done.jobStatus, 'succeeded');
  assert.match(done.artifactRef, /^asset:[a-f0-9]{48}$/);
});

test('幂等键返回同一作业；凭据不出现在任何返回结构里', async () => {
  const assets = createAssetStore();
  let submits = 0;
  const fetchImpl = async url => {
    if (url.endsWith('/prompt')) { submits += 1; return { ok: true, status: 200, json: async () => ({ prompt_id: `pid-${submits}` }) }; }
    return { ok: true, status: 200, json: async () => null };
  };
  const service = createGenerationService({
    providers: [{ id: 'local', kind: 'comfyui', baseUrl: 'http://x', workflow: WORKFLOW, apiKey: 'secret-key-value' }],
    assets, fetchImpl,
  });
  const first = await service.submit({ provider: 'local', prompt: 'p', idempotencyKey: 'k1' });
  const second = await service.submit({ provider: 'local', prompt: 'p', idempotencyKey: 'k1' });
  assert.equal(second.jobId, first.jobId);
  assert.equal(submits, 1, '同一幂等键不得重复提交');
  const serialized = JSON.stringify({ job: first, providers: service.list() });
  assert.equal(serialized.includes('secret-key-value'), false, '凭据不得出现在任何返回结构里');
  assert.equal(service.list()[0].hasApiKey, true);
});
