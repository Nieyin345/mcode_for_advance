/**
 * Headless smoke for **引用时自动挂载关联**(一跳)。
 *
 * 用户的原话:「只要是引用的存在关联,就把关联的也挂上去,本身引用的也要挂上去」,
 * 而且「所有的这些文件,包括最开始的都是**平级的**」。这里验的就是这句话在
 * `attachToChat` 里落成了什么:
 *
 *  1. **一跳展开** —— 引用 A 时 A 和它直接关联的都挂上;A 的关联的关联**不挂**
 *     (A→B→C 只出 A、B 两条)。递归展开会在几张图之间无限绕,也会一次挂上几十条;
 *  2. **入口平级** —— 入口是第一个推出去的,后面那串与它同一种 chip(`i:<id>` 键)、
 *     同样参与去重。界面分不出哪个是"用户点的"、哪个是"带进来的",这正是要的;
 *  3. **只看正向** —— A 关联 B 时挂 B,不该把 A 一起带上(那是反向爆炸);
 *  4. **分类/整库不展开** —— 它们没有"自己的关联",只有条目有;
 *  5. **库外路径先导入成 linked 条目** —— 再按条目挂。反复引用同一个文件不该长出
 *     第二条(靠导入器的 filePath 去重);
 *  6. **目标没了就跳过并如实报** —— 一条关联都挂不上时 `error` 说得清有几条没挂上,
 *     而不是静默地少挂几个。
 *
 * ## 它不碰用户真正的数据根
 *
 * `dataRoot()` 换成 `$MCODE_SMOKE_DATA_ROOT`(复用 db-migrate-smoke 的 stubs),
 * run.sh 用 `mktemp -d` 建目录,跑完就删。
 *
 * Run: scripts/attach-links-smoke/run.sh
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDb } from "@main/store/db.js";
import { CollectionRepo, LibraryRepo, LibraryLinkRepo } from "@main/store/repositories.js";
import { attachToChat, writeCollectionManifest, writeKindManifest } from "@main/library/manifest.js";
import { loadLibraryGroups } from "@main/library/kindRegistry.js";
import { resetSuppressCacheForTest, saveSuppress } from "@main/library/suppress.js";
import { sent, resetSent, setFailNext } from "./stubs/window.js";

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/** 数组比较 —— `Object.is` 对两个内容相同的数组也是 false(不是同一个引用)。 */
function eqList(name: string, actual: string[], expected: string[]): void {
  check(name, actual.join("|") === expected.join("|"), { actual, expected });
}

await initDb();

const SID = "sess-1";

/** 推出去的这批 keys,按顺序。 */
const keysOf = (): string[] => sent.map((m) => m.key);

console.log("\n一跳展开:入口 + 直接关联");

{
  const a = LibraryRepo.upsert({ title: "A 主文件", kind: "note" });
  const b = LibraryRepo.upsert({ title: "B 关联文件", kind: "note" });
  const c = LibraryRepo.upsert({ title: "C 二级关联", kind: "note" });
  LibraryLinkRepo.add(a.id, { targetItemId: b.id });
  // B 也关联了 C —— 但引用 A 时**不该**把 C 带出来(只展开一跳)
  LibraryLinkRepo.add(b.id, { targetItemId: c.id });

  resetSent();
  const res = attachToChat(SID, `i:${a.id}`);
  check("挂载成功", res.ok, res);
  eq("推出去两条", sent.length, 2);
  eq("第一条是入口 A", keysOf()[0], `i:${a.id}`);
  eq("第二条是关联 B", keysOf()[1], `i:${b.id}`);
  check("C 没被带上(只有一跳)", !keysOf().includes(`i:${c.id}`), keysOf());
  eq("两条都是 library chip", sent.filter((m) => m.kind === "library").length, 2);
  eq("都发给了这个会话", sent.filter((m) => m.sessionId === SID).length, 2);
  check("每条都带清单路径", sent.every((m) => typeof m.manifestPath === "string" && m.manifestPath.length > 0));
  eq("入口那份清单的标题是 A", sent[0]?.name, "A 主文件");
  eq("关联那条的标题是 B", sent[1]?.name, "B 关联文件");
}

console.log("\n反向不展开:A 关联 B,挂 B 不该带上 A");

