/**
 * **挑一个 python 解释器** —— 工具链检测(`env/toolchain.ts`)与工作流代码节点
 * (`orchestration/codeRunner.ts`)共用的那一份。
 *
 * ## 它防的是什么
 *
 * `env/agentEnv.ts` 为了让技能里敲的裸名 `soffice` 找得到,会把
 * `systemToolPaths.knownInstallPaths("soffice")` 给出的 **LibreOffice `program/`
 * 目录注入到子进程 PATH 最前面**。而那个目录里同时躺着 **LibreOffice 自带的
 * `python.exe`**。于是:
 *
 *   - `where python` 的第一条成了那份捆绑解释器,用户在终端里敲的 `python`
 *     (更靠后的 PATH 项)被整个盖住;
 *   - 代码节点(`mcode.code`)起的是裸名 `python`,以主进程 env 为环境 —— 同样落到
 *     它上面;
 *   - `python-deps` 的 `pip install` 若也选中它,等于**把包装进 LibreOffice 的私有
 *     环境**。
 *
 * 历史上这两个地方各写了一份"取 PATH 上第一个 python"的逻辑,于是**同一个坑踩两遍**。
 * 收在这里:候选怎么枚举、怎么认捆绑、怎么在捆绑与非捆绑之间取舍,只有这里一份。
 *
 * ## 纯 node,不引 electron
 *
 * `codeRunner` 的无头 bundle **没有桩**(见 `code-runner-smoke/run.sh`),所以这里
 * 只能依赖 node 内置 + `lib/outBuf.ts` + `lib/binPath.ts`。
 */
import { normPathKey } from "./pathNorm.js";
import { findExecutables } from "./binPath.js";

/** 找 python 解释器的候选名,与大多数人的 PATH 习惯一致。 */
export const PYTHON_CANDIDATES = ["python", "python3", "py"] as const;

/** Known bundled interpreter directory layouts, not bare project names.
 *
 * A user may work in a directory literally named "libreoffice" and place
 * their own .venv inside it. Matching just /libreoffice/ silently demotes
 * that healthy Python and may select LibreOffice's private Python instead.
 * The installed native bundle lives in program/ (Win/Linux) or an .app's
 * Contents/ tree (macOS), so match those structural segments. */
const BUNDLED_INTERPRETERS: ReadonlyArray<{ match: string; owner: string }> = [
  { match: "/libreoffice/program/", owner: "LibreOffice" },
  { match: "/libreoffice.app/contents/", owner: "LibreOffice" },
];

/** 这个解释器是不是某个程序自带的;是就返回那个程序名,否则 null。 */
export function bundledInterpreterOwner(exe: string): string | null {
  const key = normPathKey(exe);
  for (const { match, owner } of BUNDLED_INTERPRETERS) {
    if (key.includes(match)) return owner;
  }
  return null;
}

/** PATH 上所有能找到的 python 解释器(每个候选取**全部**命中,按规范键去重)。
 *
 *  为什么要"全部"而不是"第一个":LibreOffice 的捆绑 python 被注入在 PATH 最前,只看
 *  第一个命中就永远选到它 —— 要能跳过它去挑后面的,就得先拿到整串。 */
export async function collectPythonCandidates(): Promise<string[]> {
  const seen = new Set<string>();
  const all: string[] = [];
  for (const name of PYTHON_CANDIDATES) {
    for (const exe of await findExecutables(name)) {
      const key = normPathKey(exe);
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(exe);
    }
  }
  return all;
}

/**
 * 从一串候选(按 PATH 顺序、已去重)里挑一个 —— **纯函数**,不 spawn 进程,所以无头
 * 用例能直接喂候选来钉判据。
 *
 * 规则:**有非捆绑的就用非捆绑的**,哪怕它排在被注入 PATH 最前的捆绑那次之后;候选里
 * **全是**捆绑的才用它(机器上只有那一份 python 时不能报"没找到",否则会把用户唯一
 * 的解释器也排掉)。返回绝对路径,空数组 → null。
 *
 * ⚠️ 这里只做**捆绑与否**这一层取舍,不看包、不探测 —— 代码节点只要一个能跑的
 * 解释器,不希望为它多起几个进程。要"挑包最全的"那层在 `env/toolchain.ts`。
 */
export function pickPreferredPython(candidates: readonly string[]): string | null {
  if (candidates.length === 0) return null;
  return candidates.find((c) => bundledInterpreterOwner(c) === null) ?? candidates[0] ?? null;
}

/** PATH 上首选的 python 解释器绝对路径;一个都没有时 null。
 *
 *  调用方拿 null 时**退回各自的兜底**(工具链报"没找到"、代码节点退回裸名字让 spawn
 *  报 ENOENT)—— 解析期不自己造新的失败形状。
 *
 *  **在第一个非捆绑命中处就返回**(不把 `python`/`python3`/`py` 三组全扫完)—— 候选的
 *  枚举顺序就是 PATH 顺序,所以"第一个非捆绑的"与 {@link pickPreferredPython} 对整个
 *  列表的判定等价;代码节点每跑一次都调它,少起两个 `where` 子进程。 */
export async function resolvePythonExe(): Promise<string | null> {
  let firstBundled: string | null = null;
  const seen = new Set<string>();
  for (const name of PYTHON_CANDIDATES) {
    for (const exe of await findExecutables(name)) {
      const key = normPathKey(exe);
      if (seen.has(key)) continue;
      seen.add(key);
      if (bundledInterpreterOwner(exe) === null) return exe; // 首选,立刻返回
      if (firstBundled === null) firstBundled = exe; // 记下兜底(池里全是捆绑的)
    }
  }
  return firstBundled;
}
