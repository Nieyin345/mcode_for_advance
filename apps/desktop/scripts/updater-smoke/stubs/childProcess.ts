/**
 * `node:child_process` 的替身 —— 给 `detectManualInstallRequired()` 里那句
 * `spawnSync("codesign", ["-dv", …])` 用。
 *
 * ## 为什么必须换掉
 *
 * 那一句**只在 macOS 上**会跑(`process.platform !== "darwin"` 时函数提前 return),
 * 所以这台 Windows 机器上跑本套时它一次都不会被调到 —— 也就是说,不换桩的话
 * **那段"问 codesign 要签名、从输出里认 ad-hoc"的代码一行都验不到**。
 *
 * 本套要验的正是那一段:它决定 macOS 用户**在下载之前**会不会被告知"这个包装不了,
 * 去发布页手动下"。判据立在**用户看到的那行字**上,不是立在"有没有调 codesign"。
 *
 * ## 形状照真的 `spawnSync` 来(实测过,不是猜的)
 *
 * 真 `codesign -dv <path>` 把签名信息写 **stderr**、stdout 是空的、退出码 0。对应的
 * `spawnSync` 返回:
 *
 *     { stdout: null, stderr: "…TeamIdentifier…", status: 0, error: null }
 *
 * —— 信息**只在 stderr 上**。这正是 `updater.ts` 原来那个 bug 的现场:它当时用
 * `execFileSync` + `stdio: ["ignore","ignore","pipe"]`,stdout 被 ignore 之后
 * 返回值是 `null`,那条正则永远不命中(见 main.ts §6)。
 *
 * 这个桩因此**模仿真 `spawnSync` 的语义**,而不是"返回我要的那个字符串":
 *
 *  - stdout 被 ignore → `stdout: null`;被 pipe 且设了 encoding → 字符串;
 *  - 命令不存在 → `error` 有值、`status: null`(不抛);
 *  - **非零退出不抛** —— 这是 `spawnSync` 与 `execFileSync` 的关键区别,也影响调用方
 *    要不要自己看 `status`。
 *
 * ⚠️ 它**不**解析参数、也不看路径 —— 本套要控的是"codesign 吐什么",不是"路径对不对"。
 */

/** 下一条 `spawnSync` 的结果。 */
type NextCall =
  | { kind: "ok"; stderr: string; stdout?: string; status?: number }
  | { kind: "spawnError"; error: Error };

const state = {
  next: { kind: "ok", stderr: "", stdout: "", status: 0 } as NextCall,
  calls: [] as Array<{ file: string; args: string[]; options: Record<string, unknown> }>,
};

/** 摆下一条的结果。 */
export function setNext(next: NextCall): void {
  state.next = next;
}

/** 还原成"没摆过" —— 干净的默认是"codesign 什么都没说、退出 0"。 */
export function reset(): void {
  state.next = { kind: "ok", stderr: "", stdout: "", status: 0 };
  state.calls.length = 0;
}

/** 账本:每次调用记下 file/args/options —— 断言"有没有真的去问 codesign"。 */
export const calls = state.calls;

/** 与真 `spawnSync` 同形的那几个字段。`error` / `status` 都要有,因为调用方可能看。 */
interface SpawnResult {
  stdout: string | Buffer | null;
  stderr: string | null;
  status: number | null;
  error: Error | undefined;
}

export function spawnSync(
  file: string,
  args?: readonly string[],
  options?: Record<string, unknown>,
): SpawnResult {
  state.calls.push({ file, args: [...(args ?? [])], options: options ?? {} });

  const next = state.next;
  if (next.kind === "spawnError") {
    // 真 `spawnSync` 在二进制不存在时**不抛**:error 有值、status 是 null。
    return { stdout: null, stderr: null, status: null, error: next.error };
  }

  const stdio = options?.["stdio"] as unknown[] | undefined;
  const stdoutIgnored = Array.isArray(stdio) && stdio[1] === "ignore";
  const encoding = options?.["encoding"];
  const asBuffer = encoding === "buffer" || encoding === undefined;

  return {
    stdout: stdoutIgnored
      ? null
      : asBuffer
        ? Buffer.from(next.stdout ?? "", "utf8")
        : (next.stdout ?? ""),
    stderr: arrayStderrPiped(stdio) ? (next.stderr ?? "") : (next.stderr ?? ""),
    status: next.status ?? 0,
    error: undefined,
  };
}

/** stderr 那一格是不是走了 pipe。本桩**总是**把 stderr 交出去(codesign 的信息
 *  就在那儿),但这行留着说明"真 `spawnSync` 只在你接了 pipe 时才给你"这件事。 */
function arrayStderrPiped(stdio: unknown[] | undefined): boolean {
  return Array.isArray(stdio) && stdio[2] === "pipe";
}
