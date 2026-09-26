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
import { attachToChat, writeCollectionManifest, writeGroupManifest } from "@main/library/manifest.js";
import { loadLibraryGroups } from "@main/library/groupRegistry.js";
import { loadSuppress, resetSuppressCacheForTest, saveSuppress } from "@main/library/suppress.js";
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
  const a = LibraryRepo.upsert({ title: "A 主文件" });
  const b = LibraryRepo.upsert({ title: "B 关联文件" });
  const c = LibraryRepo.upsert({ title: "C 二级关联" });
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
  const a = LibraryRepo.upsert({ title: "反向 A" });
  const b = LibraryRepo.upsert({ title: "反向 B" });
  LibraryLinkRepo.add(a.id, { targetItemId: b.id });

  resetSent();
  attachToChat(SID, `i:${b.id}`);
  eq("挂 B 只推一条", sent.length, 1);
  eq("就是 B 自己", keysOf()[0], `i:${b.id}`);
  check("A 没被带上", !keysOf().includes(`i:${a.id}`), keysOf());
}

console.log("\n一个关联多个:三条出边全挂上");

{
  const hub = LibraryRepo.upsert({ title: "枢纽" });
  const x = LibraryRepo.upsert({ title: "X" });
  const y = LibraryRepo.upsert({ title: "Y" });
  const z = LibraryRepo.upsert({ title: "Z" });
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
  const a = LibraryRepo.upsert({ title: "分类里 A" });
  const b = LibraryRepo.upsert({ title: "分类里 B" });
  LibraryLinkRepo.add(a.id, { targetItemId: b.id });

  resetSent();
  const res = attachToChat(SID, "c:note");
  check("整库挂载成功", res.ok, res);
  eq("整库只推一条", sent.length, 1);
  eq("键是整库那个", keysOf()[0], "c:note");
}

console.log("\n库外路径:先导入成 linked 条目再挂");

{
  // 真在磁盘上放一个文件 —— 导入器要 existsSync 它
  const dir = mkdtempSync(join(tmpdir(), "mcode-attach-links-"));
  const outside = join(dir, "外部参考资料.md");
  writeFileSync(outside, "# 外部\n\n这是库外的一份参考。\n", "utf8");

  const host = LibraryRepo.upsert({ title: "宿主条目" });
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

  const host = LibraryRepo.upsert({ title: "宿主" });
  const good = LibraryRepo.upsert({ title: "还在的关联" });
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
  const a = LibraryRepo.upsert({ title: "无窗口 A" });
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
  // 建一套有层级的东西:大类 docs → 集合「精读队列」（kind 退役,两级直挂）。
  const groups = loadLibraryGroups();
  const docsGroup = groups.find((g) => g.id === "docs");
  check("出厂有 docs 大类", docsGroup !== undefined, groups.map((g) => g.id));

  const coll = CollectionRepo.create("精读队列", null, docsGroup?.id);
  const host = LibraryRepo.upsert({ title: "被屏蔽的宿主" });
  const linked = LibraryRepo.upsert({ title: "被屏蔽的关联" });
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

  // ③ **向下继承**:屏蔽整个「文档」大类 → 挂在它下面集合里的条目同样挂不上。
  //
  // ⚠️ 这一段**必须自己造一个条目**。②把 host 移出了集合(那是②要的前提:入口放行),
  // 而 kind 退役后"条目属于哪个大类"是**经集合**算出来的 —— 不在任何集合里的条目没有
  // group 键,拿它来验继承等于什么都没验。老写法靠 `item.kind` 取大类,那时移出集合
  // 不影响;判据换成 group_id 之后这一条就不再成立了。
  const underDocs = LibraryRepo.upsert({ title: "文档大类下的条目" });
  CollectionRepo.assign(coll.id, [underDocs.id], true);
  resetSuppressCacheForTest();
  saveSuppress({ nodes: ["group:docs"], extensions: [] });
  resetSent();
  const byGroup = attachToChat(SID, `i:${underDocs.id}`);
  check("屏蔽大类后小类下的条目也挂不上(向下继承)", !byGroup.ok, byGroup);
  check("原因指出是哪个大类", (byGroup.error ?? "").includes("文档"), byGroup);
  eq("一条都没推出去(继承)", sent.length, 0);

  // ③b **父分类也向下继承**:分类支持嵌套(左栏「移动到…」能拖成父子),屏蔽**父分类**
  //    时只挂在**子分类**里的条目同样要挡住 —— 设置页写的是「它下面的全部内容都跟着
  //    被挡」。修复前 `suppressKeysOfItem` 只取直属集合,这一条会从缝里漏过去
  //    (2026-09-26 修:父链沿 parentId 收到顶)。
  const childColl = CollectionRepo.create("子队列", coll.id, docsGroup?.id);
  const underChild = LibraryRepo.upsert({ title: "子分类里的条目" });
  CollectionRepo.assign(childColl.id, [underChild.id], true);
  resetSuppressCacheForTest();
  saveSuppress({ nodes: [`collection:${coll.id}`], extensions: [] });
  resetSent();
  const byParent = attachToChat(SID, `i:${underChild.id}`);
  check("★ 屏蔽父分类后,子分类里的条目也挂不上", !byParent.ok, byParent);
  check("原因指出的是父分类", (byParent.error ?? "").includes("精读队列"), byParent);
  eq("一条都没推出去(父分类继承)", sent.length, 0);

  // ④ 老数据里的 `type:` 条目:kind 退役后那一档不存在了,校验时**丢掉那一条**,
  //    而不是废掉整份规则 —— 用户别的屏蔽照常生效,也不会因为一个过时的键就让
  //    整个设置页保存失败。
  resetSuppressCacheForTest();
  const legacyType = saveSuppress({ nodes: ["type:note", `collection:${coll.id}`], extensions: [] });
  check("带过时 type: 的规则仍然保存成功", legacyType.ok, legacyType);
  check(
    "★ 过时那一条被丢掉,合法那条留下",
    JSON.stringify(loadSuppress().nodes) === JSON.stringify([`collection:${coll.id}`]),
    loadSuppress().nodes,
  );
  // 丢掉之后不该有任何"看着像挡住了、其实什么都拦不住"的残留
  resetSuppressCacheForTest();
  saveSuppress({ nodes: ["type:note"], extensions: [] });
  resetSent();
  const staleOnly = attachToChat(SID, `i:${underDocs.id}`);
  check("★ 只剩过时 type: 的规则不挡任何东西", staleOnly.ok, staleOnly);

  // ⑤ 按**扩展名**屏蔽 —— 条目在类型/集合上都放行,但它的文件后缀被挡
  resetSuppressCacheForTest();
  saveSuppress({ nodes: [], extensions: [".pdf"] });
  const pdfItem = LibraryRepo.upsert({ title: "一份 PDF" });
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
  const docsGroup = loadLibraryGroups().find((g) => g.id === "docs");
  const c = CollectionRepo.create("含 PDF 的集合", null, docsGroup?.id);
  const md = LibraryRepo.upsert({ title: "Markdown 那份" });
  const pdf = LibraryRepo.upsert({ title: "PDF 那份" });
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

  // 大类清单同理（kind 退役后"整库"由大类清单承担）
  const gManifest = writeGroupManifest(docsGroup?.id ?? "docs");
  const gText = readFileSync(gManifest.path, "utf8");
  const pdfTitle = "PDF 那份";
  check("大类清单里也没有被挡的那份", !gText.includes(pdfTitle), gText.slice(0, 300));

  // 收尾:清掉屏蔽,免得影响别的段
  resetSuppressCacheForTest();
  saveSuppress({ nodes: [], extensions: [] });
}

