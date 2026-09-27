/**
 * Focused regression for M02: a fork is a new, idle turn even when its source
 * is running or waiting for approval. The provider and database root are
 * isolated; no real model, application data, or Electron process is used.
 */
import { initDb } from "@main/store/db.js";
import { ProjectRepo, SessionRepo } from "@main/store/repositories.js";
import { forkSession } from "@main/lib/sessionFork.js";
import { setFakeProvider, type FakeProvider } from "./stubs/providerRegistry.js";
import type { Session } from "@contracts/session";

let failures = 0;
let checks = 0;

function check(name: string, condition: boolean, actual?: unknown): void {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${actual === undefined ? "" : ` — ${JSON.stringify(actual)}`}`);
}

function makeSession(id: string, status: Session["status"]): Session {
  const now = 1_700_000_000_000;
  return {
    id,
    projectId: "p_m02",
    providerId: "claude-sdk",
    claudeSessionId: `cli-${id}`,
    kind: "chat",
    parentSessionId: null,
    nodeId: null,
    title: id,
    status,
    model: "sonnet",
    effort: "high",
    permissionMode: "acceptEdits",
    workflowId: "default",
    customModelId: null,
    archived: false,
    pinnedAt: null,
    contextSnapshot: null,
    todos: null,
    subagents: null,
    planDraft: null,
    turnFiles: null,
    usageHistory: null,
    bookmarks: null,
    subagentTranscripts: null,
    envMode: "local",
    worktreePath: null,
    wtStyle: null,
    createdAt: now,
    updatedAt: now,
  };
}

function fakeProvider(): FakeProvider {
  const provider: FakeProvider = {
    id: "claude-sdk",
    calls: [],
    forkSession: async (providerSessionId, options) => {
      provider.calls.push({ providerSessionId, ...options });
      return `cli-fork-${provider.calls.length}`;
    },
  };
  setFakeProvider(provider);
  return provider;
}

await initDb();
ProjectRepo.create({
  id: "p_m02",
  name: "M02 isolated fixture",
  path: "C:/mcode-m02-fixture",
  archived: false,
  pinnedAt: null,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
});

const provider = fakeProvider();
for (const status of ["running", "approving"] as const) {
  const sourceId = `source-${status}`;
  SessionRepo.create(makeSession(sourceId, status));
  const fork = await forkSession(sourceId, `fork-${status}`);
  check(`fork of ${status} source starts idle`, fork.status === "idle", fork.status);
  check(`source remains ${status}`, SessionRepo.get(sourceId)?.status === status, SessionRepo.get(sourceId)?.status);
}
check("both forks used the isolated fake provider", provider.calls.length === 2, provider.calls.length);

console.log(`\n${checks - failures}/${checks} M02 checks passed`);
if (failures > 0) process.exit(1);
