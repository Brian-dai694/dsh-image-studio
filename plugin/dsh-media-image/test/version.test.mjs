// 版本号一致性守卫：package.json 是唯一来源，页面常量与 README 徽标必须跟它一致。
// 这条测试只读文件，不写任何东西；不同步时给出一条能直接照做的修复命令。
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(pluginRoot, '../..');
const read = file => readFile(file, 'utf8');

test('页面版本常量与 README 徽标都等于 package.json 的版本', async () => {
  const pkg = JSON.parse(await read(resolve(pluginRoot, 'package.json')));
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'package.json version 必须是 x.y.z');

  const module = await read(resolve(repoRoot, 'miniPaint/src/js/dsh-version.js'));
  const match = module.match(/export const DSH_IMAGE_VERSION = '([^']+)'/);
  assert.ok(match, 'dsh-version.js 必须导出 DSH_IMAGE_VERSION 常量');
  assert.equal(match[1], pkg.version, '版本号不同步，请在 plugin/dsh-media-image 下跑 npm run sync-version');

  const readme = await read(resolve(repoRoot, 'README.md'));
  assert.ok(readme.includes(`badge/version-${pkg.version}-`), 'README 版本徽标与 package.json 不一致');
  assert.ok(readme.includes(`当前版本 ${pkg.version}`), 'README 的“当前版本”说明与 package.json 不一致');
});

test('两个模式的界面都会渲染版本', async () => {
  const main = await read(resolve(repoRoot, 'miniPaint/src/js/main.js'));
  assert.match(main, /installVersionBadge\(\)/, '完整模式必须在初始化时安装版本徽标');
  const minimal = await read(resolve(repoRoot, 'miniPaint/src/js/dsh-minimal-ui.js'));
  assert.match(minimal, /DSH_IMAGE_VERSION/, '极简模式顶栏必须显示版本');
  assert.match(minimal, /dsh-minimal-version/, '极简模式版本元素必须有稳定的 class 便于验收');
  const badge = await read(resolve(repoRoot, 'miniPaint/src/js/dsh-version-badge.js'));
  assert.match(badge, /data-dsh-version/, '版本徽标必须带 data-dsh-version 便于页面读数核对');
});
