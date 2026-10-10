// 自定义模型页三个引擎（Claude / Pi / Codex）的夹具 —— 真 CustomModelsPanel 挂进真 Chrome，
// 只换掉 IPC transport 与 session store。判据落在看得见的字段、按钮与真实的 API 调用上。
window.labEvents = [];
window.labToasts = [];
window.labListeners = new Set();
window.labSubscribe = fn => { labListeners.add(fn); return () => labListeners.delete(fn); };

const claudeProvider = (id, name) => ({
  id, name, baseUrl: 'https://gw.example.com/anthropic', authMode: 'auth_token',
  protocol: 'anthropic', authTokenMasked: 'sk-***ab12',
  models: [{ id: 'claude-sonnet-5' }], disableNonEssentialTraffic: true, createdAt: 1,
});
const piProvider = (name) => ({
  name, baseUrl: 'https://gw.example.com', api: 'openai-completions', hasApiKey: true,
  models: [{ id: 'deepseek-chat', contextWindow: 200000 }],
});
const codexProvider = (id) => ({
  id, name: id, baseUrl: 'https://gw.example.com/v1', models: [{ id: 'gpt-5' }], hasApiKey: true,
});

window.labReset = () => {
  labEvents.length = 0; labToasts.length = 0;
  window.labCustomModels = [claudeProvider('claude-a', 'Gateway A')];
  window.labPiProviders = { 'pi-a': piProvider('pi-a') };
  window.labCodexProviders = [codexProvider('codex-a')];
};
window.labCustomModels = null; window.labPiProviders = null; window.labCodexProviders = null;
window.labReset();

window.labState = {
  activeProjectId: null, locale: 'zh',
  customModels: window.labCustomModels,
  reloadCustomModels: async () => { labEvents.push({ method: 'reloadCustomModels' }); },
  reloadPiAvailableModels: async () => {}, reloadCodexAvailableModels: async () => {},
  setSettingsOpen: () => {},
};
window.labPatchState = patch => { labState = { ...labState, ...patch }; for (const fn of labListeners) fn(); };

const record = (method, input) => labEvents.push({ method, input: structuredClone(input) });
window.labApi = {
  workflow: { agentProfiles: async () => ({ profiles: [] }), list: async () => ({ workflows: [] }) },
  customModel: {
    list: async () => ({ models: labCustomModels }),
    save: async input => { record('customModel.save', input); return { models: labCustomModels }; },
    delete: async input => { record('customModel.delete', input); return { models: labCustomModels }; },
    getToken: async () => ({ token: 'sk-plain' }),
    test: async input => { record('customModel.test', input); return { ok: true, detail: 'ok' }; },
  },
  piModels: {
    list: async () => ({ providers: labPiProviders }),
    save: async input => { record('piModels.save', input); return { providers: labPiProviders }; },
    delete: async input => { record('piModels.delete', input); return { providers: labPiProviders }; },
    getApiKey: async () => ({ apiKey: 'sk-plain' }),
    listAvailable: async () => ({ models: [] }),
    test: async input => { record('piModels.test', input); return { ok: true, detail: 'ok' }; },
    listEndpointModels: async input => { record('piModels.listEndpointModels', input); return { models: ['pulled-a', 'pulled-b'] }; },
  },
  codexModels: {
    list: async () => ({ providers: labCodexProviders }),
    save: async input => { record('codexModels.save', input); return { providers: labCodexProviders }; },
    delete: async input => { record('codexModels.delete', input); return { providers: labCodexProviders }; },
    getApiKey: async () => ({ apiKey: 'sk-plain' }),
    test: async input => { record('codexModels.test', input); return { ok: true, detail: 'ok' }; },
    listEndpointModels: async input => { record('codexModels.listEndpointModels', input); return { models: ['cx-a'] }; },
  },
  webBridge: { status: async () => ({ paired: false, url: 'http://127.0.0.1:1', token: 't' }), regenerateToken: async () => ({ paired: false, url: 'u', token: 't' }) },
  // 未选中供应商时右侧渲染的是「远程控制」面板，它挂载即调 publicMcp.status()。
  publicMcp: {
    status: async () => ({
      enabled: false, running: false, port: 0, fixedPort: null, secret: '', tokenHint: '',
      projectLinks: [], availableProjects: [], sandboxProjectId: null, sandboxRoot: '',
      mobileHostname: '', tunnelMode: 'quick', tunnelPhase: 'idle', tunnelUrl: '', tunnelHostname: '', tunnelError: null,
    }),
    setEnabled: async () => ({ ok: true }),
    setProject: async () => ({ ok: true }),
    setTunnelConfig: async () => ({ ok: true }),
    startTunnel: async () => ({ ok: true }),
    stopTunnel: async () => ({ ok: true }),
    regenerateSecret: async () => ({ ok: true }),
    regenerateProjectLinkSecret: async () => ({ ok: true }),
    addProjectLink: async () => ({ ok: true }),
    removeProjectLink: async () => ({ ok: true }),
  },
  session: { listNodes: async () => ({ sessions: [] }) },
};
