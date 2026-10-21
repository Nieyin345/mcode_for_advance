/**
 * Read-only G0/G1 migration preflight.
 *
 * This module deliberately does not import the workflow repository, SettingRepo,
 * dataRoot, NodeRedFlowStorage, or any runtime/deploy API. Callers must supply an
 * explicitly isolated, read-only export copy (or fictional fixtures), a manifest
 * snapshot, and review/in-flight facts obtained through an authorized channel.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import {
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import { TextDecoder } from "node:util";
import {
  WorkflowDocSchema,
  unknownWorkflowFieldPaths,
  type WorkflowDoc,
  type WorkflowEngine,
} from "@contracts/workflow";
import type { NodeTypeManifest } from "@contracts/nodeType";
import {
  flowToWorkflowDoc,
  migrateWorkflowDoc,
  roundTripMismatchPaths,
  type FlowMigrationReport,
  type NodeRedFlow,
  type NodeRedNode,
} from "./flowMigration.js";
import { nativeFlowForWorkflow } from "./workflowEngineSelection.js";

export const WORKFLOW_PREFLIGHT_API_VERSION = 1;
export const WORKFLOW_PREFLIGHT_ISOLATION_MARKER = ".mcode-workflow-preflight-isolated";
export const WORKFLOW_PREFLIGHT_ISOLATION_MARKER_CONTENT =
  "Mcode workflow migration preflight isolated v1\n";

const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const HASH_RE = /^[a-f0-9]{64}$/i;
const SOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const NATIVE_TRIGGER_TYPES = new Set([
  "inject", "watch", "http in", "mqtt in", "tcp in", "udp in",
  "websocket in", "link in", "cronplus", "mcode-trigger",
]);
const DEFAULT_NATIVE_NODE_TYPES = new Set([
  "tab", "inject", "debug", "function", "exec", "switch", "watch",
  "http in", "http response", "mqtt in", "mqtt out", "tcp in", "tcp out",
  "udp in", "udp out", "websocket in", "websocket out", "link in", "link out",
  "link call", "delay", "change", "template", "comment", "catch", "status",
  "complete", "trigger", "rbe", "split", "join", "range", "sort", "batch",
  "csv", "json", "xml", "html", "file", "file in", "file out", "subflow",
  "subflow in", "subflow out", "mcode-agent", "mcode-conversation",
  "mcode-branch", "mcode-module-capability", "mcode-node-red-call",
  "mcode-trigger", "mcode-approval",
]);

export type WorkflowPreflightDecision = "SAFE" | "HUMAN" | "REJECT" | "UNREADABLE";
export type WorkflowPreflightDirection = "mcode-to-node-red" | "node-red-to-mcode" | "inventory-only";

export interface WorkflowPreflightAuthorization {
  kind: "authorized-export-copy" | "fictional-fixture";
  /** Explicit caller attestation. The API never creates this marker or a copy. */
  isolatedReadOnlyCopy: true;
}

export type WorkflowPreflightReviewFacts =
  | { state: "not-required" }
  | { state: "pending" }
  | { state: "unknown" }
  | { state: "corrupt" }
  | { state: "approved"; approvedRevision: string };

export type WorkflowPreflightInFlightFacts =
  | { state: "none" }
  | { state: "active"; activeCount?: number }
  | { state: "pending-trigger"; pendingTriggerCount?: number }
  | { state: "unknown" };

export interface WorkflowPreflightRuntimeFacts {
  /** Host-side metadata, separate from the untrusted workflow JSON. */
  review?: WorkflowPreflightReviewFacts;
  inFlight?: WorkflowPreflightInFlightFacts;
  runboardHistory?: "available" | "missing" | "unknown" | "not-applicable";
}

interface WorkflowDocSourceBase {
  sourceId: string;
  kind: "workflow-doc";
  direction: "mcode-to-node-red" | "inventory-only";
  relativePath?: string;
  contentText?: string;
  content?: unknown;
  expectedContentHash?: string;
  expectedRevision?: string;
  runtimeFacts?: WorkflowPreflightRuntimeFacts;
}

interface FlowsJsonSourceBase {
  sourceId: string;
  kind: "flows-json";
  direction: "node-red-to-mcode" | "inventory-only";
  relativePath?: string;
  contentText?: string;
  content?: unknown;
  expectedContentHash?: string;
  expectedRevisionsByDocId?: Readonly<Record<string, string>>;
  runtimeFactsByDocId?: Readonly<Record<string, WorkflowPreflightRuntimeFacts>>;
}

export type WorkflowMigrationPreflightSource =
  | WorkflowDocSourceBase
  | FlowsJsonSourceBase;

export interface WorkflowMigrationPreflightInput {
  /** Must be an existing isolated directory with the exported-copy marker file. */
  isolationRoot: string;
  authorization: WorkflowPreflightAuthorization;
  sources: readonly WorkflowMigrationPreflightSource[];
  /** Snapshot supplied by the caller; this module never loads installed node types. */
  types: ReadonlyMap<string, NodeTypeManifest>;
  /** Optional Node-RED registry snapshot. Missing custom types remain unverified. */
  knownNativeNodeTypes?: ReadonlySet<string>;
}

export interface WorkflowPreflightReason {
  code: string;
  severity: "human" | "reject" | "unreadable";
  summary: string;
  minimumFix: string;
}

export interface WorkflowPreflightTriggerSource {
  source: "workflow.trigger" | "workflow-node" | "node-red-native";
  kind: string;
  /** Stable graph identity only; no filesystem paths or trigger parameter values. */
  nodeId?: string;
}

export interface WorkflowPreflightUnknownDependencies {
  unknownMcodeNodeTypes: string[];
  nativeOnlyNodeTypes: string[];
  unknownNativeNodeTypes: string[];
  unknownFieldPaths: string[];
  globalConfigNodeCount: number;
  crossTabReferenceCount: number;
  orphanedNodeCount: number;
  tabCount: number;
}

export interface WorkflowPreflightMigrationSummary {
  migratorVersion: number | null;
  mappedNodeCount: number;
  unmappedNodeTypes: string[];
  humanDecisionItems: number[];
  lossyIssueCount: number;
  roundTripMismatchPaths: string[];
}

export interface WorkflowMigrationPreflightRow {
  /** Deterministic, non-path identifier for this source representation. */
  rowId: string;
  sourceId: string;
  direction: WorkflowPreflightDirection;
  docId: string | null;
  name: string | null;
  engine: WorkflowEngine | "unknown";
  /** Untrusted engine hint from native tab metadata; never an execution authority. */
  declaredEngine?: WorkflowEngine | null;
  /** Engine-specific revision; separate from the byte-exact source content hash. */
  revision: string | null;
  contentHash: string | null;
  byteLength: number | null;
  triggerSources: WorkflowPreflightTriggerSource[];
  approval: {
    state: "not-required" | "approved" | "pending" | "corrupt" | "unknown" | "stale";
    approvedRevision?: string;
  };
  inFlight: {
    state: "none" | "active" | "pending-trigger" | "unknown";
    activeCount?: number;
    pendingTriggerCount?: number;
  };
  runboardHistory: "available" | "missing" | "unknown" | "not-applicable";
  unknownDependencies: WorkflowPreflightUnknownDependencies;
  fieldDiffPaths: string[];
  migration: WorkflowPreflightMigrationSummary;
  decision: WorkflowPreflightDecision;
  reasons: WorkflowPreflightReason[];
}

export interface WorkflowPreflightGateStatus {
  gate: "G0" | "G1" | "G2" | "G3" | "G4" | "G5";
  status: "manifest-only" | "fixture-only" | "dry-run-only" | "blocked";
  activationAllowed: false;
  reason: string;
}

export interface WorkflowMigrationPreflightReport {
  apiVersion: number;
  gate: "G0-G1";
  gateReleaseTable: WorkflowPreflightGateStatus[];
  sourceAuthorization: "authorized-export-copy" | "fictional-fixture";
  sourceCount: number;
  scannedCount: number;
  counts: { safe: number; human: number; reject: number; unreadable: number };
  unreadableCount: number;
  approvalSummary: { notRequired: number; approved: number; pending: number; stale: number; corrupt: number; unknown: number };
  inFlightSummary: { none: number; active: number; pendingTrigger: number; unknown: number };
  unknownDependencySummary: {
    rowsWithUnknownDependencies: number;
    unknownMcodeNodeTypeCount: number;
    nativeOnlyNodeTypeCount: number;
    unknownNativeNodeTypeCount: number;
    unknownFieldPathCount: number;
    globalConfigNodeCount: number;
    crossTabReferenceCount: number;
    orphanedNodeCount: number;
  };
  /** Stable hash over the sanitized manifest. No absolute source paths are included. */
  manifestHash: string;
  /** G0/G1 never grants permission to activate, deploy, or switch an engine. */
  activationAllowed: false;
  rows: WorkflowMigrationPreflightRow[];
}

