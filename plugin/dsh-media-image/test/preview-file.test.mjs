// 预览落盘：宿主附件写入接口没有公开声明，所以给一条可核对的看图路径——
// 写出真实 PNG，调用方用看图工具打开。这里验证"写出来的确实是那份 PNG 字节"。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodePngDataUrl, writePreviewPng, PNG_SIGNATURE } from '../lib/preview-file.js';

// 1×1 透明 PNG
const ONE_PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const DATA_URL = `data:image/png;base64,${ONE_PIXEL}`;

test('解 PNG data URL：签名必须对上，其它一律拒绝', () => {
  const bytes = decodePngDataUrl(DATA_URL);
  assert.ok(bytes.subarray(0, 8).equals(PNG_SIGNATURE), '解出来的必须是 PNG 签名');
  assert.equal(bytes.length, Buffer.from(ONE_PIXEL, 'base64').length);

  assert.throws(() => decodePngDataUrl('data:image/jpeg;base64,AAAA'), { code: 'PREVIEW_INVALID' });
  assert.throws(() => decodePngDataUrl('not a data url'), { code: 'PREVIEW_INVALID' });
  assert.throws(() => decodePngDataUrl('data:image/png;base64,AAAA'), { code: 'PREVIEW_INVALID' }, '签名不符要拒绝，不能写出假 PNG');
  assert.throws(() => decodePngDataUrl(null), { code: 'PREVIEW_INVALID' });
});

test('写盘：路径必须是 .png，写出的字节与 data URL 完全一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-preview-'));
  try {
    assert.throws(() => writePreviewPng({ dataUrl: DATA_URL, savePath: join(dir, 'a.jpg') }), { code: 'PREVIEW_INVALID' });
    assert.throws(() => writePreviewPng({ dataUrl: DATA_URL, savePath: '' }), { code: 'PREVIEW_INVALID' });

    const target = join(dir, 'nested', 'deep', 'preview.png');
    const written = writePreviewPng({ dataUrl: DATA_URL, savePath: target });
    assert.equal(written.path, target);
    assert.equal(written.bytes, Buffer.from(ONE_PIXEL, 'base64').length);
    assert.ok(existsSync(target), '目录不存在时要自己建出来');
    assert.equal(statSync(target).size, written.bytes);
    assert.deepEqual(readFileSync(target), Buffer.from(ONE_PIXEL, 'base64'), '落盘内容必须与预览字节一致');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('相对路径以给定 cwd 为基准解析', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-preview-'));
  try {
    const written = writePreviewPng({ dataUrl: DATA_URL, savePath: 'shots/a.png', cwd: dir });
    assert.equal(written.path, join(dir, 'shots', 'a.png'));
    assert.ok(existsSync(written.path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
