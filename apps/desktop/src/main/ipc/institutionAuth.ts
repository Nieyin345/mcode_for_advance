/**
 * 「机构认证」IPC。
 *
 * ## 这一层为什么这么薄
 *
 * 本功能**不管理凭据**。真正的登录态存在于内嵌浏览器共用的持久化分区
 * (`persist:mcode-browser`)里,由 `BrowserManager` 的 cookie 保管库负责持久化。
 * 用户在内嵌浏览器里登录任何站点(知网 / 学校图书馆代理 / 出版商),登录态就落在
 * 那里,下载时 Chromium 自动带上。
 *
 * 因此这里只做两件事:
 *   1. 维护一份**入口档案**(名字 / 登录地址 / 域名)—— 纯组织性记录,不含凭据;
 *   2. 从分区的 cookie **反推**「已登录哪些站点」,让用户看得见凭据覆盖范围。
 *
 * 之所以不按机构分独立凭据空间:用户明确要求认证「偏通用、不限制具体机构」。
 * 共用分区正好满足 —— 在哪里登录都算数,无需先声明机构才能登录。
 */
import type { IpcMain } from "electron";
import { z } from "zod";
import { errText, describeInputError } from "@main/lib/ipcError.js";
import {
  IPC,
  InstitutionSaveSchema,
  InstitutionDeleteSchema,
  InstitutionAuthStatusSchema,
  InstitutionClearCookiesSchema,
} from "@contracts/ipc";
import type { AuthSiteStatus, InstitutionProfile } from "@contracts/library";
import { InstitutionRepo } from "@main/store/repositories.js";
import { getBrowserCookies, clearBrowserCookiesForDomains } from "@main/browser/BrowserManager.js";
import { log } from "@main/lib/logger.js";

/** 去掉 cookie domain 的前导点(`.example.com` → `example.com`),便于展示与匹配。 */
function bareDomain(domain: string): string {
  return domain.startsWith(".") ? domain.slice(1) : domain;
}

