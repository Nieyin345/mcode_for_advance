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
} else {
  process.stderr.write('Usage: node t24-design-contract.cjs shell|small|mid\n');
  process.exit(2);
}
process.stdout.write(`T24 ${batch} design contract OK\n`);
