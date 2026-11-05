// Runs in the trusted same-origin parent, never inside the image editor iframe.
export async function startBrowserRelay({ transport, accessToken, baseUrl = '/editor-relay', editorKind = 'image', fetchImpl = globalThis.fetch.bind(globalThis), pollMs = 100, onError = () => {} }) {
  const hello = await transport.connect();
  let stopped = false;
  const abort = new AbortController();
  const tasks = new Set();
  let timer;
  let wake;
  async function post(action, data, signal = abort.signal) {
    const response = await fetchImpl(`${baseUrl}/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(data), signal, credentials: 'same-origin',
    });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.message || 'Relay request failed'), { code: value.code });
    return value;
  }
  const binding = await post('register', { editorInstanceId: hello.editorInstanceId, kind: editorKind });
  const auth = { pageId: binding.pageId, pageToken: binding.pageToken };
  async function dispatch(message) {
    let response;
    try {
      if (message.editorInstanceId !== binding.editorInstanceId) throw Object.assign(new Error('Editor binding changed'), { code: 'EDITOR_INSTANCE_MISMATCH' });
      if (message.editorKind !== undefined && message.editorKind !== editorKind) throw Object.assign(new Error('Editor kind binding changed'), { code: 'EDITOR_KIND_MISMATCH' });
      response = { requestId: message.requestId, ok: true, result: await transport.request(message) };
    } catch (error) {
      response = { requestId: message.requestId, ok: false, error: { code: error.code || 'EDITOR_ERROR', message: error.message, revision: error.revision, outcomeUnknown: error.outcomeUnknown } };
    }
    if (!stopped) await post('respond', { ...auth, response });
  }
  const loop = (async () => {
    try {
      while (!stopped) {
        const batch = await post('poll', auth);
        for (const message of batch.messages) {
          const task = dispatch(message).catch(onError).finally(() => tasks.delete(task));
          tasks.add(task);
        }
        if (!stopped) await new Promise((resolve) => { wake = resolve; timer = setTimeout(resolve, pollMs); });
      }
    } catch (error) {
      if (!stopped) { stopped = true; abort.abort(); onError(error); }
    }
  })();
  return {
    editorInstanceId: binding.editorInstanceId,
    pageId: binding.pageId,
    async stop() {
      stopped = true;
      clearTimeout(timer); wake?.(); abort.abort();
      try { await post('disconnect', auth, new AbortController().signal); }
      catch (error) { onError(error); }
      transport.dispose();
      await loop;
      await Promise.allSettled([...tasks]);
    },
  };
}