interface SourceBytes {
  bytes: Buffer;
  rawValue?: unknown;
}

type SourceReadFailure = {
  kind: "reject" | "unreadable";
  code: string;
  summary: string;
  minimumFix: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

/** Mirrors workflowTrust.workflowRevision without importing its DB-backed module. */
function workflowRevision(doc: WorkflowDoc): string {
  const execution = {
    ...doc,
    updatedAt: undefined,
    icon: undefined,
    nodes: doc.nodes.map((node) => ({ ...node, position: undefined })),
  };
  return sha256(JSON.stringify(canonical(execution)));
}

function sameFileIdentity(a: ReturnType<typeof fstatSync>, b: ReturnType<typeof fstatSync>): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink;
}

function assertDirectoryChain(absolutePath: string): void {
  try {
    const volumeRoot = parse(absolutePath).root;
    let current = volumeRoot;
    const pieces = relative(volumeRoot, absolutePath).split(sep).filter(Boolean);
    for (const piece of pieces) {
      current = join(current, piece);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("linked-or-nondirectory");
      }
    }
  } catch {
    throw new Error("Isolation root is missing or has a linked/non-directory path component.");
  }
}

function assertIsolationRoot(pathValue: string): string {
  if (typeof pathValue !== "string" || pathValue.length === 0 || !isAbsolute(pathValue)) {
    throw new Error("An explicit absolute isolationRoot is required; production dataRoot is never inferred.");
  }
  const root = resolve(pathValue);
  assertDirectoryChain(root);
  const markerPath = join(root, WORKFLOW_PREFLIGHT_ISOLATION_MARKER);
  let markerStat: ReturnType<typeof lstatSync>;
  let markerBytes: Buffer;
  try {
    markerStat = lstatSync(markerPath);
    if (markerStat.isSymbolicLink() || !markerStat.isFile() || markerStat.nlink !== 1) {
      throw new Error("invalid-marker");
    }
    markerBytes = readFileSync(markerPath);
  } catch {
    throw new Error("A regular isolation marker is required; no default dataRoot is used.");
  }
  if (markerBytes.toString("utf8") !== WORKFLOW_PREFLIGHT_ISOLATION_MARKER_CONTENT) {
    throw new Error("Isolation marker content is invalid; refusing to scan.");
  }
  return root;
}

function readRelativeSource(root: string, relativePath: string): SourceBytes | SourceReadFailure {
  if (typeof relativePath !== "string" || relativePath.length === 0
    || isAbsolute(relativePath) || win32.isAbsolute(relativePath)
    || /^[A-Za-z]:/.test(relativePath) || relativePath.includes("\0")) {
    return {
      kind: "reject",
      code: "path-outside-isolation-root",
      summary: "Source path must be relative to the explicitly marked isolation root.",
      minimumFix: "Copy the authorized export into the isolated directory and use a relative path.",
    };
  }
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0 || segments.some((part) => part === "." || part === "..")) {
    return {
      kind: "reject",
      code: "path-outside-isolation-root",
      summary: "Source path traversal is not allowed.",
      minimumFix: "Use a normalized path contained by the isolated export directory.",
    };
  }
  const candidate = resolve(root, ...segments);
  const rootRelative = relative(root, candidate);
  if (rootRelative === "" || rootRelative === ".." || rootRelative.startsWith(".." + sep) || isAbsolute(rootRelative)
    || candidate === join(root, WORKFLOW_PREFLIGHT_ISOLATION_MARKER)) {
    return {
      kind: "reject",
      code: "path-outside-isolation-root",
      summary: "Source path is outside the isolated export boundary or names the isolation marker.",
      minimumFix: "Use a separate regular file inside the isolated export directory.",
    };
  }

  let current = root;
  let beforePathStat: ReturnType<typeof lstatSync> | null = null;
  for (let index = 0; index < segments.length; index++) {
    current = join(current, segments[index]!);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(current);
    } catch (error) {
      const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
      return {
        kind: "unreadable",
        code: code === "ENOENT" ? "source-missing" : "source-unreadable",
        summary: code === "ENOENT" ? "Source file is missing." : "Source file could not be opened safely.",
        minimumFix: "Restore or re-export the source into the isolated directory, then retry.",
      };
    }
    if (stat.isSymbolicLink()) {
      return {
        kind: "reject",
        code: "linked-source-path",
        summary: "Symlink/junction source paths are not accepted.",
        minimumFix: "Copy the source bytes into a regular file inside the isolated directory.",
      };
    }
    const isLast = index === segments.length - 1;
    if (!isLast && !stat.isDirectory()) {
      return {
        kind: "reject",
        code: "invalid-source-path-component",
        summary: "A source path component is not a directory.",
        minimumFix: "Use a regular directory tree inside the isolated export directory.",
      };
    }
    if (isLast && (!stat.isFile() || stat.nlink !== 1)) {
      return {
        kind: "reject",
        code: "source-not-private-regular-file",
        summary: "Source must be a private regular file, not a directory or hard link.",
        minimumFix: "Copy the export to a new regular file in the isolated directory.",
      };
    }
    if (isLast) beforePathStat = stat;
  }
  if (beforePathStat === null) {
    return {
      kind: "reject",
      code: "invalid-source-path",
      summary: "Source path did not resolve to a regular file.",
      minimumFix: "Use a relative file path under the isolation root.",
    };
  }
  if (beforePathStat.size > MAX_SOURCE_BYTES) {
    return {
      kind: "reject",
      code: "source-too-large",
      summary: "Source exceeds the preflight JSON size limit.",
      minimumFix: "Split the export into reviewable files without dropping dependencies.",
    };
  }

  let fd: number | null = null;
  try {
    const noFollow = (constants as unknown as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    fd = openSync(candidate, constants.O_RDONLY | noFollow);
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || !sameFileIdentity(before, beforePathStat as ReturnType<typeof fstatSync>)) {
      return {
        kind: "reject",
        code: "source-changed-during-read",
        summary: "Source identity changed before it could be read.",
        minimumFix: "Take a stable export snapshot and rerun preflight against that copy.",
      };
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    const afterPath = lstatSync(candidate);
    if (!sameFileIdentity(before, after) || afterPath.isSymbolicLink()
      || afterPath.dev !== after.dev || afterPath.ino !== after.ino
      || afterPath.size !== after.size || afterPath.nlink !== 1) {
      return {
        kind: "reject",
        code: "source-changed-during-read",
        summary: "Source changed while preflight was reading it.",
        minimumFix: "Freeze a byte-stable export copy and rerun preflight.",
      };
    }
    return { bytes };
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
    if (code === "ELOOP" || code === "EMLINK") {
      return {
        kind: "reject",
        code: "linked-source-path",
        summary: "Linked source paths are not accepted.",
        minimumFix: "Copy the source bytes into a regular file inside the isolated directory.",
      };
    }
    return {
      kind: "unreadable",
      code: code === "ENOENT" ? "source-missing" : "source-unreadable",
      summary: "Source file could not be read safely.",
      minimumFix: "Restore or re-export the source into the isolated directory, then retry.",
    };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function readSource(source: WorkflowMigrationPreflightSource, root: string): SourceBytes | SourceReadFailure {
  const hasPath = typeof source.relativePath === "string";
  const hasText = typeof source.contentText === "string";
  const hasContent = Object.prototype.hasOwnProperty.call(source, "content");
  if (Number(hasPath) + Number(hasText) + Number(hasContent) !== 1) {
    return {
      kind: "reject",
      code: "invalid-source-shape",
      summary: "Each source must provide exactly one relativePath, contentText, or content value.",
      minimumFix: "Choose one explicit source representation; do not fall back to a default data root.",
    };
  }
  if (hasPath) return readRelativeSource(root, source.relativePath!);
  if (hasText) return { bytes: Buffer.from(source.contentText!, "utf8") };
  try {
    const json = JSON.stringify(source.content);
    if (json === undefined) {
      return {
        kind: "unreadable",
        code: "source-not-json-serializable",
        summary: "Inline source is not JSON serializable.",
        minimumFix: "Supply a plain JSON fixture or a regular export file.",
      };
    }
    return { bytes: Buffer.from(json, "utf8") };
  } catch {
    return {
      kind: "unreadable",
      code: "source-not-json-serializable",
      summary: "Inline source is not JSON serializable.",
      minimumFix: "Supply a plain JSON fixture or a regular export file.",
    };
  }
}

function parseJsonBytes(bytes: Buffer): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text) as unknown;
}

