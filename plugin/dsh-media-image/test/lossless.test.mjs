// Regression tests for `output.presentationMeta returned non-lossless JSON`.
// DSH validates execute value, output.render and output.presentationMeta with the same
// walkJsonValue snapshot: every enumerable property is read and `undefined` is NOT skipped.
// These tests use a strict local validator modelled on that rule.
import test from 'node:test';
import { fixtureBindings } from './host-fixture.mjs';
import assert from 'node:assert/strict';
import { registerMediaTools, toLosslessJson } from '../lib/tools.js';
import { createApprovalStore } from '../lib/gate.js';

const imageState = {
  editorKind: 'image', editorInstanceId: 'e1', documentId: 'p1', revision: 2, stateDigest: 'digest-2',
  canvas: { width: 100, height: 100 }, layers: [], history: { canUndo: false, canRedo: false },
};

const videoState = {
  editorKind: 'video', editorInstanceId: 'v1', documentId: 'p1', revision: 1, stateDigest: 'digest-1',
  timeline: { duration: 4.18, fps: 30, currentTime: 0 }, tracks: [{ id: 't', kind: 'video', clips: [] }],
  clips: [], overlays: [], history: { canUndo: false, canRedo: false }, capabilities: { webm: true, mp4: 'unknown' },
};

function bridgeFor(kind, state) {
  return {
    editorKind: kind,
    readState: async () => state,
    applyCommand: async input => ({ editorKind: kind, documentId: 'p1', commandId: input.commandId, revision: state.revision + 1, changedObjectIds: [], stateDigest: 'digest-next', history: { canUndo: true, canRedo: false } }),
    getCommandResult: async () => ({ status: 'unknown', originalResult: null }),
    startExport: async () => ({ editorKind: kind, commandId: 'x', exportId: 'exp-1', status: 'ready', artifactRef: 'artifact://exp-1' }),
    getExportStatus: async () => ({ editorKind: kind, exportId: 'exp-1', status: 'ready', artifactRef: 'artifact://exp-1' }),
  };
}

function makeTools(overrides = {}) {
  const tools = new Map();
  const ctx = { tools: { register: definition => tools.set(definition.name, definition), guard: () => {} } };
  registerMediaTools(ctx, {
    bridge: overrides.bridge ?? bridgeFor('image', imageState),
    approvals: createApprovalStore(), bindings: fixtureBindings,
  });
  return tools;
}

// Mirrors walkJsonValue: rejects undefined, functions, symbols, bigint, NaN/Infinity/-0,
// non-plain prototypes (Date/Map/Set/Error/class), sparse arrays and cycles.
function assertStrictLossless(value, label) {
  const seen = new Set();
  const walk = (node, path) => {
    if (node === undefined) throw new Error(`${label}${path}: contains undefined`);
    if (typeof node === 'function' || typeof node === 'symbol') throw new Error(`${label}${path}: not JSON (${typeof node})`);
    if (typeof node === 'bigint') throw new Error(`${label}${path}: bigint`);
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) throw new Error(`${label}${path}: non-finite number`);
      if (Object.is(node, -0)) throw new Error(`${label}${path}: negative zero`);
      return;
    }
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        if (!(index in node)) throw new Error(`${label}${path}[${index}]: sparse array`);
        walk(node[index], `${path}[${index}]`);
      }
      return;
    }
    if (node && typeof node === 'object') {
      const proto = Object.getPrototypeOf(node);
      if (proto !== Object.prototype && proto !== null) throw new Error(`${label}${path}: non-plain object ${node.constructor?.name}`);
      if (seen.has(node)) throw new Error(`${label}${path}: cycle`);
      seen.add(node);
      for (const [key, item] of Object.entries(node)) walk(item, `${path}.${key}`);
    }
  };
  walk(value, '');
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `${label}: not lossless through JSON`);
}