{
  const a = LibraryRepo.upsert({ title: "反向 A", kind: "note" });
  const b = LibraryRepo.upsert({ title: "反向 B", kind: "note" });
  LibraryLinkRepo.add(a.id, { targetItemId: b.id });

  resetSent();
  attachToChat(SID, `i:${b.id}`);
  eq("挂 B 只推一条", sent.length, 1);
  eq("就是 B 自己", keysOf()[0], `i:${b.id}`);
  check("A 没被带上", !keysOf().includes(`i:${a.id}`), keysOf());
}

console.log("\n一个关联多个:三条出边全挂上");

{
  const hub = LibraryRepo.upsert({ title: "枢纽", kind: "note" });
  const x = LibraryRepo.upsert({ title: "X", kind: "note" });
  const y = LibraryRepo.upsert({ title: "Y", kind: "note" });
  const z = LibraryRepo.upsert({ title: "Z", kind: "note" });
  LibraryLinkRepo.add(hub.id, { targetItemId: x.id });
  LibraryLinkRepo.add(hub.id, { targetItemId: y.id });
  LibraryLinkRepo.add(hub.id, { targetItemId: z.id });

  resetSent();
  attachToChat(SID, `i:${hub.id}`);
  eq("入口 + 三条关联 = 四条", sent.length, 4);
  eq("入口在最前", keysOf()[0], `i:${hub.id}`);
  const rest = keysOf().slice(1).sort();
  eqList("另外三条都在", rest, [`i:${x.id}`, `i:${y.id}`, `i:${z.id}`].sort());
}

console.log("\n分类 / 整库不展开");

{
  // 分类那条路:条目挂在分类里,条目之间也有关联 —— 但挂**分类**时不该逐条展开
  const a = LibraryRepo.upsert({ title: "分类里 A", kind: "note" });
  const b = LibraryRepo.upsert({ title: "分类里 B", kind: "note" });
  LibraryLinkRepo.add(a.id, { targetItemId: b.id });

  resetSent();
  const res = attachToChat(SID, "k:note");
  check("整库挂载成功", res.ok, res);
  eq("整库只推一条", sent.length, 1);
  eq("键是整库那个", keysOf()[0], "k:note");
}

console.log("\n库外路径:先导入成 linked 条目再挂");

{
  // 真在磁盘上放一个文件 —— 导入器要 existsSync 它
  const dir = mkdtempSync(join(tmpdir(), "mcode-attach-links-"));
  const outside = join(dir, "外部参考资料.md");
  writeFileSync(outside, "# 外部\n\n这是库外的一份参考。\n", "utf8");

  const host = LibraryRepo.upsert({ title: "宿主条目", kind: "note" });
  LibraryLinkRepo.add(host.id, { targetPath: outside });

  resetSent();
  const res = attachToChat(SID, `i:${host.id}`);
  check("挂载成功", res.ok, res);
  eq("入口 + 导入的那条 = 两条", sent.length, 2);
  eq("入口在前", keysOf()[0], `i:${host.id}`);

  const extraKey = keysOf()[1] ?? "";
  check("关联那条也是 i: 键(不是裸路径)", extraKey.startsWith("i:"), extraKey);
  const extraId = extraKey.slice(2);
  const imported = LibraryRepo.get(extraId);
  check("导入出来的条目在库里", imported !== null);
  eq("落法是 linked(文件不动)", imported?.entryMode, "linked");
  eq("记的是原绝对路径", imported?.filePath, outside);
  eq("标题取文件名去扩展名", imported?.title, "外部参考资料");

  // **反复引用同一个文件不该长出第二条** —— 这是"关联经常被引用"的常态
  const before = LibraryRepo.list({ limit: 1000 }).items.filter((i) => i.filePath === outside).length;
  resetSent();
  attachToChat(SID, `i:${host.id}`);
  const after = LibraryRepo.list({ limit: 1000 }).items.filter((i) => i.filePath === outside).length;
  eq("再挂一次还是同一条", after, before);
  eq("第二次也只推两条", sent.length, 2);
  eq("推的条目 id 没变", keysOf()[1], extraKey);

  rmSync(dir, { recursive: true, force: true });
}

console.log("\n关联目标没了:跳过,不静默");

