window.labEvents = [];
window.labToasts = [];
window.labListeners = new Set();
window.labSubscribe = fn => { labListeners.add(fn); return () => labListeners.delete(fn); };
window.labState = {
  activeProjectId: 'A', locale: new URLSearchParams(location.search).get('locale') === 'en' ? 'en' : 'zh',
  projects: [
    { id: 'A', name: 'Project A', path: '/workspace/A' },
    { id: 'B', name: 'Project B', path: '/workspace/B' },
  ],
  reloadSkills: async () => { labEvents.push({ method: 'reloadSkills' }); },
  setSettingsOpen: () => {},
};
window.labPatchState = patch => { labState = { ...labState, ...patch }; for (const fn of labListeners) fn(); };
window.labContents = {
  global: { alpha: 'GLOBAL ALPHA', beta: 'GLOBAL BETA', shared: 'GLOBAL SHARED', slow: 'SLOW CONTENT', fast: 'FAST CONTENT', 'empty-source': '', 'read-error': 'UNREADABLE', 'delete-error': 'KEEP ON FAILURE' },
  '/workspace/A': { shared: 'PROJECT A SHARED', 'a-only': 'A ONLY' },
  '/workspace/B': { shared: 'PROJECT B SHARED', 'b-only': 'B ONLY' },
  plugin: { 'plugin-skill': 'READONLY PLUGIN' },
};
window.labReadHolds = [];
window.labProjectHolds = [];
window.labHoldRead = new Set();
window.labHoldProjects = new Set();
window.labListFailure = false;
window.labDeleteFailure = true;
window.labReadsFail = true;
window.labCopyHold = false;
window.labCopyResolve = null;
const rows = (bucket, source) => Object.keys(labContents[bucket] ?? {}).map(name => ({ name, source, description: 'fixture ' + name, ...(['global', 'plugin'].includes(source) ? { perEngine: { claude: true, codex: true, pi: true } } : {}) }));
const record = (method, input) => labEvents.push({ method, input: structuredClone(input) });
const scope = input => input.source === 'project' ? input.projectPath : input.source;
const selectedList = projectPath => {
  const project = projectPath ? rows(projectPath, 'project') : [];
  return [...project, ...rows('global', 'global').filter(s => !project.some(p => p.name === s.name)), ...rows('plugin', 'plugin')];
};
window.labApi = {
  workflow: {
    agentProfiles: async () => ({ profiles: [{ id: 'profile-A', name: 'Project A profile', params: { skills: ['a-only'] } }] }),
    list: async () => ({ workflows: [] }),
  },
  skills: {
    list: async (input = {}) => {
      record('list', input);
      if (labListFailure && !input.projectPath) throw Error('list fixture unavailable');
      const result = { skills: selectedList(input.projectPath) };
      if (labHoldProjects.has(input.projectPath)) return new Promise(resolve => labProjectHolds.push(() => resolve(result)));
      return result;
    },
    bundles: async () => ({ bundles: [{ id: 'kit', label: 'Example Kit', skills: Object.keys(labContents.global) }] }),
    read: async input => {
      record('read', input);
      if (input.name === 'read-error' && labReadsFail) throw Error('read fixture unavailable');
      if (labHoldRead.has(input.name)) return new Promise(resolve => labReadHolds.push(() => resolve({ content: labContents[scope(input)]?.[input.name] ?? '' })));
      // Mirror the old backend's empty-on-missing behavior to expose a renderer
      // that forgot to send projectPath. Real filesystem behavior is covered by
      // the independent backend suite, not invented here.
      return { content: labContents[scope(input)]?.[input.name] ?? '' };
    },
    save: async input => { record('save', input); if (!scope(input)) return { ok: false, error: 'missing project path' }; labContents[scope(input)][input.name] = input.content; return { ok: true }; },
    importGithub: async input => { record('importGithub', input); return { ok: true, imported: [], skipped: [], errors: [], bundleLabel: null }; },
    delete: async input => {
      record('delete', input);
      if (input.name === 'delete-error' && labDeleteFailure) return { ok: false, error: 'delete fixture denied' };
      if (!scope(input)) return { ok: false, error: 'missing project path' };
      delete labContents[scope(input)][input.name];
      return { ok: true };
    },
    copyToProject: async input => {
      record('copyToProject', input);
      if (labCopyHold) await new Promise(resolve => { labCopyResolve = resolve; });
      const copied = [], skipped = [], failed = [];
      for (const name of input.names) {
        if (!(name in labContents.global)) failed.push({ name, reason: 'missing source' });
        else if (name in labContents[input.projectPath]) skipped.push({ name, reason: 'already exists' });
        else { labContents[input.projectPath][name] = labContents.global[name]; copied.push(name); }
      }
      return { copied, skipped, failed };
    },
    enginesSet: async input => { record('enginesSet', input); return { ok: true, perEngine: { claude: input.claude, codex: input.codex, pi: input.pi } }; },
    enginesSetBulk: async input => { record('enginesSetBulk', input); return { ok: true, perEngine: Object.fromEntries(input.names.map(n => [n, { claude: input.claude, codex: input.codex, pi: input.pi }])) }; },
    presets: { list: async () => ({ presets: [] }), save: async () => ({ ok: true }), delete: async () => ({ ok: true }) },
    projectOverview: async () => ({ rows: labState.projects.map(p => ({ projectId: p.id, projectName: p.name, projectPath: p.path, skills: Object.keys(labContents[p.path] ?? {}), missing: false })), problems: [] }),
    scanSources: async () => ({ sources: [] }),
  },
};
localStorage.setItem('mcode.skills.expanded', JSON.stringify(['bundle:kit', 'ungrouped', 'project', 'universal', 'plugin']));