function argsFor(name, definition) {
  const kind = definition.parameters.properties.editorKind?.enum?.[0] ?? (name.includes('image') ? 'image' : 'video');
  const instanceId = kind === 'image' ? 'e1' : 'v1';
  const revision = kind === 'image' ? imageState.revision : videoState.revision;
  if (name.endsWith('apply_command')) return { editorKind: kind, projectId: 'p1', instanceId, commandId: 'c1', expectedRevision: revision, operation: kind === 'image' ? 'layer.update_text' : 'media.video.clip.move', params: {} };
  if (name.endsWith('export_start')) return { editorKind: kind, projectId: 'p1', instanceId, commandId: 'c2', expectedRevision: revision, format: kind === 'image' ? 'png' : 'webm' };
  if (name.endsWith('export_status')) return { editorKind: kind, projectId: 'p1', instanceId, exportId: 'exp-1' };
  if (name.endsWith('run_plan')) return { editorKind: kind, projectId: 'p1', instanceId, commandId: 'c3', expectedRevision: revision, steps: [{ operation: kind === 'image' ? 'layer.add_text' : 'media.video.overlay.update', params: {} }] };
  if (name.endsWith('recipe')) return { action: 'list' };
  if (name.endsWith('photoshop_action')) return { action: 'status', arguments: {}, confirm: true, mode: 'assist' };
  return { projectId: 'p1', instanceId, commandId: 'c1' };
}

test('sanitizer prunes undefined keys, normalizes -0 and non-finite, converts non-plain values', () => {
  const cleaned = toLosslessJson({
    a: undefined, b: 1, c: Number.NaN, d: Number.POSITIVE_INFINITY, e: [1, undefined, 3],
    f: { g: undefined, h: 'x' }, i: () => {}, j: -0, k: new Date('2026-11-03T00:00:00Z'),
    l: new Map([['x', 1]]), m: new Set([1, 2]), n: new Error('boom'), o: /abc/,
  });
  assert.deepEqual(cleaned, {
    b: 1, c: null, d: null, e: [1, null, 3], f: { h: 'x' }, j: 0,
    k: '2026-11-03T00:00:00.000Z', l: { x: 1 }, m: [1, 2],
    n: { name: 'Error', code: null, message: 'boom' }, o: 'abc',
  });
  assertStrictLossless(cleaned, 'cleaned');
});

test('every tool value, render result and presentationMeta is strict-lossless', async () => {
  const tools = makeTools();
  for (const [name, definition] of tools) {
    const args = argsFor(name, definition);
    const value = await definition.execute(args, { agent: { id: 'agent-1' } });
    assertStrictLossless(value, `${name} value`);
    assertStrictLossless(definition.output.render(args, value), `${name} render`);
    assertStrictLossless(definition.output.presentationMeta(args, value), `${name} presentationMeta`);
  }
});

test('the failure path — every optional field absent — is also strict-lossless', async () => {
  const failing = { readState: async () => { throw Object.assign(new Error('boom'), { code: 'EDITOR_ERROR' }); } };
  const tools = makeTools({ bridge: failing });
  for (const [name, definition] of tools) {
    if (!name.endsWith('read_state')) continue;
    const args = { instanceId: 'e1', projectId: 'p1' };
    const value = await definition.execute(args, { agent: { id: 'a' } });
    assert.equal(value.status, 'rejected');
    assert.equal('revision' in value, false, `${name}: rejected value must omit revision rather than null`);
    assertStrictLossless(value, `${name} failure value`);
    assertStrictLossless(definition.output.render(args, value), `${name} failure render`);
    assertStrictLossless(definition.output.presentationMeta(args, value), `${name} failure meta`);
  }
});

test('timeout value carries status unknown without leaking outcomeUnknown booleans', async () => {
  const timingOut = {
    readState: async () => { throw Object.assign(new Error('late'), { code: 'EDITOR_TIMEOUT_OUTCOME_UNKNOWN', commandId: 'c1' }); },
  };
  const tools = makeTools({ bridge: timingOut });
  for (const [name, definition] of tools) {
    if (!name.endsWith('read_state')) continue;
    const value = await definition.execute({ instanceId: 'e1', projectId: 'p1' }, { agent: { id: 'a' } });
    assert.equal(value.status, 'unknown');
    assertStrictLossless(value, `${name} timeout value`);
    assertStrictLossless(definition.output.presentationMeta({ instanceId: 'e1', projectId: 'p1' }, value), `${name} timeout meta`);
  }
});
