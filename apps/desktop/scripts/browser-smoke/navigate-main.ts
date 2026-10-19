/**
 * `BrowserManager.waitForLoad` 的 cookie 恢复时序回归(**MC-045**)。
 *
 * ## 它治的是哪一类 bug
 *
 * `loadUrl()` 把真正的 `wc.loadURL()` 排在 `live.ready`(cookie 保管库注入)**之后**;
 * 而 `waitForLoad()` 从前**不等** `ready` 就直接看 `isLoading()`。cookie 恢复慢时
 * (磁盘/解密开销),调用端在恢复还没完成时来问"加载完了吗" —— 那一刻 `loadURL()` 根本
 * 还没被调到,`isLoading()` 是 false,于是 `waitForLoad` 把**上一页 / about:blank**
 * 判成"目标页加载成功"。模型于是对着一张空白页做 snapshot/screenshot。
 *
 * ## 判据立在哪
 *
 * 立在**结果**上:挂起 cookie 恢复的闸门 → `loadUrl()` → 在闸门还锁着时调
 * `waitForLoad()`。**若 `waitForLoad` 不等 `ready`**,它会在闸门放行前就 resolve,
 * 报出 `url=about:blank`(旧页)—— 断言就在这个"返回的 url 不是目标页 / 在放行前
 * 就返回了"上。修复后它必须等到闸门放行、`loadURL` 真跑完,才带着目标 url 返回。
 *
 * ## 它不碰用户的任何东西
 *
 * 数据根走 `MCODE_SMOKE_DATA_ROOT`(run.sh 的 `mktemp -d`);cookie 保管库是**造**出来
 * 的一条设置行,指向一个假的 session。electron 是功能替身,不起真窗口、不连网。
 *
 * Run: bash scripts/browser-smoke/run.sh(见 run.sh 里第二段 esbuild)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total += 1;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

const DATA = mkdtempSync(join(tmpdir(), "mcode-browser-nav-"));
process.env.MCODE_SMOKE_DATA_ROOT = DATA;

const { initDb } = await import("@main/store/db.js");
const { SettingRepo, ProjectRepo } = await import("@main/store/repositories.js");
const { BrowserManager } = await import("@main/browser/BrowserManager.js");
const el = await import("./navigate-stubs/electron.js");
const { BROWSER_PERSIST_LOGIN_SETTING_KEY, BROWSER_COOKIE_VAULT_SETTING_KEY, BROWSER_COOKIE_VAULT_ENC_SETTING_KEY, BROWSER_ADDRESS_HISTORY_SETTING_KEY } = await import("@contracts/ipc");

await initDb();

const PROJECT = join(DATA, "项目");
ProjectRepo.create({
  id: "p_nav",
  name: "nav",
  path: PROJECT,
  archived: false,
  sortOrder: 0,
  pinnedAt: null,
  createdAt: 1,
  updatedAt: 1,
});

console.log("\nMC-045:cookie 恢复未就绪时,导航结果不得把旧页/空白页误报为加载成功");

// 造一条持久 cookie 保管库(明文,明文分支不需要钥匙串),它会驱动 restoreCookieVault
// 去 `cookies.set()` —— 而那一步被闸门挂起。于是 `live.ready` 在闸门放行前不会 resolve。
SettingRepo.set(BROWSER_PERSIST_LOGIN_SETTING_KEY, "1");
SettingRepo.set(
  BROWSER_COOKIE_VAULT_SETTING_KEY,
  JSON.stringify([
    { name: "sid", value: "x", domain: "example.com", hostOnly: true, path: "/", secure: true, httpOnly: true },
  ]),
);

// 挂起 cookie 闸门 —— 模拟"恢复得慢"。
el.armCookieGate();

const created = BrowserManager.create(PROJECT, "desktop");
check("守卫:create 成功(不是在空台上跑)", (created as { ok: boolean }).ok === true, created);
const browserId = (created as { browserId: string }).browserId;

/* ── ARC-005: bad address history must not break real navigation events ── */
{
  const webContents = el.liveWebContents[el.liveWebContents.length - 1];
  const invalidHistory = "{truncated";
  const warnings: string[] = [];
  const oldWrite = process.stderr.write;
  process.stderr.write = ((chunk: unknown, ..._args: unknown[]) => {
    const line = String(chunk);
    if (line.includes("browser history write refused")) warnings.push(line);
    return true;
  }) as typeof process.stderr.write;
  try {
    SettingRepo.set(BROWSER_ADDRESS_HISTORY_SETTING_KEY, invalidHistory);
    webContents.emit("did-navigate", null, "https://fake-history.test");
    webContents.emit("page-title-updated", null, "fake title");
    check("★ 历史损坏时原生 did-navigate / title 事件不抛异常", true);
    check("★ 自动历史写入失败必须有诊断且不被标题更新刷屏", warnings.length === 1, warnings);
    check("★ 两次事件未覆盖损坏历史原始字节", SettingRepo.get(BROWSER_ADDRESS_HISTORY_SETTING_KEY) === invalidHistory);

    SettingRepo.set(BROWSER_ADDRESS_HISTORY_SETTING_KEY, "[]");
    webContents.emit("did-navigate", null, "https://history-recovered.test");
    check("★ 修复存档后正常导航重新可以写入历史",
      (SettingRepo.get(BROWSER_ADDRESS_HISTORY_SETTING_KEY) ?? "").includes("https://history-recovered.test"));
    SettingRepo.set(BROWSER_ADDRESS_HISTORY_SETTING_KEY, invalidHistory);
    webContents.emit("did-navigate", null, "https://fake-history-again.test");
    check("★ 经过成功写入后发生的新损坏仍会报告", warnings.length === 2, warnings);
    check("★ 新损坏不会被导航再次覆盖", SettingRepo.get(BROWSER_ADDRESS_HISTORY_SETTING_KEY) === invalidHistory);
  } finally {
    process.stderr.write = oldWrite;
    SettingRepo.set(BROWSER_ADDRESS_HISTORY_SETTING_KEY, "[]");
  }
}