console.log("\n转录与原件:引用时一起给,按文件类型屏蔽时按份去掉");

{
  saveSuppress({ nodes: [], extensions: [] });
  const dir = mkdtempSync(join(tmpdir(), "mcode-attach-orig-"));
  const manifestOf = (i: number): string => (sent[i] ? readFileSync(sent[i].manifestPath, "utf8") : "");

  // ① 通用文件(Word,没转录):清单要指出文件本身。从前清单只认 md / pdf 两列,
  //    通用条目只有 file_path,于是挂上去的 chip 里写着「这一条还没有文件」。
  const docxPath = join(dir, "课题报告.docx");
  writeFileSync(docxPath, "fake docx", "utf8");
  const docx = LibraryRepo.upsert({ title: "课题报告", entryMode: "linked", filePath: docxPath });
  resetSent();
  const r1 = attachToChat(SID, `i:${docx.id}`);
  check("通用文件挂得上", r1.ok, r1);
  check("★ 通用文件的清单写出了文件本身", manifestOf(0).includes(docxPath), manifestOf(0));
  check("★ 不再说它「还没有文件」", !manifestOf(0).includes("还没有文件"), manifestOf(0));

  // ② 关联进来的库外文件是同一个毛病:它被导入成 linked 条目(只有 file_path),
  //    关联那个 chip 的清单也得指得到文件 —— 否则「关联的一起引用」只挂上一个空壳。
  const refPath = join(dir, "参考资料.txt");
  writeFileSync(refPath, "参考", "utf8");
  const host = LibraryRepo.upsert({ title: "带库外关联的宿主" });
  LibraryLinkRepo.add(host.id, { targetPath: refPath });
  resetSent();
  attachToChat(SID, `i:${host.id}`);
  check("★ 关联进来的库外文件,清单里有它的路径", manifestOf(1).includes(refPath), manifestOf(1));

  // ③ 转录过的 PDF:引用时转录(先读)和原件都给出来 —— 转录和原件是同一条条目的两份文件。
  const paper = LibraryRepo.upsert({ title: "转录过的论文" });
  LibraryRepo.setPdf(paper.id, `papers/ee/ff/${paper.id}.pdf`, "sha-fake-3");
  LibraryRepo.setMarkdown(paper.id, `markdown/imported/${paper.id}/full.md`);
  resetSent();
  attachToChat(SID, `i:${paper.id}`);
  const m3 = manifestOf(0);
  check("★ 单篇清单里有转录", m3.includes("full.md"), m3);
  check("★ 单篇清单里也有原件 PDF", m3.includes(`${paper.id}.pdf`), m3);
  check("转录排在原件前面(先读 Markdown)", m3.indexOf("full.md") < m3.indexOf(`${paper.id}.pdf`), m3);

  const coll = CollectionRepo.create("转录对照");
  CollectionRepo.assign(coll.id, [paper.id, docx.id], true);
  const table = readFileSync(writeCollectionManifest(coll.id).path, "utf8");
  check("★ 分类清单:转录条目带出原件", table.includes("full.md") && table.includes(`${paper.id}.pdf`), table);
  check("★ 分类清单:通用文件给出路径,不再是「未下载」", table.includes(docxPath), table);

  // ④ 按文件类型屏蔽**按份算,不按条算**(2026-09-26 用户定的规矩):屏蔽只管**给 AI 看的**。
  //    屏蔽 pdf → 模型只拿到转录后的 md;用户自己预览照样看 PDF(那是界面,不过这道门)。
  //    一条条目的文件**全被**屏蔽时它才整条挂不上。
  //    (同一天早些时候改成过「任一份命中就整条挡」—— 与这个设计正相反,这几条就是钉它的。)
  saveSuppress({ nodes: [], extensions: [".pdf"] });
  resetSent();
  const r4 = attachToChat(SID, `i:${paper.id}`);
  check("★ 屏蔽 .pdf 后,转录过的 PDF 照样挂得上", r4.ok, r4);
  const m4 = manifestOf(0);
  check("★ 清单里有转录", m4.includes("full.md"), m4);
  check("★ 清单里没有 PDF 原件", !m4.includes(`${paper.id}.pdf`), m4);
  const t4 = readFileSync(writeCollectionManifest(coll.id).path, "utf8");
  check("★ 分类清单:转录过的 PDF 还在,只剩转录",
    t4.includes("转录过的论文") && t4.includes("full.md") && !t4.includes(`${paper.id}.pdf`), t4);

  // 只有 PDF、没转录的:它的文件全被屏蔽 → 整条挂不上
  const pdfOnly = LibraryRepo.upsert({ title: "还没转录的论文" });
  LibraryRepo.setPdf(pdfOnly.id, `papers/ee/00/${pdfOnly.id}.pdf`, "sha-fake-4");
  const r4b = attachToChat(SID, `i:${pdfOnly.id}`);
  check("只有 PDF 的:整条挂不上,原因说是 .pdf", !r4b.ok && (r4b.error ?? "").includes(".pdf"), r4b);

  // 屏蔽 .docx:转录过的 Word 只给转录;没转录的 Word 整条挡
  saveSuppress({ nodes: [], extensions: [".docx"] });
  const docxMd = LibraryRepo.upsert({ title: "转录过的 Word", entryMode: "linked", filePath: join(dir, "b.docx") });
  LibraryRepo.setMarkdown(docxMd.id, `markdown/imported/${docxMd.id}/full.md`);
  resetSent();
  const r5 = attachToChat(SID, `i:${docxMd.id}`);
  check("★ 屏蔽 .docx 后,转录过的 Word 挂得上、只给转录",
    r5.ok && manifestOf(0).includes("full.md") && !manifestOf(0).includes("b.docx"), manifestOf(0));
  const r5b = attachToChat(SID, `i:${docx.id}`);
  check("没转录的 Word 整条挂不上", !r5b.ok, r5b);

  // 屏蔽 .md:反过来,只给原件
  saveSuppress({ nodes: [], extensions: [".md"] });
  resetSent();
  const r6 = attachToChat(SID, `i:${paper.id}`);
  check("★ 屏蔽 .md 后,转录过的 PDF 只给原件",
    r6.ok && manifestOf(0).includes(`${paper.id}.pdf`) && !manifestOf(0).includes("full.md"), manifestOf(0));
  check("只给原件时不说「尚未转 Markdown」(转录是有的,只是不给)", !manifestOf(0).includes("尚未转"), manifestOf(0));

  // 关联的一起引用、同一级别,各自按份过滤
  saveSuppress({ nodes: [], extensions: [".pdf"] });
  const hub = LibraryRepo.upsert({ title: "引用入口" });
  LibraryLinkRepo.add(hub.id, { targetItemId: paper.id });
  LibraryLinkRepo.add(hub.id, { targetItemId: pdfOnly.id });
  resetSent();
  const r7 = attachToChat(SID, `i:${hub.id}`);
  check("入口挂上,并如实说有一条被屏蔽挡下", r7.ok && (r7.error ?? "").includes("屏蔽"), r7);
  const all7 = sent.map((m) => readFileSync(m.manifestPath, "utf8")).join("\n----\n");
  check("★ 关联的转录过的论文同级挂上,只给转录",
    all7.includes("转录过的论文") && all7.includes("full.md") && !all7.includes(`${paper.id}.pdf`), all7);
  check("★ 关联的只有 PDF 的那篇没挂上", !all7.includes("还没转录的论文"), all7);

  saveSuppress({ nodes: [], extensions: [] });
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
