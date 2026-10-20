/** ARC-006 Gate D: parse the exact native flows.json that Node-RED starts.
 * No writes or user DB; malformed/foreign flows fail closed.
 */
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecutorOwnershipRegistry } from "./executorOwnership.js";

export function nativeFlowIds(dataDir: string): string[] {
  const path = join(dataDir, "flows.json");
  let raw: string;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("flows.json 不是普通文件");
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("Node-RED flow 归属预检失败：" + (err instanceof Error ? err.message : String(err)));
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("Node-RED flows.json 损坏：拒绝在未知 flow 上启用触发器"); }
  return nativeFlowIdsOfNodes(parsed);
}

/** Migrate native tabs into a disjoint Node-RED namespace, Mcode tabs into docIds.
 * This same identity extraction is used for startup and authenticated Admin deploy. */
export function nativeFlowIdsOfNodes(parsed: unknown): string[] {
  if (!Array.isArray(parsed)) throw new Error("Node-RED flows.json 不是节点数组");
  const tabs = new Map<string, string>();
  for (const value of parsed) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Node-RED flows.json 包含非法节点");
    }
    const node = value as Record<string, unknown>;
    if (typeof node["id"] !== "string" || node["id"].length === 0 ||
        typeof node["type"] !== "string") throw new Error("Node-RED 节点缺少 id/type");
    if (node["type"] !== "tab") continue;
    const sidecar = node["x-mcode"];
    const docId = sidecar !== null && typeof sidecar === "object" && !Array.isArray(sidecar)
      ? (sidecar as Record<string, unknown>)["docId"] : null;
    if (sidecar !== undefined && (typeof docId !== "string" || docId.trim() !== docId ||
        docId.length === 0 || docId.length > 512 || /[\u0000-\u001f\u007f]/.test(docId))) {
      throw new Error("Node-RED tab " + node["id"] + " 的 x-mcode.docId 不合法");
    }
    if (tabs.has(node["id"] as string)) throw new Error("Node-RED 重复 tab id");
    // Native-only Node-RED tabs have no Mcode counterpart and cannot use a
    // Mcode docId. Keep them isolated under an engine-specific identity.
    tabs.set(node["id"] as string, typeof docId === "string" ? docId : "@node-red-native:" + node["id"]);
  }
  if (parsed.length > 0 && tabs.size === 0) {
    throw new Error("Node-RED flows.json 没有可归属的 Mcode tab：拒绝未知触发源");
  }
  for (const value of parsed) {
    const node = value as Record<string, unknown>;
    if (node["type"] === "tab") continue;
    const z = node["z"];
    // Global config nodes have no z; nodes in a flow must belong to a known tab.
    if (typeof z === "string" && z.length > 0 && !tabs.has(z)) {
      throw new Error("Node-RED 节点 " + node["id"] + " 所属 tab 未登记：拒绝启动");
    }
  }
  const ids = [...tabs.values()];
  if (new Set(ids).size !== ids.length) throw new Error("Node-RED 多个 tab 指向同一 Mcode flow：拒绝重复触发");
  return ids;
}

/** Reserve all flows before spawning, rolling back partial reservations. */
export function claimNativeFlows(ownership: ExecutorOwnershipRegistry, flowIds: readonly string[]): string[] {
  const acquired: string[] = [];
  try {
    for (const flowId of flowIds) {
      const claim = ownership.claim(flowId, "node-red", { reason: "Node-RED runtime starting", now: Date.now });
      if (!claim.ok || claim.alreadyOwned) {
        throw new Error(!claim.ok ? claim.reason : "Node-RED flow「" + flowId + "」已有同端 owner，但本进程无租约");
      }
      acquired.push(flowId);
    }
    return acquired;
  } catch (err) {
    for (const id of acquired.reverse()) ownership.release(id, "node-red");
    throw err;
  }
}
