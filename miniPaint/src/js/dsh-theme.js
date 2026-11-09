// DSH 主题接收端：宿主（DSH 面板 → host.html）用 postMessage 把令牌值传进来，
// 这里把它们写成 CSS 变量并打上 data-dsh-theme，让 dsh-theme.css 生效。
//
// 契约：{ type: 'dsh.theme', tokens: { bg, surface, sunken, text, textMuted, border, hover, accent } }
// 只接受本窗口父帧、同源、已知字段；数值只接受 #rgb/#rrggbb/rgba()/rgb()/hsl() 形状的字符串，
// 其他一律忽略——主题值会被塞进 CSS 变量，不做校验等于给样式注入开口子。

const MAX_TOKEN_LENGTH = 64;
const COLOR_SHAPE = /^(#[0-9a-f]{3,8}|rgba?\([0-9.,%\s/]+\)|hsla?\([0-9.,%\s/deg]+\))$/i;
const FIELDS = ['bg', 'surface', 'sunken', 'text', 'textMuted', 'border', 'hover', 'accent', 'accentContrast'];
const CSS_NAMES = {
  bg: '--dsh-bg', surface: '--dsh-surface', sunken: '--dsh-surface-sunken',
  text: '--dsh-text', textMuted: '--dsh-text-muted', border: '--dsh-border',
  hover: '--dsh-hover', accent: '--dsh-accent', accentContrast: '--dsh-accent-contrast',
};

export function applyDshTheme(tokens, root = document.documentElement) {
  if (!tokens || typeof tokens !== 'object' || !root?.style) return false;
  let applied = 0;
  for (const field of FIELDS) {
    const value = tokens[field];
    if (typeof value !== 'string' || !value.trim() || value.length > MAX_TOKEN_LENGTH) continue;
    if (!COLOR_SHAPE.test(value.trim())) continue;
    root.style.setProperty(CSS_NAMES[field], value.trim());
    applied += 1;
  }
  if (applied) root.setAttribute('data-dsh-theme', String(tokens.mode || 'dsh'));
  return applied > 0;
}

export function installDshTheme(win = typeof window === 'undefined' ? null : window) {
  if (!win || typeof win.addEventListener !== 'function') return () => {};
  const onMessage = event => {
    // 只认父帧、同源、带主题标记的消息；iframes 的 message 事件 source 是父窗口。
    if (event.source !== win.parent || event.origin !== win.location.origin) return;
    if (event.data?.type !== 'dsh.theme') return;
    applyDshTheme(event.data.tokens);
  };
  win.addEventListener('message', onMessage);
  return () => win.removeEventListener('message', onMessage);
}