{
  // 「目标没了」真正可达的那一种:**库外路径的文件被移走了**。
  // (库内条目被删时关联会级联走掉,见 library-registry-smoke —— 那种状态到不了这里。)
  const dir = mkdtempSync(join(tmpdir(), "mcode-attach-links-gone-"));
  const vanishing = join(dir, "待会儿就没了.md");
  writeFileSync(vanishing, "# 还在\n", "utf8");

  const host = LibraryRepo.upsert({ title: "宿主", kind: "note" });
  const good = LibraryRepo.upsert({ title: "还在的关联", kind: "note" });
  LibraryLinkRepo.add(host.id, { targetItemId: good.id });
  LibraryLinkRepo.add(host.id, { targetPath: vanishing });
  // 库外路径**不做级联**(那是文件系统的事),所以这条关联会留着 —— 移走文件,
  // 关联就指向了一个不存在的路径。
  rmSync(dir, { recursive: true, force: true });

  resetSent();
  const res = attachToChat(SID, `i:${host.id}`);
  check("挂载仍然成功", res.ok, res);
  eq("入口 + 还在的那条 = 两条", sent.length, 2);
  eq("入口在前", keysOf()[0], `i:${host.id}`);
  eq("带的是还在的那条", keysOf()[1], `i:${good.id}`);
  check("如实说了有 1 条没挂上", (res.error ?? "").includes("1"), res);
}

console.log("\n窗口没了:入口都推不出去就整体失败");

{
  const a = LibraryRepo.upsert({ title: "无窗口 A", kind: "note" });
  resetSent();
  setFailNext(true);
  const res = attachToChat(SID, `i:${a.id}`);
  check("返回失败", !res.ok, res);
  check("说清是窗口的问题", (res.error ?? "").includes("窗口"), res);
  eq("什么都没推出去", sent.length, 0);
  resetSent();
}

console.log("\n认不出的键 / 找不到的条目");

{
  resetSent();
  const bad = attachToChat(SID, "zz:whatever");
  check("认不出的前缀被拒", !bad.ok, bad);
  check("报错带上那个键", (bad.error ?? "").includes("zz:whatever"), bad);
  eq("没推任何东西", sent.length, 0);

  const missing = attachToChat(SID, "i:no-such-item");
  check("找不到的条目被拒", !missing.ok, missing);
  eq("没推任何东西(第二次)", sent.length, 0);
}

console.log("\n屏蔽:硬过滤,入口与关联一视同仁");

