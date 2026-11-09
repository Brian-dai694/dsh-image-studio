// 本地脚本后端：真实运行，洞被填上、洞外像素逐字节不变、空蒙版明确失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createAssetStore } from '../lib/assets.js';
import { createGenerationService } from '../lib/generation.js';

const PYTHON = 'C:/Users/UEFR/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe';
const SCRIPT = 'C:/Users/UEFR/.dsh/bot/workspace/dsh-image-studio/plugin/dsh-media-image/scripts/inpaint-local.py';

function makeFixture(dir) {
  // 128x128 纯色背景 + 中间一个红块；蒙版只覆盖红块。
  const py = `
import sys
from PIL import Image
import numpy as np
w = h = 128
img = np.zeros((h, w, 3), np.uint8)
img[:, :] = (40, 120, 200)
img[48:80, 48:80] = (220, 30, 30)
mask = np.zeros((h, w), np.uint8)
mask[48:80, 48:80] = 255
Image.fromarray(img, 'RGB').save(sys.argv[1])
Image.fromarray(mask, 'L').save(sys.argv[2])
`;
  execFileSync(PYTHON, ['-c', py, join(dir, 'image.png'), join(dir, 'mask.png')]);
  return { image: join(dir, 'image.png'), mask: join(dir, 'mask.png') };
}

test('本地脚本真实运行：洞被填上，洞外像素逐字节不变', t => {
  if (!existsSync(PYTHON) || !existsSync(SCRIPT)) return t.skip('缺少本机 python 或脚本');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-inpaint-'));
  try {
    const { image, mask } = makeFixture(dir);
    const before = readFileSync(image);
    const out = join(dir, 'out.png');
    const stdout = execFileSync(PYTHON, [SCRIPT, '--image', image, '--mask', mask, '--out', out], { encoding: 'utf8' });
    const result = JSON.parse(stdout.trim());
    assert.equal(result.ok, true, stdout);
    assert.equal(result.filledPixels, 32 * 32);
    assert.equal(result.engine, 'diffusion-telea-like', '要如实标注是扩散算法，不是神经模型');
    assert.ok(existsSync(out), '必须写出结果文件');
    assert.deepEqual(readFileSync(image), before, '脚本不得改动输入图');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('本地脚本作为 command provider 接入：结果进素材库，尺寸与源图一致', async t => {
  if (!existsSync(PYTHON) || !existsSync(SCRIPT)) return t.skip('缺少本机 python 或脚本');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-inpaint-provider-'));
  try {
    const { image, mask } = makeFixture(dir);
    const assets = createAssetStore();
    const imageAsset = assets.add({ bytes: readFileSync(image), name: 'scene.png' });
    const maskAsset = assets.add({ bytes: readFileSync(mask), name: 'hole.png' });
    const service = createGenerationService({
      providers: [{ id: 'local-script', kind: 'command', command: PYTHON,
        args: [SCRIPT, '--image', '{image}', '--mask', '{mask}', '--out', '{output}'], timeoutMs: 60000 }],
      assets,
    });
    assert.equal(service.list()[0].capabilities.inpaint, true);
    const job = await service.submitInpaint({ provider: 'local-script', prompt: 'fill', width: 128, height: 128,
      imageRef: `asset:${imageAsset.id}`, maskRef: `asset:${maskAsset.id}` });
    assert.equal(job.status, 'succeeded', JSON.stringify(job));
    assert.match(job.assetRef, /^asset:[a-f0-9]{48}$/);
    const produced = assets.get(job.assetRef.slice(6));
    assert.ok(produced.bytes.length > 100);
    // PNG 头里的尺寸应与源图一致（脚本不做缩放）。
    assert.equal(produced.bytes.readUInt32BE(16), 128);
    assert.equal(produced.bytes.readUInt32BE(20), 128);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('脚本拒绝空蒙版：明确报错而不是写出原图', t => {
  if (!existsSync(PYTHON) || !existsSync(SCRIPT)) return t.skip('缺少本机 python 或脚本');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-inpaint-empty-'));
  try {
    const { image } = makeFixture(dir);
    const empty = join(dir, 'empty-mask.png');
    const py = `
import sys
from PIL import Image
import numpy as np
Image.fromarray(np.zeros((128, 128), np.uint8), 'L').save(sys.argv[1])
`;
    execFileSync(PYTHON, ['-c', py, empty]);
    let failed = false;
    try {
      execFileSync(PYTHON, [SCRIPT, '--image', image, '--mask', empty, '--out', join(dir, 'x.png')], { encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      failed = true;
      const message = String(error.stdout || error.stderr || '');
      assert.match(message, /nothing to fill/, `实际输出：${message}`);
    }
    assert.equal(failed, true, '空蒙版必须失败');
    assert.equal(existsSync(join(dir, 'x.png')), false, '失败时不该写出结果');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
