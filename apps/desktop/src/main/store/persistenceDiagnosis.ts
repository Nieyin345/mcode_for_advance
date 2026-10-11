/**
 * 「保存失败到底是谁挡的」—— 把 sqlite 存盘抛出来的原始错误翻成**能动手的一句话**。
 *
 * ## 为什么需要它(报告 E3)
 *
 * Mcode 把整个库放在内存里,每次变更**整份重写 `mcode.db`**(写临时文件 → `rename` 覆盖)。
 * Windows 下只要**任何别的句柄**开着这个文件,`rename` 覆盖就抛 `EPERM` / `EBUSY`。
 * 报告实测:一个**只读**打开 `mcode.db` 的外部脚本,就能让应用每次保存都失败 ——
 * 连接一关,应用立刻恢复。
 *
 * 应用本身**已经处理得对**(`db.ts` 的 `recordPersistenceFailure`:保住内存里的数据、
 * 指数退避重试、恢复后打 `recovered`),数据不会丢。**缺的是"叫人话"**:弹窗里那句
 * 「请检查磁盘空间和目录权限」把用户指去了错方向 —— 磁盘满和目录没权限都会失败,但
 * 报告里那种「另一个进程开着库」**两种都不是**,而它恰恰是最常见的一种。
 *
 * 这里把原始错误分个类,给出一句**指得着动手方向**的补充说明。分类只认错误里那几个
 * 稳定的标记(`errno` 码 / 关键字),认不出就**如实说不认得** —— 不硬套一句。
 *
 * ## 为什么单独一个纯模块
 *
 * 分类逻辑要能被无头套件直接验(见 `persistence-diagnosis-smoke`),而 `persistenceAlerts.ts`
 * 拉 `electron`(`app` / `dialog`)、`db.ts` 拉 sql.js,都打不动。这里零依赖。
 */

/** Windows 锁文件时最常见的两个 errno;POSIX 侧对应 EBUSY / EACCES。 */
const LOCK_CODES = ["EPERM", "EBUSY", "EACCES", "ETXTBSY"];
/** 目标被另一个进程占着时,错误文本里通常出现的词。 */
const LOCK_HINTS = ["operation not permitted", "resource busy", "being used by another process", "text file busy"];

/** 磁盘满 / 配额:这是弹窗里原本就点到的那一种,不用重复解释。 */
const SPACE_CODES = ["ENOSPC", "EDQUOT"];

export interface PersistenceDiagnosis {
  /**
   * 一种机器可读的分类,供测试与将来的行为分支:
   *   - `locked`:目标文件被别的进程/句柄占着(报告 E3 那一种);
   *   - `space`:磁盘满 / 配额用尽;
   *   - `readonly`:目录/文件只读或权限不足;
   *   - `unknown`:认不出来。
   */
  kind: "locked" | "space" | "readonly" | "unknown";
  /**
   * 给用户看的一句**补充**说明(接在弹窗原正文之后)。`unknown` 时**没有**这句 ——
   * 宁可不说,也不硬套一句误导人的。空串 = 没话可说。
   */
  hint: string;
}

/** 错误对象/字符串里有没有这些标记(大小写不敏感)。 */
function hasAny(text: string, needles: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return needles.some((n) => lower.includes(n.toLowerCase()));
}

/**
 * 把存盘失败的原因分个类。
 *
 * ⚠️ **判据全在错误文本上,顺序有讲究。** `EACCES`(权限不足)与 `EPERM`(被占)在
 * Windows/POSIX 上同属权限家族、errno 也常被混用,而它们要**指向完全相反的动手方向**
 * (改权限 vs 关掉别的连接)。所以**先按文本判"permission denied"这一族**(那是权限不足),
 * **再**按 errno 判"被占"。顺序反了会把「目录没写权限」说成「另一个程序开着库」—— 正是
 * 本模块要避免的那种误导(这条由 `persistence-diagnosis-smoke` 的 EACCES 用例钉住)。
 *
 * 传入任何东西都不抛:非 Error(字符串 / 对象 / undefined)一律当"认不出"处理。
 */
export function diagnosePersistenceFailure(cause: unknown): PersistenceDiagnosis {
  const text =
    cause instanceof Error
      ? `${cause.message} ${String((cause as { code?: unknown }).code ?? "")} ${String((cause as { errno?: unknown }).errno ?? "")}`
      : String(cause ?? "");
  if (!text.trim()) return { kind: "unknown", hint: "" };

  if (hasAny(text, SPACE_CODES) || hasAny(text, ["no space left", "disk full", "quota exceeded"])) {
    // 弹窗正文已经说了"检查磁盘空间",这里不重复 —— 给的是"清哪儿"。
    return {
      kind: "space",
      hint: "磁盘或配额已满:清理磁盘空间(或把数据根挪到别的盘)后应用会自动重试。",
    };
  }

  // **先判权限不足**(文本明确说了 permission denied / 只读文件系统)—— 且要排在
  // "被占"前面:EACCES 的 errno 与 EPERM 同族,靠 errno 分不出来,只能靠这句话。
  if (hasAny(text, ["permission denied", "read-only file system", "readonly", "read only"])) {
    return {
      kind: "readonly",
      hint: "目录或文件不可写:检查数据根目录的权限,以及它是不是在只读盘/受控目录里。",
    };
  }

  if (hasAny(text, LOCK_CODES) || hasAny(text, LOCK_HINTS)) {
    return {
      kind: "locked",
      hint:
        "多半是**另一个程序正开着 mcode.db**:外部脚本、备份/同步工具、其它 agent、或挂在库上的 CI —— " +
        "**只读**打开也算。关掉那个连接后应用会立刻恢复保存。",
    };
  }

  return { kind: "unknown", hint: "" };
}

/** 分类 + 原文拼成弹窗那段 `detail`(认不出时就只回原文,不加废话)。 */
export function persistenceFailureDetail(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause ?? "");
  const { hint } = diagnosePersistenceFailure(cause);
  return hint ? `${raw}\n\n${hint}` : raw;
}
