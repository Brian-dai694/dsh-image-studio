// 随包附带的 ComfyUI 局部重绘预设：它会被**原样**当成 /prompt 的 prompt 送出去，
// 所以这里既检查"工作流本身合法"，也检查"我们的 provider 真的能驱动它"。
// 没有这一层，预设里混进一个注释键（例如 "_comment"）就会变成一个假节点，
// 直到用户接上真实 ComfyUI 才炸 —— 那是最难查的一类问题。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProvider, createGenerationService } from '../lib/generation.js';
import { createAssetStore } from '../lib/assets.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = dirname(fileURLToPath(import.meta.url));
const PRESET = join(root, '..', 'presets', 'comfyui-inpaint-sd15.json');
const workflow = JSON.parse(readFileSync(PRESET, 'utf8'));

// 与 docs/comfyui-inpaint.md 里给出的配置逐字一致；改一处就要同步改另一处（本测试会盯住）。
const CONFIG = {
  id: 'comfy-preset',
  kind: 'comfyui',
  baseUrl: 'http://127.0.0.1:8188',
  workflow,
  promptNode: { nodeId: '6', field: 'text' },
  editImageNode: { nodeId: '10', field: 'image' },
  editMaskNode: { nodeId: '11', field: 'image' },
};

function rgbaPng() {
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
  bytes.writeUInt32BE(16, 16); bytes.writeUInt32BE(16, 20);
  return bytes;
}

test('预设里每个顶层键都是真实节点：不会把注释/元数据当成假节点送进 ComfyUI', () => {
  for (const [key, node] of Object.entries(workflow)) {
    assert.match(key, /^\d+$/, `顶层键必须是数字节点 id，实际是 "${key}"`);
    assert.equal(typeof node.class_type, 'string', `节点 ${key} 缺少 class_type`);
    assert.equal(typeof node.inputs, 'object', `节点 ${key} 缺少 inputs`);
  }
});

test('预设里所有连线都指向存在的节点，且输出槽位是非负整数', () => {
  const isLink = value => Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && Number.isInteger(value[1]);
  const links = [];
  for (const [id, node] of Object.entries(workflow)) {
    for (const [field, value] of Object.entries(node.inputs)) {
      if (isLink(value)) links.push({ from: id, field, target: value[0], slot: value[1] });
      else if (Array.isArray(value)) assert.fail(`节点 ${id}.${field} 看起来像连线但不是 [id, slot]：${JSON.stringify(value)}`);
    }
  }
  assert.ok(links.length >= 6, `预设应该有足够多的连线，实际 ${links.length}`);
  for (const link of links) {
    assert.ok(workflow[link.target], `节点 ${link.from}.${link.field} 指向不存在的节点 ${link.target}`);
    assert.ok(link.slot >= 0, `节点 ${link.from}.${link.field} 的槽位必须是非负整数`);
  }
});

test('预设声明的注入点都能被 provider 找到', () => {
  for (const [label, spec] of [['promptNode', CONFIG.promptNode], ['editImageNode', CONFIG.editImageNode], ['editMaskNode', CONFIG.editMaskNode]]) {
    const node = workflow[spec.nodeId];
    assert.ok(node, `${label} 指向不存在的节点 ${spec.nodeId}`);
    assert.ok(spec.field in node.inputs, `${label} 指向的节点 ${spec.nodeId} 没有输入字段 ${spec.field}`);
  }
  // SaveImage 必须在图里：provider 的 poll 只从 outputs 里找 images[0].filename。
  assert.ok(Object.values(workflow).some(node => node.class_type === 'SaveImage'), '预设必须包含 SaveImage，否则轮询拿不到结果');
});

