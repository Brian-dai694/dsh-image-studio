// 版本徽标：完整模式放在画布右下角；极简模式的顶栏已经显示版本，这里不重复添加。
// 版本号来自 dsh-version.js（由打包脚本从插件 package.json 生成），不在页面上手写。
import { DSH_IMAGE_VERSION } from './dsh-version.js';

export function installVersionBadge() {
  if (document.documentElement.classList.contains('dsh-minimal')) return;
  if (document.querySelector('.dsh-version-badge')) return;
  const style = document.createElement('style');
  style.textContent = `.dsh-version-badge{position:fixed;right:12px;bottom:12px;z-index:20;padding:4px 10px;border-radius:999px;background:#ffffff;border:1px solid rgba(0,0,0,.08);color:#6e6e73;font:11px/1.4 -apple-system,BlinkMacSystemFont,'SF Pro Text','Microsoft YaHei',sans-serif;pointer-events:none}`;
  document.head.appendChild(style);
  const badge = document.createElement('span');
  badge.className = 'dsh-version-badge';
  badge.textContent = `v${DSH_IMAGE_VERSION}`;
  badge.setAttribute('data-dsh-version', DSH_IMAGE_VERSION);
  document.body.appendChild(badge);
}

export default installVersionBadge;
