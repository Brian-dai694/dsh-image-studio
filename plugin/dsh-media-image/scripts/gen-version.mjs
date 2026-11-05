// 把插件 package.json 的版本号同步到两处，避免页面上手写、README 上过期：
//   1) miniPaint/src/js/dsh-version.js —— 编辑器运行时读的版本常量（构建进 bundle）
//   2) 仓库 README 的 shields 版本徽标
// 只改这两处；package.json 是唯一来源，本脚本不改它。
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(scriptDir, '..');
const repoRoot = resolve(pluginRoot, '../..');
const PACKAGE_FILE = resolve(pluginRoot, 'package.json');
const VERSION_MODULE = resolve(repoRoot, 'miniPaint/src/js/dsh-version.js');
const README_FILE = resolve(repoRoot, 'README.md');

export async function syncVersion() {
  const pkg = JSON.parse(await readFile(PACKAGE_FILE, 'utf8'));
  const version = String(pkg.version || '');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`package.json 的 version 不是合法语义版本：${JSON.stringify(version)}`);
  }
  const module = `// 版本号的唯一来源是 plugin/dsh-media-image/package.json。
// 由 plugin/dsh-media-image/scripts/gen-version.mjs 生成；不要手改这一行，
// 改 package.json 后跑 \`npm run sync-version\`（在插件目录）。
export const DSH_IMAGE_VERSION = '${version}';
`;
  await writeFile(VERSION_MODULE, module, 'utf8');

  const readme = await readFile(README_FILE, 'utf8');
  const badge = `https://img.shields.io/badge/version-${version}-4D6BFE?style=flat-square`;
  // 徽标与「当前版本 X」这句话都跟 package.json 走：单源，也避免 README 自己写死后过期。
  let updated = /https:\/\/img\.shields\.io\/badge\/version-[^)\s]+/.test(readme)
    ? readme.replace(/https:\/\/img\.shields\.io\/badge\/version-[^)\s]+/, badge)
    : readme;
  updated = updated.replace(/当前版本 \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g, `当前版本 ${version}`);
  if (updated !== readme) await writeFile(README_FILE, updated, 'utf8');
  return { version, versionModule: VERSION_MODULE, readmeUpdated: updated !== readme };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await syncVersion();
  console.log(JSON.stringify({ version: result.version, versionModule: result.versionModule, readmeUpdated: result.readmeUpdated }, null, 2));
}
