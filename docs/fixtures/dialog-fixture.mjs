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

/**
 * 假会话：create 立即成功；给了 list 就按**真实契约** `{items: SessionSummary[]}` 返回；
 * 给了 peek 映射就为那些 sessionId 返回带工程标记的快照（模拟"读一眼工程身份"）。
 */
function makeRemote(frames, sessionId, options = {}) {
  const { list, peek } = options;
  const probed = new Set();
  function streamOf(framesToSend) {
    let index = 0;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (index < framesToSend.length) return { done: false, value: framesToSend[index++] };
            return new Promise(() => {});
          },
        };
      },
    };
  }
  return {
    session: {
      async create() { return { ok: true, value: { sessionId } }; },
      ...(list ? { async list() { return { ok: true, value: { items: list } }; } } : {}),
      follow(request) {
        const asked = request && request.address && request.address.sessionId;
        const projectId = peek && peek[asked];
        // 同一个会话会被看两次：第一次是"读工程标记"的探针（回标记快照），之后是真正订阅（回内容帧）。
        const isProbe = !!projectId && !probed.has(asked);
        if (projectId) probed.add(asked);
        if (isProbe) {
          const marked = '当前编辑工程身份：' + JSON.stringify({ editorKind: 'image', projectId }) + '\n用户指令：\n（夹具里的历史会话）';
          return streamOf([{ type: 'snapshot', header: { id: asked }, records: [{ event: { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, message: { content: [{ type: 'text', text: marked }] } } } }] }]);
        }
        return streamOf(frames);
      },
    },
  };
}

const text = value => [{ type: 'text', text: value }];
const message = (role, value) => ({ message: { role, content: text(value) } });

// 工具/审批事件一律来自 docs/fixtures/real-events.json（FDE 抓包原文，来源写在每条 fixtureOrigin 里）。
// 这里只构造"人说话"的样例：Markdown 富文本、会话错误、裸 JSON 兜底。
const MARKDOWN_EVENTS = [
  { seq: 101, type: 'user/message', data: { source: { kind: 'user' }, ...message('user', '把画布改成 1200×800，标题换成「产品主图」，然后导出 PNG') } },
  { seq: 102, type: 'assistant/message', data: message('assistant',
    '## 已开始处理\n\n先读取工程，再按顺序改：\n\n1. `canvas.resize` 到 1200×800\n2. 更新标题文本\n3. `export_start` 导出 PNG\n\n参考 [宽度规范](https://example.com/spec)，行内代码 `expectedRevision` 会带上。\n\n```json\n{"width":1200,"height":800}\n```\n\n> 版本冲突时会返回 REVISION_CONFLICT，请重新读取。') },
  { seq: 103, type: 'session/error', data: { error: { code: 'APPROVAL_TIMEOUT', message: '等待授权超时，本次请求已取消，需要重新发起' } } },
  { seq: 104, type: 'assistant/message', data: message('assistant',
    '{"quite":"a raw json body that must never reach the dom, it is long enough to trigger the fallback rule","n":1}') },
];

const REAL = await fetch('./real-events.json').then(response => {
  if (!response.ok) throw new Error('real-events.json 加载失败：' + response.status);
  return response.json();
});
const ALL_EVENTS = MARKDOWN_EVENTS.concat(REAL.events).sort((left, right) => left.seq - right.seq);

function snapshot(records) {
  return { type: 'snapshot', header: { id: 'fixture-session' }, records: records.map(event => ({ event })) };
}

function mount(target, { frames, bind, width = 600, list, peek }) {
  const frame = makeFrame(BINDING);
  // 默认给一条"与本工程匹配"的历史会话，模拟真实面板先列会话、再由用户选中的流程。
  const effectiveList = list || [{ sessionId: 'fixture-session', updatedAt: Date.now(), running: false, blank: false, agentAvailable: true, projections: { values: { title: '本工程：夹具会话' } } }];
  const effectivePeek = peek || { 'fixture-session': 'fixture-project' };
  const remote = makeRemote(frames, 'fixture-session', { list: effectiveList, peek: effectivePeek });
  const mountNode = document.createElement('div');
  mountNode.style.cssText = 'flex:1;min-width:0;display:flex;min-height:0;height:100%';
  target.appendChild(mountNode);
  ReactDOM.createRoot(mountNode).render(React.createElement(Conversation, {
    label: '图片编辑器 · 夹具', kind: 'image', frameRef: { current: frame },
    getRemote: () => remote, getWorkspace: () => ({ openSession() {} }), active: true, width, narrow: false,
  }));
  if (!bind) return;
  // 真实路径：先点「绑定专属对话」列出会话，再点本工程那条（不是直接 create）。
  let clickedBind = false;
  const timer = setInterval(() => {
    const buttons = Array.from(mountNode.querySelectorAll('button'));
    if (!clickedBind) {
      const button = buttons.find(node => node.textContent === '绑定专属对话');
      if (!button) return;
      button.click(); clickedBind = true; return;
    }
    const listbox = mountNode.querySelector('[role="listbox"]');
    if (!listbox) return;
    const pick = Array.from(listbox.querySelectorAll('button')).find(node => /^本工程/.test(node.textContent));
    if (!pick) return;
    clearInterval(timer);
    pick.click();
  }, 100);
}

mount(document.getElementById('full'), { frames: [snapshot(ALL_EVENTS),  // 助手流式增量：start → chunk → end（committed），结尾落成一条助手消息
  { type: 'assistant-stream', frame: { type: 'start', attemptId: 'attempt-fixture', revision: 1 } },
  { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'attempt-fixture', revision: 1, index: 0, chunk: { type: 'text-delta', text: '（流式增量）我已经把画布改成 1200×800，' } } },
  { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'attempt-fixture', revision: 1, index: 1, chunk: { type: 'text-delta', text: '接下来处理标题文本。' } } },
  { type: 'assistant-stream', frame: { type: 'end', attemptId: 'attempt-fixture', revision: 1, outcome: { kind: 'committed', seq: 999 } } },
], bind: true, width: 1080 });
mount(document.getElementById('empty'), { frames: [snapshot([])], bind: true, width: 560 });
mount(document.getElementById('unbound'), { frames: [], bind: false, width: 560 });
// ④ 绑定已有会话：严格契约 {items}，且只展示与本工程匹配的会话（无关会话默认隐藏）
mount(document.getElementById('sessions'), {
  frames: [], bind: true, width: 560,
  list: [
    { sessionId: 'session-image-a', updatedAt: 1700000002000, running: false, blank: false, agentAvailable: true, projections: { values: { title: '本工程：改标题与画布尺寸' } } },
    { sessionId: 'session-video-b', updatedAt: 1700000001000, running: true, blank: false, agentAvailable: true, projections: { values: { title: '别的工程：视频只读状态' } } },
    { sessionId: 'session-blank-c', updatedAt: 1700000000000, running: false, blank: true, agentAvailable: true },
  ],
  peek: { 'session-image-a': 'fixture-project', 'session-video-b': 'other-project' },
});

document.documentElement.dataset.fixtureReady = 'pending';
setTimeout(() => { document.documentElement.dataset.fixtureReady = 'ready'; }, 1200);