// 与真实调用方同一顺序:`browserNavigate` 先 loadUrl 再 waitForLoad。loadUrl 会把真正的
// `wc.loadURL()` 排在 `live.ready` 之后 —— 所以闸门锁着时导航根本还没开始。
const target = "https://target.test/page";
const loadRes = BrowserManager.loadUrl(browserId, target);
check("守卫:loadUrl 接受了目标 URL", (loadRes as { ok: boolean }).ok === true, loadRes);

// 让 create/loadUrl 里那些同步/微任务先排到,但闸门仍锁着 —— 此刻 ready 尚未 resolve。
await new Promise((r) => setTimeout(r, 0));

// 关键:此时导航还没开始(isLoading=false,url 是 "")。修复前 waitForLoad 会在这里
// 就返回"成功",url 是空白/旧页;修复后它会阻塞到闸门放行。
let settledEarly: { ok: boolean; url?: string } | null = null;
const waitPromise = BrowserManager.waitForLoad(browserId, 5000).then((r) => {
  settledEarly = r;
  return r;
});

// 给 waitForLoad 一个"提前返回"的机会:闸门还锁着时它不该 settle。等得比修复前那条
// "isLoading 为 false → 停 200ms 再看一眼 → 报当前 url"的窗口更久(300 > 200),
// 修前它必然已经带着空 url 返回;修后它仍卡在 `await ready` 上(闸门没放行)。
await new Promise((r) => setTimeout(r, 300));
check(
  "★ 闸门还锁着时 waitForLoad 没有提前 settle(不等 cookie 恢复就会把空白页当成功)",
  settledEarly === null,
  { settledEarly, note: "非 null 表示它在 cookie 恢复前就返回了(修复前 url 会是空串)" },
);

// 放行闸门 —— cookie 恢复完成,loadURL 才真正跑起来。
el.releaseCookieGate();
const loaded = await waitPromise;

check("闸门放行后 waitForLoad 正常返回 ok", loaded.ok === true, loaded);
// 修复前:settledEarly 会是 { ok:true, url:"" }(旧页/空白)—— 上面第一条已红;这里钉死
// "最终返回的确实是被 loadURL 载入的目标页"。
check(
  "★ 返回的 url 是真被 loadURL 载入的目标页(不是恢复期间的空白 / 旧页)",
  loaded.url === target,
  { url: loaded.url, target },
);
check(
  "★ 它确实是等到 cookie 恢复之后才返回的(不是在空白页上立刻说成功)",
  settledEarly !== null,
  { early: settledEarly },
);

// 关掉浏览器,别留活视图。
BrowserManager.close(browserId);

/* ────────────────── MC-023:cookie 保管库永不落明文 ────────────────── */

console.log("\nMC-023:cookie 保管库(真 BrowserManager,假 session/假 safeStorage)");

// 造一批"凭据"给假 session 的 cookies.get() 返回 —— 落盘内容里绝不该出现这些原文。
const SECRET = "SECRET_SESSION_VALUE_42";
el.setFakeCookies([
  { name: "sid", value: SECRET, domain: "example.com", hostOnly: true, path: "/", secure: true, httpOnly: true },
]);

