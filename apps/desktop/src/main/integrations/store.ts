/**
 * 外部集成的存储层。
 *
 * 与 `CustomModelStore`(main/lib/secretStore.ts)同一套做法:
 *
 *   - **非密钥**元数据(是否启用 / base url / 上次测试结果)→ settings 的
 *     `INTEGRATIONS_SETTING_KEY`,一个 JSON 对象
 *   - **密钥** → settings 的 `INTEGRATIONS_KEYS_SETTING_KEY`,值是 safeStorage
 *     加密后的 base64;明文永不落盘
 *
 * 对外只给 {@link IntegrationPublic} 这种打码投影。唯一能拿到明文的是
 * {@link IntegrationStore.resolve},**主进程内部用,绝不能跨 IPC**。
 */
import { encrypt, decrypt } from "@main/lib/secretStore.js";
import { SettingRepo } from "@main/store/repositories.js";
import { log } from "@main/lib/logger.js";
import { INTEGRATIONS_SETTING_KEY, INTEGRATIONS_KEYS_SETTING_KEY } from "@contracts/ipc";
import {
  INTEGRATION_CATALOG,
  maskKey,
  type IntegrationId,
  type IntegrationPublic,
  type IntegrationTestResult,
} from "@contracts/integrations";

interface IntegrationEntry {
  baseUrl?: string;
  enabled?: boolean;
  lastTest?: IntegrationTestResult | null;
}

type MetaMap = Partial<Record<IntegrationId, IntegrationEntry>>;
type KeyMap = Partial<Record<IntegrationId, string>>;

/** 读 JSON 设置。坏值不抛 —— 类目少、值畸形只会难用,不该让整个面板打不开。 */
function readJson<T>(key: string): T {
  try {
    const raw = SettingRepo.get(key);
    if (!raw) return {} as T;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as T) : ({} as T);
  } catch {
    return {} as T;
  }
}

function readMeta(): MetaMap {
  return readJson<MetaMap>(INTEGRATIONS_SETTING_KEY);
}

function readKeys(): KeyMap {
  return readJson<KeyMap>(INTEGRATIONS_KEYS_SETTING_KEY);
}

function writeMeta(meta: MetaMap): void {
  SettingRepo.set(INTEGRATIONS_SETTING_KEY, JSON.stringify(meta));
}

function writeKeys(keys: KeyMap): void {
  SettingRepo.set(INTEGRATIONS_KEYS_SETTING_KEY, JSON.stringify(keys));
}

/** 解一条密钥。safeStorage 的密文绑定操作系统用户(DPAPI),换机器/换用户会解不开
 *  —— 那时候当作「没配」,而不是抛出去把设置面板打崩。 */
function decryptKey(stored: string | undefined): string {
  if (!stored) return "";
  try {
    return decrypt(stored);
  } catch (err) {
    log.warn(`integration key undecryptable (machine/user changed?): ${(err as Error).message}`);
    return "";
  }
}

function catalogOf(id: IntegrationId) {
  return INTEGRATION_CATALOG.find((e) => e.id === id)!;
}

/** 合并写一条元数据。几个 setter 共用,写完统一回投影。 */
function patchMeta(id: IntegrationId, patch: IntegrationEntry): IntegrationPublic[] {
  const meta = readMeta();
  meta[id] = { ...meta[id], ...patch };
  writeMeta(meta);
  return IntegrationStore.listPublic();
}

/** 生效的 base url:用户覆盖优先,否则目录默认值。尾部斜杠在这里统一去掉。 */
export function baseUrlOf(id: IntegrationId): string {
  const custom = readMeta()[id]?.baseUrl?.trim();
  const raw = custom || catalogOf(id).defaultBaseUrl;
  return raw.replace(/\/+$/, "");
}

export const IntegrationStore = {
  /** 目录里每个集成的当前状态(打码)。 */
  listPublic(): IntegrationPublic[] {
    const meta = readMeta();
    const keys = readKeys();
    return INTEGRATION_CATALOG.map((entry) => {
      const cleartext = decryptKey(keys[entry.id]);
      return {
        id: entry.id,
        configured: cleartext.length > 0,
        // 缺省视为启用 —— 刚配好 key 就能直接用的预期行为
        enabled: meta[entry.id]?.enabled ?? true,
        baseUrl: baseUrlOf(entry.id),
        keyMasked: maskKey(cleartext),
        lastTest: meta[entry.id]?.lastTest ?? null,
      } satisfies IntegrationPublic;
    });
  },

  /** 存/换密钥。传空串等于清除。 */
  setKey(id: IntegrationId, key: string): IntegrationPublic[] {
    const keys = readKeys();
    const trimmed = key.trim();
    if (!trimmed) delete keys[id];
    else keys[id] = encrypt(trimmed);
    writeKeys(keys);
    // 换了密钥,上次的测试结论就失效了 —— 清掉,避免显示一个过期的「可用」
    return patchMeta(id, { lastTest: null });
  },

  clearKey(id: IntegrationId): IntegrationPublic[] {
    const keys = readKeys();
    delete keys[id];
    writeKeys(keys);
    return patchMeta(id, { lastTest: null });
  },

  setConfig(id: IntegrationId, patch: { baseUrl?: string; enabled?: boolean }): IntegrationPublic[] {
    const next: IntegrationEntry = {};
    if (patch.baseUrl !== undefined) next.baseUrl = patch.baseUrl.trim();
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    return patchMeta(id, next);
  },

  /** 记录一次连通性测试的结果。 */
  recordTest(id: IntegrationId, result: IntegrationTestResult): IntegrationPublic[] {
    return patchMeta(id, { lastTest: result });
  },

  /**
   * 主进程内部用:拿明文密钥 + 生效配置。
   * **返回值绝不能跨 IPC 边界** —— 里面是明文。
   */
  resolve(id: IntegrationId): { key: string; baseUrl: string; enabled: boolean } {
    const meta = readMeta();
    return {
      key: decryptKey(readKeys()[id]),
      baseUrl: baseUrlOf(id),
      enabled: meta[id]?.enabled ?? true,
    };
  },

};