/** `host` 是否属于 `domain`(含相等与子域)。用于把 cookie 归到机构档案名下。 */
function domainMatches(host: string, domain: string): boolean {
  const h = bareDomain(host).toLowerCase();
  const d = bareDomain(domain).toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

/**
 * 从浏览器分区的实时 cookie 推导登录态概览。
 *
 * 聚合粒度是**去掉前导点后的域**。同一域下的多个 cookie 合成一条,`expiresAt`
 * 取其中最晚的过期时间 —— 用户关心的是「这个站还能用多久」,而不是某一条 cookie。
 */
async function deriveAuthSites(profiles: InstitutionProfile[]): Promise<AuthSiteStatus[]> {
  const cookies = await getBrowserCookies({});
  const byDomain = new Map<string, { count: number; expiresAt?: number }>();

  for (const c of cookies) {
    if (!c.domain) continue;
    const key = bareDomain(c.domain).toLowerCase();
    const entry = byDomain.get(key) ?? { count: 0 };
    entry.count += 1;
    // Electron 的 expirationDate 是秒级;会话 cookie 没有该字段
    if (typeof c.expirationDate === "number") {
      entry.expiresAt = Math.max(entry.expiresAt ?? 0, c.expirationDate);
    }
    byDomain.set(key, entry);
  }

  const sites: AuthSiteStatus[] = [];
  for (const [domain, info] of byDomain) {
    sites.push({
      domain,
      cookieCount: info.count,
      expiresAt: info.expiresAt,
      matchedProfileIds: profiles
        .filter((p) => p.domains.some((d) => domainMatches(domain, d)))
        .map((p) => p.id),
    });
  }
  // 有配档案的排前面,其次按域名;让用户先看到自己关心的那几个
  return sites.sort((a, b) => {
    const aMatched = a.matchedProfileIds.length > 0 ? 0 : 1;
    const bMatched = b.matchedProfileIds.length > 0 ? 0 : 1;
    if (aMatched !== bMatched) return aMatched - bMatched;
    return a.domain.localeCompare(b.domain);
  });
}

export function registerInstitutionAuthHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.INSTITUTION_LIST, async () => {
    return { profiles: InstitutionRepo.list() };
  });

  ipcMain.handle(IPC.INSTITUTION_SAVE, async (_evt, raw) => {
    let input;
    try {
      input = InstitutionSaveSchema.parse(raw);
    } catch (err) {
      throw new Error(errText(err));
    }
    InstitutionRepo.save({
      id: input.id,
      name: input.name,
      loginUrl: input.loginUrl,
      domains: input.domains,
      proxyPrefix: input.proxyPrefix,
      notes: input.notes,
    });
    // 变更类一律返回完整新列表,渲染端整体替换缓存(既定模式)
    return { profiles: InstitutionRepo.list() };
  });

  ipcMain.handle(IPC.INSTITUTION_DELETE, async (_evt, raw) => {
    let input;
    try {
      input = InstitutionDeleteSchema.parse(raw);
    } catch (err) {
      throw new Error(errText(err));
    }
    // 注意:删档案**不会**登出任何站点 —— 档案与登录态是两回事
    InstitutionRepo.delete(input.id);
    return { profiles: InstitutionRepo.list() };
  });

  ipcMain.handle(IPC.INSTITUTION_AUTH_STATUS, async (_evt, raw) => {
    let input;
    try {
      input = InstitutionAuthStatusSchema.parse(raw ?? {});
    } catch (err) {
      throw new Error(errText(err));
    }
    let sites = await deriveAuthSites(InstitutionRepo.list());
    if (input.domains?.length) {
      sites = sites.filter((s) => input.domains!.some((d) => domainMatches(s.domain, d)));
    }
    return { sites };
  });

  ipcMain.handle(IPC.INSTITUTION_CLEAR_COOKIES, async (_evt, raw) => {
    let input;
    try {
      input = InstitutionClearCookiesSchema.parse(raw ?? {});
    } catch (err) {
      throw new Error(errText(err));
    }
    try {
      // ⚠️ 分支判据是 `Array.isArray`(「有没有给域名列表」),**不是** `.length`。
      //
      // 契约里写的是「**省略**则清空整个浏览器分区(危险,UI 需二次确认)」—— 说话的是
      // "有没有这个字段",而不是"这个数组里有几项"。原来这里判 `input.domains?.length`,
      // 于是 `domains: []`(空数组)和 `domains: undefined`(省略)落进了**同一个**清空
      // 整个分区的分支:调用方给了一个明确的空列表,收到的却是"全清"。一个字符之差触发
      // 全量登出,而两种结果在界面上长得一模一样(返回的空列表在两种语义下都是空)。
      //
      // 想清全部的调用方有明确写法:省略 `domains`(preload 的 `clearCookies({})`)。
      if (Array.isArray(input.domains)) {
        // 空列表 = 没有要清的域,什么都不做(也别去碰 cookie 存储)。
        if (input.domains.length === 0) return { sites: await deriveAuthSites(InstitutionRepo.list()) };
        const removed = await clearBrowserCookiesForDomains(input.domains);
        log.info(`institution: cleared ${removed} cookies across ${input.domains.length} domains`);
      } else {
        // 省略 domains = 清空整个浏览器分区。UI 必须二次确认。
        const all = await getBrowserCookies({});
        const domains = [...new Set(all.map((c) => c.domain).filter((d): d is string => !!d))];
        const removed = await clearBrowserCookiesForDomains(domains);
        log.info(`institution: cleared ALL browser cookies (${removed} across ${domains.length} domains)`);
      }
    } catch (err) {
      log.error(`institution.clearCookies: ${(err as Error).message}`);
      throw err;
    }
    return { sites: await deriveAuthSites(InstitutionRepo.list()) };
  });
}
