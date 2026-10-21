// Isolated fake backend: real renderer, xterm and Monaco; no user PTY or files touched.
(function () {
  const makeNs = () => new Proxy({}, { get: (_, method) => method === 'then' ? undefined : () => Promise.resolve({}) });
  const noopSub = () => () => {};
  const broken = new URLSearchParams(location.search).get('case');
  const invalid = broken === 'json' ? '{invalid-json'
    : broken === 'structure' ? JSON.stringify({ paneLayout: { version: 1, placements: [{ id: 'right', side: 'up', order: 0, sizePct: 999 }] } })
    : null;
  window.__paneEvents = { creates: [], kills: [], resizes: [] };
  window.__uncaught = [];
  window.addEventListener('error', e => { window.__uncaught.push(String(e.message || e.error)); });
  window.addEventListener('unhandledrejection', e => { window.__uncaught.push(String(e.reason)); });
  let nextTerminal = 0;
  const fixed = {
    setting: {
      getMany: async () => invalid ? { 'ui.paneLayout': invalid } : {},
      get: async () => ({ value: null }),
      set: async () => ({ ok: true }),
    },
    project: { list: async () => ({ projects: [] }) },
    session: { listPinned: async () => ({ sessions: [] }), list: async () => ({ sessions: [] }) },
    customModel: { list: async () => ({ models: [] }) },
    outputStyle: { list: async () => ({ styles: [] }) },
    workflow: { list: async () => ({ workflows: [] }), agentProfiles: async () => ({ profiles: [], problems: [] }) },
    automation: { statusAll: async () => ({ statuses: {} }) },
    library: { groupsGet: async () => ({ groups: [] }) },
    modules: { catalog: async () => ({ modules: [] }) },
    file: { readFile: async () => ({ content: 'T15 Monaco model fixture.\n', encoding: 'utf8' }), listDir: async () => ({ entries: [] }) },
    terminal: {
      create: async input => {
        const terminalId = 'isolated-pty-' + ++nextTerminal;
        window.__paneEvents.creates.push({ terminalId, input });
        return { ok: true, terminalId };
      },
      kill: async input => { window.__paneEvents.kills.push(input.terminalId); return { ok: true }; },
      resize: async input => { window.__paneEvents.resizes.push(input); return { ok: true }; },
      write: async () => ({ ok: true }),
    },
    theme: { get: async () => ({ theme: 'light', effective: 'light' }), set: async () => ({ theme: 'light', effective: 'light' }) },
  };
  window.labApi = new Proxy({}, {
    get: (_, ns) => {
      if (ns === 'then') return undefined;
      if (ns === 'on') return new Proxy({}, { get: () => noopSub });
      return fixed[ns] || makeNs();
    },
  });
})();