// MCP 页浏览器回归的夹具 —— 真 McpPanel 挂进真 Chrome，只换掉 IPC transport 与 session。
window.labEvents = [];
window.labToasts = [];
window.labListeners = new Set();
window.labSubscribe = fn => { labListeners.add(fn); return () => labListeners.delete(fn); };

/** 用户级两条 + 插件一条 + 内置一条。只有用户级能勾。 */
window.labReset = () => {
  labEvents.length = 0;
  labServers = [
    { name: 'alpha-mcp', scope: 'user', kind: 'stdio', detail: 'node alpha.js', enabled: true },
    { name: 'beta-mcp', scope: 'user', kind: 'http', detail: 'https://beta/mcp', enabled: true },
    { name: 'gamma-mcp', scope: 'user', kind: 'stdio', detail: 'node gamma.js', enabled: false },
    { name: 'plug-mcp', scope: 'plugin', kind: 'stdio', detail: 'node plug.js', enabled: true },
    { name: 'builtin-mcp', scope: 'builtin', kind: 'builtin', detail: 'built-in', enabled: true },
  ];
};
window.labServers = null;
window.labReset();

window.labState = {
  activeProjectId: null, locale: new URLSearchParams(location.search).get('locale') === 'en' ? 'en' : 'zh',
  projects: [], reloadSkills: async () => {}, setSettingsOpen: () => {},
};
window.labPatchState = patch => { labState = { ...labState, ...patch }; for (const fn of labListeners) fn(); };

const record = (method, input) => labEvents.push({ method, input: structuredClone(input) });
window.labApi = {
  workflow: { agentProfiles: async () => ({ profiles: [] }), list: async () => ({ workflows: [] }) },
  mcp: {
    list: async () => ({ servers: labServers.map(s => ({ ...s })) }),
    toggle: async input => {
      record('toggle', input);
      const s = labServers.find(x => x.name === input.name && x.scope === input.scope);
      if (s) s.enabled = input.enabled;
      return { ok: true };
    },
    remove: async input => {
      record('remove', input);
      if (input.name === 'beta-mcp') return { ok: false, error: 'remove fixture denied' };
      labServers = labServers.filter(s => s.name !== input.name);
      return { ok: true };
    },
    enginesSet: async input => { record('enginesSet', input); return { ok: true }; },
    save: async input => { record('save', input); return { ok: true }; },
    authorize: async () => ({ ok: true }),
    unauthorize: async () => ({ ok: true }),
    import: async () => ({ ok: true }),
    scanImport: async () => ({ sources: [] }),
    projectSave: async () => ({ ok: true }),
    projectList: async () => ({ servers: [] }),
    projectRemove: async () => ({ ok: true }),
    projectCopy: async () => ({ copied: [], skipped: [], failed: [] }),
    projectTrust: async () => ({ ok: true }),
    marketSources: async () => ({ sources: [] }),
    marketSourceAdd: async () => ({ ok: true }),
    marketSourceRemove: async () => ({ ok: true }),
    marketSearch: async () => ({ results: [] }),
  },
  session: { listNodes: async () => ({ sessions: [] }) },
};
window.labRemount = () => {};
