/**
 * 外部集成(密钥 + 非密钥配置)的设置键与 RPC 入参。
 *
 * 从 `ipc.ts` 按域拆出(见该文件头)。
 */

import { z } from "zod";
import { INTEGRATION_IDS } from "../integrations.js";

/** 外部集成的非密钥配置(JSON):`{ [id]: { baseUrl?, enabled, lastTest? } }`。
 *  密钥不放这里 —— 见 INTEGRATIONS_KEYS_SETTING_KEY。 */
export const INTEGRATIONS_SETTING_KEY = "integrations.config";

/** 外部集成的密钥(JSON):`{ [id]: base64Ciphertext }`,safeStorage 加密。
 *  与自定义模型那条路同一套做法,明文永不落盘。 */
export const INTEGRATIONS_KEYS_SETTING_KEY = "integrations.keys";

export const IntegrationIdSchema = z.enum(INTEGRATION_IDS);

export const IntegrationSetKeySchema = z.object({
  id: IntegrationIdSchema,
  /** 明文密钥。**只有这一条通道会带明文进来**,主进程收到即加密,之后只回打码串。 */
  key: z.string().min(1),
});
export type IntegrationSetKeyInput = z.infer<typeof IntegrationSetKeySchema>;

export const IntegrationClearKeySchema = z.object({ id: IntegrationIdSchema });
export type IntegrationClearKeyInput = z.infer<typeof IntegrationClearKeySchema>;

export const IntegrationSetConfigSchema = z.object({
  id: IntegrationIdSchema,
  /** 覆盖默认 API 根地址(自建反代/镜像)。主进程会去掉尾部斜杠。 */
  baseUrl: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});
export type IntegrationSetConfigInput = z.infer<typeof IntegrationSetConfigSchema>;

export const IntegrationTestSchema = z.object({ id: IntegrationIdSchema });
export type IntegrationTestInput = z.infer<typeof IntegrationTestSchema>;

