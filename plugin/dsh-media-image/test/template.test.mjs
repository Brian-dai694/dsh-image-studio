// 套版规划器测试：纯函数，不碰画布。用真实 PSD 模板（存在时）做端到端断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { psdToTemplate } from '../lib/psd.js';
import { createMediaRouter } from '../lib/http.js';
import { planTemplateApply, planTemplateBatch, solidColorDataUrl } from '../lib/template.js';

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

test('候选槽排除整幅背景、按面积排序，映射逐槽给出结论', async t => {
  const template = realTemplate();
  if (!template) return t.skip('缺少样例 aplus01.psd');
  const plan = planTemplateApply(template, { background: '#f4f5f7', product: { assetRef: ASSET } });
  const canvasArea = 970 * 600;
  assert.ok(plan.candidates.length >= 1, '应给出可选商品槽');
  assert.ok(plan.candidates.every(item => item.rect.width * item.rect.height < canvasArea * 0.98), '整幅背景槽不得进入候选');
  for (let i = 1; i < plan.candidates.length; i += 1) {
    const prev = plan.candidates[i - 1].rect, next = plan.candidates[i].rect;
    assert.ok(prev.width * prev.height >= next.width * next.height, '候选必须按面积从大到小');
  }
  assert.equal(plan.candidates[0].index, 1, '下标从 1 开始');
  assert.equal(plan.summary.productSlot, plan.candidates[0].id, '默认槽就是第一个候选');
  assert.equal(plan.summary.productSlotIndex, 1);
  const product = plan.mapping.find(item => item.kind === 'product');
  assert.equal(product.action, 'place-product');
  assert.ok(plan.mapping.some(item => item.kind === 'background' && item.action === 'replaced-by-solid-background'), '整幅背景槽要标明被纯色取代');
  assert.ok(plan.mapping.some(item => item.kind === 'decoration' && item.action === 'skip'), '装饰槽要标明跳过');
  assert.ok(plan.mapping.filter(item => item.kind === 'text').every(item => item.action === 'place-text' || item.action === 'skip'));
});

test('整幅背景槽不能被选作商品槽', async t => {
  const template = realTemplate();
  if (!template) return t.skip('缺少样例 aplus01.psd');
  const canvasArea = 970 * 600;
  const full = template.slots.find(slot => slot.type === 'image' && slot.visible !== false && slot.rect.width * slot.rect.height >= canvasArea * 0.98);
  if (!full) return t.skip('该样例没有整幅图片槽');
  assert.throws(() => planTemplateApply(template, { background: '#ffffff', product: { assetRef: ASSET, slotId: full.id } }), error => error.code === 'TEMPLATE_SLOT_NOT_FOUND');
});

test('用户选第 N 个候选槽时商品落进该槽', async t => {
  const template = realTemplate();
  if (!template) return t.skip('缺少样例 aplus01.psd');
  const probe = planTemplateApply(template, { product: { assetRef: ASSET } });
  if (probe.candidates.length < 2) return t.skip('该样例可选槽不足 2 个');
  const plan = planTemplateApply(template, { product: { assetRef: ASSET, slotId: planSlotId(template, 2) } });
  assert.equal(plan.summary.productSlotIndex, 2, '选第二个候选应回报下标 2');
  assert.equal(plan.summary.productSlot, plan.candidates[1].id);
});

function planSlotId(template, index) {
  const canvasArea = template.canvas.width * template.canvas.height;
  const ordered = template.slots
    .filter(slot => slot.type === 'image' && slot.visible !== false)
    .filter(slot => slot.rect.width * slot.rect.height < canvasArea * 0.98)
    .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height);
  return ordered[index - 1].id;
}


test('批量套版：每个商品各出一份规划，共用同一底图与商品槽', async t => {
  const template = realTemplate();
  if (!template) return t.skip('缺少样例 aplus01.psd');
  const base = `asset:${'b'.repeat(48)}`;
  const products = [{ assetRef: ASSET, name: 'A' }, { assetRef: `asset:${'c'.repeat(48)}`, name: 'B' }];
  const batch = planTemplateBatch(template, { baseAssetRef: base, products, textStyle: { fill_color: '#15181f' } });
  assert.equal(batch.summary.variants, 2);
  assert.equal(batch.summary.base, true);
  assert.equal(batch.variants[1].index, 2);
  assert.equal(batch.variants[1].name, 'B');
  for (const variant of batch.variants) {
    const images = variant.plan.commands.filter(command => command.type === 'layer.add_image');
    assert.equal(images[0].payload.sourceRef, base, '每份都先用同一张底图');
    assert.equal(images[1].payload.sourceRef, variant.productAssetRef, '商品图各用各的');
    assert.equal(variant.plan.summary.productSlot, batch.summary.productSlot, '批量必须固定同一个商品槽');
  }
});

test('批量套版的边界：空列表、非法引用、超过 20 个都拒绝', async t => {
  const template = realTemplate();
  if (!template) return t.skip('缺少样例 aplus01.psd');
  assert.throws(() => planTemplateBatch(template, { products: [] }), error => error.code === 'TEMPLATE_NO_PRODUCTS');
  assert.throws(() => planTemplateBatch(template, { products: [{ assetRef: 'asset:bad' }] }), error => error.code === 'TEMPLATE_BAD_ASSET');
  const many = Array.from({ length: 21 }, () => ({ assetRef: ASSET }));
  assert.throws(() => planTemplateBatch(template, { products: many }), error => error.code === 'TEMPLATE_TOO_MANY_VARIANTS');
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
