/**
 * `@main/lib/secretStore.js` 的替身 —— 只给无头脚本用。
 *
 * ## 为什么必须换掉
 *
 * 真那一份顶层 `import { safeStorage } from "electron"`(加密要一个真的 OS 钥匙串)，
 * 而且 `SettingRepo` 那条链会拉进 `db.ts` → electron。esbuild 把真的 `electron`
 * 包打进来之后，无头 node 会在 import 期就挂掉 —— 报的是
 * "Cannot determine intended module format"，看着和被测代码坏了没区别。
 *
 * ## 为什么存明文，以及这不是偷懒
 *
 * 这一套要验的是 **`ipc/customModel.ts` 那一层**(通道注册、入参校验、存进去读回来
 * 是不是同一份、删掉之后是不是真没了)，不是加密本身(那是 `secretStore.ts` 自己的
 * 事，有 electron 的钥匙串才谈得上)。
 *
 * ⚠️ 但**替身里必须存明文**，否则「读接口不会把明文吐出来」那条断言就是空过：
 * 真加密下 `authTokenMasked` 本来就是密文，而密文当然不等于明文 —— 那条断言会在
 * 「掩码逻辑被改成回传明文」时照样绿。存明文之后，掩码逻辑一旦坏掉，明文立刻出现在
 * `list()` 的返回值里，断言就红了。
 *
 * ## 边界：只实现被测代码用到的那几个方法
 *
 * `listPublic` / `save` / `remove` / `resolveApiConfig`。各自的行为**照真那份写**，
 * 特别是 `save` 找不到 id 时**抛**那句 `custom model not found` —— 这一套有一条断言
 * 钉的就是「更新一个不存在的 id 是报错，不是静默新建」。如果替身在这里悄悄兜底，
 * 那条断言测的就是替身而不是被测代码。
 */
import type {
  ApiConfig,
  AuthMode,
  CustomModelEntry,
  CustomModelInput,
  CustomModelPublic,
  Protocol,
} from "@contracts/customModel";
import { resolveProtocol } from "@contracts/customModel";

/** 一条记录在替身里的样子：真那份拆成 settings 表里的两条(`customModels` +
 *  `customModelKeys`)，这里合成一份，因为这一层验的不是拆表方式。 */
interface Record_ {
  id: string;
  name: string;
  baseUrl: string;
  authMode: AuthMode;
  protocol: Protocol;
  webSiteId?: string;
  models: CustomModelEntry[];
  subagentModel?: string;
  disableNonEssentialTraffic: boolean;
  timeoutMs?: number;
  customHeaders?: Record<string, string>;
  createdAt: number;
  /** 明文。真那份是密文(base64)，见文件头「为什么存明文」。 */
  token: string;
}

let records: Record_[] = [];
let seq = 0;

/** Mask a cleartext token the way the real store does (first 2 / last 4). */
function maskToken(plain: string): string {
  if (!plain) return "";
  if (plain.length <= 6) return "***";
  return `${plain.slice(0, 2)}***${plain.slice(-4)}`;
}

function toPublic(r: Record_): CustomModelPublic {
  return {
    id: r.id,
    name: r.name,
    baseUrl: r.baseUrl,
    authMode: r.authMode,
    protocol: r.protocol,
    webSiteId: r.webSiteId,
    authTokenMasked: maskToken(r.token),
    models: r.models,
    subagentModel: r.subagentModel,
    disableNonEssentialTraffic: r.disableNonEssentialTraffic,
    timeoutMs: r.timeoutMs,
    customHeaders: r.customHeaders,
    createdAt: r.createdAt,
  };
}

export const CustomModelStore = {
  listPublic(): CustomModelPublic[] {
    return records.map(toPublic);
  },

  save(input: CustomModelInput): CustomModelPublic[] {
    const authMode: AuthMode = input.authMode ?? "auth_token";
    const protocol = resolveProtocol(input.protocol);
    const validIds = new Set(input.models.map((m) => m.id));
    const subagentModel =
      input.subagentModel && validIds.has(input.subagentModel) ? input.subagentModel : undefined;
    if (input.id) {
      const idx = records.findIndex((r) => r.id === input.id);
      if (idx < 0) throw new Error(`custom model not found: ${input.id}`);
      const prev = records[idx];
      records[idx] = {
        ...prev,
        name: input.name,
        baseUrl: input.baseUrl,
        authMode,
        protocol,
        webSiteId: input.webSiteId,
        models: input.models,
        subagentModel,
        disableNonEssentialTraffic: input.disableNonEssentialTraffic ?? true,
        timeoutMs: input.timeoutMs,
        customHeaders: input.customHeaders,
        // 只在新 token 给了时才换（与真那份一致：不重填 = 保留原密钥）。
        token: input.authToken ? input.authToken : prev.token,
      };
    } else {
      const isWebProtocol = protocol === "web";
      if (!isWebProtocol && !input.authToken) {
        throw new Error("authToken is required when creating a custom model");
      }
      seq += 1;
      records.push({
        id: `cm_smoke_${seq}`,
        name: input.name,
        baseUrl: input.baseUrl,
        authMode,
        protocol,
        webSiteId: input.webSiteId,
        models: input.models,
        subagentModel,
        disableNonEssentialTraffic: input.disableNonEssentialTraffic ?? true,
        timeoutMs: input.timeoutMs,
        customHeaders: input.customHeaders,
        createdAt: 1_700_000_000_000 + seq,
        token: input.authToken ?? "",
      });
    }
    return this.listPublic();
  },

  remove(id: string): CustomModelPublic[] {
    records = records.filter((r) => r.id !== id);
    return this.listPublic();
  },

  /** 真那份的主进程内部才用的一条路。`getToken` handler 走的是它。 */
  resolveApiConfig(id: string, selected?: string): ApiConfig | undefined {
    const r = records.find((x) => x.id === id);
    if (!r) return undefined;
    if (!r.token && r.protocol !== "web") return undefined;
    const models = r.models.filter((m) => m.id.trim());
    if (models.length === 0) return undefined;
    const resolved = selected && models.some((m) => m.id === selected) ? selected : undefined;
    return {
      baseUrl: r.baseUrl,
      authToken: r.token,
      authMode: r.authMode,
      protocol: r.protocol,
      webSiteId: r.webSiteId,
      selectedModel: resolved ?? models[0].id,
      models,
      subagentModel: r.subagentModel,
      disableNonEssentialTraffic: r.disableNonEssentialTraffic,
      timeoutMs: r.timeoutMs,
      customHeaders: r.customHeaders,
    };
  },
};

/** 这一套自己用的：把库清空（每个段落之间互不干扰）。 */
export function __resetCustomModelStore(): void {
  records = [];
  seq = 0;
}