function unsafeJsonKeyPath(value: unknown, prefix = "$", seen = new Set<object>()): string | null {
  if (Array.isArray(value)) {
    if (seen.has(value)) return prefix;
    seen.add(value);
    for (let index = 0; index < value.length; index++) {
      const result = unsafeJsonKeyPath(value[index], prefix + "[" + index + "]", seen);
      if (result !== null) return result;
    }
    seen.delete(value);
    return null;
  }
  if (!isRecord(value)) return null;
  if (seen.has(value)) return prefix;
  seen.add(value);
  for (const key of Object.keys(value).sort()) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      return prefix + "." + key;
    }
    const result = unsafeJsonKeyPath(value[key], prefix + "." + key, seen);
    if (result !== null) return result;
  }
  seen.delete(value);
  return null;
}

function emptyUnknownDependencies(): WorkflowPreflightUnknownDependencies {
  return {
    unknownMcodeNodeTypes: [],
    nativeOnlyNodeTypes: [],
    unknownNativeNodeTypes: [],
    unknownFieldPaths: [],
    globalConfigNodeCount: 0,
    crossTabReferenceCount: 0,
    orphanedNodeCount: 0,
    tabCount: 0,
  };
}

function emptyMigrationSummary(): WorkflowPreflightMigrationSummary {
  return {
    migratorVersion: null,
    mappedNodeCount: 0,
    unmappedNodeTypes: [],
    humanDecisionItems: [],
    lossyIssueCount: 0,
    roundTripMismatchPaths: [],
  };
}

function makeRow(
  source: WorkflowMigrationPreflightSource,
  index: number,
  contentHash: string | null,
  byteLength: number | null,
): WorkflowMigrationPreflightRow {
  return {
    rowId: source.sourceId + "#" + String(index + 1).padStart(3, "0"),
    sourceId: source.sourceId,
    direction: source.direction,
    docId: null,
    name: null,
    engine: "unknown",
    revision: null,
    contentHash,
    byteLength,
    triggerSources: [],
    approval: { state: "unknown" },
    inFlight: { state: "unknown" },
    runboardHistory: "unknown",
    unknownDependencies: emptyUnknownDependencies(),
    fieldDiffPaths: [],
    migration: emptyMigrationSummary(),
    decision: "SAFE",
    reasons: [],
  };
}

function addReason(row: WorkflowMigrationPreflightRow, reason: WorkflowPreflightReason): void {
  if (row.reasons.some((existing) => existing.code === reason.code)) return;
  row.reasons.push(reason);
  row.reasons.sort((a, b) => a.code.localeCompare(b.code));
}

function rejectReason(code: string, summary: string, minimumFix: string): WorkflowPreflightReason {
  return { code, severity: "reject", summary, minimumFix };
}

function humanReason(code: string, summary: string, minimumFix: string): WorkflowPreflightReason {
  return { code, severity: "human", summary, minimumFix };
}

function unreadableReason(code: string, summary: string, minimumFix: string): WorkflowPreflightReason {
  return { code, severity: "unreadable", summary, minimumFix };
}

function finalizeDecision(row: WorkflowMigrationPreflightRow): void {
  if (row.reasons.some((reason) => reason.severity === "unreadable")) row.decision = "UNREADABLE";
  else if (row.reasons.some((reason) => reason.severity === "reject")) row.decision = "REJECT";
  else if (row.reasons.some((reason) => reason.severity === "human")) row.decision = "HUMAN";
  else row.decision = "SAFE";
}

function redactSensitiveText(value: string): string {
  let text = value;
  if (/[A-Za-z]:[\\/]/.test(text)
    || /(?:^|\s)\/(?:Users|home|tmp|var|etc|mnt|private)\//.test(text)
    || text.includes("\\\\")) {
    return "[redacted-path]";
  }
  text = text.replace(/\b(password|passwd|token|secret|api[_-]?key|authorization|credential)\b\s*[:=]\s*[^,\s;]+/gi, "$1=[redacted]");
  return text.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 120);
}

function safeLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return redactSensitiveText(value);
}

function safeType(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "unknown";
  return redactSensitiveText(value).slice(0, 100) || "unknown";
}

function validHash(value: unknown): value is string {
  return typeof value === "string" && HASH_RE.test(value);
}

function workflowTriggerSources(
  doc: WorkflowDoc,
  types: ReadonlyMap<string, NodeTypeManifest>,
): WorkflowPreflightTriggerSource[] {
  const sources: WorkflowPreflightTriggerSource[] = [];
  if (typeof doc.trigger === "string") {
    sources.push({ source: "workflow.trigger", kind: safeType(doc.trigger) });
  }
  for (const node of doc.nodes) {
    const manifestKind = types.get(node.type)?.runner.kind;
    if (manifestKind !== "trigger" && node.type !== "mcode.trigger") continue;
    const value = node.params?.triggerKind;
    const kind = typeof value === "string" && ["manual", "schedule", "file", "event"].includes(value)
      ? value : "unknown";
    sources.push({ source: "workflow-node", kind, nodeId: safeLabel(node.id) ?? undefined });
  }
  return sources.sort((a, b) =>
    (a.source + ":" + a.kind + ":" + (a.nodeId ?? "")).localeCompare(
      b.source + ":" + b.kind + ":" + (b.nodeId ?? "")));
}

function nativeTriggerSources(nodes: readonly NodeRedNode[]): WorkflowPreflightTriggerSource[] {
  return nodes.filter((node) => NATIVE_TRIGGER_TYPES.has(node.type)).map((node) => ({
    source: "node-red-native" as const,
    kind: safeType(node.type),
    nodeId: safeLabel(node.id) ?? undefined,
  })).sort((a, b) => (a.kind + ":" + (a.nodeId ?? "")).localeCompare(b.kind + ":" + (b.nodeId ?? "")));
}

function reviewFactsOf(facts: WorkflowPreflightRuntimeFacts | undefined): WorkflowPreflightReviewFacts {
  const value = facts?.review;
  if (!value || !isRecord(value) || typeof value.state !== "string") return { state: "unknown" };
  if (value.state === "approved") {
    return validHash(value.approvedRevision) ? { state: "approved", approvedRevision: value.approvedRevision }
      : { state: "corrupt" };
  }
  if (value.state === "not-required" || value.state === "pending" || value.state === "unknown" || value.state === "corrupt") {
    return { state: value.state };
  }
  return { state: "corrupt" };
}

function inFlightFactsOf(facts: WorkflowPreflightRuntimeFacts | undefined): WorkflowPreflightInFlightFacts {
  const value = facts?.inFlight;
  if (!value || !isRecord(value) || typeof value.state !== "string") return { state: "unknown" };
  if (value.state === "none" || value.state === "unknown") return { state: value.state };
  if (value.state === "active") {
    const activeCount = typeof value.activeCount === "number" && Number.isSafeInteger(value.activeCount) && value.activeCount >= 0
      ? value.activeCount : undefined;
    return { state: "active", ...(activeCount === undefined ? {} : { activeCount }) };
  }
  if (value.state === "pending-trigger") {
    const pendingTriggerCount = typeof value.pendingTriggerCount === "number"
      && Number.isSafeInteger(value.pendingTriggerCount) && value.pendingTriggerCount >= 0
      ? value.pendingTriggerCount : undefined;
    return { state: "pending-trigger", ...(pendingTriggerCount === undefined ? {} : { pendingTriggerCount }) };
  }
  return { state: "unknown" };
}

function runboardFactsOf(facts: WorkflowPreflightRuntimeFacts | undefined): WorkflowMigrationPreflightRow["runboardHistory"] {
  const value = facts?.runboardHistory;
  if (value === "available" || value === "missing" || value === "not-applicable") return value;
  return "unknown";
}

