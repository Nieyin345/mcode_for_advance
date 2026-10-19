/**
 * 故障注入用的 `node:fs` 替身 —— **只在本套 smoke 的临时目录**注入失败,
 * 绝不指向真实用户路径(见 `run.sh` 的 `mktemp -d`)。
 *
 * ## 为什么需要它
 *
 * 台账 MC-068 §33.2 / §33.3 的两条红例,考的都是「真实文件系统调用在**特定一步**抛错
 * 之后,`moveFileSafe` 如实报了什么、真文件成了什么样」。光走 happy path 测不出:
 * 必须让生产函数里的某一次 `fs.promises.rm` / `rename` / `link` 真的抛一次
 * `EPERM`(或 `EXDEV`),其余调用照走真实文件系统。
 *
 * 手法:用 `export * from "fs"` 拿真实实现,只把 `promises` 换成一个 Proxy —— 只包住
 * `moveFileSafe` 真正会调的 `rm` / `rename` / `link` 三个方法,其余方法原样透传。
 * 同步 API(`lstatSync` / `realpathSync` / `mkdtempSync` …)完全不动,smoke 自己建夹具、
 * `realPathWithin` 解析物理路径都照走真的。
 *
 * 可同时武装**多条**规则(每条各带自己的命中次数):例如「link 抛 EXDEV」+「rm 抛 EPERM」
 * 一起,才能复现「跨卷复制成功、删源失败」这条时序。
 */
import { promises as realPromises } from "fs";

export * from "fs";

type FaultKind = "rm" | "rename" | "link" | "copyFile";
type Mutation = { kind: "missing-lstat" | "rename-backup" | "copyFile-after" | "cp-after"; match:string; action: (args:string[])=>void; remaining:number };
const mutations:Mutation[]=[];
let mutationHits=0;
export function armMutation(kind:Mutation["kind"],match:string,action:(args:string[])=>void):void {
  mutations.push({kind,match,action,remaining:1});
}
export function mutationCount():number {return mutationHits;}
function mutate(kind:Mutation["kind"],args:string[]):void {
  for (const m of mutations) {
    if(m.kind===kind&&m.remaining>0&&args.some(a=>a.includes(m.match))) {
      m.remaining--;mutationHits++;m.action(args);return;
    }
  }
}

interface Rule {
  kind: FaultKind;
  /** 命中条件:调用里任意一个字符串参数**包含**这段子串。 */
  match: string;
  code: string;
  remaining: number;
  /** 抛错前先跑一下(用来在源提交前模拟「另一个写入者占了目标槽位」)。 */
  before?: (args: string[]) => void;
}

const rules: Rule[] = [];
/** 已经命中注入的总次数(供断言「注入真的生效了」)。 */
export let faultHits = 0;

/**
 * 追加一条注入规则:`kind` 方法、任意字符串参数含 `match` 时抛 `code`(默认 EPERM),
 * 最多命中 `times` 次(默认 1)。可调用多次叠加多条。
 */
export function armFault(
  kind: FaultKind,
  match: string,
  opts: { code?: string; times?: number; before?: (args: string[]) => void } = {},
): void {
  rules.push({ kind, match, code: opts.code ?? "EPERM", remaining: opts.times ?? 1, before: opts.before });
}

export function clearFault(): void {
  rules.length = 0;
  mutations.length=0;
}

/** 注入总共命中了几次(供「注入生效了吗」的守卫,防"空过"的假绿)。 */
export function hits(): number {
  return faultHits;
}

function hit(kind: FaultKind, args: unknown[]): Rule | null {
  const strs = args.filter((a): a is string => typeof a === "string");
  for (const r of rules) {
    if (r.kind !== kind || r.remaining <= 0) continue;
    if (!strs.some((s) => s.includes(r.match))) continue;
    r.remaining--;
    faultHits++;
    r.before?.(strs);
    return r;
  }
  return null;
}

function injected(kind: FaultKind, r: Rule): NodeJS.ErrnoException {
  return Object.assign(new Error(`injected ${kind} failure (isolated smoke)`), { code: r.code });
}

const rmImpl = async (path: string, options?: unknown): Promise<void> => {
  const r = hit("rm", [path]);
  if (r) throw injected("rm", r);
  return realPromises.rm(path, options as never);
};
const renameImpl = async (from: string, to: string): Promise<void> => {
  if(to.includes(".mcode-move-bak-")) mutate("rename-backup",[from,to]);
  const r = hit("rename", [from, to]);
  if (r) throw injected("rename", r);
  return realPromises.rename(from, to);
};
const linkImpl = async (existing: string, newPath: string): Promise<void> => {
  const r = hit("link", [existing, newPath]);
  if (r) throw injected("link", r);
  return realPromises.link(existing, newPath);
};
const copyFileImpl = async (src: string, dest: string, mode?: number): Promise<void> => {
  const r = hit("copyFile", [src, dest]);
  if (r) throw injected("copyFile", r);
  await realPromises.copyFile(src, dest, mode);
  mutate("copyFile-after",[src,dest]);
};

const lstatImpl = (async (...args: Parameters<typeof realPromises.lstat>)=>{
  try{return await realPromises.lstat(...args);}
  catch(error) {
    if((error as NodeJS.ErrnoException).code==="ENOENT") mutate("missing-lstat",[String(args[0])]);
    throw error;
  }
}) as typeof realPromises.lstat;
const cpImpl:typeof realPromises.cp=async(src,dest,opts):Promise<void>=>{
  await realPromises.cp(src,dest,opts);
  mutate("cp-after",[String(src),String(dest)]);
};

/** 透传真实 fs.promises, injecting only synthetic temporary fixture mutations. */
export const promises: typeof realPromises = new Proxy(realPromises, {
  get(target, prop, receiver): unknown {
    if (prop === "rm") return rmImpl;
    if (prop === "rename") return renameImpl;
    if (prop === "link") return linkImpl;
    if (prop === "copyFile") return copyFileImpl;
    if (prop === "lstat") return lstatImpl;
    if (prop === "cp") return cpImpl;
    const v = Reflect.get(target, prop, receiver);
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
  },
}) as typeof realPromises;
