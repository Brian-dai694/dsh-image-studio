// 契约：工具产出的每个顶层字段都必须在 output.schema 里声明。
// 真 bug 回归：产物落盘新增 artifactId 后忘了加进 RESULT_SCHEMA，
// 宿主按 additionalProperties:false 把整次导出判成 "invalid output"——
// 而导出本身其实已经成功、文件也已经在盘上。这类错误必须在测试里先炸。
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerMediaTools } from '../lib/tools.js';
import { createApprovalStore } from '../lib/gate.js';
import { fixtureBindings } from './host-fixture.mjs';

const execOf = () => ({ agent: { id: 's1', session: { id: 's1' } }, callId: 'c1' });

function build(bridge) {
  const tools = new Map();
  registerMediaTools({ tools: { register: definition => tools.set(definition.name, definition), guard: () => {} } }, {
    bridge, approvals: createApprovalStore(), bindings: fixtureBindings,
  });
  return tools;
}

/** 模拟宿主校验：顶层字段必须在 properties 里（additionalProperties:false）。 */
function assertDeclared(tool, value) {
  const declared = new Set(Object.keys(tool.output.schema.properties ?? {}));
  for (const key of Object.keys(value)) {
    assert.ok(declared.has(key), `${tool.name} 输出含未声明字段 "${key}"，宿主会判 invalid output`);
  }
}

test('export_start 的落盘字段都在 schema 里（artifactId/path/sha256/bytes/错误）', async () => {
  const tools = build({
    editorKind: 'image',
    readState: async () => ({ editorKind: 'image', editorInstanceId: 'i1', documentId: 'p1', revision: 2, stateDigest: 'd2', canvas: { width: 10, height: 10 }, layers: [] }),
    startExport: async input => ({
      editorKind: 'image', commandId: input.commandId, exportId: 'exp-1', status: 'completed',
      artifactRef: 'blob:http://x/y', mimeType: 'image/vnd.adobe.photoshop', bytes: 50914,
      artifactId: 'a'.repeat(32), artifactPath: '/tmp/a.psd', artifactSha256: 'f'.repeat(64), artifactBytes: 50914,
      layerCount: 1, approximations: [],
    }),
  });
  const tool = tools.get('media_image_export_start');
  const args = { editorKind: 'image', projectId: 'p1', instanceId: 'i1', commandId: 'e-1', expectedRevision: 2, format: 'psd' };
  const value = await tool.execute(args, execOf());
  assertDeclared(tool, value);
  assert.equal(value.artifactPath, '/tmp/a.psd');
  assert.equal(value.artifactSha256, 'f'.repeat(64));
  const text = tool.output.render(args, value).map(block => block.text).join('\n');
  assert.match(text, /artifactPath \/tmp\/a\.psd/, '路径必须进模型可见的文本');
  assert.match(text, /sha256 f{64}/);
});

test('落盘失败时 artifactPersistError 也在 schema 里，且不丢 artifactRef', async () => {
  const tools = build({
    editorKind: 'image',
    readState: async () => ({ editorKind: 'image', editorInstanceId: 'i1', documentId: 'p1', revision: 2, stateDigest: 'd2', canvas: { width: 10, height: 10 }, layers: [] }),
    startExport: async input => ({
      editorKind: 'image', commandId: input.commandId, exportId: 'exp-2', status: 'completed',
      artifactRef: 'blob:http://x/z',
      artifactPersistError: { code: 'ARTIFACTS_UNAVAILABLE', message: '未配置 dataDir' },
    }),
  });
  const tool = tools.get('media_image_export_start');
  const value = await tool.execute({ editorKind: 'image', projectId: 'p1', instanceId: 'i1', commandId: 'e-2', expectedRevision: 2, format: 'psd' }, execOf());
  assertDeclared(tool, value);
  assert.ok(value.artifactRef, '导出成功就必须保留 artifactRef');
  assert.equal(value.artifactPersistError.code, 'ARTIFACTS_UNAVAILABLE');
  const text = tool.output.render({}, value).map(block => block.text).join('\n');
  assert.match(text, /产物未落盘 ARTIFACTS_UNAVAILABLE/);
});