function applyRuntimeFacts(
  row: WorkflowMigrationPreflightRow,
  facts: WorkflowPreflightRuntimeFacts | undefined,
  revisionForReview: string | null,
): void {
  const review = reviewFactsOf(facts);
  if (review.state === "approved") {
    row.approval = { state: "approved", approvedRevision: review.approvedRevision };
    if (revisionForReview === null) {
      // Inventory-only/structurally blocked rows have no comparable WorkflowDoc
      // revision. Do not mislabel a merely unverified approval as stale.
      row.approval = { state: "unknown" };
      addReason(row, humanReason(
        "approval-revision-unverified",
        "An approval exists, but this source could not be mapped to the exact revision it approved.",
        "Derive and compare the authoritative workflow revision before treating this approval as current.",
      ));
    } else if (review.approvedRevision !== revisionForReview) {
      row.approval = { state: "stale", approvedRevision: review.approvedRevision };
      addReason(row, rejectReason(
        "approval-revision-mismatch",
        "Approval is not bound to the exact current workflow revision.",
        "Reconcile the approved revision against the frozen source snapshot; never reuse approval across edits.",
      ));
    }
  } else {
    row.approval = { state: review.state };
    if (review.state === "pending") {
      addReason(row, humanReason(
        "approval-pending",
        "This workflow has an outstanding human review decision.",
        "Drain or archive pending work, then obtain explicit human review for this exact revision.",
      ));
    } else if (review.state === "unknown") {
      addReason(row, humanReason(
        "approval-state-unknown",
        "No trusted approval snapshot was supplied; source JSON cannot approve itself.",
        "Supply a sanitized Host-side approval snapshot or keep this workflow out of automatic migration.",
      ));
    } else if (review.state === "corrupt") {
      addReason(row, rejectReason(
        "approval-ledger-corrupt",
        "The supplied approval snapshot is corrupt or malformed.",
        "Preserve the corrupt record for audit and repair it through the Host approval flow; do not infer approval.",
      ));
    }
  }

  const inFlight = inFlightFactsOf(facts);
  row.inFlight = inFlight;
  if (inFlight.state === "active") {
    addReason(row, humanReason(
      "workflow-in-flight",
      "An execution is active; switching ownership could duplicate or interrupt side effects.",
      "Wait for a verified drain or explicitly archive the run and record its outcome before reconsidering.",
    ));
  } else if (inFlight.state === "pending-trigger") {
    addReason(row, humanReason(
      "trigger-in-flight",
      "A trigger is queued or waiting for its merge window.",
      "Resolve the queued trigger and capture its event fingerprint before changing trigger ownership.",
    ));
  } else if (inFlight.state === "unknown") {
    addReason(row, humanReason(
      "in-flight-state-unknown",
      "The preflight has no trusted snapshot proving that executions and trigger queues are idle.",
      "Provide a sanitized run/trigger snapshot; otherwise do not switch or activate this workflow.",
    ));
  }

  row.runboardHistory = runboardFactsOf(facts);
  if (row.runboardHistory === "missing") {
    addReason(row, humanReason(
      "runboard-history-missing",
      "The available runtime events do not prove durable run history or recoverable outputs.",
      "Preserve existing run records and verify a durable runboard history path before migration.",
    ));
  } else if (row.runboardHistory === "unknown") {
    addReason(row, humanReason(
      "runboard-history-unknown",
      "Durable run history was not verified in the supplied snapshot.",
      "Verify run IDs, outputs, approvals, and restart recovery; do not treat in-memory progress as history.",
    ));
  }
}

function applyExpectedHashes(
  row: WorkflowMigrationPreflightRow,
  source: WorkflowMigrationPreflightSource,
  actualContentHash: string,
  actualRevision: string | null,
  expectedRevision?: string,
): void {
  if (source.expectedContentHash !== undefined) {
    if (!validHash(source.expectedContentHash)) {
      addReason(row, rejectReason(
        "invalid-expected-content-hash",
        "The expected content hash is malformed.",
        "Recreate the manifest from a trusted byte-stable snapshot.",
      ));
    } else if (source.expectedContentHash.toLowerCase() !== actualContentHash) {
      addReason(row, rejectReason(
        "source-content-hash-mismatch",
        "The source bytes differ from the previously recorded manifest.",
        "Freeze a new export, record its hash, and rerun preflight; do not overwrite either version.",
      ));
    }
  }
  if (expectedRevision !== undefined) {
    if (!validHash(expectedRevision)) {
      addReason(row, rejectReason(
        "invalid-expected-revision",
        "The expected revision is malformed.",
        "Recreate the revision manifest from a trusted snapshot.",
      ));
    } else if (actualRevision === null || expectedRevision.toLowerCase() !== actualRevision) {
      addReason(row, rejectReason(
        "source-revision-mismatch",
        "The current source revision differs from the expected revision, consistent with a stale or concurrent edit.",
        "Keep both revisions, compare them in isolation, and retry only against an explicitly chosen snapshot.",
      ));
    }
  }
}

function hasUnknownFields(doc: WorkflowDoc): string[] {
  return [...new Set(unknownWorkflowFieldPaths(doc).map((path) => redactSensitiveText(path)))].sort();
}

function addWorkflowTriggerGate(row: WorkflowMigrationPreflightRow): void {
  if (row.triggerSources.length === 0) return;
  const kinds = new Set(row.triggerSources.map((source) => source.kind));
  let summary = "Legacy trigger semantics are not proven equivalent by a field round-trip.";
  if (kinds.has("schedule")) {
    summary = "Old cron/time-zone/missed-tick behavior is not proven equivalent to Node-RED inject/crontab.";
  } else if (kinds.has("file")) {
    summary = "Old file-watch debounce, exclusions, project scope, and task payload are not proven equivalent to Node-RED watch.";
  } else if (kinds.has("event") || kinds.has("webhook") || kinds.has("unknown")) {
    summary = "Old event source, filtering, payload, and deduplication behavior require a human decision.";
  }
  addReason(row, humanReason(
    "trigger-semantics-unverified",
    summary,
    "Compare the old and native trigger payload, debounce, exclusion, project, missed-event, and deduplication rules; keep both trigger owners inactive during review.",
  ));
}