{
  // 建一套有层级的东西:大类 docs → 类型 note → 集合「精读队列」。
  // 三层的 id 都从现成的表里取 —— 组件里手写 id 的话,注册表一改这里就假绿。
  const groups = loadLibraryGroups();
  const docsGroup = groups.find((g) => g.id === "docs");
  check("出厂有 docs 大类", docsGroup !== undefined, groups.map((g) => g.id));
  check("docs 收着 note 类型", docsGroup?.kinds.includes("note") === true);

  const coll = CollectionRepo.create("精读队列", null, "note");
  const host = LibraryRepo.upsert({ title: "被屏蔽的宿主", kind: "note" });
  const linked = LibraryRepo.upsert({ title: "被屏蔽的关联", kind: "note" });
  CollectionRepo.assign(coll.id, [host.id, linked.id], true);

  // ① 按**集合**屏蔽:挂在那个集合里的条目整个挂不上,而且原因说得清
  resetSuppressCacheForTest();
  saveSuppress({ nodes: [`collection:${coll.id}`], extensions: [] });
  resetSent();
  const blocked = attachToChat(SID, `i:${host.id}`);
  check("被屏蔽的条目挂不上", !blocked.ok, blocked);
  check("原因里有集合名", (blocked.error ?? "").includes("精读队列"), blocked);
  check("原因说清了去哪儿改", (blocked.error ?? "").includes("设置"), blocked);
  eq("一条都没推出去", sent.length, 0);

  // ② **入口平级**:屏蔽的是"关联的那条"时,引用宿主 → 入口挂上、关联被挡下,
  //    而且如实说"另有几条被挡"。**入口不被特殊对待**是用户明确要的。
  resetSuppressCacheForTest();
  saveSuppress({ nodes: [`collection:${coll.id}`], extensions: [] });
  // 先把 host 移出集合(让入口放行),只留 linked 在里面
  CollectionRepo.assign(coll.id, [host.id], false);
  resetSuppressCacheForTest();
  LibraryLinkRepo.add(host.id, { targetItemId: linked.id });
  resetSent();
  const partial = attachToChat(SID, `i:${host.id}`);
  check("入口放行、整体成功", partial.ok, partial);
  eq("只推了入口一条", sent.length, 1);
  eq("推的是入口", keysOf()[0], `i:${host.id}`);
  check("如实说有条被屏蔽挡下", (partial.error ?? "").includes("屏蔽"), partial);

  // ③ **向下继承**:屏蔽「文档」大类 → 它下面的 note 条目同样挂不上
  resetSuppressCacheForTest();
  saveSuppress({ nodes: ["group:docs"], extensions: [] });
  resetSent();
  const byGroup = attachToChat(SID, `i:${host.id}`);
  check("屏蔽大类后小类下的条目也挂不上(向下继承)", !byGroup.ok, byGroup);
  check("原因指出是哪个大类", (byGroup.error ?? "").includes("文档"), byGroup);
  eq("一条都没推出去(继承)", sent.length, 0);

  // ④ 按**类型**屏蔽
  resetSuppressCacheForTest();
  saveSuppress({ nodes: ["type:note"], extensions: [] });
  resetSent();
  check("屏蔽类型后同样挂不上", !attachToChat(SID, `i:${host.id}`).ok);

  // ⑤ 按**扩展名**屏蔽 —— 条目在类型/集合上都放行,但它的文件后缀被挡
  resetSuppressCacheForTest();
  saveSuppress({ nodes: [], extensions: [".pdf"] });
  const pdfItem = LibraryRepo.upsert({ title: "一份 PDF", kind: "note" });
  LibraryRepo.setPdf(pdfItem.id, `papers/aa/bb/${pdfItem.id}.pdf`, "sha-fake");
  resetSent();
  const byExt = attachToChat(SID, `i:${pdfItem.id}`);
  check("按扩展名挡下", !byExt.ok, byExt);
  check("原因说明是哪种文件", (byExt.error ?? "").includes(".pdf"), byExt);

  // ⑥ **屏蔽是过滤,不是拒绝** —— 解除之后原来的挂载立刻恢复(这就是用户要的语义:
  //    改设定即可,不用去重建关联)
  resetSuppressCacheForTest();
  saveSuppress({ nodes: [], extensions: [] });
  resetSent();
  const restored = attachToChat(SID, `i:${pdfItem.id}`);
  check("解除屏蔽后恢复挂载", restored.ok, restored);
  eq("入口 + 关联都回来了", sent.length, 1);
}

console.log("\n屏蔽:整库与分类清单也过筛子");

{
  const c = CollectionRepo.create("含 PDF 的集合", null, "note");
  const md = LibraryRepo.upsert({ title: "Markdown 那份", kind: "note" });
  const pdf = LibraryRepo.upsert({ title: "PDF 那份", kind: "note" });
  LibraryRepo.setPdf(pdf.id, `papers/cc/dd/${pdf.id}.pdf`, "sha-fake-2");
  CollectionRepo.assign(c.id, [md.id, pdf.id], true);

  // 关闭屏蔽:两份都在清单里
  resetSuppressCacheForTest();
  saveSuppress({ nodes: [], extensions: [] });
  const full = writeCollectionManifest(c.id);
  eq("没屏蔽时两份都在", full.count, 2);

  // 开启 .pdf 屏蔽:**分类清单**里也要少一份 —— 否则"挂一次分类"就绕过了屏蔽
  resetSuppressCacheForTest();
  saveSuppress({ nodes: [], extensions: [".pdf"] });
  const filtered = writeCollectionManifest(c.id);
  eq("分类清单也过筛子", filtered.count, 1);
  const text = readFileSync(filtered.path, "utf8");
  check("清单正文里只有留下那份", text.includes("Markdown 那份") && !text.includes("PDF 那份"), text.slice(0, 400));
  check("说明里交代了剔掉几篇", text.includes("屏蔽规则挡掉了 1 篇"), text.slice(0, 400));

  // 整库清单同理
  const kindManifest = writeKindManifest("note");
  const kindText = readFileSync(kindManifest.path, "utf8");
  const pdfTitle = "PDF 那份";
  check("整库清单里也没有被挡的那份", !kindText.includes(pdfTitle), kindText.slice(0, 300));

  // 收尾:清掉屏蔽,免得影响别的段
  resetSuppressCacheForTest();
  saveSuppress({ nodes: [], extensions: [] });
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
