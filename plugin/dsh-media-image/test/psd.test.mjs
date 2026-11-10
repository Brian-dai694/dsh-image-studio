// PSD 模板解析测试：优先用真实模板（WPS 知识库下载的 aplus01/detail01），缺失则跳过。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createMediaRouter } from '../lib/http.js';
import { parsePsdHeader, parsePsdLayers, psdToTemplate, buildGroups, PsdError } from '../lib/psd.js';

const SAMPLES = {
  aplus: 'C:/Users/UEFR/.dsh/tools/kwiki-cli/samples/aplus01.psd',
  detail: 'C:/Users/UEFR/.dsh/tools/kwiki-cli/samples/detail01.psd',
};
const read = key => (existsSync(SAMPLES[key]) ? readFileSync(SAMPLES[key]) : null);

test('真实 A+ 模板：970×600、9 图 + 2 文字槽，文字内容正确', async t => {
  const buffer = read('aplus');
  if (!buffer) return t.skip('缺少样例 aplus01.psd');
  const header = parsePsdHeader(buffer);
  assert.equal(header.width, 970);
  assert.equal(header.height, 600);
  assert.equal(header.colorModeName, 'rgb');
  const template = psdToTemplate(buffer, { name: 'aplus01.psd' });
  assert.deepEqual(template.canvas, { width: 970, height: 600 });
  assert.equal(template.summary.text, 2);
  assert.ok(template.summary.image >= 8, `图片槽应不少于 8，实际 ${template.summary.image}`);
  const texts = template.slots.filter(slot => slot.type === 'text').map(slot => slot.text);
  assert.ok(texts.some(text => text.includes('HAND WEAVING')), `应解析出主标题，实际：${JSON.stringify(texts)}`);
  assert.ok(texts.every(text => !text.includes('\u0000')), '文本不得残留 NUL');
  assert.ok(texts.every(text => !text.includes('\r')), '回车必须规范成换行');
});

test('真实细节图模板：1500×1500、含 3 段文字槽', async t => {
  const buffer = read('detail');
  if (!buffer) return t.skip('缺少样例 detail01.psd');
  const { header, layers } = parsePsdLayers(buffer);
  assert.equal(header.width, 1500);
  assert.equal(header.height, 1500);
  assert.ok(layers.length >= 9, `图层数应不少于 9，实际 ${layers.length}`);
  const template = psdToTemplate(buffer);
  assert.equal(template.summary.text, 3);
  assert.ok(template.slots.some(slot => slot.text === 'Prevent Barrel From Cracking'));
  // 槽位矩形必须有面积，且 id 唯一（套版要靠 id 定位）
  assert.ok(template.slots.every(slot => slot.rect.width > 0 && slot.rect.height > 0));
  assert.equal(new Set(template.slots.map(slot => slot.id)).size, template.slots.length);
});

