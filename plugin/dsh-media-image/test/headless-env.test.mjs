// 无头启动的两条硬约束：
//   1) 子进程不能继承 Host 的凭据（API key / token / secret 等）；
//   2) 白名单不能因为"以后放宽"而漏嘴——黑名单兜底必须真的生效。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeChildEnv } from '../lib/headless-editor.js';

const here = dirname(fileURLToPath(import.meta.url));

test('凭据类环境变量一律不进入子进程', () => {
  const env = sanitizeChildEnv({
    PATH: '/usr/bin',
    DEEPSEEK_API_KEY: 'sk-leak',
    OPENAI_API_KEY: 'sk-leak',
    GITHUB_TOKEN: 'ghp_leak',
    AWS_SECRET_ACCESS_KEY: 'leak',
    DB_PASSWORD: 'leak',
    PRIVATE_KEY: 'leak',
    DATABASE_URL: 'postgres://u:p@h/db',
    SESSION_COOKIE: 'leak',
  });
  assert.equal(env.PATH, '/usr/bin', '启动浏览器需要的 PATH 必须保留');
  for (const name of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'DB_PASSWORD', 'PRIVATE_KEY', 'DATABASE_URL', 'SESSION_COOKIE']) {
    assert.equal(name in env, false, `${name} 不应传给子进程`);
  }
});

test('系统启动必需变量保留，未知变量默认丢弃（白名单而非黑名单）', () => {
  const env = sanitizeChildEnv({
    SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\Temp',
    COMSPEC: 'C:\\Windows\\system32\\cmd.exe',
    APPDATA: 'C:\\Users\\x\\AppData\\Roaming',
    SOME_RANDOM_THING: 'x',
    EDITOR: 'vim',
  });
  assert.equal(env.SystemRoot, 'C:\\Windows');
  assert.equal(env.TEMP, 'C:\\Temp');
  assert.equal(env.COMSPEC, 'C:\\Windows\\system32\\cmd.exe');
  assert.equal(env.APPDATA, 'C:\\Users\\x\\AppData\\Roaming');
  assert.equal('SOME_RANDOM_THING' in env, false, '未登记变量默认不传');
  assert.equal('EDITOR' in env, false);
});

test('undefined 值不会变成字符串 "undefined"', () => {
  const env = sanitizeChildEnv({ PATH: '/bin', TEMP: undefined });
  assert.equal(env.PATH, '/bin');
  assert.equal('TEMP' in env, false);
});

test('源码守卫：无头启动不得把 process.env 原样交给浏览器', () => {
  const source = readFileSync(join(here, '..', 'lib', 'headless-editor.js'), 'utf8');
  assert.equal(/env:\s*process\.env/.test(source), false, '不允许 env: process.env');
  assert.equal(/\.\.\.process\.env/.test(source), false, '不允许展开 process.env 进 env');
  assert.match(source, /sanitizeChildEnv\(\)/, '必须走清洗函数');
});
