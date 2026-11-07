// 套版规划器测试：纯函数，不碰画布。用真实 PSD 模板（存在时）做端到端断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { psdToTemplate } from '../lib/psd.js';
import { createMediaRouter } from '../lib/http.js';
import { planTemplateApply, solidColorDataUrl } from '../lib/template.js';

const APLUS = 'C:/Users/UEFR/.dsh/tools/kwiki-cli/samples/aplus01.psd';
const ASSET = `asset:${'a'.repeat(48)}`;

function realTemplate() {
  if (!existsSync(APLUS)) return null;
  return psdToTemplate(readFileSync(APLUS), { name: 'aplus01.psd' });
}

test('HTTP /template/plan：鉴权 + 返回可执行命令 + 非法模板 400', async () => {
  const token = 'plan-token';
  const router = createMediaRouter({ relay: { request: async () => ({}) }, editorKind: 'image', prefix: '/media-image', token, publicDir: '.', assets: null });
  const call = async (body, auth = token) => {
    const payload = Buffer.from(JSON.stringify(body));
    const out = { status: 0, body: '' };
    const res = { writeHead(status) { out.status = status; return res; }, end(chunk) { out.body = String(chunk ?? ''); } };
    const req = { method: 'POST', url: '/media-image/template/plan', headers: { host: 'localhost', origin: 'http://localhost', authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield payload; } };
    await router(req, res);
    return { status: out.status, value: JSON.parse(out.body) };
  };
  const template = { canvas: { width: 100, height: 100 }, slots: [{ id: 'slot-1', name: '标题', type: 'text', rect: { x: 10, y: 10, width: 60, height: 24 }, visible: true, text: 'hi' }] };
  const ok = await call({ template, background: '#ffffff', textStyle: { fill_color: '#000000' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.value.ok, true);
  assert.equal(ok.value.plan.commands[0].type, 'canvas.resize');
  assert.ok(ok.value.plan.commands.some(command => command.type === 'layer.add_text'));
  const denied = await call({ template }, 'bad');
  assert.equal(denied.status, 403);
  const bad = await call({ template: { canvas: { width: 0, height: 0 }, slots: [] } });
  assert.equal(bad.status, 400);
  assert.equal(bad.value.code, 'TEMPLATE_INVALID');
});

test('纯色 data URL 是合法 1×1 PNG（背景层靠它实现）', () => {
  const url = solidColorDataUrl('#4d6bfe');
  assert.match(url, /^data:image\/png;base64,/);
  const png = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64');
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 1, '宽 1');
  assert.equal(png.readUInt32BE(20), 1, '高 1');
  // IDAT 解压后应为 filter(0) + RGBA 共 5 字节
  const idatStart = png.indexOf(Buffer.from('IDAT', 'ascii'));
  const length = png.readUInt32BE(idatStart - 4);
  const raw = inflateSync(png.subarray(idatStart + 4, idatStart + 4 + length));
  assert.equal(raw.length, 5);
  assert.deepEqual([...raw.subarray(1)], [0x4d, 0x6b, 0xfe, 255], '颜色必须是 #4d6bfe');
});

test('非法颜色/非法资产引用都被拒绝', () => {
  assert.throws(() => solidColorDataUrl('blue'), (error) => error.code === 'TEMPLATE_BAD_COLOR');
  const template = { canvas: { width: 10, height: 10 }, slots: [] };
  assert.throws(() => planTemplateApply(template, { product: { assetRef: 'asset:bad' } }), (error) => error.code === 'TEMPLATE_BAD_ASSET');
  assert.throws(() => planTemplateApply(null), (error) => error.code === 'TEMPLATE_INVALID');
});

test('真实 A+ 模板：先对齐画布，商品图进最大图槽，文字沿用 PSD 原文', async t => {
  const template = realTemplate();
  if (!template) return t.skip('缺少样例 aplus01.psd');
  const plan = planTemplateApply(template, { background: '#f4f5f7', product: { assetRef: ASSET, name: '主图商品' }, textStyle: { fill_color: '#15181f' } });
  assert.equal(plan.commands[0].type, 'canvas.resize');
  assert.deepEqual(plan.commands[0].payload, { width: 970, height: 600 });
  assert.equal(plan.commands[1].payload.name, '背景');
  assert.equal(plan.summary.images, 2, '背景 + 商品图');
  assert.ok(plan.summary.texts >= 2, `文字命令应不少于 2，实际 ${plan.summary.texts}`);
  const product = plan.commands.find(command => command.type === 'layer.add_image' && command.payload.sourceRef === ASSET);
  assert.ok(product, '必须放置商品图');
  const biggest = template.slots.filter(slot => slot.type === 'image' && slot.rect.width * slot.rect.height < 970 * 600 * 0.98)
    .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height)[0];
  assert.equal(plan.summary.productSlot, biggest.id, '默认应挑面积最大的非整幅图槽');
  const texts = plan.commands.filter(command => command.type === 'layer.add_text').map(command => command.payload.text);
  assert.ok(texts.some(text => text.includes('HAND WEAVING')), `文字命令应带上 PSD 原文，实际 ${JSON.stringify(texts)}`);
  // 装饰图层必须如实登记为丢失，而不是静默跳过
  assert.ok(plan.skipped.some(item => item.kind === 'image'), '装饰图层丢失要登记');
});

test('可显式指定槽位与替换文案；越界矩形被夹紧在画布内', async t => {
  const template = realTemplate();
  if (!template) return t.skip('缺少样例 aplus01.psd');
  const textSlot = template.slots.find(slot => slot.type === 'text');
  const imageSlot = template.slots.filter(slot => slot.type === 'image' && slot.rect.width * slot.rect.height < 970 * 600 * 0.9)[0];
  const plan = planTemplateApply(template, {
    product: { assetRef: ASSET, slotId: imageSlot.id },
    texts: { [textSlot.id]: '自定义标题' },
  });
  assert.equal(plan.summary.productSlot, imageSlot.id);
  const replaced = plan.commands.find(command => command.type === 'layer.add_text' && command.payload.text === '自定义标题');
  assert.ok(replaced, '替换文案必须生效');
  for (const command of plan.commands) {
    const payload = command.payload;
    if (command.type === 'layer.add_text' || (command.type === 'layer.add_image' && payload.name !== '背景')) {
      assert.ok(payload.x >= 0 && payload.y >= 0, `坐标不得为负：${JSON.stringify(payload)}`);
      assert.ok(payload.x + (payload.width || 0) <= 970 + 1);
    }
  }
});

test('模板没有图片槽时，商品图不放置且明确登记', () => {
  const template = { canvas: { width: 100, height: 100 }, slots: [{ id: 'slot-1', name: '标题', type: 'text', rect: { x: 0, y: 0, width: 50, height: 20 }, visible: true, text: 'hi' }] };
  const plan = planTemplateApply(template, { product: { assetRef: ASSET } });
  assert.equal(plan.summary.productSlot, null);
  assert.ok(plan.skipped.some(item => item.kind === 'product'));
  assert.equal(plan.summary.texts, 1);
});

test('空文字槽不生成命令，而是登记为缺少文案', () => {
  const template = { canvas: { width: 100, height: 100 }, slots: [{ id: 'slot-1', name: '空标题', type: 'text', rect: { x: 0, y: 0, width: 50, height: 20 }, visible: true, text: '' }] };
  const plan = planTemplateApply(template, {});
  assert.equal(plan.summary.texts, 0);
  assert.ok(plan.skipped.some(item => item.kind === 'text' && /没有文案/.test(item.reason)));
});