{
  // ① 加密不可用(默认):保存必须**拒写** —— 不落密文,更不落明文原文。
  el.setEncryptionAvailable(false);
  SettingRepo.set(BROWSER_PERSIST_LOGIN_SETTING_KEY, "1");
  SettingRepo.set(BROWSER_COOKIE_VAULT_SETTING_KEY, "");
  SettingRepo.set(BROWSER_COOKIE_VAULT_ENC_SETTING_KEY, "");
  const res = await BrowserManager.saveCookieVault();
  check("★ 加密不可用:保存如实报失败(ok=false),不假装成功", res.ok === false, res);
  check("★ 加密不可用:普通 settings 行里没有明文凭据原文", !(SettingRepo.get(BROWSER_COOKIE_VAULT_SETTING_KEY) ?? "").includes(SECRET), {
    row: SettingRepo.get(BROWSER_COOKIE_VAULT_SETTING_KEY),
  });
  check("★ 加密不可用:密文行也没有被写入", (SettingRepo.get(BROWSER_COOKIE_VAULT_ENC_SETTING_KEY) ?? "") === "", {
    enc: SettingRepo.get(BROWSER_COOKIE_VAULT_ENC_SETTING_KEY),
  });
  const st = BrowserManager.vaultStatus();
  check("★ 状态如实报「加密不可用 + 被拒原因」", st.encryptionAvailable === false && typeof st.lastError === "string" && st.lastError.length > 0, st);
}

{
  // ② 加密可用:走密文 —— 磁盘上没有原文,而恢复能解回来(登录态仍跨重启)。
  el.setEncryptionAvailable(true);
  const res = await BrowserManager.saveCookieVault();
  check("加密可用:保存成功", res.ok === true && res.saved === 1, res);
  const enc = SettingRepo.get(BROWSER_COOKIE_VAULT_ENC_SETTING_KEY) ?? "";
  check("★ 加密可用:落盘的是密文,不含凭据原文", enc.length > 0 && !enc.includes(SECRET), { encHead: enc.slice(0, 24) });
  check("★ 加密可用:上次被拒的原因被清掉", BrowserManager.vaultStatus().lastError === null, BrowserManager.vaultStatus());

  // 恢复(真路径):新 session 上注入 cookie —— 值应能解回原文。
  // (闸门只在 MC-045 那段用;这里直通,读假 session 记下的 set() 序列。)
  el.resetSetRecords();
  await BrowserManager.restoreCookieVaultForTest();
  const restored = el.setRecords();
  check("★ 密文保管库仍能恢复登录态到 session", restored.includes(`sid=${SECRET}`), restored);
}

{
  // ③ 旧版明文迁移:某台升级来的机器,旧的明文字段还在 → 恢复读一次注入后必须擦掉。
  el.setEncryptionAvailable(false);
  const legacyPlain = JSON.stringify([
    { name: "sid", value: SECRET, domain: "example.com", hostOnly: true, path: "/", secure: true, httpOnly: true },
  ]);
  SettingRepo.set(BROWSER_COOKIE_VAULT_SETTING_KEY, legacyPlain);
  SettingRepo.set(BROWSER_COOKIE_VAULT_ENC_SETTING_KEY, "");
  el.resetSetRecords();
  await BrowserManager.restoreCookieVaultForTest();
  const restored = el.setRecords();
  check("★ 旧明文先被读出来注入回 session(登录态不白丢)", restored.includes(`sid=${SECRET}`), restored);
  check(
    "★ 注入完成后明文字段被擦除(一次性迁移,不留第二份副本)",
    (SettingRepo.get(BROWSER_COOKIE_VAULT_SETTING_KEY) ?? "") === "",
    { row: SettingRepo.get(BROWSER_COOKIE_VAULT_SETTING_KEY) },
  );
  check("★ 状态如实报「擦过旧明文」", BrowserManager.vaultStatus().plaintextErased === true, BrowserManager.vaultStatus());
}

{
  // ④ 持久化被关闭:即使明文字段还在,也不该留着 —— 关掉后没有任何"下次登录"会用它的理由。
  SettingRepo.set(BROWSER_PERSIST_LOGIN_SETTING_KEY, "0");
  SettingRepo.set(BROWSER_COOKIE_VAULT_SETTING_KEY, "[]"); // 任意非空
  el.resetSetRecords();
  await BrowserManager.restoreCookieVaultForTest();
  const restored = el.setRecords();
  check("持久化关闭:什么都不恢复", restored.length === 0, restored);
  check("★ 持久化关闭:明文行被擦(躺着的凭据不留)", (SettingRepo.get(BROWSER_COOKIE_VAULT_SETTING_KEY) ?? "") === "", {
    row: SettingRepo.get(BROWSER_COOKIE_VAULT_SETTING_KEY),
  });
  SettingRepo.set(BROWSER_PERSIST_LOGIN_SETTING_KEY, "1");
}

