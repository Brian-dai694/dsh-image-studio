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
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, isAbsolute } from 'node:path';
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
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new GenerationError('PROVIDER_INVALID', `provider "${id}" 的 args 必须是字符串数组`);
  if (!isObject(extraEnv) && extraEnv !== null && extraEnv !== undefined) throw new GenerationError('PROVIDER_INVALID', `provider "${id}" 的 env 必须是对象`);
  if (Object.values(extraEnv || {}).some(value => typeof value !== 'string')) throw new GenerationError('PROVIDER_INVALID', `provider "${id}" 的 env 值必须是字符串`);
  if (typeof outputName !== 'string' || !outputName || outputName !== basename(outputName) || /[\\/]/.test(outputName) || isAbsolute(outputName) || outputName === '.' || outputName === '..') {
    throw new GenerationError('PROVIDER_INVALID', `provider "${id}" 的 outputName 必须是临时目录内的文件名`);
  }
  const configuredTimeout = definition.timeoutMs ?? timeoutMs;
  if (!Number.isSafeInteger(configuredTimeout) || configuredTimeout < 1 || configuredTimeout > 15 * 60 * 1000) {
    throw new GenerationError('PROVIDER_INVALID', `provider "${id}" 的 timeoutMs 必须是 1..900000 的整数`);
  }

  const run = ({ commandLine, argv, cwd, timeout }) => new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(commandLine, argv, {
        cwd,
        shell: false,
        windowsHide: true,
        env: { ...process.env, ...(extraEnv || {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsVerbatimArguments: false,
      });
    } catch (error) {
      reject(new GenerationError('INPAINT_COMMAND_FAILED', `无法启动局部重绘命令：${error?.message || error}`));
      return;
    }
    if (!child || typeof child.on !== 'function' || typeof child.kill !== 'function') {
      reject(new GenerationError('INPAINT_COMMAND_FAILED', '命令启动器没有返回有效的子进程'));
      return;
    }

    const MAX_CAPTURE = 8192;
    let stdout = '', stderr = '';
    let settled = false;
    let timedOut = false;
    let timer = null;
    const appendBounded = (current, chunk) => {
      if (current.length >= MAX_CAPTURE) return current;
      return (current + chunk.toString('utf8')).slice(0, MAX_CAPTURE);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };
    const terminateAndWait = () => new Promise(resolveTermination => {
      let closed = false;
      const graceTimer = setTimeout(() => {
        if (closed) return;
        // 不再重放命令；第二次 kill 只升级同一子进程的终止请求。
        try { child.kill('SIGKILL'); } catch { /* 由 close/error 最终定案 */ }
        resolveTermination(false);
      }, 3000);
      child.on('close', () => {
        closed = true;
        clearTimeout(graceTimer);
        resolveTermination(true);
      });
      try {
        const accepted = child.kill('SIGTERM');
        if (accepted === false) {
          // kill=false 可能意味着进程已退出；close 事件仍是最终判据。
        }
      } catch { /* close/error 事件与 grace timer 处理结局 */ }
    });

    child.stdout?.on('data', chunk => { stdout = appendBounded(stdout, chunk); });
    child.stderr?.on('data', chunk => { stderr = appendBounded(stderr, chunk); });
    child.on('error', error => {
      if (timedOut || settled) return;
      finish(reject, new GenerationError('INPAINT_COMMAND_FAILED', `无法启动局部重绘命令：${error.message}`));
    });
    child.on('close', code => {
      if (timedOut || settled) return;
      finish(resolve, { code, stdout: stdout.trim(), stderr: stderr.trim() });
    });

    timer = setTimeout(async () => {
      if (settled) return;
      timedOut = true;
      const terminated = await terminateAndWait();
      if (terminated) {
        finish(reject, new GenerationError('INPAINT_TIMEOUT', `局部重绘命令超时（${Math.round(timeout / 1000)}s），子进程已退出`));
      } else {
        const error = new GenerationError('INPAINT_TERMINATION_UNKNOWN', `局部重绘命令超时（${Math.round(timeout / 1000)}s），未能确认子进程退出；临时目录将保留以避免删除仍在使用的输入文件`);
        error.preserveTempDir = true;
        finish(reject, error);
      }
    }, timeout);
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
      let preserveTempDir = false;
      try {
        await writeFile(imagePath, imageName.bytes);
        await writeFile(maskPath, maskName.bytes);
        const values = { image: imagePath, mask: maskPath, output: outputPath, prompt: String(prompt ?? ''), width: width ?? '', height: height ?? '' };
        const argv = args.map(item => fillPlaceholders(item, values));
        const outcome = await run({ commandLine: command, argv, cwd: dir, timeout: configuredTimeout });
        if (outcome.code !== 0) {
          const detail = (outcome.stderr || outcome.stdout || '').slice(0, 400);
          throw new GenerationError('INPAINT_COMMAND_FAILED', `局部重绘命令退出码 ${outcome.code}${detail ? `：${detail}` : ''}`);
        }
        if (!existsSync(outputPath)) throw new GenerationError('INPAINT_OUTPUT_MISSING', `命令没有在 {output} 位置写出图片（期望 ${outputName}）`);
        const outputStat = statSync(outputPath);
        if (outputStat.size > MAX_OUTPUT_BYTES) throw new GenerationError('INPAINT_OUTPUT_INVALID', '命令输出超过 64 MiB');
        if (outputStat.size < 8) throw new GenerationError('INPAINT_OUTPUT_INVALID', '命令输出的不是 PNG');
        const bytes = await readFile(outputPath);
        if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new GenerationError('INPAINT_OUTPUT_INVALID', '命令输出的不是 PNG');
        return { bytes };
      } catch (error) {
        if (error?.preserveTempDir) {
          preserveTempDir = true;
          error.message += `（临时目录：${dir}）`;
          error.tempDir = dir;
        }
        throw error;
      } finally {
        // 只有明确确认子进程结束后才清理；终止状态未知则保留目录供排查/安全清理。
        if (!preserveTempDir) await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}
