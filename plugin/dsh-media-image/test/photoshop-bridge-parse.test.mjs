// photoshop-bridge.ps1 的静态门禁。
//
// 为什么需要它：这个脚本只有在「本机开了 Photoshop 且用户真的调用」时才会被执行，
// 所以一个语法错误可以一直躺在仓库里不被人发现。更隐蔽的一类是编码问题：
// powershell.exe 对**没有 BOM 的脚本**按系统 ANSI 代码页读取，脚本里一旦混进非 ASCII
// 注释，UTF-8 字节会被 ANSI 误解，可能凑出一个 `"` / 反引号 / 大括号，把解析带偏。
// 这类错误连 `node --check` 都拦不住 —— 曾经真的发生过一次。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(root, '..', 'scripts', 'photoshop-bridge.ps1');

test('bridge 脚本必须是纯 ASCII：BOM-less 脚本会被 powershell.exe 按 ANSI 读，非 ASCII 注释会破坏解析', () => {
  const bytes = readFileSync(BRIDGE);
  const offenders = [];
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] > 127) offenders.push(index);
  }
  if (offenders.length) {
    const first = offenders[0];
    const context = bytes.subarray(Math.max(0, first - 40), first + 20).toString('utf8');
    assert.fail(`photoshop-bridge.ps1 含 ${offenders.length} 个非 ASCII 字节（首个在偏移 ${first}，附近：${JSON.stringify(context)}）`);
  }
});

const canParse = process.platform === 'win32' && (() => {
  try { return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { timeout: 20_000 }).status === 0; }
  catch { return false; }
})();

test('bridge 脚本能被 PowerShell 真正解析（不只是"看起来像"）', { skip: canParse ? false : 'windows powershell.exe 不可用' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ps-parse-'));
  try {
    const checker = join(dir, 'check.ps1');
    writeFileSync(checker, [
      'param([string]$Target)',
      '$tokens = $null',
      '$errors = $null',
      '$null = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $Target).Path, [ref]$tokens, [ref]$errors)',
      'if (-not $errors -or $errors.Count -eq 0) { Write-Output "PARSE_OK"; exit 0 }',
      'Write-Output ("PARSE_ERRORS: " + $errors.Count)',
      'foreach ($e in $errors) { Write-Output ("line " + $e.Extent.StartLineNumber + " : " + $e.Message) }',
      'exit 1',
      '',
    ].join('\r\n'), 'utf8');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', checker, BRIDGE], { encoding: 'utf8', timeout: 60_000 });
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    assert.equal(result.status, 0, `PowerShell 解析失败：\n${output}`);
    assert.match(output, /PARSE_OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bridge 脚本的 action 枚举与 service 白名单一致', async () => {
  const { PHOTOSHOP_ACTIONS } = await import('../lib/photoshop-com.js');
  const source = readFileSync(BRIDGE, 'utf8');
  const match = /\[ValidateSet\(([^)]*)\)\]/.exec(source);
  assert.ok(match, 'ValidateSet 必须存在，否则 action 参数没有服务端约束');
  const declared = [...match[1].matchAll(/'([a-z_]+)'/g)].map(item => item[1]).sort();
  assert.deepEqual(declared, [...PHOTOSHOP_ACTIONS].sort(), 'PowerShell 与 JS 两侧的 action 列表必须完全一致');
});
