// Trusted Host fixture for projection/bridge regressions. Security tests use the real registry.
export const fixtureBindings = {
  assert(exec, kind, args) {
    if (!args.projectId) throw Object.assign(new Error('projectId required'), { code: 'SESSION_BINDING_MISMATCH' });
    return { sessionId: 'fixture-session', editorKind: kind, instanceId: args.instanceId, projectId: args.projectId };
  },
  invalidate() {},
};