function runWorkflowDocSource(
  row: WorkflowMigrationPreflightRow,
  source: WorkflowDocSourceBase,
  rawValue: unknown,
  types: ReadonlyMap<string, NodeTypeManifest>,
): void {
  const unsafeKey = unsafeJsonKeyPath(rawValue);
  if (unsafeKey !== null) {
    addReason(row, rejectReason(
      "unsafe-json-key",
      "The source contains an unsafe object key at " + redactSensitiveText(unsafeKey) + ".",
      "Remove the unsafe key in a reviewed copy while preserving the original export for audit.",
    ));
    return;
  }
  if (!isRecord(rawValue)) {
    addReason(row, unreadableReason(
      "workflow-doc-not-object",
      "WorkflowDoc source is not a JSON object.",
      "Re-export a complete WorkflowDoc without modifying the original.",
    ));
    return;
  }
  const validation = WorkflowDocSchema.safeParse(rawValue);
  if (!validation.success) {
    addReason(row, unreadableReason(
      "workflow-doc-schema-invalid",
      "WorkflowDoc does not satisfy the current readable schema.",
      "Keep the source unchanged and inspect the schema issues in a local, access-controlled tool.",
    ));
    return;
  }
  const doc = rawValue as unknown as WorkflowDoc;
  row.docId = safeLabel(doc.id);
  row.name = safeLabel(doc.name);
  if (row.docId !== doc.id) {
    addReason(row, rejectReason(
      "sensitive-document-identity",
      "The workflow identity contains path-like or credential-like text and was redacted from the report.",
      "Assign a stable non-sensitive workflow ID in a reviewed copy; keep the original identity local for audit.",
    ));
  }
  row.engine = doc.engine ?? "mcode";
  row.revision = workflowRevision(doc);
  row.triggerSources = workflowTriggerSources(doc, types);
  row.unknownDependencies.unknownFieldPaths = hasUnknownFields(doc)
    .map((path) => redactSensitiveText(path));

  if (source.direction === "inventory-only") {
    addReason(row, humanReason(
      "inventory-only-not-migration-approval",
      "This WorkflowDoc was requested for inventory only; no engine migration has been proven or authorized.",
      "Create a separate direction-specific preflight after reviewing the inventory; this report never authorizes activation.",
    ));
  } else if (source.direction !== "mcode-to-node-red") {
    addReason(row, rejectReason(
      "workflow-direction-mismatch",
      "WorkflowDoc source direction is unsupported.",
      "Select the intended migration direction in a new preflight request.",
    ));
  }
  if (doc.engine === "node-red" && source.direction === "mcode-to-node-red") {
    addReason(row, rejectReason(
      "workflow-already-node-red-owned",
      "The document already declares Node-RED ownership; it is not an old-runner migration candidate.",
      "Reconcile the authoritative Node-RED flow and Host revision rather than migrating this document as legacy.",
    ));
  }

  const beforeUnknown = hasUnknownFields(doc);
  if (beforeUnknown.length > 0) {
    addReason(row, humanReason(
      "unknown-workflow-fields",
      "Unrecognized workflow fields are present; preservation must be reviewed, not inferred from known-field equality.",
      "Review the listed unknown field paths and verify byte-preserving retention in the native flow before any activation.",
    ));
  }

  if (source.direction === "inventory-only") {
    applyRuntimeFacts(row, source.runtimeFacts, null);
    return;
  }

  try {
    const migration = migrateWorkflowDoc(doc, { types });
    const restored = flowToWorkflowDoc(migration.flow);
    const knownDiffs = roundTripMismatchPaths(doc, restored).sort();
    const afterUnknown = hasUnknownFields(restored);
    const unknownDiffs = [...new Set([
      ...beforeUnknown.filter((path) => !afterUnknown.includes(path)).map((path) => "unknown-field-lost:" + path),
      ...afterUnknown.filter((path) => !beforeUnknown.includes(path)).map((path) => "unknown-field-added:" + path),
    ])].sort();
    row.fieldDiffPaths = [...new Set([...knownDiffs, ...unknownDiffs].map((path) => redactSensitiveText(path)))].sort();
    row.migration = {
      migratorVersion: migration.report.migratorVersion,
      mappedNodeCount: migration.report.mapped.length,
      unmappedNodeTypes: [...new Set(migration.report.unmapped.map((item) => safeType(item.type)))].sort(),
      humanDecisionItems: [...new Set(migration.report.needsHumanDecision
        .map((item) => item.merge0Item).filter((item): item is number => item !== undefined))].sort((a, b) => a - b),
      lossyIssueCount: migration.report.lossy.length,
      roundTripMismatchPaths: knownDiffs.map((path) => redactSensitiveText(path)),
    };
    row.unknownDependencies.unknownMcodeNodeTypes = row.migration.unmappedNodeTypes;
    if (migration.report.unmapped.length > 0) {
      addReason(row, rejectReason(
        "unmapped-mcode-node-type",
        "At least one Mcode node type is absent from the supplied manifest; its execution semantics are unknown.",
        "Install/verify the exact node manifest or keep the workflow in the legacy compatibility area; never activate an unknown node.",
      ));
    }
    if (knownDiffs.length > 0 || unknownDiffs.length > 0) {
      addReason(row, rejectReason(
        "round-trip-data-mismatch",
        "The migration round-trip has field differences that are not explained by a verified lossless rule.",
        "Preserve the original bytes and resolve each reported field path before reconsidering migration.",
      ));
    }
    if (migration.report.needsHumanDecision.length > 0 || migration.report.lossy.length > 0) {
      addReason(row, humanReason(
        "migration-semantics-need-review",
        "The migration report identifies semantics or representation changes that require review.",
        "Resolve every reported human-decision/loss item and rerun preflight on the same frozen source revision.",
      ));
    }
  } catch {
    addReason(row, rejectReason(
      "migration-analysis-failed",
      "The migration adapter could not safely analyze this workflow.",
      "Preserve the source and investigate the failure on a fictional fixture before retrying.",
    ));
  }

  addWorkflowTriggerGate(row);
  applyRuntimeFacts(row, source.runtimeFacts, row.revision);
}

interface NativeFlowShape {
  nodes: NodeRedNode[];
  tabs: NodeRedNode[];
  globalConfigNodes: NodeRedNode[];
  crossTabReferenceCount: number;
  duplicateNodeIds: string[];
  orphanedNodes: NodeRedNode[];
  tabCount: number;
}

function nativeFlowShape(value: unknown): NativeFlowShape | null {
  const nodesValue = Array.isArray(value) ? value
    : isRecord(value) && Array.isArray(value.flows) ? value.flows : null;
  if (nodesValue === null) return null;
  const nodes: NodeRedNode[] = [];
  for (const item of nodesValue) {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.type !== "string") return null;
    nodes.push(item as unknown as NodeRedNode);
  }
  const ids = new Set<string>();
  const duplicates = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) duplicates.add(node.id);
    ids.add(node.id);
  }
  const tabs = nodes.filter((node) => node.type === "tab");
  const globalConfigNodes = nodes.filter((node) => node.type !== "tab"
    && (typeof node.z !== "string" || node.z.length === 0));
  const tabIds = new Set(tabs.map((tab) => tab.id));
  const orphanedNodes = nodes.filter((node) => node.type !== "tab"
    && typeof node.z === "string" && node.z.length > 0 && !tabIds.has(node.z));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const tabOf = (node: NodeRedNode): string | null => node.type === "tab"
    ? node.id : typeof node.z === "string" && node.z.length > 0 ? node.z : null;
  let crossTabReferenceCount = 0;
  for (const node of nodes) {
    if (!Array.isArray(node.wires)) continue;
    for (const port of node.wires) {
      if (!Array.isArray(port)) {
        crossTabReferenceCount++;
        continue;
      }
      for (const targetId of port) {
        if (typeof targetId !== "string") {
          crossTabReferenceCount++;
          continue;
        }
        const target = byId.get(targetId);
        if (!target) {
          crossTabReferenceCount++;
          continue;
        }
        const sourceTab = tabOf(node);
        const targetTab = tabOf(target);
        if (sourceTab !== null && targetTab !== null && sourceTab !== targetTab) {
          crossTabReferenceCount++;
        }
      }
    }
  }
  return {
    nodes,
    tabs,
    globalConfigNodes,
    crossTabReferenceCount,
    duplicateNodeIds: [...duplicates].sort(),
    orphanedNodes,
    tabCount: tabs.length,
  };
}

function nativeDocId(tab: NodeRedNode): string | null {
  const meta: unknown = tab["x-mcode"];
  if (!isRecord(meta)) return null;
  const docId = meta["docId"];
  return typeof docId === "string" && docId.length > 0 ? docId : null;
}

function nativeDeclaredEngine(tab: NodeRedNode): WorkflowEngine | null {
  const meta: unknown = tab["x-mcode"];
  if (!isRecord(meta)) return null;
  const engine = meta["engine"];
  return engine === "mcode" || engine === "node-red" ? engine : null;
}

function nativeEditorChanges(flow: NodeRedFlow): string[] {
  const changes = new Set<string>();
  const tab = flow.nodes.find((node) => node.type === "tab");
  if (tab && isRecord(tab["x-mcode"])) {
    const tabMeta = tab["x-mcode"] as Record<string, unknown>;
    if (typeof tabMeta.name === "string" && tab.label !== tabMeta.name) changes.add("tab-label-edited");
  }
  for (const node of flow.nodes) {
    if (node.type === "tab" || !isRecord(node["x-mcode"])) continue;
    const meta = node["x-mcode"] as Record<string, unknown>;
    if (typeof meta.nodeId !== "string") continue;
    if (typeof meta.title === "string" && node.name !== meta.title) changes.add("node-title-edited");
    if (typeof meta.nativeId === "string" && meta.nativeId !== node.id) changes.add("node-copied-or-rekeyed");
    if (typeof meta.nativeType === "string" && meta.nativeType !== node.type) changes.add("native-type-edited");
    if (isRecord(meta.position)) {
      const px = meta.position.x;
      const py = meta.position.y;
      if (typeof px === "number" && typeof py === "number"
        && (node.x !== Math.round(px) || node.y !== Math.round(py))) changes.add("node-position-edited");
    }
    if (Array.isArray(meta.edgeMeta)) {
      const expected = meta.edgeMeta.filter((item) => isRecord(item) && item.sourceNativeId === node.id)
        .map((item) => isRecord(item) ? item.targetNativeId : null)
        .filter((id): id is string => typeof id === "string").sort();
      const actual = (Array.isArray(node.wires) ? node.wires.flat() : [])
        .filter((id): id is string => typeof id === "string").sort();
      if (JSON.stringify(expected) !== JSON.stringify(actual)) changes.add("native-wires-edited");
    } else if (Array.isArray(node.wires) && node.wires.some((port) => Array.isArray(port) && port.length > 0)) {
      changes.add("native-wires-without-baseline");
    }
  }
  return [...changes].sort();
}

