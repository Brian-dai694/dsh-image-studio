// 无头编辑器：由 Host 启动一个不依赖人操作的浏览器，把插件页面接上 relay。
//
// 为什么放在插件里而不是临时脚本：它是"Agent 自己拿到编辑实例"的唯一途径，
// 也是回归测试（verify:live）要复用的同一份代码。
//
// 安全边界（照 dsh-open-with 的做法）：子进程**不能**继承 Host 的环境变量。
// 浏览器只需要极少数系统变量就能启动；把 API key / token / secret 之类传进去，
// 等于让一个渲染进程拿走本机凭据。所以这里用**白名单**构造 env，再加黑名单兜底。
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 子进程只需要这些变量就能启动浏览器（大小写不敏感比较）。 */
const ALLOWED_ENV = new Set([
  'PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'OS', 'LANG', 'LC_ALL', 'TZ',
  'DISPLAY', 'XDG_RUNTIME_DIR',
]);

/** 即使名字在白名单里，只要命中这些特征也一律丢掉（兜底，防以后白名单放宽出错）。 */
const SECRET_PATTERN = /(api[-_]?key|secret|token|credential|password|passwd|private[-_]?key|connection[-_]?string|database[-_]?url|session[-_]?cookie|bearer)/i;

/**
 * 构造子进程环境：白名单 + 黑名单兜底。
 * @param {Record<string,string|undefined>} [source] 默认取 process.env
 * @returns {Record<string,string>}
 */
export function sanitizeChildEnv(source = process.env) {
  const out = {};
  for (const [name, value] of Object.entries(source ?? {})) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (!ALLOWED_ENV.has(upper)) continue;
    if (SECRET_PATTERN.test(name)) continue;
    out[name] = String(value);
  }
  return out;
}

/** 找出可用的 Playwright 安装位置（插件自己不声明这个依赖，避免强绑版本）。 */
function resolvePlaywright(searchRoots = []) {
  const roots = [
    ...searchRoots,
    process.env.DSH_HOME ? join(process.env.DSH_HOME, 'profiles', 'desktop', 'node_modules') : null,
    join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'profiles', 'desktop', 'node_modules'),
  ].filter(Boolean);
  for (const root of roots) {
    if (!existsSync(root)) continue;
    try {
      const require = createRequire(join(root, 'noop.js'));
      const playwright = require('playwright');
      if (playwright?.chromium) return playwright;
    } catch { /* 换下一个根目录 */ }
  }
  throw Object.assign(new Error('找不到 Playwright；无头编辑需要它（不随插件安装，避免强绑版本）'), { code: 'PLAYWRIGHT_UNAVAILABLE' });
}

/**
 * 启动无头编辑器并完成 relay 绑定 + 票据签发。
 * @returns {Promise<{instanceId:string, pageId:string, projectId:string, ticketId:string, page:object, browser:object, dispose:()=>Promise<void>}>}
 */
export async function createHeadlessEditor({
  origin,
  timeoutMs = 90_000,
  searchRoots = [],
  launch = null,
  headless = true,
} = {}) {
  if (typeof origin !== 'string' || !/^https?:\/\//.test(origin)) {
    throw Object.assign(new Error('origin 必须是 http(s) 地址'), { code: 'INVALID_ORIGIN' });
  }
  const playwright = resolvePlaywright(searchRoots);
  const env = sanitizeChildEnv(); // 只把洗过的环境交给浏览器
  const started = launch
    ? await launch({ playwright, env, headless })
    : await (async () => {
        let last;
        for (const options of [
          { headless, env, channel: 'msedge' },
          { headless, env, channel: 'chrome' },
          { headless, env },
        ]) {
          try { return await playwright.chromium.launch(options); } catch (error) { last = error; }
        }
        throw last;
      })();

  const page = await started.newPage({ viewport: { width: 1440, height: 900 } });
  const dispose = async () => { try { await started.close(); } catch { /* 已关闭 */ } };

  try {
    await page.goto(`${origin}/media-image/image/host.html`, { waitUntil: 'load', timeout: 30_000 });
    await page.waitForFunction(
      () => /已绑定 image relay/.test(document.querySelector('#status')?.textContent || ''),
      null,
      { timeout: timeoutMs },
    );
    const statusText = await page.$eval('#status', node => node.textContent.trim());
    const instanceId = /实例\s+(\S+)/.exec(statusText)?.[1] ?? null;
    const pageId = /page\s+(\S+)/.exec(statusText)?.[1] ?? null;
    if (!instanceId) throw Object.assign(new Error(`页面已连上但读不到实例 id：${statusText}`), { code: 'HEADLESS_NO_INSTANCE' });

    // 用页面自己的同源令牌签票：Host 侧拿不到页面令牌，也不应该拿。
    const ticket = await page.evaluate(async id => {
      const boot = await fetch('/media-image/boot', { credentials: 'same-origin', headers: { 'x-dsh-media-boot': '1' } });
      if (!boot.ok) return { error: `boot ${boot.status}` };
      const { accessToken } = await boot.json();
      const response = await fetch('/media-image/grant/ticket', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { authorization: `Bearer ${accessToken}`, 'x-dsh-media-relay': '1', 'content-type': 'application/json' },
        body: JSON.stringify({ instanceId: id }),
      });
      const body = await response.json().catch(() => null);
      return response.ok ? body.ticket : { error: body?.code ?? response.status };
    }, instanceId);
    if (!ticket?.ticketId) throw Object.assign(new Error(`签票失败：${JSON.stringify(ticket)}`), { code: 'HEADLESS_TICKET_FAILED' });

    return { instanceId, pageId, projectId: ticket.projectId, ticketId: ticket.ticketId, page, browser: started, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
