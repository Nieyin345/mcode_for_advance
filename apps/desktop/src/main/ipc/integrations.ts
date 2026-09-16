/**
 * 外部集成的 IPC。
 *
 * 唯一的明文入口是 `integrations.setKey` —— 收到即加密,之后所有返回值都是
 * {@link IntegrationPublic} 那种打码投影(见 store.ts 的说明)。
 */
import type { IpcMain } from "electron";
import {
  IPC,
  IntegrationClearKeySchema,
  IntegrationSetConfigSchema,
  IntegrationSetKeySchema,
  IntegrationTestSchema,
} from "@contracts/ipc";
import type { IntegrationId, IntegrationTestResult } from "@contracts/integrations";
import { IntegrationStore } from "@main/integrations/store.js";
import { mineruTest } from "@main/integrations/mineru.js";

/**
 * 按 id 分发到各家的连通性测试。**加新集成就在这里加一个 case** ——
 * 其余部分(存储、界面、打码、加密)都是通用的,不用动。
 */
async function testFor(
  id: IntegrationId,
  cfg: { key: string; baseUrl: string },
): Promise<IntegrationTestResult> {
  switch (id) {
    case "mineru":
      return mineruTest({ key: cfg.key, baseUrl: cfg.baseUrl });
  }
}

export function registerIntegrationHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.INTEGRATIONS_LIST, () => ({ integrations: IntegrationStore.listPublic() }));

  ipcMain.handle(IPC.INTEGRATIONS_SET_KEY, (_evt, raw) => {
    const input = IntegrationSetKeySchema.parse(raw);
    return { integrations: IntegrationStore.setKey(input.id, input.key) };
  });

  ipcMain.handle(IPC.INTEGRATIONS_CLEAR_KEY, (_evt, raw) => {
    const input = IntegrationClearKeySchema.parse(raw);
    return { integrations: IntegrationStore.clearKey(input.id) };
  });

  ipcMain.handle(IPC.INTEGRATIONS_SET_CONFIG, (_evt, raw) => {
    const input = IntegrationSetConfigSchema.parse(raw);
    return {
      integrations: IntegrationStore.setConfig(input.id, {
        baseUrl: input.baseUrl,
        enabled: input.enabled,
      }),
    };
  });

  ipcMain.handle(IPC.INTEGRATIONS_TEST, async (_evt, raw) => {
    const input = IntegrationTestSchema.parse(raw);
    // 测试要花几秒(要真的发一次请求),失败也必须落成一条结果而不是异常 ——
    // 用户点「测试」时看到的应该是红字说明,不是一个报错弹窗。
    let result: IntegrationTestResult;
    try {
      result = await testFor(input.id, IntegrationStore.resolve(input.id));
    } catch (err) {
      result = { ok: false, message: (err as Error).message, at: Date.now() };
    }
    return { integrations: IntegrationStore.recordTest(input.id, result) };
  });
}
