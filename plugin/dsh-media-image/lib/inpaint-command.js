// 命令行（sidecar）局部重绘后端。
//
// 借鉴 C-Shop 的可选视觉包：模型能力放在独立进程里，通过文件交互，
// "模型坏掉不会拖垮编辑器，不装也不影响其余功能"。
//
// 契约（与本插件其余后端一致）：
//   输入  源图 PNG {image}、蒙版 PNG {mask}（白色=要重画，黑色=保留），都在临时目录
//   输出  命令写到 {output} 的 PNG（默认 out.png）
//   参数  按 args 数组逐个做占位符替换，**不经过 shell**，所以文件名里的空格/引号不会变成注入
//
// 这是操作者自己配置的本地命令：插件不内置任何模型，也不下载东西。

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GenerationError } from './errors.js';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

/** 替换 {image}/{mask}/{output}/{prompt}/{width}/{height} 占位符；未知占位符原样保留。 */
export function fillPlaceholders(template, values) {
  return String(template).replace(/\{([a-z]+)\}/gi, (whole, key) => (
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole
  ));
}

/**
 * @param definition {id, kind:'command', command, args?:string[], outputName?:string, timeoutMs?, env?}
 */
export function createCommandProvider(definition, { spawnImpl = spawn, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const { id, command, args = [], outputName = 'out.png', env: extraEnv = null } = definition || {};
  if (!id) throw new GenerationError('PROVIDER_INVALID', 'command provider 需要一个非空 id');
  if (typeof command !== 'string' || !command.trim()) throw new GenerationError('PROVIDER_INVALID', `provider "${id}" 缺少 command`);
  if (!Array.isArray(args)) throw new GenerationError('PROVIDER_INVALID', `provider "${id}" 的 args 必须是数组`);
  if (!isObject(extraEnv) && extraEnv !== null && extraEnv !== undefined) throw new GenerationError('PROVIDER_INVALID', `provider "${id}" 的 env 必须是对象`);

  const run = ({ commandLine, argv, cwd, timeout }) => new Promise((resolve, reject) => {
    const child = spawnImpl(commandLine, argv, {
      cwd,
      shell: false,
      windowsHide: true,
      env: { ...process.env, ...(extraEnv || {}) },
    });
    let stdout = '', stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* 已经退出 */ }
      reject(new GenerationError('INPAINT_TIMEOUT', `局部重绘命令超时（${Math.round(timeout / 1000)}s）`));
    }, timeout);
    child.stdout?.on('data', chunk => { if (stdout.length < 8192) stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', chunk => { if (stderr.length < 8192) stderr += chunk.toString('utf8'); });
    child.on('error', error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      reject(new GenerationError('INPAINT_COMMAND_FAILED', `无法启动局部重绘命令：${error.message}`));
    });
    child.on('close', code => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });

  return {
    id,
    kind: 'command',
    describe() {
      return { id, kind: 'command', command, hasApiKey: false, capabilities: { textToImage: false, inpaint: true } };
    },
    supportsInpaint() { return true; },
    async startInpaint({ imageName, maskName, prompt = '', width, height }) {
      if (!imageName?.bytes?.length) throw new GenerationError('INPAINT_INPUT_INVALID', '缺少源图像素');
      if (!maskName?.bytes?.length) throw new GenerationError('INPAINT_INPUT_INVALID', '缺少蒙版像素');
      const dir = await mkdtemp(join(tmpdir(), 'dsh-inpaint-'));
      const imagePath = join(dir, 'image.png');
      const maskPath = join(dir, 'mask.png');
      const outputPath = join(dir, outputName);
      try {
        await writeFile(imagePath, imageName.bytes);
        await writeFile(maskPath, maskName.bytes);
        const values = { image: imagePath, mask: maskPath, output: outputPath, prompt: String(prompt ?? ''), width: width ?? '', height: height ?? '' };
        const argv = args.map(item => fillPlaceholders(item, values));
        const effectiveTimeout = definition.timeoutMs ?? timeoutMs;
        const outcome = await run({ commandLine: command, argv, cwd: dir, timeout: effectiveTimeout });
        if (outcome.code !== 0) {
          const detail = (outcome.stderr || outcome.stdout || '').slice(0, 400);
          throw new GenerationError('INPAINT_COMMAND_FAILED', `局部重绘命令退出码 ${outcome.code}${detail ? `：${detail}` : ''}`);
        }
        if (!existsSync(outputPath)) throw new GenerationError('INPAINT_OUTPUT_MISSING', `命令没有在 {output} 位置写出图片（期望 ${outputName}）`);
        const bytes = await readFile(outputPath);
        if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new GenerationError('INPAINT_OUTPUT_INVALID', '命令输出的不是 PNG');
        if (bytes.length > MAX_OUTPUT_BYTES) throw new GenerationError('INPAINT_OUTPUT_INVALID', '命令输出超过 64 MiB');
        return { bytes };
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}
