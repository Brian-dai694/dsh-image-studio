// verify:live —— 用真浏览器跑一遍"无头编辑器能否连上并签到票据"。
//
// 为什么需要它：单元测试里的 iframe / MessageChannel 都是替身，这一轮两个真 bug
// （transport 把首次 load 当重载、在 load 回调里立刻握手超时）在替身里全绿。
// 这条脚本验证的是真环境里那条链路：页面 → relay 注册 → 签票。
//
// 用法：
//   node scripts/verify-live.mjs [origin]           只验证到"签票成功"就退出
//   node scripts/verify-live.mjs [origin] --keep    验证后保持页面存活（供 Agent 绑定）
import { createHeadlessEditor } from '../lib/headless-editor.js';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const origin = args.find(value => /^https?:\/\//.test(value)) ?? 'http://127.0.0.1:49852';

const started = Date.now();
let editor = null;
try {
  editor = await createHeadlessEditor({ origin });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(JSON.stringify({
    ok: true,
    origin,
    elapsedSeconds: Number(seconds),
    instanceId: editor.instanceId,
    pageId: editor.pageId,
    projectId: editor.projectId,
    ticketId: editor.ticketId,
    next: `Agent 侧首次调用：media_image_read_state { bind: true, instanceId: "${editor.instanceId}", projectId: "${editor.projectId}" }`,
    keepAlive: keep,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, origin, code: error.code ?? 'VERIFY_FAILED', message: error.message }, null, 2));
  await editor?.dispose();
  process.exit(1);
}

if (keep) {
  // 保持页面存活，Agent 才有实例可绑；Ctrl+C 结束。
  await new Promise(() => {});
} else {
  await editor.dispose();
}
