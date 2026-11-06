// 插件规范自检：包清单、技能包结构、bundle patch 挂载行，以及「文档写的必须真实存在」。
// 这组测试防的是文档漂移——SKILL.md 里写了白名单没有的命令，Agent 会照着报错。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED_COMMANDS } from '../lib/bridge.js';
import { TOOL_KINDS } from '../lib/gate.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const patchText = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');

test('包清单符合 DSH bundle 约定：入口、导出、files、patch 都存在', () => {
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, 'lib/index.js');
  assert.ok(statSync(join(root, pkg.main)).isFile(), 'main 必须真实存在');
  assert.equal(pkg.exports['.'], './lib/index.js');
  assert.ok(statSync(join(root, pkg.exports['./client'])).isFile(), 'client 导出必须真实存在');
  assert.ok(statSync(join(root, pkg.exports['./package.json'])).isFile());
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.ok(statSync(join(root, pkg.dsh.bundle.patch)).isFile(), 'bundle patch 必须真实存在');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.ok(Array.isArray(pkg.files));
  // files 白名单必须覆盖所有随包发布的顶层目录与文件，否则 npm pack 会静默漏掉。
  for (const entry of ['lib/', 'public/', 'skills/', 'scripts/', 'cordis.patch.yml', 'README.md']) {
    assert.ok(pkg.files.includes(entry), `files 缺少 ${entry}`);
  }
  for (const entry of ['lib', 'public', 'skills', 'scripts']) {
    assert.ok(statSync(join(root, entry)).isDirectory(), `${entry} 目录不存在`);
  }
});

test('每个技能目录都有 SKILL.md，且 name 与目录名一致、description 带触发词', () => {
  const skillRoot = join(root, 'skills');
  const dirs = readdirSync(skillRoot).filter(name => statSync(join(skillRoot, name)).isDirectory());
  assert.ok(dirs.length > 0, '至少要有一个技能');
  for (const dir of dirs) {
    const file = join(skillRoot, dir, 'SKILL.md');
    const text = readFileSync(file, 'utf8');
    const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
    assert.ok(front, `${dir}/SKILL.md 缺少 frontmatter`);
    const name = /^name:\s*(.+)$/m.exec(front[1])?.[1]?.trim();
    const description = /^description:\s*(.+)$/m.exec(front[1])?.[1]?.trim();
    assert.equal(name, dir, 'name 必须等于目录名（技能目录即技能名）');
    assert.ok(description && description.length >= 40, 'description 要足够具体，才能被正确召回');
    assert.match(description, /Trigger words|触发词/, 'description 要写明触发词');
    assert.ok(text.split('\n').length > 20, '正文要给出可执行流程，而不是一句摘要');
  }
});

test('bundle patch 有唯一的技能挂载行，providerName 与包名一致且不占用内置名', () => {
  const ids = [...patchText.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'patch 行 id 不得重复');
  assert.ok(ids.includes('dsh-media-image'), '缺少插件本体行');
  assert.ok(ids.includes('dsh-media-image-skills'), '缺少技能挂载行');

  const skillBlock = patchText.slice(patchText.indexOf('- id: dsh-media-image-skills'));
  assert.match(skillBlock, /name:\s*'@deepseek-ai\/dsh-skill-filesystem'/, '技能要走 skill-filesystem 提供方');
  assert.match(skillBlock, /providerName:\s*dsh-media-image\b/, 'providerName 必须与包名一致');
  for (const reserved of ['runtime', 'default', 'codewhale-toolkit']) {
    assert.notEqual(`dsh-media-image`, reserved);
    assert.doesNotMatch(skillBlock, new RegExp(`providerName:\\s*${reserved}\\b`), `providerName 不得占用 ${reserved}`);
  }
  assert.match(skillBlock, /includeDefaultRoots:\s*false/, '只挂本包技能，不吞默认根目录');
  assert.match(skillBlock, /bundledSkillDir:.*dsh-media-image\/skills\//, 'bundledSkillDir 必须指向本包 skills/');
  assert.match(skillBlock, /!!js /, '路径要用 !!js 在宿主侧解析，不能写死绝对路径');
  assert.equal(/([A-Za-z]:\\|\.\.\/)/.test(skillBlock), false, 'patch 里不得出现机器相关绝对路径');
});

test('文档不漂移：SKILL.md 提到的命令与工具都必须真实存在', () => {
  const skillText = readFileSync(join(root, 'skills', 'dsh-media-image', 'SKILL.md'), 'utf8');
  const allowed = ALLOWED_COMMANDS.image;
  const commands = new Set([...skillText.matchAll(/`((?:layer|canvas|history)\.[a-z_]+)`/g)].map(match => match[1]));
  assert.ok(commands.size >= 5, '文档应点名具体命令');
  for (const command of commands) assert.ok(allowed.has(command), `SKILL.md 提到了未在白名单里的命令：${command}`);

  const tools = new Set([...skillText.matchAll(/`(media_image_[a-z_]+)`/g)].map(match => match[1]));
  assert.ok(tools.size >= 5, '文档应点名具体工具');
  for (const tool of tools) assert.ok(TOOL_KINDS[tool] === 'image', `SKILL.md 提到了未注册的工具：${tool}`);

  // 反向也要成立：列出全部工具，避免新工具上线后文档默默落后。
  for (const tool of Object.keys(TOOL_KINDS)) assert.ok(tools.has(tool), `SKILL.md 漏写了工具：${tool}`);
});
