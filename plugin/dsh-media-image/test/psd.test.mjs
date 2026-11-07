// PSD 模板解析测试：优先用真实模板（WPS 知识库下载的 aplus01/detail01），缺失则跳过。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createMediaRouter } from '../lib/http.js';
import { parsePsdHeader, parsePsdLayers, psdToTemplate, PsdError } from '../lib/psd.js';

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