{
  // ⑤ 加密"可用"、但 encryptString 抛错(钥匙串锁定/权限):同样必须拒写 ——
  //    不落密文、不落明文,且原因要能从 vaultStatus() 读到(设置页可见)。
  el.setEncryptionAvailable(true);
  el.setEncryptThrows(true);
  SettingRepo.set(BROWSER_COOKIE_VAULT_ENC_SETTING_KEY, "");
  SettingRepo.set(BROWSER_COOKIE_VAULT_SETTING_KEY, "");
  const res = await BrowserManager.saveCookieVault();
  check("★ 加密抛错:保存如实报失败(ok=false),不假装成功", res.ok === false, res);
  check("★ 加密抛错:密文行没有被写入", (SettingRepo.get(BROWSER_COOKIE_VAULT_ENC_SETTING_KEY) ?? "") === "", {
    enc: SettingRepo.get(BROWSER_COOKIE_VAULT_ENC_SETTING_KEY),
  });
  check("★ 加密抛错:普通 settings 行里没有明文凭据原文", !(SettingRepo.get(BROWSER_COOKIE_VAULT_SETTING_KEY) ?? "").includes(SECRET), {
    row: SettingRepo.get(BROWSER_COOKIE_VAULT_SETTING_KEY),
  });
  const st = BrowserManager.vaultStatus();
  check("★ 加密抛错:状态报出可见原因(不是只进日志)", typeof st.lastError === "string" && st.lastError.length > 0, st);
  el.setEncryptThrows(false);
}

{
  // ⑥ 解密失败 ≠ 没有 Cookie。密文在、钥匙串在,但内容解不开(如来自另一个系统用户 /
  //    密钥环变了)—— 从前只写一行日志,状态页与「没存过」同形。现在必须报出可见错误。
  el.setEncryptionAvailable(true);
  SettingRepo.set(
    BROWSER_COOKIE_VAULT_ENC_SETTING_KEY,
    Buffer.from("ciphertext-from-another-keychain").toString("base64"),
  );
  SettingRepo.set(BROWSER_COOKIE_VAULT_SETTING_KEY, "");
  el.resetSetRecords();
  await BrowserManager.restoreCookieVaultForTest();
  const st = BrowserManager.vaultStatus();
  check(
    "★ 解密失败:没有被当成「没有 Cookie」静默吞掉 —— 状态报出可见原因",
    typeof st.restoreError === "string" && st.restoreError.length > 0,
    st,
  );
  check("解密失败:没有任何 cookie 被注入(守卫,防空过)", el.setRecords().length === 0, el.setRecords());
}

{
  // ⑦ 健康路径:密文可解 → 恢复成功,restoreError 必须清空(防「永远在报」的假修复,
  //    也防 ⑥ 的原因黏住后续正常启动)。
  const healthyVault = JSON.stringify([
    { name: "sid", value: SECRET, domain: "example.com", hostOnly: true, path: "/", secure: true, httpOnly: true },
  ]);
  SettingRepo.set(BROWSER_COOKIE_VAULT_ENC_SETTING_KEY, Buffer.from(`enc:${healthyVault}`, "utf8").toString("base64"));
  el.resetSetRecords();
  await BrowserManager.restoreCookieVaultForTest();
  const st = BrowserManager.vaultStatus();
  check("★ 健康路径:密文保管库能恢复登录态", el.setRecords().includes(`sid=${SECRET}`), el.setRecords());
  check("★ 健康路径:恢复成功后没有残留错误(防「永远在报」)", st.restoreError === null, st);
}

{
  // ⑧ 有可恢复的条目、但会话全部拒绝注入:这是「登录态没恢复」而不是「没有 Cookie」,
  //    状态页必须如实报(从前只有逐条 warn,汇总口径一片空白)。
  const healthyVault = JSON.stringify([
    { name: "sid", value: SECRET, domain: "example.com", hostOnly: true, path: "/", secure: true, httpOnly: true },
  ]);
  SettingRepo.set(BROWSER_COOKIE_VAULT_ENC_SETTING_KEY, Buffer.from(`enc:${healthyVault}`, "utf8").toString("base64"));
  el.setCookiesSetThrows(true);
  el.resetSetRecords();
  await BrowserManager.restoreCookieVaultForTest();
  el.setCookiesSetThrows(false);
  const st = BrowserManager.vaultStatus();
  check(
    "★ 全部注入被拒:状态如实报「登录态没有恢复」(不是静默空)",
    typeof st.restoreError === "string" && st.restoreError.length > 0,
    st,
  );
  check("全部注入被拒:确实没有 cookie 落进 session(守卫)", el.setRecords().length === 0, el.setRecords());
}

rmSync(DATA, { recursive: true, force: true });

console.log(`\nbrowser-smoke(navigate):${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
