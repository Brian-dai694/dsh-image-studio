// 对话框静态夹具（NON-RUNTIME）。
//
// 目的：不接 DSH 宿主，也能把真实渲染路径跑一遍——样例"会话事件"喂给真实的
// makeTranscript → buildDialogPlan → Conversation 组件，因此夹具与线上只差"数据来源"。
// 这里不含任何业务判断，也不冒充运行时；真机验收仍由 FDE 在部署后做。
//
// 依赖：plugin/dsh-media-image 的 devDependencies（react / react-dom 18.3.1，精确版本），
// 页面从 node_modules 直接加载 UMD 构建；不进运行包（package.json 的 files 不含 docs/）。

const client = window.__fixtureClient;
const React = window.React;
const ReactDOM = window.ReactDOM;
const Conversation = client.chat.Conversation;

const BINDING = { editorKind: 'image', projectId: 'fixture-project', pageId: 'fixture-page', editorInstanceId: 'fixture-instance' };

/** 同源 about:blank iframe，只负责回答 media.binding.read。 */
function makeFrame(binding) {
  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  iframe.setAttribute('aria-hidden', 'true');
  document.body.appendChild(iframe);
  const reply = JSON.stringify({ type: 'media.binding.result', binding });
  const script = `window.addEventListener('message', function (event) {
    var data = event.data || {};
    if (data.type !== 'media.binding.read') return;
    var reply = ${reply};
    reply.requestId = data.requestId;
    parent.postMessage(reply, '*');
  });`;
  iframe.contentDocument.open();
  iframe.contentDocument.write(`<!doctype html><meta charset="utf-8"><script>${script}<\/script>`);
  iframe.contentDocument.close();
  return iframe;
}

/** 假会话：create 立即成功；给了 list 就模拟"可挂接的历史会话"；follow 只吐固定帧，吐完挂起。 */
function makeRemote(frames, sessionId, list) {
  return {
    session: {
      async create() { return { ok: true, value: { sessionId } }; },
      ...(list ? { async list() { return { ok: true, value: { sessions: list } }; } } : {}),
      follow() {
        let index = 0;
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                if (index < frames.length) return { done: false, value: frames[index++] };
                return new Promise(() => {}); // 静态夹具：不再产生新消息
              },
            };
          },
        };
      },
    },
  };
}

const text = value => [{ type: 'text', text: value }];
const message = (role, value) => ({ message: { role, content: text(value) } });

/** 8 类样例事件：用户、助手、工具四态、审批四态、错误、解析失败、撤销/导出凭据。 */
const EVENTS = [
  { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, ...message('user', '把画布改成 1200×800，标题换成「产品主图」，然后导出 PNG') } },
  { seq: 2, type: 'assistant/message', data: message('assistant',
    '## 已开始处理\n\n先读取工程，再按顺序改：\n\n1. `canvas.resize` 到 1200×800\n2. 更新标题文本\n3. `export_start` 导出 PNG\n\n参考 [宽度规范](https://example.com/spec)，行内代码 `expectedRevision` 会带上。\n\n```json\n{"width":1200,"height":800}\n```\n\n> 版本冲突时会返回 REVISION_CONFLICT，请重新读取。') },
  // 工具事件用真实外壳：call 带 toolName，result 是 {ok, value} 包一层（与线上一致）
  { seq: 3, type: 'tool/call', data: { call: { toolName: 'media_image_read_state', arguments: { operation: 'read_state' } } } },
  { seq: 4, type: 'tool/result', data: { call: { toolName: 'media_image_read_state' }, result: { ok: true, value: { status: 'applied', revision: 1, layersCount: 3 } } } },
  { seq: 5, type: 'tool/call', data: { call: { toolName: 'media_image_apply_command', arguments: { operation: 'canvas.resize' } } } },
  { seq: 6, type: 'tool/result', data: { call: { toolName: 'media_image_apply_command' }, result: { ok: true, value: { status: 'applied', revision: 2, commandId: 'cmd-fixture-1', afterDigest: 'fnv1a64-00000000000000a2', operation: 'canvas.resize' } } } },
  { seq: 7, type: 'tool/result', data: { result: { ok: false, error: { code: 'REVISION_CONFLICT' }, value: { status: 'rejected', revision: 2 } } } },
  { seq: 8, type: 'tool/result', data: { result: { ok: true, value: { status: 'unknown', revision: 3 } } } },
  { seq: 9, type: 'tool/call', data: { call: { toolName: 'media_image_export_start', arguments: { format: 'png' } } } },
  { seq: 10, type: 'tool/result', data: { call: { toolName: 'media_image_export_start' }, result: { ok: true, value: { status: 'applied', revision: 4, exportId: 'exp-fixture-1', artifactRef: 'blob:http://127.0.0.1:8819/fixture-1', format: 'png' } } } },
  { seq: 11, type: 'approval/asked', data: { toolName: 'media_image_apply_command', reason: 'document=fixture-project page=fixture-page' } },
  { seq: 12, type: 'approval/decided', data: { outcome: 'allowed-once' } },
  { seq: 13, type: 'approval/decided', data: { outcome: 'rejected' } },
  { seq: 14, type: 'approval/decided', data: { outcome: 'unavailable' } },
  { seq: 15, type: 'session/error', data: { error: { code: 'APPROVAL_TIMEOUT', message: '等待授权超时，本次请求已取消，需要重新发起' } } },
  { seq: 16, type: 'assistant/message', data: message('assistant',
    '{"quite":"a raw json body that must never reach the dom, it is long enough to trigger the fallback rule","n":1}') },
];