function applyNativeDependencySummary(
  row: WorkflowMigrationPreflightRow,
  shape: NativeFlowShape,
  tab: NodeRedNode,
  members: NodeRedNode[],
  knownNativeNodeTypes: ReadonlySet<string>,
): void {
  row.unknownDependencies.tabCount = shape.tabCount;
  row.unknownDependencies.globalConfigNodeCount = shape.globalConfigNodes.length;
  row.unknownDependencies.crossTabReferenceCount = shape.crossTabReferenceCount;
  row.unknownDependencies.orphanedNodeCount = shape.orphanedNodes.length;
  row.unknownDependencies.unknownNativeNodeTypes = [...new Set(
    members.map((node) => node.type).filter((type) => !knownNativeNodeTypes.has(type)).map(safeType),
  )].sort();
  row.unknownDependencies.nativeOnlyNodeTypes = [...new Set(
    members.filter((node) => {
      const meta: unknown = node["x-mcode"];
      return !isRecord(meta) || typeof meta["nodeId"] !== "string";
    }).map((node) => safeType(node.type)),
  )].sort();
  const meta = tab["x-mcode"];
  if (isRecord(meta) && isRecord(meta.unknown)) {
    row.unknownDependencies.unknownFieldPaths.push(...Object.keys(meta.unknown).map((key) => "tab.x-mcode.unknown." + key));
  }
  for (const node of members) {
    const nodeMeta = node["x-mcode"];
    if (isRecord(nodeMeta) && isRecord(nodeMeta.unknown)) {
      row.unknownDependencies.unknownFieldPaths.push(...Object.keys(nodeMeta.unknown)
        .map((key) => "nodes[" + safeLabel(node.id) + "].x-mcode.unknown." + key));
    }
  }
  row.unknownDependencies.unknownFieldPaths = [...new Set(
    row.unknownDependencies.unknownFieldPaths.map((path) => redactSensitiveText(path)),
  )].sort();
}

