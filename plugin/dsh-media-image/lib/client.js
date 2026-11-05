// Browser-side Cordis module: two sidebar entries, each pairing its editor with the real
// conversation.
//
// Seats, all official: `sidebar.panellist` holds the entry buttons, `main` holds the page
// body, `ctx.layout.selectPanel(id)` switches panels. The conversation is NOT re-created:
// messages come from `remote.session.follow` and input goes to `remote.session.prompt`, so
// an unbound or unsupported host shows an explicit status line instead of a fake dialogue.
window.__ModuleLoader__.load({
  id: 'dsh-media-image',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var PANEL_LIST = 'sidebar.panellist'
    var MAIN = 'main'
    var ORDER = -3
    // Rewritten per package by split-packages.mjs: two merged packages sharing one overlay
    // id would collide in the root list slot and drop one editor's sidebar entry.
    var RETAINED_OVERLAY_ID = 'media-image-retained-editors'
    var EASE = 'cubic-bezier(.25,.1,.25,1)'

    var ENTRIES = [
      {
        id: 'media-image-editor',
        label: '图片编辑器',
        src: '/media-image/image/host.html',
        icon: 'M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6zm2 9.5 3-3.5 2.5 3 2-2.5 2.5 3V18H6v-2.5zM9 9.5A1.5 1.5 0 1 0 9 6.5a1.5 1.5 0 0 0 0 3z',
      },
    ]

    // ---------- service helpers (exported for tests) ----------

    function pick(ctx, key) {
      try {
        if (ctx && ctx[key] !== undefined && ctx[key] !== null) return ctx[key]
        if (ctx && typeof ctx.get === 'function') return ctx.get(key)
      } catch (_) { /* service may not be composed yet */ }
      return undefined
    }

    function promptBody(sessionId, text, attachments) {
      var content = [{ type: 'text', text: text }]
      // 附图作为真正的 image 内容片段发送；宿主若不支持会在 sendPrompt 里被如实报回来，
      // 不做"看起来发出去了"的假成功。
      if (Array.isArray(attachments)) attachments.forEach(function (part) { if (part && part.type === 'image') content.push(part) })
      return {
        requestId: 'media-studio-' + Date.now() + '-' + Math.random().toString(16).slice(2),
        sessionId: sessionId, mode: 'queue', content: content,
      }
    }

    /** Send one message. Never reports success it did not observe. */
    async function sendPrompt(remote, sessionId, text, attachments) {
      var session = remote && remote.session
      if (!session || typeof session.prompt !== 'function') return { ok: false, message: '宿主未提供 session.prompt，无法发送消息。' }
      try {
        var value = await session.prompt(promptBody(sessionId, text, attachments))
        if (value && value.ok === false) return { ok: false, message: '发送被宿主拒绝：' + (value.error?.message || value.error?.code || '未知原因') }
        if (!value || value.ok !== true || value.value?.accepted !== true) return { ok: false, unknown: true, message: '宿主未确认受理，请核对会话记录。' }
        return { ok: true, value: value.value }
      } catch (error) {
        return { ok: false, unknown: true, message: '发送结果未确认，请先核对会话记录，避免重复发送。' }
      }
    }

    /** Prose carried by a streamed event, or null when it carries none. */
    function textOfEvent(event) {
      if (!event || typeof event !== 'object') return null
      var keys = ['text', 'delta', 'contentText']
      for (var i = 0; i < keys.length; i += 1) {
        if (typeof event[keys[i]] === 'string' && event[keys[i]]) return event[keys[i]]
      }
      var content = (event.message && event.message.content) || event.content
      if (Array.isArray(content)) {
        var joined = content.filter(function (part) { return part && part.type === 'text' && typeof part.text === 'string' })
          .map(function (part) { return part.text }).join('')
        if (joined) return joined
      }
      if (event.message && typeof event.message.role === 'string' && typeof event.message.text === 'string') return event.message.text
      return null
    }

    /**
     * `remote.session.list` 在不同宿主版本里字段形状不一，这里统一成 `[{sessionId,title}]`。
     * 拿不到结构就返回 null，调用方据此回退到"只能新建"，绝不假装有会话列表。
     */
    /**
     * 严格解析 `remote.session.list`：契约是 `{ items: SessionSummary[] }`（单页，没有 sessions/hasMore/
     * nextCursor）。形状不对就抛明确错误，**不静默退回"只能新建"**——那会让功能静默消失。
     * 标题只在 `projections.values.title`，可为 null 或缺失；缺失时渲染层显示「未命名会话」。
     */
    function normalizeSessionItems(value) {
      const raw = value && (value.value || value);
      if (!raw || !Array.isArray(raw.items)) {
        const error = new Error('宿主返回的会话列表不符合契约（缺少 items 数组），请核对 remote.session.list 的版本');
        error.code = 'SESSION_LIST_UNSUPPORTED';
        throw error;
      }
      const out = [];
      for (const item of raw.items) {
        if (!item || typeof item.sessionId !== 'string' || !item.sessionId) continue;
        const values = item.projections && item.projections.values;
        const rawTitle = values && typeof values.title === 'string' ? values.title.trim() : '';
        out.push({
          sessionId: item.sessionId,
          title: rawTitle ? rawTitle.slice(0, 80) : null,
          updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : null,
          running: item.running === true,
          blank: item.blank === true,
          agentAvailable: item.agentAvailable !== false,
          cwd: typeof item.cwd === 'string' ? item.cwd : null,
        });
      }
      return out;
    }

    /** 读会话列表；宿主没提供 list 或形状不符合契约时抛错（由绑定流程明确报给用户）。 */
    async function listSessions(remote, limit = 8) {
      const session = remote && remote.session;
      const list = session && (session.list || session.listSessions);
      if (typeof list !== 'function') {
        const error = new Error('宿主未提供 remote.session.list，无法列出历史会话；可以新建专属会话');
        error.code = 'SESSION_LIST_UNSUPPORTED';
        throw error;
      }
      return normalizeSessionItems(await list({ limit }));
    }

    /** 会话摘要上的标注：空会话 / 有回合在跑 / 助手不在线。只做显示，不改变排序。 */
    function sessionAnnotations(item) {
      const notes = [];
      if (item && item.blank === true) notes.push('空会话');
      if (item && item.running === true) notes.push('有回合在跑');
      if (item && item.agentAvailable === false) notes.push('助手不在线');
      return notes;
    }

    /**
     * 隐私边界：默认只列出**带本工程标记**的会话；其余一律不进列表（连标题都不显示）。
     * 没有匹配项时由 UI 只给「新建」，而不是让用户从无关会话里挑。
     */
    function filterSessionsForProject(items, projectId, projectById) {
      const list = Array.isArray(items) ? items : [];
      const matched = [];
      const others = [];
      for (const item of list) {
        if (projectId && projectById && projectById[item.sessionId] === projectId) matched.push(item);
        else others.push(item);
      }
      return { matched, others };
    }

    /**
     * 读取一个会话的工程标记：短暂 follow，拿到快照就取消；超时/无标记返回 null。
     * 只用于"能否挂接"的判断，不缓存、不落盘。
     */
    function peekProjectId(remote, sessionId, timeoutMs = 800) {
      return new Promise(resolve => {
        let done = false;
        let stop = null;
        const finish = value => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (typeof stop === 'function') stop();
          resolve(value);
        };
        const timer = setTimeout(() => finish(null), timeoutMs);
        stop = followSession(remote, sessionId, frame => {
          const records = frame && frame.type === 'snapshot' ? frame.records : (frame && frame.record ? [frame.record] : []);
          const found = projectIdFromRecords(records);
          if (found) finish(found);
          else if (frame && frame.type === 'snapshot') finish(null);
        }, () => finish(null));
        if (typeof stop !== 'function') finish(null);
      });
    }

    /** 从会话记录里找工程身份标记的 projectId；找不到返回 null（只代表"没标记"，不代表匹配）。 */
    function projectIdFromRecords(records) {
      if (!Array.isArray(records)) return null;
      for (const record of records) {
        const event = record && record.event;
        const text = event && textOfEvent(event.data?.message || event.data);
        if (typeof text !== 'string' || text.indexOf('当前编辑工程身份：') < 0) continue;
        const match = /"projectId"\s*:\s*"([^"]+)"/.exec(text);
        if (match) return match[1];
      }
      return null;
    }

    /**
     * 绑定已有会话时的工程校验：会话里带过工程身份、且 projectId 与当前工程不同 → 拒绝绑定。
     * 没带标记（例如新建后还没发过指令）不拒绝，交给后续 read_state/审批把关。
     */
    function projectMismatch(records, projectId) {
      const found = projectIdFromRecords(records);
      if (!found || !projectId) return null;
      return found === projectId ? null : found;
    }

    /**
     * 订阅一个专属会话的消息流，返回取消函数；宿主不支持订阅时返回 null。
     * 参数：remote 宿主 Remote 服务、sessionId 目标会话、onEvent 逐帧回调、onError 异常回调。
     * 取消语义：置位标志 → abort 信号 → 调 iterator.return，之后到达的帧一律丢弃，
     * 避免切页或换绑后旧会话的迟到消息污染当前对话。
     */
    function followSession(remote, sessionId, onEvent, onError) {
      var session = remote && remote.session
      if (!session || typeof session.follow !== 'function') return null
      var controller = new AbortController()
      var iterator = null
      var cancelled = false
      void (async function () {
        try {
          var stream = session.follow({ address: { kind: 'session', sessionId: sessionId }, assistantStream: true, maxMessages: 200 }, controller.signal)
          if (cancelled) {
            if (stream && typeof stream.return === 'function') await stream.return()
            return
          }
          if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') throw new Error('宿主返回了无法识别的消息流')
          iterator = stream[Symbol.asyncIterator]()
          while (!cancelled) {
            var next = await iterator.next()
            if (cancelled || next.done) break
            onEvent(next.value)
          }
        } catch (error) {
          if (!cancelled && onError) onError(error)
        }
      })()
      return function () {
        cancelled = true
        controller.abort()
        if (iterator && typeof iterator.return === 'function') Promise.resolve(iterator.return()).catch(function () {})
      }
    }


    function readBinding(frame, kind) {
      return new Promise(function (resolve, reject) {
        var requestId = crypto.randomUUID()
        var timer = setTimeout(function () { finish(); reject(new Error('读取工程身份超时')) }, 8000)
        function finish() { clearTimeout(timer); window.removeEventListener('message', receive) }
        function receive(event) {
          if (event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.type !== 'media.binding.result' || event.data.requestId !== requestId) return
          finish()
          var b = event.data.binding
          if (!b || b.editorKind !== kind || !b.projectId || !b.pageId || !b.editorInstanceId) { reject(new Error(event.data.error || '工程身份不完整')); return }
          resolve(b)
        }
        window.addEventListener('message', receive)
        frame.contentWindow.postMessage({ type: 'media.binding.read', requestId: requestId }, location.origin)
      })
    }
    function bindingKey(b) { return [b.editorKind, b.projectId, b.pageId, b.editorInstanceId].join(':') }
    // 真实会话里 tool/result 的外壳比契约示例深一层（例如 {result:{ok,value}}、或回执正文
    // 放在 content[{type:'text',text:'{...}'}] 里）。所以不写死某条路径，而是把所有"可能是回执"
    // 的层收集起来再按字段取第一个可用值：少一层/多一层/纯文本 JSON 都能解析。
    var FACT_KEYS = ['result', 'value', 'output', 'data', 'call', 'payload', 'response', 'content', 'parts', 'blocks', 'items', 'messages', 'meta', 'error'];
    /** 分层顺序 = 取值优先级：先外层再内层，契约层（result.value / call.result.value）紧跟其后。 */
    function orderedSources(root) {
      var layers = [];
      function add(value) { if (value && typeof value === 'object' && layers.indexOf(value) < 0) layers.push(value) }
      add(root);
      add(root.result); add(root.result && root.result.value);
      add(root.call);
      var callResult = root.call && root.call.result;
      add(callResult); add(callResult && callResult.value);
      add(root.value); add(root.output); add(root.meta); add(root.error); add(root.data); add(root.payload); add(root.response);
      // 低优先级：content/parts 里再包一层的对象，以及文本形态的 JSON 回执
      factSources(root).forEach(add);
      return layers;
    }
    function factSources(root) {
      var out = [], queue = [root], seen = new Set();
      while (queue.length && out.length < 64) {
        var value = queue.shift();
        if (value === undefined || value === null) continue;
        if (typeof value === 'string') {
          var trimmed = value.trim();
          if (trimmed.charAt(0) !== '{') continue;
          try { value = JSON.parse(trimmed) } catch (_) { continue }
        }
        if (Array.isArray(value)) { value.forEach(function (item) { queue.push(item) }); continue }
        if (typeof value !== 'object' || seen.has(value)) continue;
        seen.add(value); out.push(value);
        for (var index = 0; index < FACT_KEYS.length; index += 1) {
          var next = value[FACT_KEYS[index]];
          if (next !== undefined && next !== null) queue.push(next);
        }
        if (typeof value.text === 'string') queue.push(value.text);
      }
      return out;
    }
    function pickAny(sources, keys) {
      for (var index = 0; index < sources.length; index += 1) {
        for (var key = 0; key < keys.length; key += 1) {
          var value = sources[index][keys[key]];
          if (value !== undefined && value !== null && value !== '') return value;
        }
      }
      return undefined;
    }
    /** 收集某个字段在各层出现的不同取值；第一个是优先级最高的那个，其余用于"不一致"诊断。 */
    function collectValues(sources, key) {
      var seen = [], values = [];
      for (var index = 0; index < sources.length; index += 1) {
        var value = sources[index][key];
        if (typeof value !== 'string' || !value) continue;
        if (seen.indexOf(value) >= 0) continue;
        seen.push(value); values.push(value);
      }
      return values;
    }
    var stringOf = value => typeof value === 'string' && value ? value : undefined;
    /** 一次把回执里所有用得到的字段抽出来：状态、修订、错误码、撤销凭据、导出引用。 */
    function toolFacts(data) {
      var sources = orderedSources(data);
      var error = pickAny(sources, ['error']);
      var errorCode;
      if (typeof error === 'string') errorCode = error;
      else if (error && typeof error === 'object') errorCode = stringOf(error.code);
      if (!errorCode) {
        var bareCode = stringOf(pickAny(sources, ['code']));
        if (bareCode && /^[A-Z][A-Z0-9_]{3,}$/.test(bareCode)) errorCode = bareCode;
      }
      if (!errorCode && pickAny(sources, ['ok']) === false) errorCode = 'TOOL_ERROR';
      // 后端已把稳定错误码放进 meta.errorCode（不再靠解析文本行）。
      if (!errorCode) errorCode = stringOf(pickAny(sources, ['errorCode']));
      var revision = pickAny(sources, ['revision', 'appliedRevision']);
      var format = stringOf(pickAny(sources, ['format', 'mimeType']));
      // 可定位对象：Host 的写命令回执带 changedObjectIds；面板只用它做"点卡片定位"。
      var changedRaw = pickAny(sources, ['changedObjectIds']);
      var changedObjectIds = Array.isArray(changedRaw)
        ? changedRaw.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 256).slice(0, 200)
        : [];
      // 状态：按层级优先取第一个；若其他层给出不同值，不静默丢弃，交给卡片显示"不一致"。
      var statuses = collectValues(sources, 'status');
      return {
        toolName: stringOf(pickAny(sources, ['toolName'])) || '',
        status: statuses[0] || '',
        statusConflicts: statuses.slice(1),
        revision: Number.isSafeInteger(revision) ? revision : undefined,
        errorCode: errorCode,
        commandId: stringOf(pickAny(sources, ['commandId', 'targetCommandId'])),
        afterDigest: stringOf(pickAny(sources, ['afterDigest'])),
        exportId: stringOf(pickAny(sources, ['exportId'])),
        artifactRef: stringOf(pickAny(sources, ['artifactRef'])),
        format: format,
        changedObjectIds: changedObjectIds,
        // meta.objectKind 与 changedObjectIds 同时出现；这里只取值，白名单校验在 locateFromFacts。
        objectKind: stringOf(pickAny(sources, ['objectKind'])),
      };
    }
    /** 回执证据优先取 message.content 里的工具输出 JSON，其次才是事件外壳。 */
    function evidenceData(value) {
      return outputJsonOf(value && value.message) || outputJsonOf(value) || value;
    }
    function undoEvidence(value) {
      var facts = toolFacts(evidenceData(value));
      if (!facts.commandId || !Number.isSafeInteger(facts.revision) || !facts.afterDigest) return null;
      return { commandId: facts.commandId, appliedRevision: facts.revision, afterDigest: facts.afterDigest };
    }
    /**
     * 撤销指令：只把带凭据的指令填进输入框，由会话里的 Agent 执行。
     * 凭据缺一项就不生成文案——宁可不给按钮，也不给一个跑不通的指令。
     */
    function undoPrompt(evidence) {
      var undo = sanitizeUndo(evidence);
      if (!undo) return '';
      return '撤销上一步修改：使用 history.undo，params={"targetCommandId":"' + undo.commandId + '","afterDigest":"' + undo.afterDigest + '"}'
        + '（commandId=' + undo.commandId + '，appliedRevision=' + undo.appliedRevision + '）。'
        + '先 read_state 确认这一步仍是历史栈顶；若返回 HISTORY_CONFLICT 说明已有后续修改，立即停止并说明，不要重试或绕过。';
    }
    function resultIssue(value) {
      var facts = toolFacts(evidenceData(value));
      if (facts.errorCode === 'HISTORY_CONFLICT') return '已有后续人工或 AI 修改，不能单独撤销这一步。请回读当前历史；不要重试旧命令。';
      return null;
    }
    /**
     * 从工具回执里找导出的artifactRef：只用于在界面上提供真实「另存」入口。
     * Host 侧通常是合成引用（artifact://…），因此按钮会请编辑器自己再导一次，而不是直接打开该引用。
     */
    function exportEvidence(value) {
      var facts = toolFacts(evidenceData(value));
      if (!facts.exportId && !facts.artifactRef) return null;
      return { exportId: facts.exportId || null, artifactRef: facts.artifactRef || null, format: /jpe?g/i.test(String(facts.format || '')) ? 'jpeg' : 'png' };
    }
    function watchPanel(layout, onChange) {
      var store = layout && layout.panelInfo
      if (!store || typeof store.subscribe !== 'function' || typeof store.getSnapshot !== 'function') { onChange(null); return function () {} }
      function sync() { onChange(store.getSnapshot().activePanelId) }
      var off = store.subscribe(sync)
      sync()
      return off
    }
    var EDITOR_IDS = ['media-image-editor']
    function isEditorPanel(panelId) { return EDITOR_IDS.indexOf(panelId) >= 0 }
    /** Measured box, or null while the node is absent or not laid out yet. */
    function measureRect(node) {
      if (!node || node.isConnected !== true || typeof node.getBoundingClientRect !== 'function') return null
      try {
        var r = node.getBoundingClientRect()
        return r && r.width > 0 && r.height > 0 ? { left: r.left, top: r.top, width: r.width, height: r.height } : null
      } catch (_) { return null }
    }
    /**
     * The live anchor for the active panel. A navigation away unmounts the keyed main
     * panel and a return mounts a fresh one, so a cached node can be detached: fall back
     * to the marker the anchor renders, never to a cached detached node.
     */
    /**
     * 取当前面板对应的锚点节点：切页时 keyed main 面板会卸载重挂，缓存节点可能已脱离文档，
     * 因此失效时按 data-media-anchor 重新查询存活节点，绝不继续用旧引用（否则 overlay 永久隐藏）。
     * 参数：node 缓存节点、nodeId 缓存节点所属入口 id、panelId 宿主当前激活的 main key。
     */
    function resolveAnchor(node, nodeId, panelId) {
      if (!isEditorPanel(panelId)) return null
      if (node && node.isConnected === true && nodeId === panelId) return node
      if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return null
      try {
        var found = document.querySelector('[data-media-anchor="' + panelId + '"]')
        return found && found.isConnected === true ? found : null
      } catch (_) { return null }
    }
    /**
     * 是否显示常驻编辑器：必须同时满足「宿主激活的 main key 就是本入口」「锚点仍在文档中」
     * 「锚点有实际尺寸」。任一不满足就只隐藏、不卸载，工程与撤销栈因此保留。
     */
    function retainedVisible(panelId, entryId, node, rect) {
      return panelId === entryId && !!node && node.isConnected === true && !!rect && rect.width > 0 && rect.height > 0
    }
    function releaseHiddenFocus(node, visible) {
      if (!visible && node && node.contains(document.activeElement)) document.activeElement?.blur?.()
    }
    function makeNavigationGate(notify) {
      var native = false
      return {
        isNative: function () { return native },
        enterNative: function () { native = true; notify() },
        enterEditor: function () { native = false; notify() }
      }
    }
    function openNativeSession(workspace, sessionId) {
      if (!sessionId || !workspace || typeof workspace.openSession !== 'function') throw new Error('宿主未提供原生会话导航，无法打开审批界面。')
      workspace.openSession(sessionId)
    }
    function approvalText(outcome) {
      if (outcome === 'allowed-once') return '已允许一次，等待 Host 复验工程并登记；尚不能确认绑定成功。'
      if (outcome === 'rejected') return '审批已拒绝（也可能由 never 策略自动拒绝），本次请求未获授权。'
      if (outcome === 'cancelled') return '审批已取消，本次请求未获授权。'
      if (outcome === 'unavailable') return '原生审批不可用或没有可回答的界面，本次请求未获授权。'
      return '审批结果未知，请核对原生会话；不能确认授权。'
    }
    var TOOL_NAMES = { media_image_read_state: '读取工程', media_image_apply_command: '执行编辑', media_image_get_command_result: '查询命令结果', media_image_export_start: '开始导出', media_image_export_status: '查询导出', media_video_read_state: '读取工程', media_video_apply_command: '执行编辑', media_video_get_command_result: '查询命令结果', media_video_export_start: '开始导出', media_video_export_status: '查询导出' }
    var ERROR_TEXT = {
      SESSION_BINDING_REQUIRED: '本会话还没有绑定工程，需要本人在原生会话中授权一次',
      APPROVAL_TIMEOUT: '等待授权超时，本次请求已取消，需要重新发起',
      APPROVAL_REJECTED: '授权被拒绝，本次请求未执行',
      APPROVAL_UNAVAILABLE: '当前没有可用的授权界面，本次请求未执行',
      REVISION_CONFLICT: '工程版本已变化，请重新读取最新状态后再改',
      HISTORY_CONFLICT: '已有后续修改，不能单独撤销这一步',
      HISTORY_EMPTY: '没有可撤销的记录',
      DOCUMENT_MISMATCH: '工程已变化，请重新绑定对话',
      EDITOR_NOT_READY: '编辑器还没准备好，请稍后重试',
      EDITOR_INSTANCE_MISMATCH: '编辑器实例已变化，请重新绑定对话',
      LAYER_NOT_FOUND: '找不到这个图层，可能已被删除',
      INVALID_REQUEST: '参数不符合编辑器要求',
      HUMAN_CONFIRMATION_REQUIRED: '这一步是破坏性操作，需要你单独确认',
    }

    // ---------- 工程授权（panel 通道）----------
    // 事实链：工具都注册了，但编辑器没有"已授权实例"时 gate 回 EDITOR_NOT_READY / APPROVAL_DENIED；
    // 桌面端 approval=never 把原生审批这条路堵死，模型读不到画布就只能靠自己猜。所以面板需要一条
    // **本人点击**的授权通道：Host 签发一次性票据（5 分钟，绑定 会话×工程×实例），gate 校验后写审计。
    // 铁律（契约）：不得静默授权、Agent 不得代点、票据不可重放、解绑同样要本人点。
    //
    // 线协议按契约（docs/project-grant-v1.md §3）：
    //   POST /media-image/bind        {instanceId}                     → {ok, ticket:{ticketId,projectId,expiresAt,ttlMs}}
    //   POST /media-image/bind        {action:'revoke', instanceId}    → {ok, revoked:true}
    //   GET  /media-image/bind-status ?instanceId=…                    → {ok, ticket|null, grant:null|{source,projectId,grantedAt,expiresAt}}
    // 面板只发 instanceId：会话身份由 Host 在工具调用时用真实 exec 补，工程由 Host 从页面实时读。
    // 鉴权：同源 + `authorization: Bearer <pageToken>`；桌面端没有 Origin，还要带 `x-dsh-media-relay: 1`。
    // pageToken 从 /media-image/boot 取（同源页面才拿得到）。
    var AUTH = {
      boot: '/media-image/boot',
      bind: '/media-image/bind',
      status: '/media-image/bind-status',
      bootHeader: 'x-dsh-media-boot',
      relayHeader: 'x-dsh-media-relay',
      ttlMs: 5 * 60 * 1000,
    }
    var AUTH_SOURCES = { native: '原生审批', panel: '面板授权' }
    var pageTokenCache = null

    /** 页面令牌：同源页面才拿得到；缓存到本页面生命周期，401/403 时清空重取。 */
    async function readPageToken(fetchImpl) {
      if (pageTokenCache) return pageTokenCache
      var call = fetchImpl || (typeof fetch === 'function' ? fetch : null)
      if (!call) throw Object.assign(new Error('当前环境没有同源请求能力，无法授权'), { code: 'AUTH_UNAVAILABLE' })
      var headers = {}
      headers[AUTH.bootHeader] = '1'
      var response = await call(AUTH.boot, { credentials: 'same-origin', headers: headers })
      if (!response.ok) throw Object.assign(new Error('无法取得页面令牌（HTTP ' + response.status + '）'), { code: 'AUTH_UNAVAILABLE' })
      var body = await response.json().catch(function () { return null })
      if (!body || typeof body.accessToken !== 'string' || !body.accessToken) throw Object.assign(new Error('页面令牌格式不对'), { code: 'AUTH_UNAVAILABLE' })
      pageTokenCache = body.accessToken
      return pageTokenCache
    }

    /** 带页面令牌的同源请求：GET 不带 body；401/403 视为令牌失效，下次重取。 */
    async function authorizationCall(path, options, fetchImpl) {
      var call = fetchImpl || (typeof fetch === 'function' ? fetch : null)
      if (!call) throw Object.assign(new Error('当前环境没有同源请求能力，无法授权'), { code: 'AUTH_UNAVAILABLE' })
      var token = await readPageToken(fetchImpl)
      var method = (options && options.method) || 'POST'
      var headers = { authorization: 'Bearer ' + token }
      headers[AUTH.relayHeader] = '1'
      var init = { method: method, credentials: 'same-origin', headers: headers }
      if (method !== 'GET') {
        headers['content-type'] = 'application/json'
        init.body = JSON.stringify((options && options.body) || {})
      }
      var response = await call(path, init)
      var body = null
      try { body = await response.json() } catch (_) { body = null }
      if (response.status === 401 || response.status === 403) pageTokenCache = null
      return { response: response, body: body }
    }


    /**
     * 授权四态：未授权 / 待激活 / 已授权 / 已过期。
     * 「待激活」= 票据已签发、但还没被会话消费（票据 ≠ 授权，契约 §3），不能显示成已授权。
     */
    function authorizationState(record, now) {
      var at = Number.isFinite(now) ? now : Date.now()
      if (!record || typeof record !== 'object') return { code: 'unauthorized', label: '未授权' }
      if (record.authorized === true) {
        if (Number.isFinite(record.expiresAt) && record.expiresAt <= at) return { code: 'expired', label: '已过期' }
        return { code: 'authorized', label: '已授权' }
      }
      if (record.pending === true) return { code: 'pending', label: '待激活' }
      if (record.expired === true) return { code: 'expired', label: '已过期' }
      return { code: 'unauthorized', label: '未授权' }
    }
    function shortRef(value) {
      var text = typeof value === 'string' ? value : ''
      return text.length > 10 ? text.slice(0, 8) + '…' : (text || '—')
    }
    function remainingText(ms) {
      var total = Math.max(0, Math.floor(ms / 1000))
      return Math.floor(total / 60) + ':' + (total % 60 < 10 ? '0' : '') + (total % 60)
    }
    function clockText(stamp) {
      var date = new Date(stamp)
      return (date.getHours() < 10 ? '0' : '') + date.getHours() + ':' + (date.getMinutes() < 10 ? '0' : '') + date.getMinutes()
    }
    /** 授权范围与有效期：写清"授了什么、到什么时候、是不是已经激活"；缺的字段标"未提供"。 */
    function authorizationSummary(record, now) {
      var at = Number.isFinite(now) ? now : Date.now()
      var state = authorizationState(record, at)
      if (state.code === 'unauthorized') {
        return '当前会话还没有读写这个工程的授权；此时模型调用会回「未授权」，编辑器不会被改动。'
      }
      // 票据 ≠ 授权：票据要等会话里第一次 read_state 才算激活（契约 §3）。
      if (state.code === 'pending') {
        var left = (record.ticketExpiresAt || 0) - at
        return '已签发票据 ' + shortRef(record.ticketId) + '，等待会话里第一次「读取工程」激活'
          + (Number.isFinite(record.ticketExpiresAt) ? '（' + (left > 0 ? '还剩 ' + remainingText(left) : '已过期') + '）' : '')
          + '；票据一次性，重复使用会被拒。'
      }
      var parts = ['范围：本会话 × 工程 ' + shortRef(record.projectId)]
      if (record.editorInstanceId) parts.push('实例 ' + shortRef(record.editorInstanceId))
      parts.push('来源：' + (AUTH_SOURCES[record.source] || '未提供'))
      if (Number.isFinite(record.expiresAt)) {
        var remain = record.expiresAt - at
        parts.push(remain > 0
          ? '有效期至 ' + clockText(record.expiresAt) + '（还剩 ' + remainingText(remain) + '）'
          : '有效期已于 ' + clockText(record.expiresAt) + ' 结束')
      } else parts.push('有效期：未提供')
      if (record.grantedAt && Number.isFinite(record.grantedAt)) parts.push('授权于 ' + clockText(record.grantedAt))
      return parts.join(' · ')
    }
    /**
     * 面板请求体：**只有 instanceId**（契约 §3）。
     * 面板不知道也不该知道真实会话；sessionId 由 Host 在工具调用时用真实 exec 补上，
     * 让面板指定 sessionId 等于把"自报身份"请回来。工程也由 Host 从页面实时读。
     */
    function authorizationRequest(binding) {
      if (!binding || typeof binding !== 'object') throw Object.assign(new Error('还没有绑定会话，无法授权'), { code: 'AUTH_NO_BINDING' })
      var instanceId = binding.editorInstanceId
      if (typeof instanceId !== 'string' || !instanceId) {
        throw Object.assign(new Error('编辑器实例缺失（页面还没连上编辑器），无法授权'), { code: 'AUTH_NO_BINDING' })
      }
      return { instanceId: instanceId }
    }
    /**
     * bind-status 回执 → 本地记录。
     * grant 存在即已授权；只有 ticket 时是「票据已签发、还没被会话消费」；两者都过期就标 expired。
     * 只取白名单字段：令牌、票据密文都不落到面板状态里。
     */
    function fromBindingStatus(body, binding, now) {
      var at = Number.isFinite(now) ? now : Date.now()
      var grant = body && body.grant
      if (grant && typeof grant === 'object' && (!Number.isFinite(grant.expiresAt) || grant.expiresAt > at)) {
        return {
          authorized: true,
          ...(grant.source === 'native' || grant.source === 'panel' ? { source: grant.source } : {}),
          ...(typeof grant.projectId === 'string' ? { projectId: grant.projectId } : {}),
          ...(Number.isFinite(grant.grantedAt) ? { grantedAt: grant.grantedAt } : {}),
          ...(Number.isFinite(grant.expiresAt) ? { expiresAt: grant.expiresAt } : {}),
          ...(binding && binding.editorInstanceId ? { editorInstanceId: binding.editorInstanceId } : {}),
        }
      }
      var ticket = body && body.ticket
      if (ticket && typeof ticket === 'object' && Number.isFinite(ticket.expiresAt) && ticket.expiresAt > at) {
        return {
          authorized: false, pending: true,
          ...(typeof ticket.ticketId === 'string' ? { ticketId: ticket.ticketId } : {}),
          ...(typeof ticket.projectId === 'string' ? { projectId: ticket.projectId } : {}),
          ticketExpiresAt: ticket.expiresAt,
          ...(binding && binding.editorInstanceId ? { editorInstanceId: binding.editorInstanceId } : {}),
        }
      }
      if (grant || ticket) return { authorized: false, expired: true, ...(grant && Number.isFinite(grant.expiresAt) ? { expiresAt: grant.expiresAt } : {}) }
      return { authorized: false }
    }
    /** 失败原因：优先用 Host 的稳定错误码，其次才是 HTTP 状态；都要说清"没有签发票据"。 */
    function authorizationFailure(body, status) {
      var code = (body && (body.errorCode || body.code)) || ''
      var text = (body && (body.message || body.error)) || ''
      if (code === 'APPROVAL_REJECTED' || code === 'APPROVAL_DENIED') return '授权被拒绝；本次没有签发票据。'
      if (code === 'APPROVAL_UNAVAILABLE' || code === 'SESSION_APPROVAL_UNAVAILABLE') return '当前策略禁用了原生审批；请用面板授权这条通道。'
      if (code === 'BIND_UNAVAILABLE') return '这个 Host 版本没有面板授权能力；请改用原生审批。'
      if (code === 'EDITOR_NOT_READY') return text || '编辑器页面还没连上，先打开编辑器再授权。'
      if (code === 'SCOPE_MISMATCH' || code === 'SESSION_BINDING_STALE') return '授权范围与当前会话/工程/实例不一致，已拒绝；请重新授权。'
      if (status === 401 || status === 403) return '同源校验或页面令牌失败（HTTP ' + status + '）；请刷新页面后重试。'
      if (status === 404) return 'Host 还没有提供面板授权接口（版本较旧）；请改用原生审批。'
      return text || ('授权失败（HTTP ' + status + '），本次没有签发票据。')
    }
    /**
     * 面板授权：**只能由用户点击触发**。签发的是**一次性票据**，不是授权本身——
     * 会话里第一次 read_state 才会把它换成 grant；这里不做自动重试、不做静默降级。
     */
    async function requestAuthorization(binding, fetchImpl) {
      var identity = authorizationRequest(binding)
      var result = await authorizationCall(AUTH.bind, {
        method: 'POST',
        body: { instanceId: identity.instanceId },
      }, fetchImpl)
      if (!result.response.ok || !result.body || result.body.ok === false) {
        throw Object.assign(new Error(authorizationFailure(result.body, result.response.status)), { code: 'AUTH_FAILED' })
      }
      var ticket = result.body.ticket
      if (!ticket || typeof ticket.ticketId !== 'string') {
        throw Object.assign(new Error('Host 没有返回票据，请核对审计记录'), { code: 'AUTH_FAILED' })
      }
      return {
        authorized: false, pending: true, ticketId: ticket.ticketId,
        ...(typeof ticket.projectId === 'string' ? { projectId: ticket.projectId } : {}),
        ...(Number.isFinite(ticket.expiresAt) ? { ticketExpiresAt: ticket.expiresAt } : {}),
        editorInstanceId: identity.instanceId,
      }
    }
    async function releaseAuthorization(binding, fetchImpl) {
      var identity = authorizationRequest(binding)
      var result = await authorizationCall(AUTH.bind, {
        method: 'POST',
        body: { action: 'revoke', instanceId: identity.instanceId },
      }, fetchImpl)
      if (!result.response.ok || (result.body && result.body.ok === false)) {
        throw Object.assign(new Error((result.body && result.body.message) || ('解绑失败（HTTP ' + result.response.status + '）；授权可能仍然有效')), { code: 'AUTH_FAILED' })
      }
      return { authorized: false }
    }
    /** 读一次授权状态：接口缺失（404）就标 unsupported，UI 会提示走原生审批。 */
    async function readAuthorizationStatus(binding, fetchImpl) {
      var identity = authorizationRequest(binding)
      var result = await authorizationCall(AUTH.status + '?instanceId=' + encodeURIComponent(identity.instanceId), { method: 'GET' }, fetchImpl)
      if (result.response.status === 404) return { authorized: false, unsupported: true }
      if (!result.response.ok || !result.body) return { authorized: false }
      return fromBindingStatus(result.body, binding)
    }
    /** 面板授权按钮可用性：三项身份齐全，且当前不是"已授权"（已授权时按钮变成解绑）。 */
    function canRequestAuthorization(binding, record, now) {
      try { authorizationRequest(binding) } catch (_) { return false }
      return authorizationState(record, now).code !== 'authorized'
    }

    /**
     * 把工具回执压成一张可读卡片：工具中文名、状态、修订号、一行说明。
     * 聊天面板只显示这些结构化字段，绝不把 canonical JSON 原样铺给用户。
     */
    /** 从 message.content 的文本块里解析工具输出 JSON（真实事件里状态与凭据都在这层）。 */
    function outputJsonOf(container, depth = 0) {
      if (!container || typeof container !== 'object' || depth > 4) return null;
      const content = container.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (!part) continue;
          if (typeof part === 'string') {
            const parsed = parseJsonText(part);
            if (parsed) return parsed;
          } else if (typeof part.text === 'string') {
            const parsed = parseJsonText(part.text);
            if (parsed) return parsed;
          }
        }
      }
      if (container.message && container.message !== container) return outputJsonOf(container.message, depth + 1);
      return null;
    }
    function parseJsonText(text) {
      if (typeof text !== 'string') return null;
      const trimmed = text.trim();
      if (trimmed.charAt(0) !== '{') return null;
      try { return JSON.parse(trimmed) } catch (_) { return null }
    }

    /**
     * 工具回执卡片。真实事件形状（源码结论，见 docs/session-event-shapes.md）：
     *   tool/call  : {callId, name, arguments(JSON 字符串)}
     *   tool/result: {callId?, message:{toolCallId, isError, content[]}, error?{code}}
     *   工具输出（status/revision/commandId/afterDigest/exportId/artifactRef）在 content 文本 JSON 里。
     * 规则：pending 只由"有 call 无 result"得出；rejected 只由 isError/error 得出；
     * **不许把"解析不到摘要"当成 unknown**——成功但摘要解析不出来时显示 applied + 摘要无法解析。
     */
    function toolCard(data, isCall, fallbackName) {
      if (!data || typeof data !== 'object') return null
      var message = data.message && typeof data.message === 'object' ? data.message : null
      var isError = message ? message.isError === true : false
      var callName = typeof data.name === 'string' ? data.name : (data.call && typeof data.call.name === 'string' ? data.call.name : '')
      var output = message ? outputJsonOf(message) : null
      var baseFacts = toolFacts(data)
      // 事件外壳（result.value 等）优先；只有外壳里没有任何可用字段时，才把 content 文本 JSON 当来源。
      if (!output && !baseFacts.status && !baseFacts.exportId && !baseFacts.artifactRef) output = outputJsonOf(data)
      var facts = output ? toolFacts(output) : baseFacts
      var errorCode = facts.errorCode || (data.error && typeof data.error.code === 'string' ? data.error.code : undefined)
      if (!errorCode && isError) errorCode = 'TOOL_ERROR'
      var rawName = callName || facts.toolName || fallbackName || ''
      var name = TOOL_NAMES[rawName] || rawName || '工具调用'
      var status
      if (isCall) status = 'running'
      else if (isError || errorCode) status = 'rejected'
      else status = facts.status || 'applied'
      var revision = facts.revision
      var line = ''
      if (!isCall) {
        if (errorCode) line = ERROR_TEXT[errorCode] || ('操作没有完成：' + errorCode)
        else if (facts.exportId) line = '导出任务 ' + facts.exportId + (facts.status ? ' · ' + facts.status : '')
        else if (facts.artifactRef) line = '导出文件已就绪'
        else if (revision !== undefined) line = '修订 R' + revision
        else if (status === 'rejected') line = '未执行（编辑器拒绝了这次修改，回执里没有错误码）'
        // 成功但没有结构化摘要（导出/撤销凭据本身就算摘要，不叠加这句话）。
        if (!output && status === 'applied' && !facts.exportId && !facts.artifactRef) line = (line ? line + ' ' : '') + '已执行（摘要无法解析）'
      }
      // 同一回执里出现多个不一致的状态：按外层取值，但必须把"不一致"说出来，不能静默挑一个。
      if (facts.statusConflicts.length) {
        var all = [facts.status].concat(facts.statusConflicts).filter(Boolean).join(' / ')
        line = (line ? line + ' ' : '') + '（回执里有多处状态不一致：' + all + '，已按外层取值）'
      }
      var card = { name: name, status: status, revision: Number.isSafeInteger(revision) ? revision : null, line: line, error: !!errorCode }
      // 摘要解析不出来时，把原始正文留给"复制诊断信息"，不进 DOM。
      if (!isCall && !output) {
        var rawText = message && Array.isArray(message.content)
          ? message.content.map(function (part) { return part && (typeof part === 'string' ? part : part.text) || '' }).join('\n')
          : ''
        if (rawText) card.diagnostic = rawText
      }
      return card
    }
    // ---------- P1 共生交互：高亮请求与建议表 ----------

    /** 高亮请求：只允许计划里的 locate 触发；TTL 200–5000ms（默认 2000）。 */
    function highlightRequest(locate, requestId, ttlMs) {
      if (!locate || !Array.isArray(locate.objectIds) || locate.objectIds.length === 0) return null;
      const ids = locate.objectIds.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 256).slice(0, 200);
      if (!ids.length) return null;
      const ttl = Math.max(200, Math.min(5000, Number.isFinite(ttlMs) ? ttlMs : 2000));
      return { type: 'media.highlight.request', requestId, objectIds: ids, ttlMs: ttl };
    }

    // 建议表：只列白名单里有对应命令、且参数能从"选中一个图层"推出来的动作。
    // 白名单外的动作不显示（不置灰），避免面板变成命令大全。
    var SUGGESTION_TABLE = [
      { label: '隐藏这个图层', build: id => `把图层 ${id} 隐藏起来` },
      { label: '移到画布左上角', build: id => `把图层 ${id} 移到画布左上角（x=0, y=0）` },
      { label: '宽度设为画布一半', build: id => `把图层 ${id} 的宽度设为画布宽度的一半，保持比例` },
      { label: '置顶', build: id => `把图层 ${id} 移到最上层（toIndex=0）` },
    ];

    /** 建议只对"恰好选中一个图层"生效；其他情况返回空表（面板就不显示建议区）。 */
    function suggestionsFor(selectedObjectIds, objectKind) {
      if (objectKind !== 'layer' || !Array.isArray(selectedObjectIds) || selectedObjectIds.length !== 1) return [];
      const id = selectedObjectIds[0];
      if (typeof id !== 'string' || !id) return [];
      return SUGGESTION_TABLE.map(item => ({ label: item.label, prompt: item.build(id) }));
    }


    // ---------- 对话框 v1：纯函数层 ----------
    //
    // 渲染前先把"会话行"压成可读的计划（plan），组件只负责画。这样两点能被测试钉住：
    // ① 任何一行都不会把原始 JSON 铺到界面上；② 审批只给"打开原生会话"，不造假按钮。

    var MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024
    var ATTACHMENT_TYPES = { 'image/png': true, 'image/jpeg': true, 'image/webp': true }

    /** 把一段文本切成行内片段：普通文本、`代码`、![图](url)、[链接](url)、裸链接。 */
    function parseInlineTokens(text) {
      var source = String(text == null ? '' : text)
      var tokens = []
      var pattern = /(`[^`\n]+`)|(!\[[^\]\n]*\]\([^)\s]+\))|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+)/g
      var last = 0, match
      while ((match = pattern.exec(source)) !== null) {
        if (match.index > last) tokens.push({ kind: 'text', text: source.slice(last, match.index) })
        var raw = match[0]
        if (raw.charAt(0) === '`') tokens.push({ kind: 'code', text: raw.slice(1, -1) })
        else if (raw.slice(0, 2) === '![') {
          var image = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(raw)
          tokens.push(image ? { kind: 'image', alt: image[1], href: image[2] } : { kind: 'text', text: raw })
        } else if (raw.charAt(0) === '[') {
          var link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(raw)
          tokens.push(link ? { kind: 'link', text: link[1], href: link[2] } : { kind: 'text', text: raw })
        } else tokens.push({ kind: 'link', text: raw, href: raw })
        last = match.index + raw.length
      }
      if (last < source.length) tokens.push({ kind: 'text', text: source.slice(last) })
      return tokens
    }

    /** 轻量 Markdown 分块：标题、列表、围栏代码、引用、段落。不认识的一律当段落，不吞内容。 */
    function parseMarkdownBlocks(text) {
      var lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n')
      var blocks = [], buffer = []
      function flush() {
        if (!buffer.length) return
        blocks.push({ kind: 'paragraph', text: buffer.join('\n') })
        buffer = []
      }
      for (var index = 0; index < lines.length; index += 1) {
        var line = lines[index]
        if (/^```/.test(line)) {
          flush()
          var lang = line.slice(3).trim()
          var code = []
          index += 1
          while (index < lines.length && !/^```/.test(lines[index])) code.push(lines[index++])
          blocks.push({ kind: 'code', lang: lang, text: code.join('\n') })
          continue
        }
        var heading = /^(#{1,3})\s+(.*)$/.exec(line)
        if (heading) { flush(); blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] }); continue }
        var bullet = /^\s*[-*]\s+(.*)$/.exec(line)
        var ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
        if (bullet || ordered) {
          flush()
          var list = { kind: 'list', ordered: !!ordered, items: [] }
          while (index < lines.length) {
            var next = lines[index]
            var item = /^\s*[-*]\s+(.*)$/.exec(next) || /^\s*\d+[.)]\s+(.*)$/.exec(next)
            if (!item) break
            list.items.push(item[1])
            index += 1
          }
          index -= 1
          blocks.push(list)
          continue
        }
        var quote = /^>\s?(.*)$/.exec(line)
        if (quote) { flush(); blocks.push({ kind: 'quote', text: quote[1] }); continue }
        if (!line.trim()) { flush(); continue }
        buffer.push(line)
      }
      flush()
      return blocks
    }

    /** 附件：只接受 PNG/JPEG/WebP，按 base64 大小校验，超限明确拒绝而不是悄悄丢。 */
    function attachmentFromDataUrl(name, dataUrl) {
      var match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl == null ? '' : dataUrl))
      if (!match) return { ok: false, message: '只能附加 PNG、JPEG 或 WebP 图片' }
      var mediaType = match[1].toLowerCase()
      if (!ATTACHMENT_TYPES[mediaType]) return { ok: false, message: '只支持 PNG、JPEG、WebP 图片（当前是 ' + mediaType + '）' }
      var data = match[2].replace(/\s+/g, '')
      var bytes = Math.floor(data.length * 3 / 4)
      if (bytes > MAX_ATTACHMENT_BYTES) return { ok: false, message: '图片约 ' + Math.round(bytes / 1024 / 1024) + ' MB，超过 4 MB 上限，请先压缩' }
      return { ok: true, name: String(name || '图片'), bytes: bytes, part: { type: 'image', mediaType: mediaType, data: data } }
    }

    /** 输入区发送状态：只有在真正没发出去且值得重试时才允许"重试一次"。 */
    function retryState(failure) {
      if (!failure || !failure.text) return null
      if (failure.unknown) return { retryable: false, reason: '上次结果未知，请先核对会话记录，避免重复发送' }
      return { retryable: true, reason: '' }
    }

    var PLAN_JSON_KEYS = ['{', '["', '\"toolName\"', '\"arguments\"']

    /** 工具卡片四态：宿主回执里的自由文本收敛成四个固定值，unknown 单独一态（不可重放）。 */
    function normalizeToolStatus(status, failed) {
      var value = String(status || '').toLowerCase()
      if (!value) return failed ? 'rejected' : 'pending'
      if (value === 'applied' || value === 'completed' || value === 'ok' || value === 'ready') return 'applied'
      if (value === 'rejected' || value === 'failed' || value === 'error' || value === 'aborted') return 'rejected'
      if (value === 'unknown' || value === 'pending' || value === 'running' || value === 'queued') return value === 'unknown' ? 'unknown' : 'pending'
      return failed ? 'rejected' : 'pending'
    }

    /** 阈值：一段文本里出现以 { 或 [ 开头的长串，就认为它是裸 JSON，不能进 DOM。 */
    function looksLikeRawJson(text) {
      var value = String(text == null ? '' : text)
      if (value.length < 40) return false
      var trimmed = value.trim()
      if (trimmed.charAt(0) !== '{' && trimmed.charAt(0) !== '[') return false
      return /^(?:\{[\s\S]*\}|\[[\s\S]*\])$/.test(trimmed)
    }

    /** 严格判定：能解析成 JSON 结构就算裸 JSON，不看长度。错误行与工具回执用它。 */
    function isJsonStructure(text) {
      var trimmed = String(text == null ? '' : text).trim()
      if (trimmed.charAt(0) !== '{' && trimmed.charAt(0) !== '[') return false
      try { JSON.parse(trimmed); return true } catch (_) { return false }
    }

    /** 错误行/工具回执的最终判定：结构可解析，或长得像整段 JSON，都算裸 JSON。 */
    function isRawPayload(text) {
      return isJsonStructure(text) || looksLikeRawJson(text)
    }

    /** 撤销凭据校验：三项缺一项就整体省略。 */
    function sanitizeUndo(undo) {
      if (!undo || typeof undo !== 'object') return null
      if (typeof undo.commandId !== 'string' || !undo.commandId || undo.commandId.length > 256) return null
      if (!Number.isSafeInteger(undo.appliedRevision) || undo.appliedRevision < 0) return null
      if (typeof undo.afterDigest !== 'string' || !/^fnv1a64-[0-9a-f]{16}$/.test(undo.afterDigest)) return null
      return { commandId: undo.commandId, appliedRevision: undo.appliedRevision, afterDigest: undo.afterDigest }
    }

    /** 导出引用校验：exportId 必须存在，其余按需保留。 */
    function sanitizeExport(ref) {
      if (!ref || typeof ref !== 'object') return null
      if (typeof ref.exportId !== 'string' || !ref.exportId || ref.exportId.length > 256) return null
      var out = { exportId: ref.exportId }
      if (typeof ref.artifactRef === 'string' && ref.artifactRef) out.artifactRef = ref.artifactRef
      if (typeof ref.format === 'string' && /^[a-z]{2,8}$/i.test(ref.format)) out.format = ref.format
      return out
    }

    // 可定位对象：图片侧 layer，视频侧 clip / overlay / track。白名单外的 kind 整体丢弃。
    var LOCATE_KINDS = { layer: true, clip: true, overlay: true, track: true }

    /** 定位目标校验：只有"非空字符串数组 + 白名单 kind"才保留，任何一项非法就整体省略。 */
    function sanitizeLocate(locate) {
      if (!locate || typeof locate !== 'object') return null
      if (!LOCATE_KINDS[locate.kind]) return null
      if (!Array.isArray(locate.objectIds) || locate.objectIds.length === 0) return null
      if (!locate.objectIds.every(function (id) { return typeof id === 'string' && id.length > 0 && id.length <= 256 })) return null
      return { objectIds: locate.objectIds.slice(), kind: locate.kind }
    }

    /**
     * 投影层：回执 meta.changedObjectIds + meta.objectKind → 计划里的 row.locate。
     *
     * 两项缺一不可：后端契约里 objectKind 与 changedObjectIds 同时出现，所以
     * **kind 缺失或越界时整体省略 locate，不按 'layer' 猜**（本文件第三条回归的取舍）。
     * 理由：猜错类型会把描边落在别的对象上；"卡片不可点"是明确、可解释的降级，
     * 和"没有 changedObjectIds 就没有 locate"是同一条规则——定位信息只从回执来，不猜。
     */
    function locateFromFacts(facts) {
      if (!facts) return null
      var ids = facts.changedObjectIds
      if (!Array.isArray(ids) || ids.length === 0) return null
      if (!LOCATE_KINDS[facts.objectKind]) return null
      return { objectIds: ids.slice(), kind: facts.objectKind }
    }

    /**
     * 计划 → 卡片可点属性：只有合法 locate 才挂 role=button 与 data-object-ids。
     * 没有 locate 时连 role 都不挂（不可点、不可聚焦），避免读屏把普通回执卡当按钮。
     */
    function locateAttributes(locate) {
      var target = sanitizeLocate(locate)
      if (!target) return { 'data-object-ids': '', 'data-object-kind': '' }
      return {
        role: 'button', tabIndex: 0, title: '定位到画布对象',
        'data-object-ids': target.objectIds.join(','), 'data-object-kind': target.kind,
      }
    }

    /** 会话行 → 界面计划。零原始 JSON：解析不出来就退回一句话摘要。 */
    function buildDialogPlan(rows) {
      var list = Array.isArray(rows) ? rows : []
      return list.map(function (row) {
        var key = row && row.id ? row.id : 'row-' + Math.random().toString(16).slice(2)
        if (!row || typeof row !== 'object') return { key: key, kind: 'assistant', badge: null, blocks: [{ kind: 'paragraph', text: '' }], actions: [] }
        if (row.role === 'approval') {
          // 审批也只显示四态：允许一次=applied；拒绝/取消=rejected；不可用或结果未知=unknown。
          // 三态之外没有第五种，也不提供任何"代为作答"的入口。
          var approvalBadge = !row.decided ? 'pending'
            : row.outcome === 'allowed-once' ? 'applied'
            : row.outcome === 'rejected' || row.outcome === 'cancelled' ? 'rejected' : 'unknown'
          return {
            key: key, kind: 'approval', badge: approvalBadge, tone: approvalBadge === 'rejected' ? 'error' : approvalBadge === 'pending' ? 'warn' : 'muted',
            title: row.title || (row.decided ? '审批结果' : '等待本人在原生会话确认'),
            blocks: [{ kind: 'paragraph', text: row.text || '审批状态来自原生会话，本面板只显示状态，不代为作答。' }],
            // 审批永远只给"打开原生会话"：没有可提交的按钮，避免伪造授权入口。
            actions: [{ kind: 'open-native', label: '打开原生会话 / 审批' }],
          }
        }
        if (row.role === 'tool') {
          var card = row.card || { name: '工具调用', status: '', revision: null, line: '' }
          var badge = normalizeToolStatus(card.status, !!card.error)
          var actions = []
          // 动作自带凭据：渲染层拿到就能用，不回查原始行。
          var undo = sanitizeUndo(row.undo)
          if (undo) actions.push({ kind: 'fill-undo', label: '填入撤销指令', hint: '仅栈顶可撤；已有后续修改会返回 HISTORY_CONFLICT', prompt: undoPrompt(undo), undo: undo })
          var exported = sanitizeExport(row.exportRef)
          if (exported) actions.push({ kind: 'download-export', label: '在编辑器中另存为文件', export: exported })
          // 裸 JSON 只进诊断（剪贴板），不进卡片正文；普通文本诊断（如"版本冲突"）保留正文。
          var rawLine = card.line && isRawPayload(card.line)
          var diagnostic = card.diagnostic || (rawLine ? card.line : '')
          var locate = sanitizeLocate(row.locate)
          return {
            key: key, kind: 'tool', badge: badge,
            tone: badge === 'rejected' ? 'error' : badge === 'unknown' ? 'warn' : badge === 'applied' ? 'good' : 'muted',
            card: { name: card.name || '工具调用', status: badge, revision: card.revision, line: rawLine ? '' : (card.line || '') },
            issue: row.issue || '', diagnostic: diagnostic, actions: actions,
            // 透传：P1 的 editor.highlight 全靠它；渲染规则是"有 locate 才可点"。
            ...(locate ? { locate: locate } : {}),
          }
        }
        if (row.role === 'error') {
          var errorText = isRawPayload(row.text) ? '操作没有完成（无法解析摘要）' : String(row.text || '操作没有完成')
          return { key: key, kind: 'error', badge: 'rejected', tone: 'error', blocks: [{ kind: 'paragraph', text: errorText }], actions: [] }
        }
        var text = String(row.text == null ? '' : row.text)
        var raw = looksLikeRawJson(text)
        // 兜底：正文里如果还是一段 JSON，就退成一句话摘要，原始内容只留给"复制诊断信息"。
        var blocks = raw
          ? [{ kind: 'paragraph', text: '这一步已执行（无法解析摘要）' }]
          : parseMarkdownBlocks(text)
        return { key: key, kind: row.role === 'user' ? 'user' : 'assistant', badge: null, tone: 'normal', blocks: blocks, diagnostic: raw ? text : '', actions: [] }
      })
    }

    function makeTranscript() {
      var events = new Map(), attempts = new Map()
      function add(event) {
        if (!event || !Number.isSafeInteger(event.seq)) return
        events.set(event.seq, event)
        attempts.forEach(function (a, id) { if (a.commitSeq === event.seq) attempts.delete(id) })
      }
      return function (frame) {
        if (frame.type === 'snapshot') { (frame.records || []).forEach(function (r) { add(r.event) }) }
        if (frame.type === 'event') add(frame.event)
        if (frame.type === 'assistant-stream') {
          var f = frame.frame, a = attempts.get(f.attemptId)
          if (f.type === 'start') { if (!a || f.revision > a.revision) attempts.set(f.attemptId, { revision: f.revision, chunks: new Map() }) }
          else if (a && a.revision === f.revision) {
            if (f.type === 'chunk') a.chunks.set(f.index, f.chunk)
            if (f.type === 'end') {
              if (f.outcome.kind === 'abandoned' || events.has(f.outcome.seq)) attempts.delete(f.attemptId)
              else a.commitSeq = f.outcome.seq
            }
          }
        }
        var rows = []
        // tool/call 行带工具名，tool/result 行只有 toolCallId：按 id 映射回名字，
        // 映射不到就沿用上一条 call 的名字，避免整屏「工具调用」。
        var lastName = null
        var callNames = new Map()
        Array.from(events.values()).sort(function (a,b) { return a.seq-b.seq }).forEach(function (e) {
          var d = e.data || {}, message = d.message || d
          if (e.type === 'user/message' || e.type === 'assistant/message') {
            // User-role also carries runtime and skill context; only human source is chat.
            if (e.type === 'user/message' && d.source?.kind !== 'user') return
            if (e.surfaceOp !== undefined && e.surfaceOp !== 'append') return
            var text = textOfEvent(message)
            if (e.type === 'user/message' && text && text.indexOf('当前编辑工程身份：') === 0) {
              var marker = '\n用户指令：\n'
              var at = text.indexOf(marker)
              if (at >= 0) text = text.slice(at + marker.length)
            }
            if (text) rows.push({ id: 'event-'+e.seq, role: e.type === 'user/message' ? 'user' : 'assistant', text: text })
          } else if (e.type === 'approval/asked') {
            rows.push({ id: 'event-'+e.seq, role: 'approval', text: '等待本人在原生会话确认审批：' + (d.toolName || '') + (d.reason ? '\n' + (typeof d.reason === 'string' ? d.reason : JSON.stringify(d.reason)) : '') })
          } else if (e.type === 'approval/decided') {
            rows.push({ id: 'event-'+e.seq, role: 'approval', decided: true, outcome: d.outcome, text: approvalText(d.outcome) })
          } else if (e.type === 'error' || /\/error$/.test(e.type)) {
            // 会话级错误：只取一句可读文本，原始结构（code/stack）不进界面。
            var failure = d.message || d.error || {}
            var failureText = typeof failure === 'string' ? failure : (failure.message || failure.code || '操作没有完成')
            rows.push({ id: 'event-'+e.seq, role: 'error', text: String(failureText) })
          } else if (e.type === 'tool/call' || e.type === 'tool/result') {
            var isCall = e.type === 'tool/call'
            var callId = d.callId || (d.call && d.call.callId) || (d.message && (d.message.toolCallId || (d.message.source && d.message.source.callId)))
            var fallback = (callId && callNames.get(callId)) || lastName
            var card = toolCard(d, isCall, isCall ? null : fallback)
            if (isCall && card) { if (callId) callNames.set(callId, card.name); lastName = card.name }
            // 可定位对象只从回执 meta 来：changedObjectIds + objectKind 两项齐全才有 locate
            // （卡片才可点）；缺一项就整体省略，不去文本行里猜 id、也不猜类型。
            var factsForLocate = isCall ? null : toolFacts(evidenceData(d))
            rows.push({ id: 'event-'+e.seq, role: 'tool', card: card, issue: isCall ? null : resultIssue(d), exportRef: isCall ? null : exportEvidence(d), undo: !isCall && !resultIssue(d) ? undoEvidence(d) : null, text: '', diagnostic: card && card.diagnostic ? card.diagnostic : null, locate: locateFromFacts(factsForLocate) })
          }
        })
        attempts.forEach(function (a, id) {
          var text = Array.from(a.chunks.entries()).sort(function (x,y) { return x[0]-y[0] }).map(function (p) { return p[1]?.type === 'text-delta' ? p[1].text : '' }).join('')
          if (text) rows.push({ id: 'attempt-'+id, role: 'assistant', text: text })
        })
        return rows.slice(-200)
      }
    }

    // ---------- UI ----------

    function Icon(props) {
      var React = require('react')
      return React.createElement('svg', { viewBox: '0 0 24 24', width: 22, height: 22, fill: 'currentColor', 'aria-hidden': 'true' },
        React.createElement('path', { d: props.d }))
    }

    function makeEntry(entry, getLayout, onSelect) {
      return function SidebarEntry(props) {
        var React = require('react')
        var active = !!(props && props.active)
        var onClick = function () {
          try {
            var layout = getLayout()
            if (layout && typeof layout.selectPanel === 'function') { layout.selectPanel(entry.id); if (onSelect) onSelect(entry.id) }
          } catch (_) { /* host keeps the previous panel */ }
        }
        return React.createElement('button', {
          type: 'button', title: entry.label, 'aria-label': entry.label,
          'aria-pressed': active ? 'true' : 'false', onClick: onClick,
          style: {
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 36, height: 36, margin: '2px 0', padding: 0,
            border: 0, borderRadius: 10, cursor: 'pointer',
            color: active ? '#0071e3' : 'inherit',
            background: active ? 'rgba(0,113,227,.12)' : 'transparent',
            transition: 'background-color 180ms ' + EASE + ', transform 180ms ' + EASE,
          },
        }, React.createElement(Icon, { d: entry.icon }))
      }
    }

    /** Right-hand conversation: real events in, real prompt out. */
    function Conversation(props) {
      var React = require('react')
      var state = React.useState([])
      var messages = state[0]
      var setMessages = state[1]
      var draftState = React.useState('')
      var draft = draftState[0]
      var setDraft = draftState[1]
      var statusState = React.useState('点击绑定专属对话，关联当前工程')
      var status = statusState[0]
      var setStatus = statusState[1]
      var listRef = React.useRef(null)
      var bindingRef = React.useRef(null)
      var stopRef = React.useRef(null)
      var aliveRef = React.useRef(true)
      var sendingRef = React.useRef(false)
      var transcriptRef = React.useRef(null)
      var activeRef = React.useRef(props.active !== false)
      activeRef.current = props.active !== false
      var [ready, setReady] = React.useState(false)
      var [busy, setBusy] = React.useState(false)
      var attachState = React.useState([])
      var attach = attachState[0]
      var setAttach = attachState[1]
      // 失败重试只保留"最后一次没发出去的同一条消息"，重试逐字重发，不换参数。
      var lastFailureRef = React.useRef(null)
      var fileRef = React.useRef(null)
      var choiceState = React.useState(null)
      var choices = choiceState[0]
      var setChoices = choiceState[1]
      var showAllState = React.useState(false)
      var showAll = showAllState[0]
      var setShowAll = showAllState[1]
      // 编辑器选中通知（只读）：只用于渲染建议，不缓存成第二份文档状态。
      var selectionState = React.useState(null)
      var selection = selectionState[0]
      var setSelection = selectionState[1]
      // 附图相关的提示只能留在输入区，不许污染顶部状态行（上一版出现过"没选文件却报 5MB 超限"）。
      var attachNoticeState = React.useState('')
      var attachNotice = attachNoticeState[0]
      var setAttachNotice = attachNoticeState[1]
      // 工程授权：三态显示（未授权/已授权/已过期）；确认卡片与解绑都必须由本人点。
      var authState = React.useState(null)
      var auth = authState[0]
      var setAuth = authState[1]
      var authBusyState = React.useState(false)
      var authBusy = authBusyState[0]
      var setAuthBusy = authBusyState[1]
      var authConfirmState = React.useState(false)
      var authConfirm = authConfirmState[0]
      var setAuthConfirm = authConfirmState[1]
      var authErrorState = React.useState('')
      var authError = authErrorState[0]
      var setAuthError = authErrorState[1]

      /** 绑定/切换会话时把输入区状态清干净：附件、附图提示、失败重试游标。 */
      function resetComposer() {
        setAttach([]); setAttachNotice(''); lastFailureRef.current = null
      }

      /**
       * 绑定会话：sessionId 为空表示新建，否则挂接已有会话。
       * 绑定前先读工程身份；挂接已有会话时若历史里带过别的 projectId，直接拒绝并说明原因。
       */
      async function bindSession(sessionId) {
        if (sendingRef.current) return
        sendingRef.current = true; setBusy(true); setReady(false); setChoices(null)
        if (stopRef.current) { stopRef.current(); stopRef.current = null }
        bindingRef.current = null; transcriptRef.current = null; setMessages([]); resetComposer()
        try {
          var b = await readBinding(props.frameRef.current, props.kind)
          var remote = props.getRemote()
          if (!sessionId) {
            if (!remote?.session?.create) throw new Error('宿主未提供会话创建接口')
            var created = await remote.session.create({})
            if (!created?.ok || !created.value?.sessionId) throw new Error('创建专属会话失败，请检查宿主会话配置')
            sessionId = created.value.sessionId
          }
          if (!aliveRef.current) return
          b.sessionId = sessionId
          bindingRef.current = b
          setAuth(null); setAuthConfirm(false); setAuthError('')
          void refreshAuthorization(b)
          var reduce = makeTranscript()
          transcriptRef.current = reduce
          if (!activeRef.current) { setStatus('会话已绑定，返回编辑器后恢复订阅；工程尚待授权'); return }
          stopRef.current = followSession(remote, sessionId, function (frame) {
            if (!aliveRef.current || bindingRef.current !== b) return
            if (frame.type === 'snapshot' && frame.header.id !== b.sessionId) { setReady(false); setStatus('会话身份不匹配，已停止'); stopRef.current?.(); return }
            if (frame.type === 'snapshot') {
              var other = projectMismatch(frame.records, b.projectId)
              if (other) {
                // 拒绝挂接：会话里留着别的工程，继续用会把指令发到错误的画布上。
                bindingRef.current = null; setReady(false)
                setStatus('这个会话属于另一个工程（projectId ' + String(other).slice(0, 8) + '…），已拒绝绑定；请选择本工程的会话或新建')
                stopRef.current?.(); return
              }
            }
            setMessages(reduce(frame)); setReady(true); setStatus('已连接对话，工程授权以 Host 回读为准 · ' + b.editorKind)
          }, function (error) { if (aliveRef.current) { setReady(false); setStatus('订阅中断：' + error.message) } })
          if (!stopRef.current) throw new Error('宿主未提供消息订阅接口')
          setStatus('正在同步会话…')
        } catch (error) { if (aliveRef.current) setStatus(error.message) }
        finally { sendingRef.current = false; if (aliveRef.current) setBusy(false) }
      }

      /**
       * 绑定入口：先按契约列会话，再逐个读工程标记，**只把与本工程匹配的会话给用户看**。
       * 契约不符时明确报错（不静默退回）；没有匹配项时只保留「新建」。
       */
      async function bind() {
        if (sendingRef.current) return
        sendingRef.current = true; setBusy(true); setReady(false); setShowAll(false)
        if (stopRef.current) { stopRef.current(); stopRef.current = null }
        bindingRef.current = null; transcriptRef.current = null; setMessages([]); resetComposer()
        try {
          var binding = await readBinding(props.frameRef.current, props.kind)
          var remote = props.getRemote()
          var items = await listSessions(remote, 8)
          var usable = items.filter(function (item) { return item.agentAvailable !== false }).slice(0, 8)
          var projectById = {}
          await Promise.all(usable.map(function (item) {
            return peekProjectId(remote, item.sessionId, 800).then(function (projectId) { projectById[item.sessionId] = projectId })
          }))
          if (!aliveRef.current) return
          var grouped = filterSessionsForProject(usable, binding.projectId, projectById)
          setChoices({ matched: grouped.matched, others: grouped.others, projectId: binding.projectId })
          setStatus(grouped.matched.length
            ? '选择一个与本工程匹配的会话，或新建专属会话'
            : '没有与本工程匹配的历史会话，可以新建专属会话')
        } catch (error) {
          if (!aliveRef.current) return
          // 契约不符/接口缺失：说清楚原因，但仍允许新建（不是"静默回退"）。
          setChoices({ matched: [], others: [], error: error.message })
          setStatus(error.message)
        } finally { if (aliveRef.current) setBusy(false); sendingRef.current = false }
      }

      /**
       * 读一次授权状态。接口不存在（Host 版本旧）就标 unsupported 并提示走原生审批——
       * 不把"读不到"伪装成"未授权"，也不假装已授权。
       */
      async function refreshAuthorization(target) {
        var b = target || bindingRef.current
        if (!b) { setAuth(null); return }
        try { authorizationRequest(b) } catch (_) { setAuth(null); return }
        try { setAuth(await readAuthorizationStatus(b)) } catch (_) { setAuth({ authorized: false }) }
      }

      /** 确认卡片点「确认授权」之后才发：这是唯一会签发授权的地方。 */
      async function authorize() {
        var b = bindingRef.current
        if (!b || authBusy) return
        setAuthBusy(true); setAuthError('')
        try {
          setAuth(await requestAuthorization(b))
          setAuthConfirm(false)
          setStatus('已签发票据：在会话里让它读取工程（read_state）即可激活；票据一次性，5 分钟内有效')
        } catch (error) { setAuthError(error.message) }
        finally { if (aliveRef.current) setAuthBusy(false) }
      }

      /** 解绑同样要本人点；失败时明确说"授权可能仍然有效"，不假装已解绑。 */
      async function unbindAuthorization() {
        var b = bindingRef.current
        if (!b || authBusy) return
        setAuthBusy(true); setAuthError('')
        try {
          var released = await releaseAuthorization(b)
          setAuth(released); setAuthConfirm(false)
          setStatus('已解绑：本会话不再能读写这个工程')
        } catch (error) { setAuthError(error.message) }
        finally { if (aliveRef.current) setAuthBusy(false) }
      }

      React.useEffect(function () {
        aliveRef.current = true
        return function () { aliveRef.current = false; bindingRef.current = null; if (stopRef.current) stopRef.current() }
      }, [])

      React.useEffect(function () {
        var cancelled = false
        if (stopRef.current) { stopRef.current(); stopRef.current = null }
        setReady(false)
        var b = bindingRef.current
        if (props.active === false || !b) return
        void readBinding(props.frameRef.current, props.kind).then(function (current) {
          if (cancelled || !aliveRef.current) return
          if (bindingKey(current) !== bindingKey(b)) { setStatus('工程已变化，请重新绑定对话'); return }
          var reduce = transcriptRef.current || makeTranscript()
          transcriptRef.current = reduce
          stopRef.current = followSession(props.getRemote(), b.sessionId, function (frame) {
            if (cancelled || bindingRef.current !== b) return
            setMessages(reduce(frame)); setReady(true); setStatus('已恢复原工程会话')
          }, function (error) { if (!cancelled) {setReady(false);setStatus(error.message)} })
        }).catch(function (error) { if (!cancelled) setStatus(error.message) })
        return function () { cancelled = true; if (stopRef.current) {stopRef.current();stopRef.current=null} }
      }, [props.active])

      React.useEffect(function () {
        if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
      }, [messages.length])

      async function submit(override, snapshotAttachments) {
        var text = typeof override === 'string' ? override : String(draft || '').trim()
        var attachments = Array.isArray(snapshotAttachments) ? snapshotAttachments : attach.map(function (item) { return item.part })
        var b = bindingRef.current
        if (!text || !ready || !b || sendingRef.current) return
        sendingRef.current = true; setBusy(true)
        try {
          var current = await readBinding(props.frameRef.current, props.kind)
          if (bindingKey(current) !== bindingKey(b)) { setReady(false); stopRef.current?.(); throw new Error('工程已变化，请重新绑定对话') }
          var context = '当前编辑工程身份：' + JSON.stringify(b) + '\n首次尚无 Host 授权时，对应 read_state 显式传 bind:true，申请原生审批；等待用户本人在原生会话回答，拒绝/取消/不可用时停止，不修改策略、不重试冒充授权。已授权的后续 read_state 省略 bind。仅操作上述工程；先通过对应 media_' + b.editorKind + '_* 工具读取并核对身份、修订，再执行授权修改。身份不一致时停止。' + '\n用户指令：\n'
          var result = await sendPrompt(props.getRemote(), b.sessionId, context + text, attachments)
          if (!aliveRef.current || bindingRef.current !== b) return
          if (result.ok) {
            setDraft(''); setAttach([]); setAttachNotice(''); lastFailureRef.current = null
            setStatus('消息已受理，等待真实会话反馈')
          } else {
            // 只记"同一条消息"，重试时逐字重发，绝不改参数重发。
            lastFailureRef.current = { text: text, attachments: attachments, unknown: !!result.unknown, message: result.message }
            setStatus(result.message); if (result.unknown) setReady(false)
          }
        } catch (error) { if (aliveRef.current) setStatus(error.message) }
        finally { sendingRef.current = false; if (aliveRef.current) setBusy(false) }
      }

      /** 读取附图：只收 PNG/JPEG/WebP，超限或格式不对都明确报出来，不静默丢。 */
      function pickFiles(event) {
        var files = Array.prototype.slice.call((event.target && event.target.files) || [])
        if (event.target) event.target.value = ''
        if (!files.length) return
        files.forEach(function (file) {
          var reader = new FileReader()
          reader.onload = function () {
            var parsed = attachmentFromDataUrl(file.name, reader.result)
            // 附图相关提示只进输入区，不进顶部状态行。
            if (!parsed.ok) { setAttachNotice('附图未加入：' + parsed.message); return }
            setAttach(function (current) {
              if (current.length >= 3) { setAttachNotice('最多附加 3 张图片'); return current }
              setAttachNotice('')
              return current.concat([{ name: parsed.name, bytes: parsed.bytes, part: parsed.part }])
            })
          }
          reader.onerror = function () { setAttachNotice('读取图片失败：' + (file.name || '未知文件')) }
          reader.readAsDataURL(file)
        })
      }

      // The Host only carries a synthetic artifact ref, so a real file can only be produced by
      // the page that owns the editor. Ask it to export and hand the download back to the user.
      function downloadExport(evidence) {
        var frame = props.frameRef.current
        if (!frame || !frame.contentWindow) { setStatus('编辑器尚未就绪，无法保存导出文件'); return }
        var requestId = crypto.randomUUID()
        function receive(event) {
          if (event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.type !== 'media.export.result' || event.data.requestId !== requestId) return
          finish()
          if (event.data.ok) setStatus('已请求编辑器导出并触发下载；请查看浏览器下载列表。')
          else setStatus('保存失败：' + (event.data.error || '编辑器未返回原因'))
        }
        function finish() { window.removeEventListener('message', receive); clearTimeout(timer) }
        var timer = setTimeout(function () { finish(); setStatus('编辑器未在 20 秒内完成导出，结果未知，请稍后核对下载列表') }, 20000)
        window.addEventListener('message', receive)
        frame.contentWindow.postMessage({ type: 'media.export.download', requestId: requestId, format: evidence.format || 'png' }, location.origin)
      }

      /**
       * 卡片点击 → 只请求描边高亮。2 秒超时；失败如实报错，不改文档、不改选中。
       */
      function requestHighlight(locate) {
        var frame = props.frameRef.current
        if (!frame || !frame.contentWindow) { setStatus('编辑器尚未就绪，无法定位对象'); return }
        var requestId = crypto.randomUUID()
        var message = highlightRequest(locate, requestId, 2000)
        if (!message) { setStatus('这条回执没有可定位的对象'); return }
        function receive(event) {
          if (event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.type !== 'media.highlight.result' || event.data.requestId !== requestId) return
          finish()
          if (!event.data.ok) { setStatus('定位失败：' + (event.data.error?.message || '编辑器未返回原因')); return }
          var matched = event.data.matched || [], missing = event.data.missing || []
          if (!matched.length) { setStatus('画布上找不到这些对象（可能已被删除或替换）'); return }
          setStatus('已在画布上描边 ' + matched.length + ' 个对象' + (missing.length ? '，另有 ' + missing.length + ' 个不存在' : ''))
        }
        function finish() { window.removeEventListener('message', receive); clearTimeout(timer) }
        var timer = setTimeout(function () { finish(); setStatus('定位请求超时（2 秒），未做任何改动') }, 2000)
        window.addEventListener('message', receive)
        frame.contentWindow.postMessage(message, location.origin)
      }


      function onKeyDown(event) {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing && !event.isComposing) { event.preventDefault(); void submit() }
      }

      // ---------- 对话框 v1 渲染 ----------
      // 统一 class + 一份 style，按钮三态与 focus ring 只在一处定义；色值全部来自 visual-spec。
      var DIALOG_CSS = [
        '.dsh-media-btn{font:inherit;font-size:12.5px;border:0;border-radius:999px;padding:8px 14px;background:#f5f5f7;color:#0071e3;cursor:pointer;transition:transform 180ms ' + EASE + ',background-color 180ms ' + EASE + '}',
        '.dsh-media-btn:hover:not(:disabled){background:#ececf0}',
        '.dsh-media-btn:active:not(:disabled){transform:scale(.98)}',
        '.dsh-media-btn:focus-visible{outline:2px solid #0071e3;outline-offset:2px}',
        '.dsh-media-btn:disabled{color:#86868b;cursor:not-allowed;opacity:.7}',
        '.dsh-media-btn-primary{background:#0071e3;color:#ffffff;font-weight:500}',
        '.dsh-media-btn-primary:hover:not(:disabled){background:#0066cc}',
        '.dsh-media-btn-primary:active:not(:disabled){transform:scale(.96)}',
        '.dsh-media-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 6px 4px 10px;border-radius:999px;background:#f5f5f7;color:#1d1d1f;font-size:11px}',
        '.dsh-media-chip-x{border:0;background:transparent;color:#6e6e73;cursor:pointer;border-radius:999px;width:18px;height:18px;line-height:1;padding:0}',
        '.dsh-media-chip-x:focus-visible{outline:2px solid #0071e3;outline-offset:1px}',
        '.dsh-media-skeleton{height:12px;border-radius:6px;background:linear-gradient(90deg,#f0f0f2,#f7f7f8,#f0f0f2);background-size:200% 100%;animation:dsh-media-shimmer 1.2s infinite linear}',
        '@keyframes dsh-media-shimmer{from{background-position:0 0}to{background-position:-200% 0}}',
        '@media(prefers-reduced-motion:reduce){.dsh-media-btn,.dsh-media-chip-x{transition:none}.dsh-media-skeleton{animation:none}}',
      ].join('')
      React.useEffect(function () {
        function receive(event) {
          if (event.origin !== location.origin || event.source !== parent || event.data?.type !== 'media.selection.changed') return
          setSelection({ selectedObjectIds: event.data.selectedObjectIds || [], objectKind: event.data.objectKind || null })
        }
        window.addEventListener('message', receive)
        return function () { window.removeEventListener('message', receive) }
      }, [])

      React.useEffect(function () {
        if (typeof document === 'undefined' || document.getElementById('dsh-media-dialog-style')) return
        var el = document.createElement('style'); el.id = 'dsh-media-dialog-style'; el.textContent = DIALOG_CSS
        document.head.appendChild(el)
      }, [])

      var BADGES = {
        applied: { label: '已执行', color: '#1d7a3c', background: 'rgba(29,122,60,.10)', weight: 600 },
        rejected: { label: '未执行', color: '#ff3b30', background: 'rgba(255,59,48,.10)', weight: 600 },
        // unknown 在协议里"不可重放"，视觉上不能画成失败：用墨色 + 更重的描边，并写明不要重放。
        unknown: { label: '结果未知 · 不要重放', color: '#1d1d1f', background: 'rgba(0,0,0,.06)', weight: 700 },
        pending: { label: '进行中', color: '#6e6e73', background: 'rgba(0,0,0,.05)', weight: 500 },
      }
      var plan = buildDialogPlan(messages)
      var lastFailure = lastFailureRef.current
      var retry = retryState(lastFailure)

      function btn(options) {
        var React = require('react')
        return React.createElement('button', {
          type: 'button', className: 'dsh-media-btn' + (options.variant === 'primary' ? ' dsh-media-btn-primary' : ''),
          disabled: !!options.disabled, title: options.title || '', onClick: options.onClick, style: options.style,
        }, options.label)
      }

      function copyText(text, okMessage) {
        var value = String(text || '')
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            void navigator.clipboard.writeText(value).then(function () { setStatus(okMessage || '诊断信息已复制到剪贴板') },
              function () { setStatus('复制失败：剪贴板不可用') })
            return
          }
          setStatus('复制失败：剪贴板不可用')
        } catch (_) { setStatus('复制失败：剪贴板不可用') }
      }

      function inline(tokens) {
        var React = require('react')
        return tokens.map(function (token, index) {
          if (token.kind === 'code') return React.createElement('code', { key: index, style: { fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', fontSize: '0.92em', background: 'rgba(0,0,0,.06)', borderRadius: 6, padding: '1px 5px' } }, token.text)
          if (token.kind === 'link') return React.createElement('a', {
            key: index, href: token.href, target: '_blank', rel: 'noreferrer noopener', referrerPolicy: 'no-referrer',
            onClick: function (event) {
              if (!/^https?:\/\//i.test(token.href)) { event.preventDefault(); setStatus('只允许打开 http/https 链接'); return }
              if (typeof window.confirm === 'function' && !window.confirm('将打开外部链接：\n' + token.href)) event.preventDefault()
            },
            style: { color: '#0071e3', textDecoration: 'underline' },
          }, token.text)
          if (token.kind === 'image') return React.createElement('img', { key: index, src: token.href, alt: token.alt || '图片', style: { display: 'block', maxWidth: '100%', borderRadius: 10, marginTop: 6 }, loading: 'lazy' })
          return React.createElement('span', { key: index }, token.text)
        })
      }

      function blocks(items) {
        var React = require('react')
        return items.map(function (block, index) {
          if (block.kind === 'code') return React.createElement('pre', { key: index, style: { margin: '6px 0 0', padding: 10, borderRadius: 10, background: '#f5f5f7', overflowX: 'auto', fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', fontSize: 12, lineHeight: 1.5 } }, React.createElement('code', null, block.text))
          if (block.kind === 'heading') return React.createElement('div', { key: index, style: { margin: '6px 0 0', fontWeight: 600, fontSize: block.level === 1 ? 15 : block.level === 2 ? 14 : 13 } }, inline(parseInlineTokens(block.text)))
          if (block.kind === 'list') return React.createElement(block.ordered ? 'ol' : 'ul', { key: index, style: { margin: '6px 0 0', paddingLeft: 18, display: 'grid', gap: 3 } },
            block.items.map(function (item, itemIndex) { return React.createElement('li', { key: itemIndex }, inline(parseInlineTokens(item))) }))
          if (block.kind === 'quote') return React.createElement('blockquote', { key: index, style: { margin: '6px 0 0', paddingLeft: 10, borderLeft: '2px solid rgba(0,0,0,.12)', color: '#6e6e73' } }, inline(parseInlineTokens(block.text)))
          return React.createElement('div', { key: index, style: { margin: index === 0 ? 0 : '6px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, inline(parseInlineTokens(block.text)))
        })
      }

      function badge(kind) {
        var React = require('react')
        var tone = BADGES[kind] || BADGES.pending
        return React.createElement('span', {
          style: { padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: tone.weight, color: tone.color, background: tone.background },
        }, tone.label)
      }

      /** 授权状态胶囊：三态、两套色（accent 蓝 / 灰 + 过期用现有 warn 橙），不新增第四种色。 */
      function authorizationPill() {
        var React = require('react')
        var state = authorizationState(auth, Date.now())
        var tones = {
          authorized: { color: '#0071e3', background: 'rgba(0,113,227,.10)' },
          expired: { color: '#b25000', background: 'rgba(255,149,0,.14)' },
          unauthorized: { color: '#6e6e73', background: '#e8e8ed' },
        }
        var tone = tones[state.code] || tones.unauthorized
        return React.createElement('span', {
          role: 'status', 'data-authorization-state': state.code,
          style: { fontSize: 11, fontWeight: 500, color: tone.color, background: tone.background, borderRadius: 999, padding: '2px 8px' },
        }, state.label)
      }

      function renderActions(item) {
        var React = require('react')
        // 只用计划里的动作数据：不回查原始行（隐式耦合是架构师明确禁止的）。
        return item.actions.map(function (action, index) {
          if (action.kind === 'open-native') {
            var workspace = typeof props.getWorkspace === 'function' ? props.getWorkspace() : null
            var canOpen = !!(workspace && typeof workspace.openSession === 'function')
            return btn({ key: index, label: action.label, disabled: !canOpen, title: canOpen ? '' : '宿主未提供原生会话导航', style: { marginTop: 8 },
              onClick: function () { try { openNativeSession(workspace, bindingRef.current?.sessionId) } catch (error) { setStatus(error.message) } } })
          }
          if (action.kind === 'fill-undo' && action.prompt) {
            return btn({ key: index, label: action.label, title: action.hint, style: { marginTop: 8 },
              onClick: function () { setDraft(action.prompt); setStatus('已填入撤销指令；仅栈顶可撤，已有后续修改会返回 HISTORY_CONFLICT。请确认后再发送。') } })
          }
          if (action.kind === 'download-export' && action.export) {
            return btn({ key: index, label: action.label, style: { marginTop: 8 }, onClick: function () { downloadExport(action.export) } })
          }
          return null
        }).filter(Boolean)
      }

      function renderRow(item) {
        var React = require('react')
        if (item.kind === 'approval') {
          var approvalBadge = item.badge || 'pending'
          return React.createElement('div', { key: item.key, style: { alignSelf: 'stretch', padding: '10px 12px', borderRadius: 14, background: '#ffffff', boxShadow: 'inset 0 0 0 1px rgba(0,0,0,.08)', fontSize: 12.5, lineHeight: 1.5, color: '#1d1d1f' } },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
              React.createElement('strong', { style: { fontWeight: 600 } }, item.title), badge(approvalBadge)),
            blocks(item.blocks), renderActions(item))
        }
        if (item.kind === 'tool') {
          var locate = item.locate || null
          // 规则：有 locate 才可点。不做"按 key 回查原始行"那种隐式耦合。
          var locateProps = locateAttributes(locate)
          if (locate) {
            locateProps.onClick = function () { requestHighlight(locate) }
            locateProps.onKeyDown = function (event) {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              requestHighlight(locate)
            }
          }
          return React.createElement('div', {
            key: item.key, ...locateProps,
            style: { alignSelf: 'stretch', padding: '10px 12px', borderRadius: 14, background: '#ffffff', boxShadow: 'inset 0 0 0 1px rgba(0,0,0,.08)', fontSize: 12.5, lineHeight: 1.5, color: '#1d1d1f', cursor: locate ? 'pointer' : 'default' },
          },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
              React.createElement('strong', { style: { fontWeight: 600 } }, item.card.name), badge(item.badge),
              item.card.revision === null || item.card.revision === undefined ? null : React.createElement('span', { style: { fontSize: 11, color: '#86868b' } }, 'R' + item.card.revision)),
            item.card.line ? React.createElement('div', { style: { marginTop: 4, color: '#6e6e73', wordBreak: 'break-word' } }, item.card.line) : null,
            item.issue ? React.createElement('div', { role: 'status', style: { marginTop: 6, color: '#ff3b30' } }, item.issue) : null,
            item.diagnostic ? btn({ label: '复制诊断信息', style: { marginTop: 8 }, onClick: function () { copyText(item.diagnostic, '已复制这一步的诊断信息') } }) : null,
            renderActions(item))
        }
        if (item.kind === 'error') {
          return React.createElement('div', { key: item.key, role: 'alert', style: { alignSelf: 'stretch', padding: '9px 12px', borderRadius: 12, background: 'rgba(255,59,48,.08)', color: '#ff3b30', fontSize: 12.5, lineHeight: 1.5 } },
            blocks(item.blocks))
        }
        var mine = item.kind === 'user'
        return React.createElement('div', {
          key: item.key,
          style: {
            alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '86%',
            padding: '9px 12px', borderRadius: 14, fontSize: 13, lineHeight: 1.5,
            background: mine ? '#0071e3' : '#f5f5f7', color: mine ? '#ffffff' : '#1d1d1f', wordBreak: 'break-word',
          },
        }, blocks(item.blocks),
        item.diagnostic ? btn({ label: '复制诊断信息', style: { marginTop: 8, background: 'rgba(255,255,255,.16)', color: mine ? '#ffffff' : '#0071e3' },
          onClick: function () { copyText(item.diagnostic, '已复制这条消息的诊断信息') } }) : null)
      }

      function skeletonRows() {
        var React = require('react')
        return React.createElement('div', { 'aria-busy': 'true', 'aria-label': '正在同步会话', style: { display: 'grid', gap: 8 } },
          [72, 92, 60].map(function (width, index) {
            return React.createElement('div', { key: index, className: 'dsh-media-skeleton', style: { width: width + '%', alignSelf: index % 2 ? 'flex-end' : 'flex-start' } })
          }))
      }

      function emptyState() {
        var React = require('react')
        if (!bindingRef.current) {
          return React.createElement('div', { style: { display: 'grid', gap: 8, padding: '10px 12px', borderRadius: 14, background: '#f5f5f7' } },
            React.createElement('strong', { style: { fontSize: 13 } }, '还没有绑定专属对话'),
            React.createElement('span', { style: { fontSize: 12, color: '#6e6e73' } }, '点顶部「绑定专属对话」把当前工程连接到会话；工程首次授权要本人到原生会话确认。'))
        }
        var examples = ['读取当前工程状态，告诉我现在有几个图层', '把画布尺寸改成 1200×800', '把选中的图层隐藏起来']
        return React.createElement('div', { style: { display: 'grid', gap: 8 } },
          React.createElement('span', { style: { fontSize: 12, color: '#86868b' } }, '已连接，还没有消息。可以试试：'),
          examples.map(function (example) {
            return btn({ key: example, label: example, style: { textAlign: 'left', justifySelf: 'start' }, onClick: function () { setDraft(example) } })
          }))
      }

      function composer() {
        var React = require('react')
        var suggestions = suggestionsFor(selection?.selectedObjectIds, selection?.objectKind)
        return React.createElement('div', { style: { padding: 12, boxShadow: 'inset 0 1px 0 rgba(0,0,0,.08)', background: '#ffffff' } },
          suggestions.length ? React.createElement('div', { role: 'group', 'aria-label': '基于当前选中对象的建议', style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 } },
            suggestions.map(function (suggestion) {
              return btn({ key: suggestion.label, label: suggestion.label, style: { background: '#eef4ff' }, title: suggestion.prompt,
                onClick: function () { setDraft(suggestion.prompt) } })
            })) : null,
          attach.length ? React.createElement('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 } },
            attach.map(function (item, index) {
              return React.createElement('span', { key: item.name + index, className: 'dsh-media-chip' },
                item.name + ' · ' + Math.max(1, Math.round(item.bytes / 1024)) + ' KB',
                React.createElement('button', {
                  type: 'button', className: 'dsh-media-chip-x', 'aria-label': '移除附图 ' + item.name,
                  onClick: function () { setAttach(function (current) { return current.filter(function (_, at) { return at !== index }) }) },
                }, '×'))
            })) : null,
          attachNotice ? React.createElement('div', { role: 'status', style: { marginBottom: 8, fontSize: 11.5, color: '#ff3b30' } }, attachNotice) : null,
          React.createElement('textarea', {
            value: draft, disabled: !ready || busy, 'aria-label': '编辑指令', rows: 3,
            placeholder: ready ? '输入指令，Enter 发送，Shift+Enter 换行' : '先绑定专属对话',
            onChange: function (event) { setDraft(event.target.value) }, onKeyDown: onKeyDown,
            style: { width: '100%', boxSizing: 'border-box', resize: 'none', padding: '10px 12px', border: '1px solid transparent', borderRadius: 10, background: '#f5f5f7', font: 'inherit', fontSize: 13, color: '#1d1d1f' },
          }),
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
            React.createElement('input', { ref: fileRef, type: 'file', accept: 'image/png,image/jpeg,image/webp', multiple: true, style: { display: 'none' }, onChange: pickFiles }),
            btn({ label: '附图', disabled: !ready || busy, title: '附加图片（PNG/JPEG/WebP，单张 ≤ 4 MB，最多 3 张）', onClick: function () { if (fileRef.current) fileRef.current.click() } }),
            React.createElement('span', { style: { flex: 1, fontSize: 11, color: '#86868b' } }, busy ? '正在发送…' : 'Enter 发送 · Shift+Enter 换行'),
            retry && retry.retryable ? btn({ label: '重试一次', onClick: function () { var failure = lastFailureRef.current; if (failure) void submit(failure.text, failure.attachments) } }) : null,
            retry && !retry.retryable ? React.createElement('span', { style: { fontSize: 11, color: '#6e6e73' } }, retry.reason) : null,
            btn({ label: busy ? '发送中…' : '发送', variant: 'primary', disabled: !ready || busy, onClick: function () { void submit() } })))
      }

      var authView = authorizationState(auth, Date.now())
      return React.createElement('aside', {
        style: {
          width: props.narrow ? '100%' : (props.width || 340), flex: props.narrow ? '0 0 auto' : '0 0 ' + (props.width || 340) + 'px',
          height: props.narrow ? '42vh' : 'auto', display: 'flex', flexDirection: 'column', minHeight: 0,
          background: '#ffffff', boxShadow: props.narrow ? 'inset 0 1px 0 rgba(0,0,0,.08)' : 'inset 1px 0 0 rgba(0,0,0,.08)',
        },
      },
      React.createElement('div', {
        style: { padding: '14px 16px 10px', fontSize: 12, letterSpacing: '.02em', color: '#6e6e73', boxShadow: 'inset 0 -1px 0 rgba(0,0,0,.08)' },
      }, '对话 · ' + props.label, React.createElement('button', { type: 'button', className: 'dsh-media-btn', disabled: busy, onClick: function () { void bind() }, style: { marginLeft: 12 } }, '绑定专属对话'), React.createElement('div', { style: { marginTop: 4, fontSize: 11, color: status.indexOf('未') === 0 ? '#ff3b30' : '#6e6e73' } }, status),
      choices ? React.createElement('div', { role: 'listbox', 'aria-label': '可挂接的会话', style: { marginTop: 8, display: 'grid', gap: 6, padding: 8, borderRadius: 12, background: '#f5f5f7' } },
        choices.error ? React.createElement('div', { role: 'status', style: { fontSize: 11.5, color: '#ff3b30' } }, choices.error) : null,
        choices.matched.map(function (item) {
          var notes = sessionAnnotations(item)
          return btn({ key: item.sessionId, label: (item.title || '未命名会话') + (notes.length ? ' · ' + notes.join(' · ') : ''), style: { textAlign: 'left', background: '#ffffff' }, onClick: function () { void bindSession(item.sessionId) } })
        }),
        !choices.error && !choices.matched.length ? React.createElement('div', { style: { fontSize: 11.5, color: '#6e6e73' } }, '没有与本工程匹配的历史会话。') : null,
        choices.others.length ? btn({ label: showAll ? '隐藏其他会话' : '显示全部会话（仅供诊断）', onClick: function () { setShowAll(!showAll) } }) : null,
        showAll && choices.others.length ? React.createElement('div', { role: 'note', style: { fontSize: 11, color: '#ff3b30', lineHeight: 1.5 } }, '下面是与本工程无关的会话，仅供诊断；默认不展示，以免暴露本实例其他会话的标题。') : null,
        showAll ? choices.others.map(function (item) {
          var notes = sessionAnnotations(item)
          return btn({ key: 'other-' + item.sessionId, label: (item.title || '未命名会话') + (notes.length ? ' · ' + notes.join(' · ') : ''), style: { textAlign: 'left', background: '#ffffff' }, onClick: function () { void bindSession(item.sessionId) } })
        }) : null,
        btn({ label: '＋ 新建专属会话', variant: 'primary', onClick: function () { void bindSession(null) } })) : null),
      React.createElement('div', {
        style: { padding: '8px 16px', fontSize: 12, color: '#6e6e73' }, role: 'status',
      },
        '工程授权：原生审批可用时优先走它；被策略禁用（如桌面端 approval=never）时用下面的面板授权——只有你本人点击才会签发，Agent 不能代点。切回编辑器会保留工程。',
        React.createElement('button', {
          type: 'button', className: 'dsh-media-btn', disabled: !bindingRef.current || !props.getWorkspace?.(),
          title: bindingRef.current && !props.getWorkspace?.() ? '宿主未提供原生会话导航' : '',
          onClick: function () {
            try { openNativeSession(props.getWorkspace?.(), bindingRef.current?.sessionId) }
            catch (error) { setStatus(error.message) }
          },
          style: { display: 'block', marginTop: 6 },
        }, '打开原生会话 / 审批')),
      // 工程授权卡片：范围（会话×工程×实例）、来源、有效期、三态；确认卡片与解绑都由本人点。
      React.createElement('div', {
        role: 'region', 'aria-label': '工程授权',
        'data-authorization': authView.code,
        style: { margin: '0 16px 10px', padding: '10px 12px', borderRadius: 14, background: '#f5f5f7' },
      },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          React.createElement('strong', { style: { fontSize: 12.5, fontWeight: 600, color: '#1d1d1f' } }, '工程授权'),
          authorizationPill()),
        React.createElement('div', { style: { marginTop: 4, fontSize: 11.5, lineHeight: 1.55, color: '#6e6e73' } },
          authorizationSummary(auth, Date.now())),
        auth && auth.unsupported ? React.createElement('div', { role: 'note', style: { marginTop: 4, fontSize: 11, lineHeight: 1.5, color: '#b25000' } },
          'Host 还没有提供面板授权接口（当前版本较旧），请点上面的「打开原生会话 / 审批」。') : null,
        authError ? React.createElement('div', { role: 'alert', style: { marginTop: 6, fontSize: 11.5, color: '#ff3b30' } }, authError) : null,
        React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
          authView.code === 'authorized' || authView.code === 'pending'
            ? btn({ label: authBusy ? '解绑中…' : (authView.code === 'pending' ? '撤销票据' : '解绑工程授权'), disabled: authBusy, title: '解绑后本会话立即失去读写权限，模型调用会回「未授权」', onClick: function () { void unbindAuthorization() } })
            : authConfirm
              ? [btn({ key: 'confirm', label: authBusy ? '授权中…' : '确认授权（本人点击）', variant: 'primary', disabled: authBusy || !bindingRef.current, onClick: function () { void authorize() } }),
                 btn({ key: 'cancel', label: '取消', disabled: authBusy, onClick: function () { setAuthConfirm(false) } })]
              : btn({ label: authView.code === 'expired' ? '重新授权' : '授权此会话读写本工程', variant: 'primary', disabled: authBusy || !bindingRef.current, title: '只授给当前会话 × 这个工程 × 这个编辑器实例；Agent 不能代点', onClick: function () { setAuthConfirm(true) } }),
          // 会话消费票据后 grant 才出现：面板不轮询（不猜状态），给一个手动刷新入口。
          btn({ label: '刷新授权状态', disabled: authBusy || !bindingRef.current, title: '会话里执行过 read_state 之后点一下，读取最新授权', onClick: function () { void refreshAuthorization() } })),
        authConfirm && authView.code !== 'authorized'
          ? React.createElement('div', { role: 'note', style: { marginTop: 6, fontSize: 11, lineHeight: 1.5, color: '#6e6e73' } },
            '将签发票据：会话 ' + shortRef(bindingRef.current?.sessionId) + ' · 实例 ' + shortRef(bindingRef.current?.editorInstanceId) + '。票据 5 分钟内一次性有效；会话第一次读取工程时激活为授权（页面关闭或换工程即失效）。')
          : null,
        React.createElement('div', { style: { marginTop: 6, fontSize: 10.5, lineHeight: 1.5, color: '#86868b' } },
          '授权只由你本人点击产生；Host 会记下谁、何时、哪个工程、到什么时候。票据不可重放。')),
      React.createElement('div', { ref: listRef, style: { flex: 1, overflow: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 } },
        busy && plan.length === 0 ? skeletonRows() : null,
        !busy && plan.length === 0 ? emptyState() : null,
        plan.map(function (item) { return renderRow(item) })),
      composer())
    }

    /** Page body: editor fills the pane, conversation sits to its right. */
    function makePage(entry, getBoundRemote, getWorkspace) {
      return function EditorPage(props) {
        var React = require('react')
        var frameRef = React.useRef(null)
        var widthState = React.useState(340)
        var width = widthState[0]
        var setWidth = widthState[1]
        var narrowState = React.useState(typeof window !== 'undefined' ? window.innerWidth < 720 : false)
        var narrow = narrowState[0]
        var setNarrow = narrowState[1]
        var draggingRef = React.useRef(null)
        var getRemote = function () {
          if (props && props.remote) return props.remote
          if (props && props.ctx) return pick(props.ctx, 'remote') || { session: pick(props.ctx, 'remote.session') }
          if (props && props.remoteSession) return { session: props.remoteSession }
          return getBoundRemote ? getBoundRemote() : null
        }
        React.useEffect(function () {
          function onResize() { setNarrow(window.innerWidth < 720) }
          window.addEventListener('resize', onResize)
          return function () { window.removeEventListener('resize', onResize) }
        }, [])
        // 分栏只改容器宽度和 iframe 的 CSS 尺寸：iframe 元素本身不换 key、不重建，
        // 否则拖一下就丢工程。
        function startDrag(event) {
          if (narrow) return
          event.preventDefault()
          draggingRef.current = event.clientX
          function move(moveEvent) {
            if (draggingRef.current === null) return
            var delta = draggingRef.current - moveEvent.clientX
            draggingRef.current = moveEvent.clientX
            setWidth(function (current) { return Math.max(280, Math.min(620, current + delta)) })
          }
          function end() {
            draggingRef.current = null
            window.removeEventListener('mousemove', move)
            window.removeEventListener('mouseup', end)
          }
          window.addEventListener('mousemove', move)
          window.addEventListener('mouseup', end)
        }
        return React.createElement('div', {
          style: { display: 'flex', flexDirection: narrow ? 'column' : 'row', height: '100%', minHeight: 0, background: '#f5f5f7' },
        },
          React.createElement('iframe', {
            ref: frameRef, src: entry.src, title: entry.label,
            style: { flex: 1, border: 0, display: 'block', minWidth: 0, minHeight: 0, background: '#f5f5f7' },
          }),
          narrow ? null : React.createElement('div', {
            role: 'separator', 'aria-orientation': 'vertical', 'aria-label': '拖动调整对话宽度', title: '拖动调整对话宽度',
            onMouseDown: startDrag,
            style: { flex: '0 0 6px', cursor: 'col-resize', background: 'transparent', boxShadow: 'inset 1px 0 0 rgba(0,0,0,.08)' },
          }),
          React.createElement(Conversation, {
            label: entry.label, kind: 'image', frameRef: frameRef, getRemote: getRemote, getWorkspace: getWorkspace,
            active: props?.active !== false, width: width, narrow: narrow,
          })
        )
      }
    }

    // ---------- native tool cards (tool.call.toolview) ----------
    //
    // 宿主在原生对话里按工具名分派 tool.call.toolview；命中就替换通用工具行，所以模型看到的
    // canonical JSON 不必进聊天正文。props.block.content 是结果内容片段数组（part.text），
    // 我们只解析其中的摘要/JSON 字段，渲染中文卡片。本机宿主 0.2.x 已声明该槽位。

    /** 工具结果正文：拼接 content 片段里的可读文本。 */
    function blockText(block) {
      if (!block || !Array.isArray(block.content)) return ''
      return block.content.map(function (part) {
        if (typeof part === 'string') return part
        if (part && typeof part.text === 'string') return part.text
        return ''
      }).filter(Boolean).join('\n')
    }

    /** 从结果正文里取出对象：优先整段 JSON，其次首尾花括号之间的 JSON。 */
    function parseBlockJson(text) {
      if (!text) return null
      var trimmed = text.trim()
      try { if (trimmed[0] === '{') return JSON.parse(trimmed) } catch (_) { /* 继续尝试内嵌 JSON */ }
      var start = trimmed.indexOf('{'), end = trimmed.lastIndexOf('}')
      if (start >= 0 && end > start) {
        try { return JSON.parse(trimmed.slice(start, end + 1)) } catch (_) { return null }
      }
      return null
    }

    /** 摘要文本（`applied · cmd-1 · R2 · exportId exp-1`）解析成字段，作为 JSON 缺失时的降级。 */
    function parseSummary(text) {
      if (!text) return {}
      var out = {}
      var status = /(applied|rejected|unknown|pending|failed|completed)/.exec(text)
      if (status) out.status = status[1]
      var revision = /\bR(\d+)\b/.exec(text)
      if (revision) out.revision = Number(revision[1])
      var exportId = /exportId\s+([\w.-]+)/.exec(text)
      if (exportId) out.exportId = exportId[1]
      var artifact = /artifactRef\s+(\S+)/.exec(text)
      if (artifact) out.artifactRef = artifact[1]
      var command = /\b(cmd-[\w.-]+)/.exec(text)
      if (command) out.commandId = command[1]
      return out
    }

    function toolViewCard(toolName, props) {
      var text = blockText(props && props.block)
      var data = parseBlockJson(text) || {}
      var summary = parseSummary(text)
      var payload = data.result || data.value || data
      var status = data.status || payload.status || summary.status || (props && props.block && props.block.kind ? 'completed' : 'pending')
      var revision = payload.revision ?? data.revision ?? summary.revision
      var errorCode = (payload.error && payload.error.code) || (data.error && data.error.code) || summary.errorCode
      var lines = []
      if (errorCode) lines.push(ERROR_TEXT[errorCode] || ('没有完成：' + errorCode))
      if (data.exportId || payload.exportId || summary.exportId) lines.push('导出任务 ' + (data.exportId || payload.exportId || summary.exportId))
      if (data.artifactRef || payload.artifactRef || summary.artifactRef) lines.push('文件引用 ' + (data.artifactRef || payload.artifactRef || summary.artifactRef))
      if (payload.layersCount !== undefined) lines.push(payload.layersCount + ' 个图层')
      if (payload.operation) lines.push('操作 ' + payload.operation)
      if (payload.documentId) lines.push('工程 ' + String(payload.documentId).slice(0, 8))
      if (payload.trackId) lines.push('轨道 ' + String(payload.trackId).slice(0, 8))
      if (!lines.length && text) lines.push(text.split('\n')[0].slice(0, 120))
      if (!lines.length) lines.push('已完成')
      return {
        title: TOOL_NAMES[toolName] || toolName,
        status: String(status || 'unknown'),
        revision: Number.isSafeInteger(revision) ? revision : null,
        lines: lines,
        failed: !!errorCode,
      }
    }

    /** 原生对话里的工具卡片：工具名 + 状态 + 修订号 + 关键字段，不显示原始 JSON。 */
    function makeToolView(toolName) {
      return function MediaToolView(props) {
        var React = require('react')
        var card = toolViewCard(toolName, props)
        var tone = card.failed ? '#ff3b30' : card.status === 'applied' ? '#1d7a3c' : '#6e6e73'
        return React.createElement('div', {
          style: { padding: '10px 12px', borderRadius: 14, background: '#ffffff', fontSize: 12.5, lineHeight: 1.5,
            boxShadow: 'inset 0 0 0 1px rgba(0,0,0,.08)', color: '#1d1d1f', maxWidth: 520 },
        },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            React.createElement('strong', { style: { fontWeight: 600 } }, card.title),
            React.createElement('span', { style: { fontSize: 11, color: tone } }, card.status),
            card.revision === null ? null : React.createElement('span', { style: { fontSize: 11, color: '#86868b' } }, 'R' + card.revision)),
          card.lines.map(function (line, index) {
            return React.createElement('div', { key: index, style: { marginTop: 4, color: '#6e6e73', wordBreak: 'break-word' } }, line)
          }))
      }
    }

    // 每个包只注册自己 5 个工具；split-packages.mjs 会按包名重写这个数组。
    var TOOL_VIEW_KEYS = ['media_image_read_state', 'media_image_apply_command', 'media_image_get_command_result', 'media_image_export_start', 'media_image_export_status']

    // ---------- wiring ----------

    function install(ctx) {
      var slots = pick(ctx, 'slots')
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return false
      var getLayout = function () { return pick(ctx, 'layout') }
      var disposers = []
      // main keyed occupants unmount on navigation. Keep the actual editor React tree
      // in the root-scoped additive overlay and only measure the current main anchor.
      var anchor = null, anchorId = null, listeners = new Set()
      function notify() { listeners.forEach(function (fn) { fn() }) }
      var navigation = makeNavigationGate(notify)
      function nativeWorkspace() {
        var workspace = pick(ctx, 'uiWorkspace')
        if (!workspace || typeof workspace.openSession !== 'function') return null
        return { openSession: function (id) {
          navigation.enterNative()
          workspace.openSession(id)
          // Explicitly reveal conversation through the public layout action as well.
          getLayout().selectPanel(null)
        } }
      }
      function anchorPage(entry) {
        return function EditorAnchor() {
          var React = require('react')
          var ref = React.useRef(null)
          React.useLayoutEffect(function () {
            var node = ref.current
            anchor = node; anchorId = entry.id; notify()
            return function () { if (anchor === node) { anchor = null; anchorId = null; notify() } }
          }, [])
          return React.createElement('div', { ref: ref, 'data-media-anchor': entry.id, style: { height: '100%', minHeight: 0, width: '100%' } })
        }
      }
      var pages = ENTRIES.map(function (entry) { return makePage(entry, function () { return pick(ctx, 'remote') || { session: pick(ctx, 'remote.session') } }, nativeWorkspace) })
      function RetainedLayer(props) {
        var React = require('react'), ref = React.useRef(null)
        React.useLayoutEffect(function () { releaseHiddenFocus(ref.current, props.visible) }, [props.visible])
        var rect = props.rect
        return React.createElement('div', { ref:ref, 'data-media-retained':props.entry.id, 'aria-hidden':!props.visible, inert:!props.visible ? '' : undefined,
          style:{ position:'fixed', left:rect?.left || 0, top:rect?.top || 0, width:rect?.width || 1, height:rect?.height || 1, visibility:props.visible?'visible':'hidden', pointerEvents:props.visible?'auto':'none', overflow:'hidden' } }, React.createElement(props.page, {active:props.visible}))
      }
      function RetainedEditors() {
        var React = require('react')
        var panelState = React.useState(null)
        React.useLayoutEffect(function () { return watchPanel(getLayout(), panelState[1]) }, [])
        var panelId = panelState[0]
        var node = resolveAnchor(anchor, anchorId, panelId)
        var tick = React.useState(0), rectState = React.useState(null), visited = React.useRef(new Set())
        React.useLayoutEffect(function () { var fn = function () { tick[1](function (n) { return n+1 }) }; listeners.add(fn); fn(); return function () { listeners.delete(fn) } }, [])
        // The host panel wins: returning to an editor clears the native-navigation gate even
        // if the openSession click never reported back, so a stale gate cannot blank the pane.
        React.useLayoutEffect(function () {
          if (isEditorPanel(panelId) && navigation.isNative()) navigation.enterEditor()
        }, [panelId])
        React.useLayoutEffect(function () {
          if (!node) { rectState[1](null); return }
          var current = node, cancelled = false
          function measure() { if (cancelled || !current.isConnected) return; rectState[1](measureRect(current)) }
          measure()
          var observer = new ResizeObserver(measure); observer.observe(current)
          window.addEventListener('resize', measure)
          // A fresh anchor is laid out after our render, so re-measure on the next frames.
          var raf = requestAnimationFrame(measure)
          var timers = [setTimeout(measure, 50), setTimeout(measure, 250)]
          return function () {
            cancelled = true; cancelAnimationFrame(raf); timers.forEach(clearTimeout)
            observer.disconnect(); window.removeEventListener('resize', measure)
          }
        }, [node, panelId])
        if (isEditorPanel(panelId)) visited.current.add(panelId)
        var rect = rectState[0] || measureRect(node)
        return React.createElement(React.Fragment, null, ENTRIES.map(function (entry, index) {
          if (!visited.current.has(entry.id)) return null
          var visible = !navigation.isNative() && retainedVisible(panelId, entry.id, node, rect)
          return React.createElement(RetainedLayer, {key:entry.id, entry:entry, page:pages[index], visible:visible, rect:rect})
        }))
      }
      // One overlay entry per client package: `shell.overlay` is a root list slot that
      // rejects duplicate ids, and a throw here must not abort the sidebar registration
      // below (a failed overlay would otherwise show up as a silently missing entry).
      var offRetained = null
      try {
        offRetained = slots.inject('shell.overlay', function () { return slots.register({ name:'shell.overlay', id: RETAINED_OVERLAY_ID, order:0 }, RetainedEditors) })
      } catch (error) {
        if (typeof console !== 'undefined' && console.warn) console.warn('[media-studio] 常驻编辑器 overlay 注册失败：', RETAINED_OVERLAY_ID, String(error))
      }
      if (typeof offRetained === 'function') disposers.push(offRetained)
      // 原生对话里的工具卡片：注册失败不能连带杀掉侧栏入口，同样单独 try/catch。
      TOOL_VIEW_KEYS.forEach(function (toolName) {
        try {
          var offView = slots.inject('tool.call.toolview', function () {
            return slots.register({ name: 'tool.call.toolview', key: toolName }, makeToolView(toolName))
          })
          if (typeof offView === 'function') disposers.push(offView)
        } catch (error) {
          if (typeof console !== 'undefined' && console.warn) console.warn('[media-studio] 工具卡片注册失败：', toolName, String(error))
        }
      })
      // forEach, not a `for (var i ...)`: `slots.inject` runs its factory later, so a
      // function-scoped `entry` would leave both registrations pointing at the last entry.
      ENTRIES.forEach(function (entry, index) {
        try {
          var offList = slots.inject(PANEL_LIST, function () {
            return slots.register({ name: PANEL_LIST, id: entry.id, order: ORDER + index, label: entry.label }, makeEntry(entry, getLayout, navigation.enterEditor))
          })
          if (typeof offList === 'function') disposers.push(offList)
          var offMain = slots.inject(MAIN, function () {
            return slots.register({ name: MAIN, id: entry.id, key: entry.id, order: ORDER + index, inject: function () { return { remote: pick(ctx, 'remote'), remoteSession: pick(ctx, 'remote.session') } } }, anchorPage(entry))
          })
          if (typeof offMain === 'function') disposers.push(offMain)
        } catch (error) {
          if (typeof console !== 'undefined' && console.warn) console.warn('[media-studio] 侧栏入口注册失败：', entry.id, String(error))
        }
      })
      return disposers.length > 0
    }

    function apply(ctx) {
      if (!ctx || typeof ctx.inject !== 'function') { install(ctx); return }
      try { ctx.inject(['slots', 'layout', 'remote', 'remote.session', 'uiWorkspace'], function (scoped) { install(scoped || ctx) }) }
      catch (_) { install(ctx) }
    }

    exports.name = 'dsh-media-image'
    exports.inject = ['slots', 'layout', 'remote', 'remote.session', 'uiWorkspace']
    exports.apply = apply
    exports.entries = ENTRIES
    exports.toolViewKeys = TOOL_VIEW_KEYS.slice()
    // Exposed for the contract tests; the host only consumes name/inject/apply.
    exports.chat = { undoPrompt: undoPrompt, resultIssue: resultIssue, exportEvidence: exportEvidence, toolCard: toolCard, watchPanel: watchPanel, retainedVisible: retainedVisible, retainedOverlayId: RETAINED_OVERLAY_ID, measureRect: measureRect, resolveAnchor: resolveAnchor, isEditorPanel: isEditorPanel, releaseHiddenFocus: releaseHiddenFocus, makePage: makePage, openNativeSession: openNativeSession, approvalText: approvalText, makeTranscript: makeTranscript, bindingKey: bindingKey, sendPrompt: sendPrompt, textOfEvent: textOfEvent, followSession: followSession, promptBody: promptBody,
      // 对话框 v1 纯函数层：消息映射、Markdown、附件、重试判定、定位透传、动作凭据。
      buildDialogPlan: buildDialogPlan, parseMarkdownBlocks: parseMarkdownBlocks, parseInlineTokens: parseInlineTokens, attachmentFromDataUrl: attachmentFromDataUrl, retryState: retryState, normalizeToolStatus: normalizeToolStatus, looksLikeRawJson: looksLikeRawJson, isJsonStructure: isJsonStructure, isRawPayload: isRawPayload, sanitizeLocate: sanitizeLocate, sanitizeUndo: sanitizeUndo, sanitizeExport: sanitizeExport,
      // 静态夹具复用同一套渲染组件（docs/fixtures/dialog-fixture.html）。
      Conversation: Conversation,
      // 会话挂接：严格契约解析、工程标记提取、隐私过滤（纯函数，便于测试）。
      sessionListItems: normalizeSessionItems, normalizeSessionItems: normalizeSessionItems, listSessions: listSessions,
      sessionAnnotations: sessionAnnotations, filterSessionsForProject: filterSessionsForProject, peekProjectId: peekProjectId,
      // P1 共生：高亮请求与静态建议表（纯函数，便于测试）。
      highlightRequest: highlightRequest, suggestionsFor: suggestionsFor, suggestionTable: SUGGESTION_TABLE.slice(),
      // 定位：投影层映射（meta → row.locate）与计划 → DOM 属性。
      locateFromFacts: locateFromFacts, locateAttributes: locateAttributes,
      // 工程授权：三态、范围/有效期文案、bind-status 解析、面板签发与解绑（纯函数可单独测）。
      authorizationState: authorizationState, authorizationSummary: authorizationSummary,
      authorizationRequest: authorizationRequest, fromBindingStatus: fromBindingStatus,
      readAuthorizationStatus: readAuthorizationStatus,
      requestAuthorization: requestAuthorization, releaseAuthorization: releaseAuthorization,
      canRequestAuthorization: canRequestAuthorization, AUTH: AUTH,
      projectIdFromRecords: projectIdFromRecords, projectMismatch: projectMismatch }
    return module.exports
  },
})