function snapshot(records) {
  return { type: 'snapshot', header: { id: 'fixture-session' }, records: records.map(event => ({ event })) };
}

function mount(target, { frames, bind, width = 600, list }) {
  const frame = makeFrame(BINDING);
  const remote = makeRemote(frames, 'fixture-session', list);
  const mountNode = document.createElement('div');
  mountNode.style.cssText = 'flex:1;min-width:0;display:flex;min-height:0;height:100%';
  target.appendChild(mountNode);
  ReactDOM.createRoot(mountNode).render(React.createElement(Conversation, {
    label: '图片编辑器 · 夹具', kind: 'image', frameRef: { current: frame },
    getRemote: () => remote, getWorkspace: () => ({ openSession() {} }), active: true, width, narrow: false,
  }));
  if (!bind) return;
  // 点一次「绑定专属对话」，之后的订阅、投影、渲染都走真实代码路径。
  const timer = setInterval(() => {
    const button = Array.from(mountNode.querySelectorAll('button')).find(node => node.textContent === '绑定专属对话');
    if (!button) return;
    clearInterval(timer);
    button.click();
  }, 100);
}

mount(document.getElementById('full'), { frames: [snapshot(EVENTS),  // 助手流式增量：start → chunk → end（committed），结尾落成一条助手消息
  { type: 'assistant-stream', frame: { type: 'start', attemptId: 'attempt-fixture', revision: 1 } },
  { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'attempt-fixture', revision: 1, index: 0, chunk: { type: 'text-delta', text: '（流式增量）我已经把画布改成 1200×800，' } } },
  { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'attempt-fixture', revision: 1, index: 1, chunk: { type: 'text-delta', text: '接下来处理标题文本。' } } },
  { type: 'assistant-stream', frame: { type: 'end', attemptId: 'attempt-fixture', revision: 1, outcome: { kind: 'committed', seq: 999 } } },
], bind: true, width: 1080 });
mount(document.getElementById('empty'), { frames: [snapshot([])], bind: true, width: 560 });
mount(document.getElementById('unbound'), { frames: [], bind: false, width: 560 });
// ④ 绑定已有会话：宿主返回两个历史会话，点「绑定专属对话」应列出它们 + 新建入口
mount(document.getElementById('sessions'), {
  frames: [], bind: true, width: 560,
  list: [
    { sessionId: 'session-image-a', title: '图片工程：改标题与画布尺寸' },
    { sessionId: 'session-video-b', title: '视频工程：首次绑定只读状态' },
  ],
});

document.documentElement.dataset.fixtureReady = 'pending';
setTimeout(() => { document.documentElement.dataset.fixtureReady = 'ready'; }, 1200);
