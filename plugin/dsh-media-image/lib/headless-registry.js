// 无头编辑器注册表：由工具层显式调用，替"人必须先打开页面"这条路补一个 Agent 自助入口。
//
// 边界：
// - **不自动调用**。只有显式 `media_image_ensure_editor` 才会拉起浏览器；
//   普通命令仍然走"必须有已授权链路"，避免读一次状态就偷偷起一个进程。
// - 一个实例一个句柄，注册表持有到插件卸载；重复调用同 origin 复用已有实例。
// - 授权不在这里完成：拉起后仍然要 Agent 用 `bind:true` 认领票据，
//   权限判断始终只有一条路（gate.js）。
import { createHeadlessEditor } from './headless-editor.js';

const instances = new Map();

/** 当前登记在册的无头实例（只读快照，给工具回执与状态用）。 */
export function listHeadlessEditors() {
  return [...instances.values()].map(item => ({
    instanceId: item.instanceId,
    pageId: item.pageId,
    projectId: item.projectId,
    origin: item.origin,
    startedAt: item.startedAt,
    ticketId: item.ticketId,
  }));
}

/**
 * 确保有一个可用的无头编辑器。
 * @param {object} options
 * @param {string} options.origin DSH Web 同源地址（页面必须由同一服务提供）
 * @param {boolean} [options.reuse=true] 同 origin 已有实例时直接复用
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{instanceId:string,pageId:string,projectId:string,ticketId:string,reused:boolean}>}
 */
export async function ensureHeadlessEditor({ origin, reuse = true, timeoutMs } = {}) {
  if (reuse) {
    for (const item of instances.values()) {
      if (item.origin === origin) {
        return { instanceId: item.instanceId, pageId: item.pageId, projectId: item.projectId, ticketId: item.ticketId, reused: true };
      }
    }
  }
  const editor = await createHeadlessEditor({ origin, ...(timeoutMs ? { timeoutMs } : {}) });
  instances.set(editor.instanceId, {
    instanceId: editor.instanceId,
    pageId: editor.pageId,
    projectId: editor.projectId,
    ticketId: editor.ticketId,
    origin,
    startedAt: new Date().toISOString(),
    dispose: editor.dispose,
  });
  return { instanceId: editor.instanceId, pageId: editor.pageId, projectId: editor.projectId, ticketId: editor.ticketId, reused: false };
}

/** 关掉其中一个实例（页面被关/出错收尾时用）。 */
export async function closeHeadlessEditor(instanceId) {
  const item = instances.get(instanceId);
  if (!item) return false;
  instances.delete(instanceId);
  await item.dispose();
  return true;
}

/** 插件卸载时统一收尾，避免留下孤儿浏览器进程。 */
export async function closeAllHeadlessEditors() {
  const all = [...instances.values()];
  instances.clear();
  await Promise.allSettled(all.map(item => item.dispose()));
  return all.length;
}
