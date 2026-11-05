const fs = require('fs');
const file = 'lib/client.js';
let s = fs.readFileSync(file, 'utf8');
s = s.replace(/    function sessionIdOf\(ctx\) \{[\s\S]*?\n    function promptBody/, `    function promptBody`);
s = s.replace(/    function revealConversationSidebar\(getLayout\) \{[\s\S]*?\n    function makeEntry/, '    function makeEntry');
const helpers = `
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
            var text = textOfEvent(message)
            if (text) rows.push({ id: 'event-'+e.seq, role: e.type === 'user/message' ? 'user' : 'assistant', text: text })
          } else if (e.type === 'tool/call' || e.type === 'tool/result') {
            rows.push({ id: 'event-'+e.seq, role: 'tool', text: (e.type === 'tool/call' ? '调用工具：' : '工具返回：') + JSON.stringify(d).slice(0, 3000) })
          }
        })
        attempts.forEach(function (a, id) {
          var text = Array.from(a.chunks.entries()).sort(function (x,y) { return x[0]-y[0] }).map(function (p) { return p[1]?.type === 'text-delta' ? p[1].text : '' }).join('')
          if (text) rows.push({ id: 'attempt-'+id, role: 'assistant', text: text })
        })
        return rows.slice(-200)
      }
    }
`;
s = s.replace('    // ---------- UI ----------', helpers+'\n    // ---------- UI ----------');
s = s.replace("      var listRef = React.useRef(null)", `      var listRef = React.useRef(null)
      var bindingRef = React.useRef(null)
      var stopRef = React.useRef(null)
      var aliveRef = React.useRef(true)
      var sendingRef = React.useRef(false)
      var [ready, setReady] = React.useState(false)
      var [busy, setBusy] = React.useState(false)
      async function bind() {
        if (sendingRef.current) return
        sendingRef.current = true; setBusy(true); setReady(false)
        if (stopRef.current) stopRef.current()
        bindingRef.current = null; setMessages([])
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
          stopRef.current = followSession(remote, b.sessionId, function (frame) {
            if (!aliveRef.current || bindingRef.current !== b) return
            if (frame.type === 'snapshot' && frame.header.id !== b.sessionId) { setReady(false); setStatus('会话身份不匹配，已停止'); stopRef.current?.(); return }
            setMessages(reduce(frame)); setReady(true); setStatus('已连接专属会话 · ' + b.editorKind)
          }, function (error) { if (aliveRef.current) { setReady(false); setStatus('订阅中断：' + error.message) } })
          if (!stopRef.current) throw new Error('宿主未提供消息订阅接口')
          setStatus('正在同步专属会话…')
        } catch (error) { if (aliveRef.current) setStatus(error.message) }
        finally { sendingRef.current = false; if (aliveRef.current) setBusy(false) }
      }`);
s = s.replace(/      React.useEffect\(function \(\) \{\n        var remote = props.getRemote\(\)[\s\S]*?      \}, \[\]\)/, `      React.useEffect(function () {
        aliveRef.current = true
        return function () { aliveRef.current = false; bindingRef.current = null; if (stopRef.current) stopRef.current() }
      }, [])`);
s = s.replace(/      async function submit\(\) \{[\s\S]*?\n      function onKeyDown/, `      async function submit() {
        var text = String(draft || '').trim(), b = bindingRef.current
        if (!text || !ready || !b || sendingRef.current) return
        sendingRef.current = true; setBusy(true)
        try {
          var current = await readBinding(props.frameRef.current, props.kind)
          if (bindingKey(current) !== bindingKey(b)) { setReady(false); stopRef.current?.(); throw new Error('工程已变化，请重新绑定对话') }
          var context = '当前编辑工程身份：' + JSON.stringify(b) + '\\n仅操作上述工程；先通过对应 media_' + b.editorKind + '_* 工具读取并核对身份、修订，再执行授权修改。身份不一致时停止。\\n用户指令：\\n'
          var result = await sendPrompt(props.getRemote(), b.sessionId, context + text)
          if (!aliveRef.current || bindingRef.current !== b) return
          if (result.ok) { setDraft(''); setStatus('消息已受理，等待真实会话反馈') }
          else { setStatus(result.message); if (result.unknown) setReady(false) }
        } catch (error) { if (aliveRef.current) setStatus(error.message) }
        finally { sendingRef.current = false; if (aliveRef.current) setBusy(false) }
      }

      function onKeyDown`);
s=s.replace("if (event.key === 'Enter' && !event.shiftKey)", "if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing && !event.isComposing)");
s=s.replace("'对话 · ' + props.label, React.createElement", "'对话 · ' + props.label, React.createElement('button', { type: 'button', disabled: busy, onClick: function () { void bind() }, style: { marginLeft: 12, border: 0, borderRadius: 12, padding: '8px 12px', background: '#f5f5f7', color: '#0071e3', cursor: 'pointer' } }, '绑定专属对话'), React.createElement");
s=s.replace("var statusState = React.useState('正在解析会话…')", "var statusState = React.useState('点击绑定专属对话，关联当前工程')");
s=s.replace('key: index,', 'key: message.id,');
s=s.replace("          value: draft,", "          value: draft, disabled: !ready || busy, 'aria-label': '编辑指令',");
s=s.replace("          onClick: function () { void submit() },", "          disabled: !ready || busy, onClick: function () { void submit() },");
s=s.replace("var getRemote = function () { return pick(props && props.ctx ? props.ctx : {}, 'remote') }", "var frameRef = React.useRef(null)\n        var getRemote = function () { return pick(props && props.ctx ? props.ctx : {}, 'remote') }");
s=s.replace('src: entry.src, title: entry.label,', 'ref: frameRef, src: entry.src, title: entry.label,');
s=s.replace('label: entry.label, getRemote: getRemote, getCtx: getCtx', "label: entry.label, kind: entry.id === 'media-image-editor' ? 'image' : 'video', frameRef: frameRef, getRemote: getRemote");
s=s.replace('sessionIdOf: sessionIdOf, ', 'makeTranscript: makeTranscript, bindingKey: bindingKey, ');
fs.writeFileSync(file,s);
