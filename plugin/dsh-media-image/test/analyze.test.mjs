// 自检：测量值 → findings（每条建议必须是白名单命令），以及工具层只读行为。
import test from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_COMMANDS } from '../lib/bridge.js';
import { reviewMeasurements, summarizeMeasurements, THRESHOLDS } from '../lib/analyze.js';

const base = (overrides = {}) => ({
  width: 970, height: 600, sampledWidth: 320, sampledHeight: 198,
  luminance: { mean: 0.5, histogram: [0, 0.1, 0.2, 0.4, 0.3, 0, 0, 0] },
  clipping: { shadows: 0, highlights: 0 },
  colorCast: { r: 128, g: 128, b: 128, spread: 0 },
  sharpness: { laplacianVariance: 500 },
  layers: { total: 2, visible: 2, offCanvas: [], zeroSize: [], textOverflow: [] },
  opaqueRatio: 0.98,
  ...overrides,
});

test('偏暗 / 偏亮各自给出提示，方向不能反', () => {
  const dark = reviewMeasurements(base({ luminance: { mean: 0.05, histogram: [] } }));
  assert.equal(dark.some(item => item.code === 'TOO_DARK'), true);
  const bright = reviewMeasurements(base({ luminance: { mean: 0.95, histogram: [] } }));
  assert.equal(bright.some(item => item.code === 'TOO_BRIGHT'), true);
  const normal = reviewMeasurements(base());
  assert.equal(normal.some(item => item.code === 'TOO_DARK' || item.code === 'TOO_BRIGHT'), false);
});

test('裁切比例越高，严重级别越高（warn → high）', () => {
  const warn = reviewMeasurements(base({ clipping: { shadows: 0, highlights: 0.03 } })).find(item => item.code === 'HIGHLIGHT_CLIPPING');
  const high = reviewMeasurements(base({ clipping: { shadows: 0, highlights: 0.09 } })).find(item => item.code === 'HIGHLIGHT_CLIPPING');
  assert.equal(warn.severity, 'warn');
  assert.equal(high.severity, 'high');
  const shadow = reviewMeasurements(base({ clipping: { shadows: 0.05, highlights: 0 } })).find(item => item.code === 'SHADOW_CLIPPING');
  assert.equal(shadow.severity, 'warn');
});

test('偏色与低清晰度按阈值出现，透明画布单独报', () => {
  assert.equal(reviewMeasurements(base({ colorCast: { r: 150, g: 120, b: 110, spread: 40 } })).some(i => i.code === 'COLOR_CAST'), true);
  assert.equal(reviewMeasurements(base({ sharpness: { laplacianVariance: 10 } })).some(i => i.code === 'LOW_DETAIL'), true);
  assert.equal(reviewMeasurements(base({ opaqueRatio: 0.001 })).some(i => i.code === 'ALMOST_EMPTY'), true);
  assert.equal(reviewMeasurements(base()).some(i => i.code === 'LOW_DETAIL'), false, '清晰度正常时不该报');
});

test('图层体检：越界/零尺寸/文字超框都被点名', () => {
  const findings = reviewMeasurements(base({ layers: { total: 3, visible: 3, offCanvas: ['l1'], zeroSize: ['l2'], textOverflow: [{ id: 'l3', width: 1200 }] } }));
  const codes = findings.map(item => item.code);
  assert.ok(codes.includes('OFF_CANVAS'));
  assert.ok(codes.includes('EMPTY_LAYER'));
  assert.ok(codes.includes('TEXT_OVERFLOW'));
  assert.match(findings.find(item => item.code === 'TEXT_OVERFLOW').message, /l3/);
});

test('每条建议命令都必须真实存在于白名单', () => {
  const nasty = base({
    luminance: { mean: 0.02, histogram: [] },
    clipping: { shadows: 0.2, highlights: 0.2 },
    colorCast: { r: 200, g: 100, b: 90, spread: 110 },
    sharpness: { laplacianVariance: 1 },
    opaqueRatio: 0.001,
    layers: { total: 3, visible: 3, offCanvas: ['a'], zeroSize: ['b'], textOverflow: [{ id: 'c', width: 9999 }] },
  });
  const findings = reviewMeasurements(nasty);
  assert.ok(findings.length >= 6, `应报出多条，实际 ${findings.length}`);
  for (const item of findings) {
    if (!item.suggestedCommand) continue;
    assert.ok(ALLOWED_COMMANDS.image.has(item.suggestedCommand), `${item.code} 建议了不存在的命令 ${item.suggestedCommand}`);
  }
});

test('没有测量值时返回空清单，不编造', () => {
  assert.deepEqual(reviewMeasurements(null), []);
  assert.deepEqual(reviewMeasurements(undefined), []);
  assert.equal(summarizeMeasurements(null), '');
});

test('摘要只报数值，不做好坏评价', () => {
  const text = summarizeMeasurements(base({ clipping: { shadows: 0.01, highlights: 0.03 } }));
  assert.match(text, /平均亮度 0\.5/);
  assert.match(text, /高光裁切 3\.0%/);
  assert.equal(/好|棒|完美|漂亮/.test(text), false, '摘要里不能出现主观评价');
  assert.ok(THRESHOLDS.clippingHigh > THRESHOLDS.clippingWarn);
});

test('media_image_analyze 已注册且只读：回测量、findings 与摘要，revision 不变', async () => {
  const { fixtureBindings } = await import('./host-fixture.mjs');
  const { createMediaBridge } = await import('../lib/bridge.js');
  const { registerMediaTools } = await import('../lib/tools.js');
  const { createApprovalStore } = await import('../lib/gate.js');
  const measurement = base({ clipping: { shadows: 0, highlights: 0.12 } });
  const relay = {
    request: async message => {
      if (message.type === 'editor.read_state') {
        return { editorKind: 'image', editorInstanceId: 'e1', documentId: 'doc-1', revision: 7, stateDigest: 'fnv1a64-7',
          canvas: { width: 970, height: 600 }, layers: [], history: { canUndo: true, canRedo: false } };
      }
      if (message.type === 'editor.analyze') return measurement;
      throw new Error(`unexpected ${message.type}`);
    },
  };
  const tools = new Map();
  registerMediaTools({ tools: { register: d => tools.set(d.name, d), guard: () => {} } },
    { bridge: createMediaBridge({ relay, editorKind: 'image' }), approvals: createApprovalStore(), bindings: fixtureBindings });
  const definition = tools.get('media_image_analyze');
  assert.ok(definition, '必须注册自检工具');
  const value = await definition.execute({ editorKind: 'image', projectId: 'doc-1', instanceId: 'e1' }, { agent: { id: 'a' } });
  assert.equal(value.status, 'applied');
  assert.equal(value.revision, 7, '测量不得推进 revision');
  assert.ok(Array.isArray(value.findings) && value.findings.length > 0);
  assert.equal(value.counts.high >= 1, true);
  assert.match(value.summary, /高光裁切 12\.0%/);
  assert.match(value.note, /只测量/);
});