function runFlowsJsonSource(
  rows: WorkflowMigrationPreflightRow[],
  source: FlowsJsonSourceBase,
  rawValue: unknown,
  contentHash: string,
  byteLength: number,
  types: ReadonlyMap<string, NodeTypeManifest>,
  knownNativeNodeTypes: ReadonlySet<string>,
): void {
  const unsafeKey = unsafeJsonKeyPath(rawValue);
  if (unsafeKey !== null) {
    const row = rows[0]!;
    row.contentHash = contentHash;
    row.byteLength = byteLength;
    addReason(row, rejectReason(
      "unsafe-json-key",
      "The source contains an unsafe object key at " + redactSensitiveText(unsafeKey) + ".",
      "Remove the unsafe key in a reviewed copy while preserving the original export for audit.",
    ));
    return;
  }
  const shape = nativeFlowShape(rawValue);
  if (shape === null) {
    const row = rows[0]!;
    row.contentHash = contentHash;
    row.byteLength = byteLength;
    addReason(row, unreadableReason(
      "flows-json-shape-invalid",
      "The source is not a valid Node-RED node array or an object containing a flows array.",
      "Re-export flows.json from the native storage adapter without editing the original.",
    ));
    return;
  }
  if (shape.tabs.length === 0) {
    const row = rows[0]!;
    row.contentHash = contentHash;
    row.byteLength = byteLength;
    addReason(row, rejectReason(
      "flows-json-no-tabs",
      "The readable Node-RED export contains no tab, so no workflow boundary can be established.",
      "Preserve the source and determine whether the export is incomplete or represents only global configuration.",
    ));
    return;
  }

  const duplicateDocIds = new Map<string, number>();
  for (const tab of shape.tabs) {
    const id = nativeDocId(tab);
    if (id !== null) duplicateDocIds.set(id, (duplicateDocIds.get(id) ?? 0) + 1);
  }

  shape.tabs.forEach((tab, tabIndex) => {
    const row = rows[tabIndex]!;
    row.contentHash = contentHash;
    row.byteLength = byteLength;
    row.engine = "node-red";
    row.declaredEngine = nativeDeclaredEngine(tab);
    const rawDocId = nativeDocId(tab);
    row.docId = rawDocId === null ? null : safeLabel(rawDocId);
    row.name = safeLabel(tab.label);
    if (rawDocId !== null && row.docId !== rawDocId) {
      addReason(row, rejectReason(
        "sensitive-document-identity",
        "The native tab identity contains path-like or credential-like text and was redacted from the report.",
        "Assign a stable non-sensitive workflow ID in a reviewed copy; keep the original identity local for audit.",
      ));
    }
    const nativeTabId = tab.id;
    const members = shape.nodes.filter((node) => node.type !== "tab" && node.z === nativeTabId);
    const tabNodes = [tab, ...members];
    row.revision = sha256(canonicalJson({ nodes: tabNodes }));
    row.triggerSources = nativeTriggerSources(members);
    applyNativeDependencySummary(row, shape, tab, members, knownNativeNodeTypes);

    if (row.docId === null && source.direction === "node-red-to-mcode") {
      addReason(row, rejectReason(
        "native-tab-missing-doc-id",
        "This native tab has no Mcode workflow identity; a reverse migration must not guess one.",
        "Keep the tab native or establish an explicit Host-side identity mapping after reviewing the source.",
      ));
    }
    if (rawDocId !== null && (duplicateDocIds.get(rawDocId) ?? 0) > 1) {
      addReason(row, rejectReason(
        "duplicate-native-doc-id",
        "More than one native tab claims the same workflow identity.",
        "Preserve every tab and resolve identity collisions before any migration or write-back.",
      ));
    }
    if (shape.duplicateNodeIds.length > 0) {
      addReason(row, rejectReason(
        "duplicate-native-node-id",
        "The native export contains duplicate node identities.",
        "Preserve the original and resolve node identity collisions in a separate reviewed copy.",
      ));
    }
    if (shape.crossTabReferenceCount > 0) {
      const severity = source.direction === "node-red-to-mcode" ? "reject" : "human";
      addReason(row, severity === "reject"
        ? rejectReason(
          "cross-tab-or-dangling-wire",
          "A wire crosses a tab boundary or points to a missing node.",
          "Resolve the native graph references without deleting or silently reassigning any node.",
        )
        : humanReason(
          "cross-tab-or-dangling-wire",
          "The native graph contains cross-tab or dangling references that need review.",
          "Verify all target identities and tab ownership before treating this export as a migration manifest.",
        ));
    }
    if (shape.orphanedNodes.length > 0) {
      const severity = source.direction === "node-red-to-mcode" ? "reject" : "human";
      addReason(row, severity === "reject"
        ? rejectReason(
          "orphaned-native-node",
          "One or more native nodes refer to a tab identity that is absent from this export.",
          "Preserve the original nodes and restore the missing tab or resolve ownership in a separate reviewed copy.",
        )
        : humanReason(
          "orphaned-native-node",
          "One or more native nodes refer to a tab identity that is absent from this export.",
          "Restore the missing tab or resolve ownership before treating this export as a complete inventory.",
        ));
    }
    if (shape.globalConfigNodes.length > 0) {
      const severity = source.direction === "node-red-to-mcode" ? "reject" : "human";
      addReason(row, severity === "reject"
        ? rejectReason(
          "global-config-dependency",
          "The export contains global Node-RED configuration nodes that cannot be assigned safely to one Mcode document.",
          "Keep the original native configuration intact and define an explicit supported dependency mapping before reverse migration.",
        )
        : humanReason(
          "global-config-dependency",
          "Global Node-RED configuration is present and must be included in the dependency inventory.",
          "Record the configuration dependency and verify its lifecycle without copying credentials into the report.",
        ));
    }
    if (shape.tabCount > 1) {
      addReason(row, humanReason(
        "native-multi-tab-context",
        "The export contains multiple native tabs; per-tab migration must prove that shared configuration and references remain intact.",
        "Inventory every tab and shared dependency, then preflight each tab against a frozen export.",
      ));
    }
    if (row.unknownDependencies.unknownNativeNodeTypes.length > 0) {
      const severity = source.direction === "node-red-to-mcode" ? "reject" : "human";
      addReason(row, severity === "reject"
        ? rejectReason(
          "unknown-native-node-type",
          "At least one native node type is absent from the supplied Node-RED registry snapshot.",
          "Install/verify the exact node package and version, or keep the graph in its original native compatibility area.",
        )
        : humanReason(
          "unknown-native-node-type",
          "At least one native node type is not verified by the supplied registry snapshot.",
          "Record the exact package/version in the local manifest; do not delete or rewrite the native node.",
        ));
    }
    if (source.direction === "inventory-only") {
      addReason(row, humanReason(
        "inventory-only-not-migration-approval",
        "This source was requested for inventory only; no engine migration has been proven or authorized.",
        "Create a separate direction-specific preflight after reviewing the inventory; this report never authorizes activation.",
      ));
      applyRuntimeFacts(row, source.runtimeFactsByDocId?.[rawDocId ?? ""], null);
      return;
    }

    if (row.unknownDependencies.nativeOnlyNodeTypes.length > 0) {
      addReason(row, rejectReason(
        "native-only-node-not-reversible",
        "One or more native nodes have no Mcode node identity; reverse migration would lose native execution semantics.",
        "Keep these nodes in the native tab or implement and verify an explicit adapter before considering reverse migration.",
      ));
    }

    let nativeFlow: NodeRedFlow | null = null;
    let derivedDoc: WorkflowDoc | null = null;
    if (rawDocId !== null && row.docId === rawDocId && row.unknownDependencies.globalConfigNodeCount === 0
      && row.unknownDependencies.crossTabReferenceCount === 0
      && row.unknownDependencies.nativeOnlyNodeTypes.length === 0
      && row.unknownDependencies.unknownNativeNodeTypes.length === 0
      && (duplicateDocIds.get(row.docId) ?? 0) === 1
      && shape.duplicateNodeIds.length === 0) {
      try {
        nativeFlow = nativeFlowForWorkflow(shape.nodes, rawDocId!);
        derivedDoc = flowToWorkflowDoc(nativeFlow);
        row.revision = sha256(canonicalJson({ nodes: tabNodes }));
      } catch {
        addReason(row, rejectReason(
          "native-flow-conversion-rejected",
          "The current native flow could not be converted without guessing identity or type semantics.",
          "Preserve the native flow and inspect the exact type/identity mismatch in a fictional fixture.",
        ));
      }
    } else if (row.docId !== null && source.direction === "node-red-to-mcode") {
      // The specific structural blocker is already recorded above. Do not attempt
      // conversion merely to produce a more optimistic round-trip result.
    }

    if (derivedDoc !== null && nativeFlow !== null) {
      const reviewRevision = workflowRevision(derivedDoc);
      applyRuntimeFacts(row, source.runtimeFactsByDocId?.[rawDocId ?? ""], reviewRevision);
      const unknownPaths = hasUnknownFields(derivedDoc);
      row.unknownDependencies.unknownFieldPaths.push(...unknownPaths.map((path) => "workflow." + path));
      row.unknownDependencies.unknownFieldPaths = [...new Set(
    row.unknownDependencies.unknownFieldPaths.map((path) => redactSensitiveText(path)),
  )].sort();
      if (unknownPaths.length > 0) {
        addReason(row, humanReason(
          "unknown-workflow-fields",
          "The reverse-mapped workflow contains fields outside the current contract.",
          "Review unknown field paths and prove byte-preserving retention before any future write-back.",
        ));
      }
      const editorChanges = nativeEditorChanges(nativeFlow);
      if (editorChanges.length > 0) {
        addReason(row, humanReason(
          "native-editor-changes-unverified",
          "Native editor changes were detected, but real Deploy, GET/flows, SQL read-back, and restart persistence are not proven here.",
          "Verify the native edit through the real Electron/Node-RED path and compare the resulting revision before any switch.",
        ));
      } else {
        addReason(row, humanReason(
          "native-editor-u1-unverified",
          "A static native export cannot prove the real Electron editor, Deploy, and restart round-trip.",
          "Obtain the dedicated U1 evidence for this exact native flow before approving a reverse migration.",
        ));
      }
      try {
        const migrated = migrateWorkflowDoc(derivedDoc, { types });
        const restored = flowToWorkflowDoc(migrated.flow);
        const knownDiffs = roundTripMismatchPaths(derivedDoc, restored).sort();
        row.fieldDiffPaths = [...new Set([...row.fieldDiffPaths, ...knownDiffs].map((path) => redactSensitiveText(path)))].sort();
        row.migration = {
          migratorVersion: migrated.report.migratorVersion,
          mappedNodeCount: migrated.report.mapped.length,
          unmappedNodeTypes: [...new Set(migrated.report.unmapped.map((item) => safeType(item.type)))].sort(),
          humanDecisionItems: [...new Set(migrated.report.needsHumanDecision
            .map((item) => item.merge0Item).filter((item): item is number => item !== undefined))].sort((a, b) => a - b),
          lossyIssueCount: migrated.report.lossy.length,
          roundTripMismatchPaths: knownDiffs.map((path) => redactSensitiveText(path)),
        };
        row.unknownDependencies.unknownMcodeNodeTypes = row.migration.unmappedNodeTypes;
        if (migrated.report.unmapped.length > 0) {
          addReason(row, rejectReason(
            "unmapped-mcode-node-type",
            "The reverse-mapped document references a node type absent from the supplied Mcode manifest.",
            "Verify the exact Mcode node manifest or keep the workflow in native compatibility mode.",
          ));
        }
        if (knownDiffs.length > 0) {
          addReason(row, rejectReason(
            "round-trip-data-mismatch",
            "The reverse-mapped workflow has field differences that are not explained by a verified rule.",
            "Preserve both revisions and resolve each field difference before any migration.",
          ));
        }
        if (migrated.report.needsHumanDecision.length > 0 || migrated.report.lossy.length > 0) {
          addReason(row, humanReason(
            "migration-semantics-need-review",
            "The adapter identified native-to-Mcode semantic or representation differences.",
            "Resolve every human-decision/loss item and rerun preflight on the same frozen native revision.",
          ));
        }
      } catch {
        addReason(row, rejectReason(
          "migration-analysis-failed",
          "The reverse-mapped document could not be analyzed safely.",
          "Preserve the native source and investigate on a fictional fixture before retrying.",
        ));
      }
      addWorkflowTriggerGate(row);
    } else {
      // Even when structural blockers prevent conversion, retain the supplied
      // review/run facts; without a comparable WorkflowDoc revision approval is
      // explicitly unknown rather than silently assumed current.
      applyRuntimeFacts(row, source.runtimeFactsByDocId?.[rawDocId ?? ""], null);
    }
  });
}

function applySourceReadFailure(
  row: WorkflowMigrationPreflightRow,
  failure: SourceReadFailure,
): void {
  const reason = failure.kind === "reject"
    ? rejectReason(failure.code, failure.summary, failure.minimumFix)
    : unreadableReason(failure.code, failure.summary, failure.minimumFix);
  addReason(row, reason);
}

function safeSourceId(sourceId: unknown): sourceId is string {
  return typeof sourceId === "string" && SOURCE_ID_RE.test(sourceId);
}

/**
 * Build a stable G0/G1 manifest. This function only reads the explicitly marked
 * isolation directory; it never creates files, changes workflow ownership, or
 * touches production storage, workflow execution, Node-RED Admin, or the DB.
 */
