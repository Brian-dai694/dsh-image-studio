// Packs the already-built miniPaint page into the plugin's public/image/ tree.
// The miniPaint checkout is only read, never written: the packaged copy is a build
// artifact of this plugin, so `/media/image/` can be served by ctx.webServer alone.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(scriptDir, '..');
const DEFAULT_SOURCE = resolve(pluginRoot, '../../miniPaint/miniPaint-master');
const DEFAULT_TARGET = resolve(pluginRoot, 'public/image');
// The wrapper page is authored here, not copied from miniPaint: it is what binds the
// packaged editor to the image relay, so it is emitted next to index.html.
const WRAPPER_DIR = resolve(scriptDir, 'image-page');
const WRAPPER_FILES = ['host.html', 'host.js'];

// Marketing previews and the disabled PWA manifest are not part of the editor runtime.
const EXCLUDED_FILES = new Set(['images/preview.gif', 'images/preview.jpg']);
const EXCLUDED_DIRS = ['images/manifest/'];
// Only the runtime surface is packaged: source, node_modules and old bundles stay out.
const INCLUDED_ROOTS = ['index.html', 'dist', 'images'];
const EXCLUDED_PATTERNS = [/\.map$/, /\.bak-/, /\.LICENSE\.txt\.bak-/];
const REQUIRED_FILES = ['index.html', 'dist/bundle.js', 'images/favicon.png'];

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const toPosix = value => value.split('\\').join('/');

async function walk(root, prefix = '') {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { files.push(...await walk(root, rel)); continue; }
    if (!entry.isFile()) continue;
    if (EXCLUDED_FILES.has(rel)) continue;
    if (EXCLUDED_DIRS.some(dir => rel.startsWith(dir))) continue;
    if (EXCLUDED_PATTERNS.some(pattern => pattern.test(rel))) continue;
    files.push(rel);
  }
  return files.sort();
}

// Entry-page references must resolve inside the packaged tree; a missing asset here is
// exactly the failure mode that produced a blank editor page before.
export function missingReferences(html, files) {
  const known = new Set(files);
  // Commented-out tags (the disabled PWA manifest link) are not runtime requests.
  const active = html.replace(/<!--[\s\S]*?-->/g, '');
  const refs = [...active.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1])
    .filter(ref => !/^(?:[a-z]+:|\/|#)/i.test(ref));
  return refs.filter(ref => !known.has(ref.replace(/^\.\//, '')));
}

export async function packImage({ source = DEFAULT_SOURCE, target = DEFAULT_TARGET } = {}) {
  const files = [];
  for (const root of INCLUDED_ROOTS) {
    const full = join(source, root);
    const info = await stat(full).catch(() => null);
    if (!info) throw new Error(`miniPaint 构建产物缺少 ${root}`);
    if (info.isFile()) files.push(root);
    else files.push(...await walk(source, root));
  }
  files.sort();
  for (const required of REQUIRED_FILES) {
    if (!files.includes(required)) throw new Error(`miniPaint 构建产物缺少 ${required}（先在其目录执行构建）`);
  }
  const html = await readFile(join(source, 'index.html'), 'utf8');
  const wrapper = new Map();
  for (const name of WRAPPER_FILES) wrapper.set(name, await readFile(join(WRAPPER_DIR, name)));
  const packaged = [...files, ...WRAPPER_FILES].sort();
  const missing = missingReferences(html, packaged);
  if (missing.length) throw new Error(`index.html 引用了未打包的资源：${missing.join(', ')}`);
  const wrapperMissing = missingReferences(wrapper.get('host.html').toString('utf8'), packaged);
  if (wrapperMissing.length) throw new Error(`host.html 引用了未打包的资源：${wrapperMissing.join(', ')}`);

  await rm(target, { recursive: true, force: true });
  const manifest = [];
  for (const rel of files) {
    const from = join(source, rel);
    const to = join(target, rel);
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
    const bytes = await readFile(from);
    manifest.push({ path: rel, bytes: bytes.length, sha256: sha256(bytes), origin: 'miniPaint' });
  }
  for (const [name, bytes] of wrapper) {
    await writeFile(join(target, name), bytes);
    manifest.push({ path: name, bytes: bytes.length, sha256: sha256(bytes), origin: 'plugin' });
  }
  manifest.sort((left, right) => left.path.localeCompare(right.path));

  const build = {
    format: 'dsh-media-studio-image-page',
    version: 1,
    entry: 'index.html',
    source,
    bundleSha256: manifest.find(item => item.path === 'dist/bundle.js').sha256,
    fileCount: manifest.length,
    totalBytes: manifest.reduce((sum, item) => sum + item.bytes, 0),
    files: manifest,
  };
  await writeFile(join(target, 'BUILD.json'), `${JSON.stringify(build, null, 2)}\n`, 'utf8');
  return build;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [source, target] = process.argv.slice(2);
  const build = await packImage({ ...(source ? { source: resolve(source) } : {}), ...(target ? { target: resolve(target) } : {}) });
  console.log(JSON.stringify({
    entry: build.entry,
    target: DEFAULT_TARGET,
    fileCount: build.fileCount,
    totalBytes: build.totalBytes,
    bundleSha256: build.bundleSha256,
    source: build.source,
  }, null, 2));
}
