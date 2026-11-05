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

    function promptBody(sessionId, text) {
      return {
        requestId: 'media-studio-' + Date.now() + '-' + Math.random().toString(16).slice(2),
        sessionId: sessionId, mode: 'queue', content: [{ type: 'text', text: text }],
      }
    }

    /** Send one message. Never reports success it did not observe. */
    async function sendPrompt(remote, sessionId, text) {
      var session = remote && remote.session
      if (!session || typeof session.prompt !== 'function') return { ok: false, message: '宿主未提供 session.prompt，无法发送消息。' }
      try {
        var value = await session.prompt(promptBody(sessionId, text))
        if (value && value.ok === false) return { ok: false, message: '发送被宿主拒绝：' + JSON.stringify(value.error) }
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

    /** Subscribe to a session stream; returns a disposer, or null when unsupported. */
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
    function undoEvidence(value, depth) {
      if (!value || typeof value !== 'object' || depth > 6) return null
      if (typeof value.commandId === 'string' && Number.isSafeInteger(value.revision) && typeof value.afterDigest === 'string') return { commandId: value.commandId, appliedRevision: value.revision, afterDigest: value.afterDigest }
      for (var key of ['result', 'value', 'originalResult', 'output', 'data']) {
        var found = undoEvidence(value[key], depth + 1)
        if (found) return found
      }
      return null
    }
    function resultIssue(value, depth) {
      if (!value || typeof value !== 'object' || depth > 6) return null
      if (value.code === 'HISTORY_CONFLICT') return '已有后续人工或 AI 修改，不能单独撤销这一步。请回读当前历史；不要重试旧命令。'
      for (var key of ['error', 'result', 'value', 'originalResult', 'output', 'data']) {
        var found = resultIssue(value[key], depth + 1)
        if (found) return found
      }
      return null
    }
    function undoPrompt(kind, evidence) {
      var operation = kind === 'video' ? 'media.video.history.undo' : 'history.undo'
      return '请撤销这一条修改。先 read_state 核对 history.lastCommandId=' + evidence.commandId + '、history.appliedRevision=' + evidence.appliedRevision + '、history.afterDigest=' + evidence.afterDigest + ' 与当前 revision/stateDigest 一致且仍在栈顶；不一致或 HISTORY_CONFLICT 就停止并说明已有后续修改，不重试旧命令。确认后使用 operation="' + operation + '", params=' + JSON.stringify({ targetCommandId: evidence.commandId, afterDigest: evidence.afterDigest }) + '，携带最新 expectedRevision，执行后回读。'
    }
    function watchPanel(layout, onChange) {
      var store = layout && layout.panelInfo
      if (!store || typeof store.subscribe !== 'function' || typeof store.getSnapshot !== 'function') { onChange(null); return function () {} }
      function sync() { onChange(store.getSnapshot().activePanelId) }
      var off = store.subscribe(sync)
      sync()
      return off
    }
    var EDITOR_IDS = ['media-image-editor', 'media-video-editor']
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
    function resolveAnchor(node, nodeId, panelId) {
      if (!isEditorPanel(panelId)) return null
      if (node && node.isConnected === true && nodeId === panelId) return node
      if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return null
      try {
        var found = document.querySelector('[data-media-anchor="' + panelId + '"]')
        return found && found.isConnected === true ? found : null
      } catch (_) { return null }
    }
    /** Visible only when the host says this panel is active and its anchor is laid out. */
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
            rows.push({ id: 'event-'+e.seq, role: 'approval', text: approvalText(d.outcome) })
          } else if (e.type === 'tool/call' || e.type === 'tool/result') {
            rows.push({ id: 'event-'+e.seq, role: 'tool', issue: e.type === 'tool/result' ? resultIssue(d, 0) : null, undo: e.type === 'tool/result' && !resultIssue(d, 0) ? undoEvidence(d, 0) : null, text: (e.type === 'tool/call' ? '调用工具：' : '工具返回：') + JSON.stringify(d).slice(0, 3000) })
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
      async function bind() {
        if (sendingRef.current) return
        sendingRef.current = true; setBusy(true); setReady(false)
        if (stopRef.current) stopRef.current()
        bindingRef.current = null; transcriptRef.current = null; setMessages([])
        try {
          var b = await readBinding(props.frameRef.current, props.kind)
          var remote = props.getRemote()
          if (!remote?.session?.create) throw new Error('宿主未提供会话创建接口')
          var result = await remote.session.create({})
          if (!result?.ok || !result.value?.sessionId) throw new Error('创建专属会话失败，请检查宿主会话配置')
          if (!aliveRef.current) return
          b.sessionId = result.value.sessionId
          bindingRef.current = b
          var reduce = makeTranscript()
          transcriptRef.current = reduce
          if (!activeRef.current) { setStatus('专属对话已创建，返回编辑器后恢复订阅；工程尚待授权'); return }
          stopRef.current = followSession(remote, b.sessionId, function (frame) {
            if (!aliveRef.current || bindingRef.current !== b) return
            if (frame.type === 'snapshot' && frame.header.id !== b.sessionId) { setReady(false); setStatus('会话身份不匹配，已停止'); stopRef.current?.(); return }
            setMessages(reduce(frame)); setReady(true); setStatus('已连接对话，工程授权以 Host 回读为准 · ' + b.editorKind)
          }, function (error) { if (aliveRef.current) { setReady(false); setStatus('订阅中断：' + error.message) } })
          if (!stopRef.current) throw new Error('宿主未提供消息订阅接口')
          setStatus('正在同步专属会话…')
        } catch (error) { if (aliveRef.current) setStatus(error.message) }
        finally { sendingRef.current = false; if (aliveRef.current) setBusy(false) }
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

      async function submit(override) {
        var text = typeof override === 'string' ? override : String(draft || '').trim(), b = bindingRef.current
        if (!text || !ready || !b || sendingRef.current) return
        sendingRef.current = true; setBusy(true)
        try {
          var current = await readBinding(props.frameRef.current, props.kind)
          if (bindingKey(current) !== bindingKey(b)) { setReady(false); stopRef.current?.(); throw new Error('工程已变化，请重新绑定对话') }
          var videoContract = b.editorKind === 'video' ? '\n视频操作契约：operation="media.video.overlay.add" 时 params={kind:"text",text:用户指定文字,startUs:非负整数,durationUs:正整数}；时间单位微秒，1秒=1000000微秒。图片叠加用 kind:"image",sourceRef，仍须 startUs/durationUs。禁止 startTime/duration 参数。只用对应 media_video_* 工具，先 read_state，再使用读回的 revision/digest 与绑定身份提交，成功后再次 read_state。' : ''
          var context = '当前编辑工程身份：' + JSON.stringify(b) + '\n首次尚无 Host 授权时，对应 read_state 显式传 bind:true，申请原生审批；等待用户本人在原生会话回答，拒绝/取消/不可用时停止，不修改策略、不重试冒充授权。已授权的后续 read_state 省略 bind。仅操作上述工程；先通过对应 media_' + b.editorKind + '_* 工具读取并核对身份、修订，再执行授权修改。身份不一致时停止。' + videoContract + '\n用户指令：\n'
          var result = await sendPrompt(props.getRemote(), b.sessionId, context + text)
          if (!aliveRef.current || bindingRef.current !== b) return
          if (result.ok) { setDraft(''); setStatus('消息已受理，等待真实会话反馈') }
          else { setStatus(result.message); if (result.unknown) setReady(false) }
        } catch (error) { if (aliveRef.current) setStatus(error.message) }
        finally { sendingRef.current = false; if (aliveRef.current) setBusy(false) }
      }

      function onKeyDown(event) {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing && !event.isComposing) { event.preventDefault(); void submit() }
      }

      return React.createElement('aside', {
        style: {
          width: 340, flex: '0 0 340px', display: 'flex', flexDirection: 'column',
          background: '#ffffff', boxShadow: 'inset 1px 0 0 rgba(0,0,0,.08)', minHeight: 0,
        },
      },
      React.createElement('div', {
        style: { padding: '14px 16px 10px', fontSize: 12, letterSpacing: '.02em', color: '#6e6e73', boxShadow: 'inset 0 -1px 0 rgba(0,0,0,.08)' },
      }, '对话 · ' + props.label, React.createElement('button', { type: 'button', disabled: busy, onClick: function () { void bind() }, style: { marginLeft: 12, border: 0, borderRadius: 12, padding: '8px 12px', background: '#f5f5f7', color: '#0071e3', cursor: 'pointer' } }, '绑定专属对话'), React.createElement('div', { style: { marginTop: 4, fontSize: 11, color: status.indexOf('未') === 0 ? '#ff3b30' : '#6e6e73' } }, status)),
      React.createElement('div', { style: { padding: '8px 16px', fontSize: 12, color: '#6e6e73' }, role: 'status' },
        '工程首次授权须本人在原生会话确认。切回编辑器会保留工程；策略禁止时保持未授权。',
        React.createElement('button', { type: 'button', disabled: !bindingRef.current, onClick: function () {
          try { openNativeSession(props.getWorkspace?.(), bindingRef.current?.sessionId) }
          catch (error) { setStatus(error.message) }
        }, style: { display: 'block', marginTop: 6, border: 0, borderRadius: 12, padding: '8px 12px', background: '#f5f5f7', color: '#0071e3', cursor: 'pointer' } }, '打开原生会话 / 审批')),
      React.createElement('div', { ref: listRef, style: { flex: 1, overflow: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 } },
        messages.length === 0
          ? React.createElement('p', { style: { margin: 0, fontSize: 13, color: '#86868b' } }, '还没有消息。输入指令后由真实会话处理。')
          : messages.map(function (message, index) {
            var mine = message.role === 'user'
            var bad = message.role === 'error'
            return React.createElement('div', {
              key: message.id,
              style: {
                alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '86%',
                padding: '9px 12px', borderRadius: 14, fontSize: 13, lineHeight: 1.5,
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                background: mine ? '#0071e3' : bad ? '#ffeceb' : '#f5f5f7',
                color: mine ? '#ffffff' : bad ? '#ff3b30' : '#1d1d1f',
              },
            }, message.text,
            message.issue ? React.createElement('div', { role: 'status', style: { marginTop: 8, fontWeight: 500 } }, message.issue) : null,
            message.undo ? React.createElement('div', { style: { marginTop: 8, fontSize: 11 } }, '命令：' + message.undo.commandId + '\n修订：' + message.undo.appliedRevision + '\n摘要：' + message.undo.afterDigest) : null,
            message.undo ? React.createElement('button', {
              type: 'button', disabled: true, title: '定向撤销尚待真实页面验收，暂不可用',
              onClick: function () { void submit(undoPrompt(props.kind, message.undo)) },
              style: { display: 'block', marginTop: 8, border: 0, borderRadius: 12, padding: '8px 12px', background: '#ffffff', color: '#0071e3', cursor: 'pointer' },
            }, '撤销这一步') : null)
          })),
      React.createElement('div', { style: { padding: 12, boxShadow: 'inset 0 1px 0 rgba(0,0,0,.08)' } },
        React.createElement('textarea', {
          value: draft, disabled: !ready || busy, 'aria-label': '编辑指令',
          rows: 3,
          placeholder: '输入指令，Enter 发送，Shift+Enter 换行',
          onChange: function (event) { setDraft(event.target.value) },
          onKeyDown: onKeyDown,
          style: {
            width: '100%', boxSizing: 'border-box', resize: 'none', padding: '10px 12px',
            border: '1px solid transparent', borderRadius: 10, background: '#f5f5f7',
            font: 'inherit', fontSize: 13, color: '#1d1d1f',
          },
        }),
        React.createElement('button', {
          type: 'button',
          disabled: !ready || busy, onClick: function () { void submit() },
          style: {
            marginTop: 8, width: '100%', padding: '10px 14px', border: 0, borderRadius: 999,
            background: '#0071e3', color: '#ffffff', font: 'inherit', fontWeight: 500, cursor: 'pointer',
            transition: 'background-color 180ms ' + EASE,
          },
        }, '发送'))
      )
    }

    /** Page body: editor fills the pane, conversation sits to its right. */
    function makePage(entry, getBoundRemote, getWorkspace) {
      return function EditorPage(props) {
        var React = require('react')
        var frameRef = React.useRef(null)
        var getRemote = function () {
          if (props && props.remote) return props.remote
          if (props && props.ctx) return pick(props.ctx, 'remote') || { session: pick(props.ctx, 'remote.session') }
          if (props && props.remoteSession) return { session: props.remoteSession }
          return getBoundRemote ? getBoundRemote() : null
        }
        return React.createElement('div', { style: { display: 'flex', height: '100%', minHeight: 0, background: '#f5f5f7' } },
          React.createElement('iframe', {
            ref: frameRef, src: entry.src, title: entry.label,
            style: { flex: 1, border: 0, display: 'block', minWidth: 0, background: '#f5f5f7' },
          }),
          React.createElement(Conversation, { label: entry.label, kind: entry.id === 'media-image-editor' ? 'image' : 'video', frameRef: frameRef, getRemote: getRemote, getWorkspace: getWorkspace, active: props?.active !== false })
        )
      }
    }

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
      var offRetained = slots.inject('shell.overlay', function () { return slots.register({ name:'shell.overlay', id:'media-retained-editors', order:0 }, RetainedEditors) })
      if (typeof offRetained === 'function') disposers.push(offRetained)
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

    exports.name = 'dsh-media-studio'
    exports.inject = ['slots', 'layout', 'remote', 'remote.session', 'uiWorkspace']
    exports.apply = apply
    exports.entries = ENTRIES
    // Exposed for the contract tests; the host only consumes name/inject/apply.
    exports.chat = { undoPrompt: undoPrompt, resultIssue: resultIssue, watchPanel: watchPanel, retainedVisible: retainedVisible, measureRect: measureRect, resolveAnchor: resolveAnchor, isEditorPanel: isEditorPanel, releaseHiddenFocus: retainedVisible, releaseHiddenFocus: releaseHiddenFocus, makePage: makePage, openNativeSession: openNativeSession, approvalText: approvalText, makeTranscript: makeTranscript, bindingKey: bindingKey, sendPrompt: sendPrompt, textOfEvent: textOfEvent, followSession: followSession, promptBody: promptBody }
    return module.exports
  },
})