export function runWorkflowMigrationPreflight(
  input: WorkflowMigrationPreflightInput,
): WorkflowMigrationPreflightReport {
  if (!input || !input.authorization
    || (input.authorization.kind !== "authorized-export-copy" && input.authorization.kind !== "fictional-fixture")
    || input.authorization.isolatedReadOnlyCopy !== true) {
    throw new Error("Explicit authorization and isolatedReadOnlyCopy attestation are required.");
  }
  if (!Array.isArray(input.sources) || input.sources.length === 0) {
    throw new Error("At least one explicit preflight source is required.");
  }
  if (!(input.types instanceof Map) && (!input.types || typeof input.types.get !== "function")) {
    throw new Error("An explicit read-only node manifest snapshot is required.");
  }
  const sourceIds = new Set<string>();
  for (const source of input.sources) {
    if (!source || !safeSourceId(source.sourceId)) throw new Error("Each source needs a stable non-path sourceId.");
    if (sourceIds.has(source.sourceId)) throw new Error("Duplicate sourceId is not allowed.");
    sourceIds.add(source.sourceId);
  }
  const root = assertIsolationRoot(input.isolationRoot);
  const types = new Map(input.types);
  const knownNativeNodeTypes = new Set(input.knownNativeNodeTypes ?? DEFAULT_NATIVE_NODE_TYPES);
  const rows: WorkflowMigrationPreflightRow[] = [];

  for (const source of input.sources) {
    const read = readSource(source, root);
    if (!("bytes" in read)) {
      const row = makeRow(source, 0, null, null);
      applySourceReadFailure(row, read);
      finalizeDecision(row);
      rows.push(row);
      continue;
    }
    const bytes = read.bytes;
    const contentHash = sha256(bytes);
    let rawValue: unknown;
    try {
      rawValue = parseJsonBytes(bytes);
    } catch {
      const row = makeRow(source, 0, contentHash, bytes.length);
      addReason(row, unreadableReason(
        "source-json-unreadable",
        "The source is not valid UTF-8 JSON or appears truncated/corrupt.",
        "Preserve the original bytes, obtain a complete export, and retry without repairing the source in place.",
      ));
      finalizeDecision(row);
      rows.push(row);
      continue;
    }

    const unsafeKey = unsafeJsonKeyPath(rawValue);
    if (unsafeKey !== null) {
      const row = makeRow(source, 0, contentHash, bytes.length);
      row.docId = source.kind === "workflow-doc" && isRecord(rawValue) && typeof rawValue.id === "string"
        ? safeLabel(rawValue.id) : null;
      row.engine = source.kind === "flows-json" ? "node-red" : "unknown";
      addReason(row, rejectReason(
        "unsafe-json-key",
        "The source contains an unsafe object key at " + redactSensitiveText(unsafeKey) + ".",
        "Remove the unsafe key in a reviewed copy while preserving the original export for audit.",
      ));
      finalizeDecision(row);
      rows.push(row);
      continue;
    }

    if (source.kind === "workflow-doc") {
      const row = makeRow(source, 0, contentHash, bytes.length);
      runWorkflowDocSource(row, source, rawValue, types);
      applyExpectedHashes(row, source, contentHash, row.revision,
        source.expectedRevision);
      finalizeDecision(row);
      rows.push(row);
      continue;
    }

    const preliminaryShape = nativeFlowShape(rawValue);
    const rowCount = preliminaryShape?.tabs.length ? preliminaryShape.tabs.length : 1;
    const sourceRows = Array.from({ length: rowCount }, (_, index) =>
      makeRow(source, index, contentHash, bytes.length));
    runFlowsJsonSource(sourceRows, source, rawValue, contentHash, bytes.length, types, knownNativeNodeTypes);
    for (const row of sourceRows) {
      const expectedRevision = row.docId === null ? undefined : source.expectedRevisionsByDocId?.[row.docId];
      applyExpectedHashes(row, source, contentHash, row.revision, expectedRevision);
      finalizeDecision(row);
      rows.push(row);
    }
  }

  // Duplicate representations from the same engine are ambiguous. The same
  // docId appearing once in each engine is allowed and is useful for G0 inventory.
  const byEngineAndId = new Map<string, WorkflowMigrationPreflightRow[]>();
  for (const row of rows) {
    if (row.docId === null || row.engine === "unknown") continue;
    const key = row.engine + "\u0000" + row.docId;
    const group = byEngineAndId.get(key) ?? [];
    group.push(row);
    byEngineAndId.set(key, group);
  }
  for (const group of byEngineAndId.values()) {
    if (group.length < 2) continue;
    for (const row of group) {
      addReason(row, rejectReason(
        "duplicate-document-representation",
        "More than one source row in the same engine claims this workflow identity.",
        "Preserve all source versions and reconcile identity/revision before proceeding.",
      ));
      finalizeDecision(row);
    }
  }

  rows.sort((a, b) => a.rowId.localeCompare(b.rowId));
  const counts = {
    safe: rows.filter((row) => row.decision === "SAFE").length,
    human: rows.filter((row) => row.decision === "HUMAN").length,
    reject: rows.filter((row) => row.decision === "REJECT").length,
    unreadable: rows.filter((row) => row.decision === "UNREADABLE").length,
  };
  const approvalSummary = {
    notRequired: rows.filter((row) => row.approval.state === "not-required").length,
    approved: rows.filter((row) => row.approval.state === "approved").length,
    pending: rows.filter((row) => row.approval.state === "pending").length,
    stale: rows.filter((row) => row.approval.state === "stale").length,
    corrupt: rows.filter((row) => row.approval.state === "corrupt").length,
    unknown: rows.filter((row) => row.approval.state === "unknown").length,
  };
  const inFlightSummary = {
    none: rows.filter((row) => row.inFlight.state === "none").length,
    active: rows.filter((row) => row.inFlight.state === "active").length,
    pendingTrigger: rows.filter((row) => row.inFlight.state === "pending-trigger").length,
    unknown: rows.filter((row) => row.inFlight.state === "unknown").length,
  };
  const rowsWithUnknownDependencies = rows.filter((row) =>
    row.unknownDependencies.unknownMcodeNodeTypes.length > 0
    || row.unknownDependencies.nativeOnlyNodeTypes.length > 0
    || row.unknownDependencies.unknownNativeNodeTypes.length > 0
    || row.unknownDependencies.unknownFieldPaths.length > 0
    || row.unknownDependencies.globalConfigNodeCount > 0
    || row.unknownDependencies.crossTabReferenceCount > 0
    || row.unknownDependencies.orphanedNodeCount > 0);
  const unknownDependencySummary = {
    rowsWithUnknownDependencies: rowsWithUnknownDependencies.length,
    unknownMcodeNodeTypeCount: rows.reduce((sum, row) => sum + row.unknownDependencies.unknownMcodeNodeTypes.length, 0),
    nativeOnlyNodeTypeCount: rows.reduce((sum, row) => sum + row.unknownDependencies.nativeOnlyNodeTypes.length, 0),
    unknownNativeNodeTypeCount: rows.reduce((sum, row) => sum + row.unknownDependencies.unknownNativeNodeTypes.length, 0),
    unknownFieldPathCount: rows.reduce((sum, row) => sum + row.unknownDependencies.unknownFieldPaths.length, 0),
    globalConfigNodeCount: rows.reduce((sum, row) => sum + row.unknownDependencies.globalConfigNodeCount, 0),
    crossTabReferenceCount: rows.reduce((sum, row) => sum + row.unknownDependencies.crossTabReferenceCount, 0),
    orphanedNodeCount: rows.reduce((sum, row) => sum + row.unknownDependencies.orphanedNodeCount, 0),
  };
  const gateReleaseTable: WorkflowPreflightGateStatus[] = [
    {
      gate: "G0",
      status: input.authorization.kind === "fictional-fixture" ? "fixture-only" : "manifest-only",
      activationAllowed: false,
      reason: "This report hashes supplied files only; it does not certify a complete SQL/runStore/approval/credential backup manifest.",
    },
    {
      gate: "G1",
      status: "dry-run-only",
      activationAllowed: false,
      reason: "Static fictional/export-copy preflight only; no trigger was fired and no native Deploy/GET/SQL/restart round-trip was performed.",
    },
    { gate: "G2", status: "blocked", activationAllowed: false, reason: "Requires per-document user consent, idle runs/approvals, native deploy/read-back, revision CAS, and rollback evidence." },
    { gate: "G3", status: "blocked", activationAllowed: false, reason: "Requires isolated shadow traces, cross-process restart/crash tests, and continuous correlation evidence." },
    { gate: "G4", status: "blocked", activationAllowed: false, reason: "Requires G0-G3 fully green, two real process restarts, and verified history/approval recovery." },
    { gate: "G5", status: "blocked", activationAllowed: false, reason: "Requires all migrated workflows verified and an independent signed retirement review." },
  ];
  const manifestWithoutHash = {
    apiVersion: WORKFLOW_PREFLIGHT_API_VERSION,
    gate: "G0-G1" as const,
    gateReleaseTable,
    sourceAuthorization: input.authorization.kind,
    sourceCount: input.sources.length,
    scannedCount: rows.length,
    counts,
    unreadableCount: counts.unreadable,
    approvalSummary,
    inFlightSummary,
    unknownDependencySummary,
    activationAllowed: false as const,
    rows,
  };
  if (counts.safe + counts.human + counts.reject + counts.unreadable !== rows.length) {
    throw new Error("Internal preflight count invariant failed.");
  }
  return { ...manifestWithoutHash, manifestHash: sha256(canonicalJson(manifestWithoutHash)) };
}
