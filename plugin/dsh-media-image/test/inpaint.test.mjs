import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssetStore } from '../lib/assets.js';
import { createGenerationService } from '../lib/generation.js';
import { createMediaRouter } from '../lib/http.js';

function rgbaPng() {
// PNG fixture 尺寸写成 16×16，以符合生成服务最小尺寸限制；assets.add 校验签名。
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
  bytes.writeUInt32BE(16, 16); bytes.writeUInt32BE(16, 20);
  return bytes;
}
const PNG = rgbaPng();
const WORKFLOW = {
  '1': { class_type: 'LoadImage', inputs: { image: 'placeholder.png' } },
  '2': { class_type: 'LoadImage', inputs: { image: 'placeholder-mask.png' } },
  '3': { class_type: 'CLIPTextEncode', inputs: { text: '' } },
};

function makeFetch({ history = [], capture } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    capture?.(String(url), init);
    if (String(url).endsWith('/upload/image')) return { ok: true, status: 200, json: async () => ({ name: calls.length === 1 ? 'source-upload.png' : 'mask-upload.png' }) };
    if (String(url).endsWith('/prompt')) {
      const body = JSON.parse(init.body);
      assert.equal(body.prompt['1'].inputs.image, 'source-upload.png');
      assert.equal(body.prompt['2'].inputs.image, 'mask-upload.png');
      assert.equal(body.prompt['3'].inputs.text, 'replace selected object');
      return { ok: true, status: 200, json: async () => ({ prompt_id: 'inpaint-1' }) };
    }
    if (String(url).includes('/history/')) return { ok: true, status: 200, json: async () => ({ 'inpaint-1': { outputs: { '9': { images: [{ filename: 'result.png' }] } } } }) };
    if (String(url).includes('/view?')) return { ok: true, status: 200, arrayBuffer: async () => PNG };
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetchImpl, calls };
}

test('普通 text-to-image ComfyUI workflow 的 capability 明确为 inpaint=false', () => {
  const assets = createAssetStore();
  const plain = createGenerationService({ providers: [{ id: 'mock-comfy', kind: 'comfyui', baseUrl: 'http://127.0.0.1:8199', workflow: WORKFLOW, promptNode: { nodeId: '3' } }], assets, fetchImpl: async()=>{} });
  assert.deepEqual(plain.list()[0].capabilities, { textToImage: true, inpaint: false });
});

test('局部重绘只对显式支持 image/mask 节点的 ComfyUI workflow 开放', () => {
  const assets = createAssetStore();
  const plain = createGenerationService({ providers: [{ id: 'txt', kind: 'comfyui', baseUrl: 'http://x', workflow: WORKFLOW }], assets, fetchImpl: async()=>{} });
  const edit = createGenerationService({ providers: [{ id: 'edit', kind: 'comfyui', baseUrl: 'http://x', workflow: WORKFLOW, editImageNode: { nodeId: '1' }, editMaskNode: { nodeId: '2' }, promptNode: { nodeId: '3' } }], assets, fetchImpl: async()=>{} });
  assert.equal(plain.list()[0].capabilities.inpaint, false);
  assert.equal(plain.supportsInpaint('txt'), false);
  assert.equal(edit.list()[0].capabilities.inpaint, true);
  assert.equal(edit.supportsInpaint('edit'), true);
});

test('局部重绘上传原图/蒙版，显式绑定 workflow 节点，结果进入临时素材库', async () => {
  const assets = createAssetStore();
  const image = assets.add({ bytes: PNG, name: 'source.png' });
  const mask = assets.add({ bytes: PNG, name: 'mask.png' });
  const { fetchImpl, calls } = makeFetch();
  const service = createGenerationService({ providers: [{ id: 'edit', kind: 'comfyui', baseUrl: 'http://comfy', workflow: WORKFLOW, editImageNode: { nodeId: '1' }, editMaskNode: { nodeId: '2' }, promptNode: { nodeId: '3' } }], assets, fetchImpl });
  const job = await service.submitInpaint({ provider: 'edit', prompt: 'replace selected object', width: 16, height: 16, imageRef: `asset:${image.id}`, maskRef: `asset:${mask.id}`, idempotencyKey: 'idem-1' });
  assert.equal(job.status, 'running');
  assert.equal(calls.filter(c => c.url.endsWith('/upload/image')).length, 2);
  const done = await service.status(job.jobId);
  assert.equal(done.status, 'succeeded');
  assert.match(done.assetRef, /^asset:[a-f0-9]{48}$/);
  assert.equal(assets.list().length, 3);
});

test('不支持的 provider、丢失 asset 或尺寸不匹配明确拒绝，不提交工作流', async () => {
  const assets = createAssetStore();
  const image = assets.add({ bytes: PNG, name: 'source.png' });
  const mask = assets.add({ bytes: PNG, name: 'mask.png' });
  let prompts = 0;
  const fetchImpl = async url => { if (String(url).endsWith('/prompt')) prompts++; throw new Error('unexpected'); };
  const plain = createGenerationService({ providers: [{ id: 'txt', kind: 'comfyui', baseUrl: 'http://x', workflow: WORKFLOW }], assets, fetchImpl });
  await assert.rejects(() => plain.submitInpaint({ provider: 'txt', prompt: 'x', width: 16, height: 16, imageRef: `asset:${image.id}`, maskRef: `asset:${mask.id}` }), { code: 'INPAINT_UNSUPPORTED' });
  await assert.rejects(() => plain.submitInpaint({ provider: 'txt', prompt: 'x', width: 1, height: 1, imageRef: 'asset:missing', maskRef: `asset:${mask.id}` }), { code: 'INPAINT_UNSUPPORTED' });
  assert.equal(prompts, 0);
});

test('HTTP 局部重绘 capability 与未配置后端返回清楚状态并强制鉴权', async () => {
  const token = 'inpaint-token';
  const assets = createAssetStore();
  const router = createMediaRouter({ relay: { request: async () => ({}) }, editorKind: 'image', prefix: '/media-image', token, publicDir: '.', assets, generation: null });
  const call = async ({ method = 'GET', url, headers = {}, body }) => {
    const out = { status: 0, body: '' };
    const res = { writeHead(status) { out.status = status; return res; }, end(chunk) { out.body = String(chunk ?? ''); } };
    const req = { method, url, headers, async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); } };
    await router(req, res);
    return { status: out.status, value: JSON.parse(out.body) };
  };
  const headers = { host: 'localhost', origin: 'http://localhost', authorization: `Bearer ${token}`, 'x-dsh-media-relay': '1' };
  const status = await call({ url: '/media-image/inpaint', headers });
  assert.equal(status.status, 501);
  assert.equal(status.value.code, 'PROVIDER_UNAVAILABLE');
  const denied = await call({ url: '/media-image/inpaint', headers: { ...headers, authorization: 'Bearer bad' } });
  assert.equal(denied.status, 403);
});
