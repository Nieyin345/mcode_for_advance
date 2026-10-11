/**
 * Headless smoke for **存盘失败诊断** —— `main/store/persistenceDiagnosis.ts`(报告 E3)。
 *
 * ## 为什么值得单独一套
 *
 * 报告实测:一个**只读**打开 `mcode.db` 的外部脚本,就能让应用每次保存都抛
 * `EPERM: operation not permitted, rename …`。应用本身处理得对(保住内存数据、退避重试、
 * 恢复),但弹窗里那句「请检查磁盘空间和目录权限」把用户指去了**错方向** —— 磁盘满和
 * 权限不足都不是那一次的病因,而"另一个进程开着库"**是最常见的一种**,用户却想不到。
 *
 * 这一套验的就是那句补充说明:**锁文件 → 说得出来;磁盘满 → 说得出来;认不出 → 不硬套**。
 * 判据立在**用户看到的那行字上**(硬规矩:matching 用户可见文案,不是匹配机制)。
 *
 * `persistenceDiagnosis.ts` 是零依赖纯模块,所以直接引 —— 不拉 electron / sql.js。
 */
import {
  diagnosePersistenceFailure,
  persistenceFailureDetail,
} from "../../src/main/store/persistenceDiagnosis.js";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

/** 造成一个带 errno `code` 的错误,像 node 抛的那样。 */
function errWithCode(code: string, message: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

/* ───────────────── §1 报告 E3 那一种:文件被别的进程占着 ───────────────── */

{
  // 逐字取报告里的那行错误(EPERM + rename)。
  const eperm = errWithCode(
    "EPERM",
    "EPERM: operation not permitted, rename 'mcode.db.persist-1234.tmp' -> 'mcode.db'",
  );
  const d = diagnosePersistenceFailure(eperm);
  check("EPERM(报告 E3 的原始错误)→ 分类为 locked", d.kind === "locked", d);
  check(
    "★ 提示里点出「另一个程序正开着 mcode.db」(用户才想得到去关谁)",
    d.hint.includes("另一个程序") && d.hint.includes("mcode.db"),
    d.hint,
  );
  check(
    "★ 提示明说「只读打开也算」(报告实测:只读连接就够)",
    d.hint.includes("只读"),
    d.hint,
  );
  check("提示给了退路(关掉连接后自动恢复)", d.hint.includes("恢复"), d.hint);

  // Windows 另一常见的 EBUSY。
  check(
    "EBUSY → 也是 locked",
    diagnosePersistenceFailure(errWithCode("EBUSY", "EBUSY: resource busy or locked, rename")).kind === "locked",
  );
  // 文本形态(没有结构化 code,只有消息)—— 真实里经常是这种。
  check(
    "只有文本「being used by another process」也认(没有 code 的情况)",
    diagnosePersistenceFailure(new Error("EPERM: file is being used by another process")).kind === "locked",
  );
}

/* ───────────────────────── §2 磁盘满 ───────────────────────── */

{
  const enospc = errWithCode("ENOSPC", "ENOSPC: no space left on device, write");
  const d = diagnosePersistenceFailure(enospc);
  check("ENOSPC → 分类为 space", d.kind === "space", d);
  check("space 提示指向「清理磁盘空间」", d.hint.includes("磁盘空间") || d.hint.includes("配额"), d.hint);
  // 弹窗正文已经说了"检查磁盘空间",所以 space 的 hint 不该只是重复那句 —— 要给方向。
  check(
    "space 提示不是复述正文(给了「挪数据根」这类可做的动作)",
    d.hint.includes("数据根") || d.hint.includes("其他盘") || d.hint.includes("清理"),
    d.hint,
  );
}

/* ─────────────────── §3 权限/只读:与 locked 分开 ─────────────────── */

{
  const eacces = errWithCode("EACCES", "EACCES: permission denied, rename 'x' -> 'mcode.db'");
  const d = diagnosePersistenceFailure(eacces);
  // ⚠️ EACCES 同时在 LOCK_CODES 里,但消息是 "permission denied" → 报告 E3 关心的
  // "谁占着文件"不是这里的病因,不该把它说成"另一个程序开着库"。
  check(
    "EACCES + permission denied → readonly(不误判成 locked)",
    d.kind === "readonly",
    d,
  );
  check("readonly 提示指向权限/只读盘", d.hint.includes("权限") || d.hint.includes("只读"), d.hint);
}

/* ─────────── §4 认不出就**不硬套** —— 这条防的是"误导" ─────────── */

{
  const weird = diagnosePersistenceFailure(new Error("Unexpected token in JSON at position 3"));
  check("认不出的错误 → 分类 unknown", weird.kind === "unknown", weird);
  check(
    "★ 认不出时**不**给提示(宁可不说,也不硬套一句误导人的)",
    weird.hint === "",
    weird.hint,
  );
  // 空 / undefined / 非 Error 都不能抛(它跑在弹窗路径上,抛了就再也没人报错了)。
  for (const bad of [undefined, null, "", "   ", 42, { foo: 1 }]) {
    let threw = false;
    try {
      diagnosePersistenceFailure(bad);
    } catch {
      threw = true;
    }
    check(`非 Error 输入(${JSON.stringify(bad)})不抛`, !threw);
  }
}

/* ───────────── §5 detail 拼接:原文必须在,提示接在后面 ───────────── */

{
  const eperm = errWithCode("EPERM", "EPERM: operation not permitted, rename 'a' -> 'mcode.db'");
  const detail = persistenceFailureDetail(eperm);
  check("detail 里保留了原始错误(排障要用)", detail.includes("operation not permitted"), detail);
  check("detail 里也带了那句提示", detail.includes("另一个程序"), detail);
  check(
    "提示排在原文之后(用户先看到真实错误,再看解释)",
    detail.indexOf("operation not permitted") < detail.indexOf("另一个程序"),
    detail,
  );

  // 认不出时 detail 就是原文,后面不添废话。
  const unknownDetail = persistenceFailureDetail(new Error("boom-boom"));
  check(
    "认不出时 detail 原样返回(不加多余空行/废话)",
    unknownDetail === "boom-boom",
    { unknownDetail },
  );
}

console.log(`\npersistence-diagnosis-smoke:${total - failures}/${total} 通过`);
process.exit(failures === 0 ? 0 : 1);
