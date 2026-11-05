import app from './app.js';
import config from './config.js';

export function installMinimalUi(bridge) {
  if (!new URLSearchParams(location.search).has('minimal')) return;
  document.documentElement.classList.add('dsh-minimal');
  const style = document.createElement('style');
  style.textContent = `
    .dsh-minimal {--dsh-bg:#f5f5f7;--dsh-ink:#1d1d1f;--dsh-blue:#0071e3;--dsh-radius:16px;--dsh-space:16px}
    .dsh-minimal .main_menu,.dsh-minimal .submenu,.dsh-minimal .sidebar_left,.dsh-minimal .sidebar_right,.dsh-minimal .mobile_menu,.dsh-minimal .ruler_left,.dsh-minimal .ruler_top {display:none!important}
    .dsh-minimal .wrapper {top:60px!important;bottom:0!important;grid-template-columns:minmax(0,1fr)!important;grid-template-rows:minmax(0,1fr)!important;grid-template-areas:'main'!important;background:var(--dsh-bg)}
    .dsh-minimal .middle_area {grid-area:main!important;min-width:0;min-height:0;margin:0!important}
    .dsh-minimal .main_wrapper {inset:0!important;margin:0!important}
    .dsh-minimal-bar {position:fixed;inset:0 0 auto;height:60px;display:flex;align-items:center;gap:12px;padding:0 var(--dsh-space);background:#fff;color:var(--dsh-ink);font:14px -apple-system,BlinkMacSystemFont,'SF Pro Text','Microsoft YaHei',sans-serif;z-index:20;border-bottom:1px solid #e5e5ea}
    .dsh-minimal-bar strong {margin-right:auto;font-weight:600}
    .dsh-minimal-bar button,.dsh-minimal-bar summary {font:inherit;border:0;border-radius:var(--dsh-radius);padding:10px 16px;background:var(--dsh-bg);color:var(--dsh-ink);cursor:pointer;list-style:none;transition:transform 180ms cubic-bezier(.25,.1,.25,1)}
    .dsh-minimal-bar button:active,.dsh-minimal-bar summary:active {transform:scale(.98)}
    .dsh-minimal-bar :focus-visible {outline:2px solid var(--dsh-blue);outline-offset:2px}
    .dsh-minimal-bar details {position:relative}.dsh-minimal-menu {position:absolute;right:0;top:48px;display:grid;gap:8px;min-width:180px;padding:12px;background:#fff;border:1px solid #e5e5ea;border-radius:var(--dsh-radius);box-shadow:0 4px 12px rgba(0,0,0,.08)}
    .dsh-minimal-panel {position:absolute;right:0;top:48px;display:grid;gap:10px;width:260px;padding:14px;background:#fff;border:1px solid #e5e5ea;border-radius:var(--dsh-radius);box-shadow:0 4px 12px rgba(0,0,0,.08)}
    .dsh-minimal-panel[hidden] {display:none}
    .dsh-minimal-panel label {display:grid;gap:6px;font-size:12px;color:#6e6e73}
    .dsh-minimal-panel textarea,.dsh-minimal-panel input {font:inherit;font-size:13px;padding:10px 12px;border:1px solid transparent;border-radius:10px;background:var(--dsh-bg);color:var(--dsh-ink);width:100%;box-sizing:border-box;resize:vertical}
    .dsh-minimal-panel .row {display:flex;gap:8px}
    .dsh-minimal-panel .row button {flex:1}
    .dsh-minimal-note {position:fixed;bottom:12px;left:16px;max-width:80%;font:12px/1.5 -apple-system,sans-serif;color:var(--dsh-ink);background:#fff;padding:8px 12px;border-radius:12px;z-index:20}
    @media(prefers-reduced-motion:reduce){.dsh-minimal-bar *{transition:none!important}}
  `;
  document.head.appendChild(style);
  const bar = document.createElement('header'); bar.className = 'dsh-minimal-bar';
  const title = document.createElement('strong'); title.textContent = '图片编辑器'; bar.appendChild(title);
  const note = document.createElement('output'); note.className = 'dsh-minimal-note'; note.setAttribute('aria-live','polite'); note.hidden = true;
  function fail(error) { note.hidden = false; note.textContent = error.message || '操作失败'; }
  function download(url, name) { const a = document.createElement('a'); a.href = url; a.download = name; a.click(); }
  const input = document.createElement('button'); input.textContent = '导入'; input.setAttribute('aria-label', '导入图片或工程'); input.onclick = () => app.FileOpen.open_file(); bar.appendChild(input);

  // Overlay entries stay reachable in minimal mode: hiding the native toolbars must not remove
  // the only way for a human to add a text or image layer without going through an agent.
  function insertText(text) {
    const body = String(text || '').trim();
    if (!body) throw new Error('请输入文字内容');
    const meta = { size: 32, family: 'Arial' };
    const lines = body.split('\n').map(line => [{ text: line, meta: { ...meta } }]);
    app.State.do_action(new app.Actions.Insert_layer_action({
      name: body.slice(0, 80) || '文本', type: 'text',
      x: Math.round((config.WIDTH || 800) / 2), y: Math.round((config.HEIGHT || 600) / 2),
      rotate: 0, is_vector: true, render_function: ['text', 'render'], data: lines,
      params: { boundary: 'dynamic', kerning: 'metrics', text_direction: 'ltr', wrap_direction: 'ttb', halign: 'center', valign: 'top', wrap: 'letter' },
    }, false));
  }
  function insertImageFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('读取图片失败'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('无法解析这张图片'));
        img.onload = () => {
          app.State.do_action(new app.Actions.Insert_layer_action({
            name: file.name || '图片', type: 'image', link: img,
            x: Math.max(0, Math.round(((config.WIDTH || 800) - img.width) / 2)),
            y: Math.max(0, Math.round(((config.HEIGHT || 600) - img.height) / 2)),
            width: img.width, height: img.height, width_original: img.width, height_original: img.height,
          }));
          resolve();
        };
        img.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    });
  }

  let openPanel = null;
  function togglePanel(panel, trigger) {
    const next = openPanel === panel ? null : panel;
    if (openPanel) openPanel.hidden = true;
    openPanel = next;
    for (const button of panelButtons) button.setAttribute('aria-expanded', String(button.dataset.panel === (openPanel && openPanel.dataset.panel)));
    if (openPanel) openPanel.hidden = false;
    if (trigger) trigger.focus();
  }
  const panelButtons = [];

  const textButton = document.createElement('button');
  textButton.type = 'button'; textButton.textContent = '文字'; textButton.setAttribute('aria-label', '添加文字图层');
  textButton.setAttribute('aria-haspopup', 'dialog'); textButton.setAttribute('aria-expanded', 'false');
  const textPanel = document.createElement('div');
  textPanel.className = 'dsh-minimal-panel'; textPanel.hidden = true; textPanel.dataset.panel = 'text';
  textPanel.setAttribute('role', 'dialog'); textPanel.setAttribute('aria-label', '添加文字图层');
  const textLabel = document.createElement('label'); textLabel.textContent = '文字内容';
  const textArea = document.createElement('textarea'); textArea.rows = 3; textArea.placeholder = '输入要添加的文字，支持多行';
  textLabel.appendChild(textArea); textPanel.appendChild(textLabel);
  const textRow = document.createElement('div'); textRow.className = 'row';
  const textOk = document.createElement('button'); textOk.type = 'button'; textOk.textContent = '添加';
  const textCancel = document.createElement('button'); textCancel.type = 'button'; textCancel.textContent = '取消';
  textOk.onclick = () => { try { insertText(textArea.value); textArea.value = ''; togglePanel(null); note.hidden = false; note.textContent = '已添加文字图层'; } catch (error) { fail(error); } };
  textCancel.onclick = () => togglePanel(null);
  textRow.append(textOk, textCancel); textPanel.appendChild(textRow);
  textButton.onclick = () => togglePanel(textPanel, textButton);

  const imageButton = document.createElement('button');
  imageButton.type = 'button'; imageButton.textContent = '图片'; imageButton.setAttribute('aria-label', '添加图片图层');
  const fileInput = document.createElement('input');
  fileInput.type = 'file'; fileInput.accept = 'image/*'; fileInput.hidden = true;
  imageButton.onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    try { await insertImageFile(file); note.hidden = false; note.textContent = '已添加图片图层'; } catch (error) { fail(error); }
  };

  const textWrap = document.createElement('div'); textWrap.style.position = 'relative';
  const imageWrap = document.createElement('div'); imageWrap.style.position = 'relative';
  textWrap.append(textButton, textPanel); imageWrap.append(imageButton, fileInput);
  textButton.dataset.panel = 'text';
  panelButtons.push(textButton);
  bar.append(textWrap, imageWrap);
  const menu = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = '导出'; menu.appendChild(summary);
  const items = document.createElement('div'); items.className = 'dsh-minimal-menu'; menu.appendChild(items);
  for (const format of ['png','jpeg','json']) {
    const button = document.createElement('button'); button.textContent = format === 'json' ? '保存工程 JSON' : '导出 ' + format.toUpperCase();
    button.onclick = async () => {
      button.disabled = true;
      try {
        if (format === 'json') {
          const blob = new Blob([app.FileSave.export_as_json()], {type:'application/json'}), url = URL.createObjectURL(blob);
          download(url, 'image-project.json'); setTimeout(() => URL.revokeObjectURL(url), 60000);
        } else {
          const item = await bridge.enqueue(async () => { bridge.refreshRevision(); return bridge.exportStart({documentId:bridge.documentId,expectedRevision:bridge.revision,commandId:crypto.randomUUID(),format}); });
          download(item.artifactRef, 'image.' + (format === 'jpeg' ? 'jpg' : 'png'));
        }
        menu.open = false; note.hidden = false; note.textContent = '已生成文件，请查看浏览器下载。';
      } catch (error) { fail(error); } finally {button.disabled = false;}
    };
    items.appendChild(button);
  }
  bar.appendChild(menu); document.body.append(bar, note);
  config.need_render = true; window.dispatchEvent(new Event('resize'));
}