test('用这份预设构造的 provider 声明支持 inpaint，并能把原图/蒙版注入到正确节点', async () => {
  const provider = buildProvider(CONFIG, { fetchImpl: async () => { throw new Error('不应发起请求'); } });
  assert.equal(provider.supportsInpaint(), true);
  assert.equal(provider.describe().capabilities.inpaint, true);

  const uploaded = [];
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target.endsWith('/upload/image')) {
      uploaded.push(init.body);
      return { ok: true, status: 200, json: async () => ({ name: `up-${uploaded.length}.png` }) };
    }
    if (target.endsWith('/prompt')) {
      const body = JSON.parse(init.body);
      assert.equal(body.prompt['10'].inputs.image, 'up-1.png', '源图必须注入 editImageNode');
      assert.equal(body.prompt['11'].inputs.image, 'up-2.png', '蒙版必须注入 editMaskNode');
      assert.equal(body.prompt['6'].inputs.text, 'a red door', '提示词必须注入 promptNode');
      return { ok: true, status: 200, json: async () => ({ prompt_id: 'p-1' }) };
    }
    if (target.includes('/history/')) return { ok: true, status: 200, json: async () => ({ 'p-1': { outputs: { '9': { images: [{ filename: 'r.png', type: 'output' }] } } } }) };
    if (target.includes('/view?')) return { ok: true, status: 200, arrayBuffer: async () => rgbaPng() };
    throw new Error(`unexpected fetch ${target}`);
  };
  const live = buildProvider(CONFIG, { fetchImpl });
  const started = await live.startInpaint({
    prompt: 'a red door',
    imageName: { bytes: rgbaPng(), mime: 'image/png', filename: 's.png' },
    maskName: { bytes: rgbaPng(), mime: 'image/png', filename: 'm.png' },
  });
  assert.equal(started.remoteId, 'p-1');
  const polled = await live.poll({ remoteId: 'p-1' });
  assert.equal(polled.status, 'succeeded');
  assert.ok(polled.bytes.length > 0);
});

test('预设目录必须随包发布：否则文档让用户"复制这份预设"，装了却找不到文件', () => {
  const manifest = JSON.parse(readFileSync(join(root, '..', 'package.json'), 'utf8'));
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  assert.ok(files.includes('presets/'), `package.json 的 files 必须包含 presets/，实际 ${JSON.stringify(files)}`);
});

test('预设可以经 generation service 落成真实素材（结果进临时素材库）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-comfy-preset-'));
  try {
    const assets = createAssetStore({ dataDir: dir });
    const fetchImpl = async (url) => {
      const target = String(url);
      if (target.endsWith('/upload/image')) return { ok: true, status: 200, json: async () => ({ name: 'up.png' }) };
      if (target.endsWith('/prompt')) return { ok: true, status: 200, json: async () => ({ prompt_id: 'p-2' }) };
      if (target.includes('/history/')) return { ok: true, status: 200, json: async () => ({ 'p-2': { outputs: { '9': { images: [{ filename: 'r.png', type: 'output' }] } } } }) };
      if (target.includes('/view?')) return { ok: true, status: 200, arrayBuffer: async () => rgbaPng() };
      throw new Error(`unexpected fetch ${target}`);
    };
    const service = createGenerationService({ providers: [CONFIG], assets, fetchImpl, timeoutMs: 5000 });
    const described = service.list().find(item => item.id === 'comfy-preset');
    assert.equal(described.capabilities.inpaint, true, '预设构造出来的 provider 必须声明可局部重绘');
    assert.equal(service.supportsInpaint('comfy-preset'), true);

    const source = assets.add({ bytes: rgbaPng(), name: 'source' });
    const mask = assets.add({ bytes: rgbaPng(), name: 'mask' });
    const job = await service.submitInpaint({
      provider: 'comfy-preset', prompt: 'a red door', width: 16, height: 16,
      imageRef: `asset:${source.id}`, maskRef: `asset:${mask.id}`,
    });
    const done = await service.status(job.jobId);
    assert.equal(done.status, 'succeeded', JSON.stringify(done));
    assert.match(done.assetRef, /^asset:[a-f0-9]{48}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