test('真实 A+ 模板：文字槽带出字号/字体/对齐/颜色/行距（来自引擎块）', async t => {
  const buffer = read('aplus');
  if (!buffer) return t.skip('缺少样例 aplus01.psd');
  const template = psdToTemplate(buffer, { name: 'aplus01.psd' });
  const texts = template.slots.filter(slot => slot.type === 'text');
  assert.equal(texts.length, 2);

  const title = texts.find(slot => slot.text.includes('HAND WEAVING'));
  assert.ok(title, '应找到主标题槽');
  // 这些值都是从 EngineData 里真读出来的，不是猜的：真实文件里就写着 /FontSize 50.0 与 /FontSet Poppins-Medium。
  assert.equal(title.fontSize, 50);
  assert.equal(title.fontName, 'Poppins-Medium');
  assert.equal(title.justification, 'left');
  assert.match(title.fillColor, /^#[0-9a-f]{6}$/);
  assert.ok(title.leading > 0 && title.leading < 200, `行距应在合理范围，实际 ${title.leading}`);
  // 一段文字可能有多段 run：如实标注取值口径，不假装代表整层。
  assert.equal(title.textSampled, 'first-run');

  // 另一个槽位字号不同 —— 说明不是拿同一个全局值糊弄。
  const subtitle = texts.find(slot => slot !== title);
  assert.equal(subtitle.fontSize, 30);
  assert.notEqual(subtitle.fontName, null);
});

test('真实细节图模板：居中对齐与两种字重都能分别解析', async t => {
  const buffer = read('detail');
  if (!buffer) return t.skip('缺少样例 detail01.psd');
  const template = psdToTemplate(buffer);
  const texts = template.slots.filter(slot => slot.type === 'text');
  assert.ok(texts.length >= 3);
  // 这层在文件里是 /Justification 2（居中）+ Roboto-Bold。
  const bold = texts.find(slot => slot.text === 'Prevent Barrel From Cracking');
  assert.ok(bold, '应找到主标题');
  assert.equal(bold.justification, 'center');
  assert.equal(bold.fontName, 'Roboto-Bold');
  assert.ok(Number.isFinite(bold.fontSize) && bold.fontSize > 0);
  // 其余小字是 Roboto-Medium，字号更小 —— 同层不同样式要能分开。
  const others = texts.filter(slot => slot !== bold);
  assert.ok(others.every(slot => slot.fontName === 'Roboto-Medium'), JSON.stringify(others.map(slot => slot.fontName)));
  assert.ok(others.every(slot => slot.fontSize < bold.fontSize));
});

test('真实模板的组结构：只在 lsct 标记能配对时成组，且子树语义正确', async t => {
  const aplus = read('aplus');
  if (!aplus) return t.skip('缺少样例 aplus01.psd');
  const template = psdToTemplate(aplus);
  assert.equal(template.summary.groups, 1);
  assert.deepEqual(template.groupWarnings, [], '真实文件不该出现分组歧义');
  const group = template.groups[0];
  assert.equal(group.name, '1');
  assert.equal(group.layerIndexes.length, 10);
  // 组内槽位要带上所属组；背景不在组里，就不该有 group。
  const inside = template.slots.filter(slot => slot.group);
  assert.equal(new Set(inside.map(slot => slot.group.name)).size, 1);
  const background = template.slots.find(slot => slot.name === '背景');
  assert.ok(background, '应找到背景层');
  assert.equal(background.group, undefined, '组外的图层不能凭空归属某个组');

  const detail = read('detail');
  if (!detail) return;
  const detailTemplate = psdToTemplate(detail);
  assert.equal(detailTemplate.summary.groups, 2);
  assert.deepEqual(detailTemplate.groupWarnings, []);
  const names = detailTemplate.groups.map(item => item.name).sort();
  assert.deepEqual(names, ['文案', '细节图'].sort());
  // 「文案」组装的是三段文字，「细节图」组装的是图片槽 —— 子树语义必须对得上。
  const copyGroup = detailTemplate.groups.find(item => item.name === '文案');
  const textSlots = detailTemplate.slots.filter(slot => slot.type === 'text');
  assert.deepEqual(textSlots.map(slot => slot.index ?? slot.id).length, 3);
  assert.ok(textSlots.every(slot => slot.group?.name === '文案'), JSON.stringify(textSlots.map(slot => slot.group)));
  assert.equal(copyGroup.layerIndexes.length, 3);
  // 两个组的成员不能重叠。
  const all = detailTemplate.groups.flatMap(item => item.layerIndexes);
  assert.equal(new Set(all).size, all.length, '同一图层不能同时属于两个组');
});

test('组结构异常时如实登记 warning，不硬凑一棵树', () => {
  const layers = (specs) => specs.map(([index, sectionType], position) => ({
    index,
    name: `L${position}`,
    ...(sectionType === null ? {} : { sectionType }),
  }));

  // 正常：分隔符(3) → 子层 → 组标记(2)
  const balanced = buildGroups(layers([[0, null], [1, 3], [2, null], [3, null], [4, 2]]));
  assert.equal(balanced.groups.length, 1);
  assert.deepEqual(balanced.groups[0].layerIndexes, [2, 3]);
  assert.deepEqual(balanced.groupWarnings, []);

  // 只有组标记、没有分隔符 → ORPHAN，且不建组
  const orphan = buildGroups(layers([[0, null], [1, 2]]));
  assert.equal(orphan.groups.length, 0);
  assert.equal(orphan.groupWarnings[0].code, 'PSD_GROUP_ORPHAN');

  // 只有分隔符、没有组标记 → UNCLOSED，成员不归属任何组
  const unclosed = buildGroups(layers([[0, 3], [1, null], [2, null]]));
  assert.equal(unclosed.groups.length, 0);
  assert.equal(unclosed.groupWarnings[0].code, 'PSD_GROUP_UNCLOSED');
  assert.deepEqual(unclosed.groupWarnings[0].pendingLayerIndexes, [1, 2]);

  // 嵌套/重复分隔符 → UNBALANCED，宁可报错也不猜
  const nested = buildGroups(layers([[0, 3], [1, null], [2, 3], [3, null], [4, 2]]));
  assert.equal(nested.groupWarnings[0].code, 'PSD_GROUP_UNBALANCED');
});

test('非 PSD / 过小 / 头部异常都给出稳定错误码', () => {
  assert.throws(() => parsePsdHeader(Buffer.from('PNG...')), (error) => error.code === 'PSD_TOO_SMALL');
  assert.throws(() => parsePsdHeader(Buffer.alloc(26)), (error) => error.code === 'PSD_BAD_SIGNATURE');
  const fake = Buffer.alloc(30); fake.write('8BPS', 0, 'ascii'); fake.writeUInt16BE(1, 4); fake.writeUInt32BE(0, 18);
  assert.throws(() => parsePsdHeader(fake), (error) => error.code === 'PSD_BAD_DIMENSIONS');
  assert.ok(new PsdError('PSD_X', 'x') instanceof Error);
});

test('HTTP /psd/slots：鉴权、空体、非 PSD 都按契约返回', async () => {
  const token = 'psd-token';
  const router = createMediaRouter({ relay: { request: async () => ({}) }, editorKind: 'image', prefix: '/media-image', token, publicDir: '.', assets: null });
  const call = async ({ headers = {}, body = Buffer.alloc(0), method = 'POST' }) => {
    const out = { status: 0, body: '' };
    const res = { writeHead(status) { out.status = status; return res; }, end(chunk) { out.body = String(chunk ?? ''); } };
    const req = { method, url: '/media-image/psd/slots', headers, async *[Symbol.asyncIterator]() { yield body; } };
    await router(req, res);
    return { status: out.status, value: JSON.parse(out.body) };
  };
  const base = { host: 'localhost', origin: 'http://localhost' };
  const denied = await call({ headers: { ...base, authorization: 'Bearer nope' } });
  assert.equal(denied.status, 403);
  const empty = await call({ headers: { ...base, authorization: `Bearer ${token}` } });
  assert.equal(empty.status, 400);
  assert.equal(empty.value.code, 'PSD_EMPTY');
  const notPsd = await call({ headers: { ...base, authorization: `Bearer ${token}` }, body: Buffer.from('not a psd at all, but long enough to pass the size check...') });
  assert.equal(notPsd.status, 400);
  assert.equal(notPsd.value.code, 'PSD_BAD_SIGNATURE');
  assert.match(notPsd.value.hint, /\.psd/);
});

test('HTTP /psd/slots：真实 PSD 返回槽位模板', async t => {
  const buffer = read('aplus');
  if (!buffer) return t.skip('缺少样例 aplus01.psd');
  const token = 'psd-ok-token';
  const router = createMediaRouter({ relay: { request: async () => ({}) }, editorKind: 'image', prefix: '/media-image', token, publicDir: '.', assets: null });
  const out = { status: 0, body: '' };
  const res = { writeHead(status) { out.status = status; return res; }, end(chunk) { out.body = String(chunk ?? ''); } };
  const req = { method: 'POST', url: '/media-image/psd/slots', headers: { host: 'localhost', origin: 'http://localhost', authorization: `Bearer ${token}`, 'x-psd-name': 'aplus01.psd' }, async *[Symbol.asyncIterator]() { yield buffer; } };
  await router(req, res);
  assert.equal(out.status, 200);
  const value = JSON.parse(out.body);
  assert.equal(value.ok, true);
  assert.equal(value.template.name, 'aplus01.psd');
  assert.equal(value.template.canvas.width, 970);
  assert.ok(value.template.slotCount >= 10);
});
