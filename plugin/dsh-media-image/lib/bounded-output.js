export function boundToolOutput(value, { name, commandId, maxBytes = 262144 } = {}) {
  if (Buffer.byteLength(JSON.stringify(value)) <= maxBytes) return value;
  const mutation = name === 'editor_apply_command';
  return { ok: false, error: {
    code: mutation ? 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN' : 'PAYLOAD_TOO_LARGE',
    message: '工具应答超出大小上限；无法确认原命令结果，不得据此重放。',
    outcomeUnknown: true,
    ...(commandId ? { commandId } : {}),
  } };
}
