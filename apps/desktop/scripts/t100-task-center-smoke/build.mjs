/**
 * 把**真** `TaskCenterPanel` / `TaskRow` 挂进极小 React 运行时。
 *
 * 判据见 main.ts 文件头。要点：`Button` 必须真的渲染成 `<button>` 才点得动 ——
 * `@base-ui/react/button` 在这里换成一个直通的原生实现。
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readdirSync, mkdtempSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const source = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(source, "../..");
mkdirSync(join(desktop, ".tmp"), { recursive: true });
const dir = mkdtempSync(join(desktop, ".tmp", "t100-task-center-"));
const pnpm = join(desktop, "../../node_modules/.pnpm");
const pkg = (prefix, sub) => {
  const n = readdirSync(pnpm).filter((x) => x.startsWith(prefix)).sort().at(-1);
  if (!n) throw new Error("Missing installed dependency: " + prefix);
  return join(pnpm, n, "node_modules", sub);
};
const esbuild = await import(pathToFileURL(pkg("esbuild@", "esbuild/lib/main.js")).href);
const stub = (p) => join(source, p);

/**
 * 直通 Button：产出一个 `type: "button"` 的**元素对象**。
 *
 * ⚠️ 关键：极小运行时（fakeReact）**不执行子组件**，`__nodes()` 只收集结构。
 * 若写成 `(p) => createElement("button", ...)`，那个节点的 `.type` 是一个函数，
 * `__nodes()` 里就找不到 `type === "button"` —— 实测 `BUTTON COUNT: 0`，所有
 * 「点按钮」的断言全红。返回元素对象后 `.type` 是字符串，onClick/disabled 原样在内。
 */
const BASE_UI_BUTTON = `
export const Button = (props) => {
  const { children, variant, size, className, ...rest } = props;
  void variant; void size; void className;
  return { type: "button", props: { ...rest, children } };
};
export default { Button };
`;

await esbuild.build({
  entryPoints: [join(source, "main.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  jsx: "automatic",
  tsconfig: join(desktop, "tsconfig.json"),
  absWorkingDir: desktop,
  outfile: join(dir, "smoke.mjs"),
  logLevel: "error",
  loader: { ".woff": "dataurl", ".woff2": "dataurl", ".ttf": "dataurl", ".eot": "dataurl", ".css": "empty" },
  plugins: [{
    name: "t100-task-center",
    setup(b) {
      b.onResolve({ filter: /^react$/ }, () => ({ path: stub("fakeReact.ts") }));
      b.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: stub("jsxRuntime.ts") }));
      b.onResolve({ filter: /^react-dom$/ }, () => ({ path: "empty", namespace: "stub" }));
      b.onResolve({ filter: /^react-dom\/client$/ }, () => ({ path: "empty", namespace: "stub" }));
      b.onResolve({ filter: /^@tabler\/icons-react$/ }, () => ({ path: stub("iconsStub.cjs") }));
      b.onResolve({ filter: /^react-icons\// }, () => ({ path: stub("iconsStub.cjs") }));
      b.onResolve({ filter: /^@base-ui\/react\/button$/ }, () => ({ path: "baseuiButton", namespace: "stub" }));
      b.onResolve({ filter: /^@base-ui\/react/ }, () => ({ path: "baseuiButton", namespace: "stub" }));
      b.onResolve({ filter: /^@renderer\/lib\/api\.js$/ }, () => ({ path: stub("api-stub.ts") }));
      b.onResolve({ filter: /^@renderer\/hooks\/useRpc\.js$/ }, () => ({ path: stub("useRpc-stub.ts") }));
      b.onResolve({ filter: /^@renderer\/stores\/sessionStore\.js$/ }, () => ({ path: stub("sessionStore-stub.ts") }));
      b.onResolve({ filter: /^@renderer\/lib\/i18n\/index\.js$/ }, () => ({ path: stub("sessionStore-stub.ts") }));
      b.onResolve({ filter: /^@renderer\/stores\/toastStore\.js$/ }, () => ({ path: stub("toastStore-stub.ts") }));
      b.onResolve({ filter: /^@renderer\/components\/ui\/index\.js$/ }, () => ({ path: stub("ui-stub.ts") }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({
        contents:
          a.path === "empty"
            ? ""
            : a.path === "baseuiButton"
              ? BASE_UI_BUTTON
              : "",
        loader: "tsx",
      }));
    },
  }],
});

const unit = spawnSync(process.execPath, [join(dir, "smoke.mjs")], { cwd: desktop, stdio: "inherit", timeout: 60000 });
if (unit.status !== 0) process.exit(unit.status ?? 1);
