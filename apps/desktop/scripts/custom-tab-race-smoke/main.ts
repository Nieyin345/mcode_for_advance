/**
 * custom-tab-race-smoke — `CustomTabView` 里 `FileTab` 的**旧回包回写**
 * (与 project-branch-race-smoke / 底层修复记录 #116/#117/#121 同一类)。
 *
 * ## 盯的是什么
 *
 * 右栏自定义页签里的「文件」页签每 4 秒重读一次文件。用户切到**另一个**自定义页签时,
 * `FileTab` 是**同一个组件实例换了 `abs` prop**(不是重挂)。弱网 / 大文件下 `readFile`
 * 几百毫秒很正常,于是:
 *
 *   A 文件的 readFile 在飞 → 用户切到 B → B 的 readFile 先回 → A 的 readFile 后回。
 *
 * 没有请求序号守卫时,A 那句迟到的 `setContent` 会把 B 的内容**盖掉** —— 页签标题写着
 * B,B 底下画的却是 A 的文件内容。
 *
 * ## 判据
 *
 * 立在**页面上那行字**上:切到 B、放完所有回包后,页面上必须是 B 的内容。
 *
 * ## 它怎么跑
 *
 * esbuild 打包真组件;`react` 换极小 hooks 运行时,`customUiStore` / icons 换直通桩,
 * `@renderer/lib/api.js` 换成**能扣住回包**的替身。`FileTab` 是 `CustomTabView` 的子组件
 * (fake-react 只跑根组件),所以直接 import 它、把它当根挂载。不起浏览器、不写盘。
 *
 * Run: scripts/custom-tab-race-smoke/run.sh
 */
import "./prelude.js";
import { __mount, __render, __flush, __text } from "./fakeReact.js";
import { server, resetApi, release } from "./api-stub.js";
import { FileTab } from "@renderer/components/customUi/CustomTabView.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  checks++;
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

useSessionStore.setState({ locale: "zh" } as never);

const A = "/p/a.txt";
const B = "/p/b.txt";

async function scenario(): Promise<void> {
  resetApi();
  // 用**.txt**(不是 .md)—— 那条路径直接渲染 `<pre>{text}</pre>`,内容落在 __text() 里。
  server.files[A] = "CONTENT-OF-A";
  server.files[B] = "CONTENT-OF-B";
  server.hold.add("file:readFile");

  let abs = A;
  __mount(() => FileTab({ title: "A", abs, projectPath: "/p" }));
  await __flush();
  check("A 的 readFile 在飞(被扣住)", server.held.some((h) => h.input.filePath === A), server.held.map((h) => h.input));

  // 切到 B —— 同一个组件实例换 prop。B 的 readFile 也扣着。
  abs = B;
  __render();
  await __flush();
  check("切到 B 后发出的是 B 的 readFile", server.held.some((h) => h.input.filePath === B), server.held.map((h) => h.input));

  // B(新)先回 —— 正常显示 B 的内容。
  release("file:readFile", (i) => i.filePath === B);
  await __flush();
  check("B 先回 → 显示 B 的内容", __text().includes("CONTENT-OF-B"), __text());

  // A(旧)现在才回 —— 它不许把 B 的内容盖掉。
  release("file:readFile", (i) => i.filePath === A);
  await __flush();
  check(
    "★ 迟到的 A 回包不许盖掉 B 的内容",
    __text().includes("CONTENT-OF-B") && !__text().includes("CONTENT-OF-A"),
    __text(),
  );
}

await scenario();

console.log(`\ncustom-tab-race-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) process.exitCode = 1;
// FileTab 起了 4s 轮询的 setInterval —— 无头跑真组件得显式收尾,否则 node 不退出。
process.exit(failures > 0 ? 1 : 0);
