// 插件页浏览器回归的夹具 —— 真 PluginsPanel 挂进真 Chrome，只在这里换掉 IPC
// transport 与 session。判据落在看得见的行与真实的 API 调用上。
window.labEvents = [];
window.labToasts = [];
window.labListeners = new Set();
window.labSubscribe = fn => { labListeners.add(fn); return () => labListeners.delete(fn); };

const plugin = (name, extra = {}) => ({
  name, version: '1.0.0', enabled: true, description: 'fixture ' + name,
  components: { skills: [], commands: [], agents: [], mcpServers: [], hooks: [], apps: [] },
  ...extra,
});
/** 每一轮测试前把夹具复位（插件被启用/停用/删除后要还原），否则逐条测试会互相污染。 */
window.labReset = () => {
  labEvents.length = 0;
  labToasts.length = 0;
  labPlugins = {
    alpha: plugin('alpha'),
    beta: plugin('beta'),
    gamma: plugin('gamma', { enabled: false }),
    // 带 hooks 且默认禁用 —— 启用它应弹出「这些 hooks 不会执行」的确认框(MSP4)。
    delta: plugin('delta', {
      enabled: false,
      components: { skills: [], commands: [], agents: [], mcpServers: [], hooks: [{ event: 'PreToolUse', matcher: 'Bash', command: 'echo hi' }], apps: [] },
    }),
  };
};
/** 安装流程返回的带 hooks 插件(审查卡要固定显示「不会执行」)。
 *  它**不**在 labPlugins 里 —— 安装是「先装、审查、再决定启用」,装完不该已经在列表里。 */
window.labHookPlugin = {
  name: 'hooked', version: '2.0.0', enabled: false, description: 'fixture hooked',
  components: { skills: [], commands: [], agents: [], mcpServers: [], hooks: [{ event: 'PreToolUse', matcher: 'Bash', command: 'echo hi' }], apps: [] },
  source: { kind: 'local-dir', ref: '/tmp/hooked' }, rootDir: '/tmp/hooked',
};
window.labPlugins = null;
window.labReset();
window.labState = {
  activeProjectId: null, locale: new URLSearchParams(location.search).get('locale') === 'en' ? 'en' : 'zh',
  projects: [],
  reloadSkills: async () => {},
  setSettingsOpen: () => {},
};
window.labPatchState = patch => { labState = { ...labState, ...patch }; for (const fn of labListeners) fn(); };

const record = (method, input) => labEvents.push({ method, input: structuredClone(input) });
window.labApi = {
  workflow: { agentProfiles: async () => ({ profiles: [] }), list: async () => ({ workflows: [] }) },
  // 「安装 ▾ → 本地目录」走它取路径。夹具给个固定路径即可。
  pickFolder: async () => ({ path: '/tmp/hooked-src' }),
  plugins: {
    list: async () => ({ plugins: Object.values(labPlugins) }),
    marketplaceList: async () => ({ marketplaces: [] }),
    projectList: async () => ({ plugins: [] }),
    setEnabled: async input => {
      record('setEnabled', input);
      if (!(input.name in labPlugins)) return { ok: false, error: 'no such plugin' };
      labPlugins[input.name].enabled = input.enabled;
      return { ok: true };
    },
    enginesSet: async input => { record('enginesSet', input); return { ok: true }; },
    remove: async input => {
      record('remove', input);
      if (input.name === 'beta') return { ok: false, error: 'remove fixture denied' };
      delete labPlugins[input.name];
      return { ok: true };
    },
    installLocal: async () => ({ ok: true, plugin: window.labHookPlugin }),
    installGit: async () => ({ ok: true }),
    installMarketplace: async () => ({ ok: true }),
    marketplaceAdd: async () => ({ ok: true }),
    marketplaceRemove: async () => ({ ok: true }),
    marketplaceRefresh: async () => ({ ok: true }),
  },
  session: { listNodes: async () => ({ sessions: [] }) },
};
window.labRemount = () => {};
