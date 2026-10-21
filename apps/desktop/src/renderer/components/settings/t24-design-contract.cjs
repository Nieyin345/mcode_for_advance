/** T24 UI refactor contract: scoped structural checks for source-only mutation tests.
 * Usage: node t24-design-contract.cjs shell|small|mid
 * Mutation: set T24_MUTATION=shell|small|mid, expect nonzero exit.
 * Functional behavior stays under the existing settings *-smoke suites.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(name) { return fs.readFileSync(path.join(__dirname, name), 'utf8'); }
function check(condition, description) { assert.ok(condition, description); }
const batch = process.argv[2];

if (batch === 'shell') {
  let shell = read('SettingsPage.tsx');
  if (process.env.T24_MUTATION === 'shell') shell = shell.replace('<Button\n                      key={item.id}', '<button\n                      key={item.id}');
  check(shell.includes('import { Button, LoadingNote } from "@renderer/components/ui/index.js"'), 'shared navigation and loading primitives imported');
  check(/<Button\s+key=\{item\.id\}/.test(shell), 'navigation action must use the shared Button');
  check(/<LoadingNote\s+label=\{t\("common\.loading"\)\}/.test(shell), 'async panel loading must use shared LoadingNote');
  check(shell.includes('aria-current={isActive ? "page" : undefined}'), 'active navigation semantics preserved');
} else if (batch === 'small') {
  let root = read('DataRootPanel.tsx');
  const about = read('AboutPanel.tsx');
  const market = read('MarketView.tsx');
  if (process.env.T24_MUTATION === 'small') root = root.replace('<ErrorNote>{error}</ErrorNote>', '<div>{error}</div>');
  check(root.includes('<ErrorNote>{error}</ErrorNote>'), 'data-root mutation error must use ErrorNote');
  check(root.includes('<Card className="bg-surface-muted/40 p-3">'), 'data tree uses shared Card');
  check(about.includes('<Card className="mt-8 w-full max-w-md divide-y divide-edge">'), 'about runtime rows use shared Card');
  check(about.includes('return <ErrorNote tone="warning"'), 'update errors use shared ErrorNote');
  check(market.includes('<Badge variant="success"'), 'market installed states use shared Badge');
  check(market.includes('<Card className="overflow-hidden">'), 'market catalog uses shared Card');
} else if (batch === 'mid') {
  const gov = read('GovernancePanel.tsx');
  let usage = read('UsagePanel.tsx');
  const notifications = read('NotificationsPanel.tsx');
  const style = read('OutputStylePanel.tsx');
  if (process.env.T24_MUTATION === 'mid') usage = usage.replace('<ErrorNote>{error}</ErrorNote>', '<div>{error}</div>');
  check(gov.includes('<Segmented'), 'governance tabs must use shared CDS segmented control');
  check(usage.includes('<ErrorNote>{error}</ErrorNote>'), 'usage error must use shared ErrorNote');
  check(usage.includes('<LoadingNote label={t("common.loading")}'), 'usage loading must use shared LoadingNote');
  check(notifications.includes('<EmptyState title={t("settings.notifications.projectEmpty")}'), 'project empty state must be shared');
  check(style.includes('<ErrorNote>{t("settings.outputStyle.loadFailed")}</ErrorNote>'), 'style loading failure must use shared ErrorNote');
} else if (batch === 'wide') {
  let remote = read('RemoteControlPanel.tsx');
  const market = read('McpMarketView.tsx');
  const appearance = read('AppearancePanel.tsx');
  if (process.env.T24_MUTATION === 'wide') remote = remote.replace('<ErrorNote>{status.tunnelError}</ErrorNote>', '<p>{status.tunnelError}</p>');
  check(remote.includes('<ErrorNote>{status.tunnelError}</ErrorNote>'), 'remote tunnel failure uses shared ErrorNote');
  check(remote.includes('<Badge variant={status?.enabled ? "warning" : "neutral"}>'), 'remote status uses shared Badge');
  check(remote.includes('<Card className="space-y-1.5 bg-surface/40 p-2.5">'), 'remote tunnel uses shared Card');
  check(market.includes('<ErrorNote className="mb-2">'), 'MCP market errors use shared ErrorNote');
  check(market.includes('{saving && <Spinner size="xs" />}'), 'MCP install uses shared Spinner');
  check(appearance.includes('<Button variant="ghost" size={null}'), 'appearance native button replaced');
} else if (batch === 'plugins') {
  let p = read('PluginsPanelParts.tsx');
  if (process.env.T24_MUTATION === 'plugins') p = p.replace('<Card className="divide-y divide-edge overflow-hidden">', '<div className="divide-y divide-edge overflow-hidden">');
  check(p.includes('<Card className="divide-y divide-edge overflow-hidden">'), 'installed-plugin list uses shared Card');
  check(p.includes('<Card className="overflow-hidden">'), 'plugin marketplace catalog uses shared Card');
  check(p.includes('<Badge variant="success"'), 'installed marker uses shared Badge');
  check(p.includes('{fetching ? <Spinner size="xs" />'), 'catalog refresh uses shared Spinner');
  check(!p.includes('rounded-xl'), 'no hardcoded large radius in large plugins view');
} else if (batch === 'textarea') {
  const names = ['AppearanceExtras','CustomUiPanelParts','EngineToolsPanel','HooksPanel','LibraryTypesPanel','McpPanelParts','SceneDeployPanel','SettingsGitPanel','SettingsTerminalPanel','SkillsPanelParts','TitleGenPanel','UnattendedPlanPanel'];
  for (const name of names) {
    let content = read(name + '.tsx');
    if (name === 'CustomUiPanelParts' && process.env.T24_MUTATION === 'textarea') content = content.replace('<Textarea', '<textarea');
    check(content.includes('<Textarea'), name + ': shared Textarea must be used');
    check(!/<textarea\b/.test(content), name + ': no native textarea');
  }
} else if (batch === 'skill-buttons') {
  const names=['SkillNodesView','SkillPresetsView','SkillProjectOverview','ProjectSkillsView','FontSizeStepper'];
  for(const name of names){
    let s=read(name+'.tsx');
    if(name==='SkillPresetsView' && process.env.T24_MUTATION === 'skill-buttons') s=s.replace('<Button variant="ghost" size={null}', '<button');
    check(!/<button\b/.test(s),name+': native action not permitted');
  }
} else if (batch === 'runtime') {
  let runtime=read('RuntimesPanel.tsx');
  const browser=read('SettingsBrowserPanel.tsx');
  const terminal=read('SettingsTerminalPanel.tsx');
  const title=read('TitleGenPanel.tsx');
  const tools=read('EngineToolsPanel.tsx');
  if(process.env.T24_MUTATION === 'runtime') runtime=runtime.replace('<Badge variant="success">', '<span>');
  check(runtime.includes('<Badge variant="success">'), 'runtime install status uses Badge');
  check(runtime.includes('<LoadingNote label={t("settings.runtimes.loading")}'), 'runtime list loading uses LoadingNote');
  check(runtime.includes('<ErrorNote className="mt-1.5"'), 'runtime failure uses ErrorNote');
  check(browser.includes('<ErrorNote tone="warning"'), 'browser encryption warning uses ErrorNote');
  for(const [n,s] of [['browser',browser],['terminal',terminal],['title',title],['tools',tools]]) check(!/<button\b/.test(s), n+': native action not permitted');
} else {
  process.stderr.write('Usage: node t24-design-contract.cjs shell|small|mid|wide|plugins|textarea|skill-buttons|runtime\n');
  process.exit(2);
}
process.stdout.write(`T24 ${batch} design contract OK\n`);
