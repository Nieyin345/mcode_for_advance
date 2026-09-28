/**
 * 假 VPS —— 真的起一个 ssh2 **服务端**(`ssh2.Server`),绑回环 + 随机端口。
 *
 * ## 为什么不起真 sshd、不连外网
 *
 * 中继的另一端在用户的 VPS 上。本套要验的是**中继自己**在那条链路上做对没有
 * (退避、清定时器、错误文案、半截状态),这些全在客户端这一侧决定。所以服务端的
 * 每一种反应(拒绝认证 / 拒绝端口转发 / 不答 SFTP / 直接掐断)在这里按需摆出来。
 *
 * 摆不出来的那一种写在 main.ts 的"没验的"那一段:**真的公网 SSH 服务器**
 * (`sshd_config` 的 `AllowTcpForwarding`、真实的 `ss`/`netstat` 输出、真的
 * `socat`/`python3` 二进制)。
 *
 * ## 它替中继干活的两件事
 *
 * 1. **回应 `exec`**:中继靠 `which socat` / `which python3` / `ss -ltn …` 的输出
 *    决定走哪条转发器分支。这里按 `execReplies` 逐条回。
 * 2. **`tcpip-forward` → `forwardOut`**:中继调 `forwardIn` 时服务端收到
 *    `tcpip-forward` 全局请求;这里**当场**在回环上起一个"手机"端口,谁连它就把
 *    连接 `forwardOut` 回中继 —— 于是 `tcp connection` 事件真的会来,
 *    `pipeToLocal()` 也就真的被走了一遍(不是假装)。
 *
 * ## SFTP
 *
 * `sftp: "accept"` 时提供一个只够 `uploadForwarderScript()` 用的最小服务端
 * (`MKDIR` / `OPEN` / `WRITE` / `CLOSE` / `FSTAT`),并把收到的字节按文件名攒起来
 * —— 用来核对上传内容与仓库里那份 `forwarder.py` 是否逐字节一致。
 */
import { createRequire } from "node:module";
import * as net from "node:net";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import * as timers from "./timers.js";

/* ⚠️ `ssh2` 走**运行期** require,不参与 esbuild 打包。
 *
 * 打包进来会连坐 `cpu-features`(原生 `.node`,esbuild 解析不了)以及 ssh2 自己
 * CJS 里的 `__dirname`(定死的 ESM 输出里没有)。两者报出来的都不是"中继坏了"。
 * run.sh 因此给了 `--external:ssh2` + bundle 旁边一份 `node_modules` 软链 ——
 * 与 library-adopt-smoke 给 pdfjs-dist 的那一手同源。
 *
 * ⚠️ **必须是 `require` 而不是 `await import("ssh2")`。** ssh2 的 CJS 入口对 ESM
 * 命名导入是"探测出来"的,而那个探测在**外层也是 ESM** 时拿不到 —— 实测
 * `await import("ssh2")` 里 `Server` / `utils` 都是 undefined,报出来的是一句
 * "`Server` is not a constructor",看着像本套的假 VPS 写坏了。`require` 拿到的是
 * CJS 那个真实的 `module.exports`,两件事都在。 */
const require_ = createRequire(import.meta.url);
const ssh2 = require_("ssh2") as {
  Server: new (cfg: unknown, cb: (client: SshClient) => void) => SshServer;
  utils: { generateKeyPairSync(type: string): { private: string; public: string } };
};

/* ⚠️ 超时那一手要走**没被换过**的定时器,所以从观察台借,而不是在这里读
 *    `globalThis.setTimeout` —— 本模块是在 `timers.install()` **之后**才被 import 的
 *    (main.ts 的 import 顺序),此刻全局那个已经是记录版了。见 `phoneGet`。 */
const realTimers = {
  setTimeout: timers.real.setTimeout,
};

/** ssh2 服务端那一侧的连接对象 —— 只写本套用到的那几个成员。 */
export interface SshClient {
  on(event: string, cb: (...args: never[]) => void): void;
  forwardOut(
    boundAddr: string,
    boundPort: number,
    remoteAddr: string,
    remotePort: number,
    cb: (err: Error | undefined, stream: NodeJS.ReadWriteStream) => void,
  ): void;
  end(): void;
  destroy(): void;
}

export interface SshServer {
  listen(port: number, host: string, cb: () => void): void;
  address(): net.AddressInfo | string | null;
  close(cb?: () => void): void;
  on(event: string, cb: (...args: never[]) => void): void;
}

/** 一条 `exec` 的应答策略。 */
export interface ExecRule {
  /** 命中条件:命令里含这个子串。 */
  match: string;
  stdout: string;
  /** 默认 0。 */
  code?: number;
}

export interface FakeVpsOptions {
  /** 认证放不放行。false = 模拟"密码/密钥不对"。 */
  acceptAuth?: boolean;
  /**
   * 认证**既不接受也不拒绝** —— 就那么挂着(模拟一台卡死的 sshd / 黑洞路由)。
   *
   * ⚠️ 这是"握手还没完"那条路上唯一**确定性**的摆法。认证挂着时 `ready` 永远不会来,
   * 也不会触发 `error` —— 于是中继那边只有 `conn.end()` 会产生 `close`。用它来钉
   * `connect()` 的 promise 一定会 settle(见 `main.ts` 第 9 节)。
   * (定时器观察台放过第三方定时器,所以 ssh2 自己的 20s `readyTimeout` 到时候还是会
   *  报错 —— 但那要 20 秒,断言在那之前就下结论。)
   */
  hangAuth?: boolean;
  /** `tcpip-forward` 放不放行。false = 模拟服务端不让开反向隧道。 */
  acceptForward?: boolean;
  /** 收到 SFTP 子系统请求时的反应。`"swallow"` 干脆不理(不拒绝也不接受)。 */
  sftp?: "accept" | "reject" | "swallow";
  /** 按顺序匹配的 `exec` 应答;端口模型认不出的命令才轮到它们。 */
  execReplies?: ExecRule[];
  /** 转发建立之后,"手机"那一侧要不要真的连进来(默认要)。 */
  connectPhone?: boolean;
  /** 转发器进程能起来,但绑端口时失败(`EADDRINUSE`)。 */
  bindFails?: boolean;
}

export interface FakeVpsHandle {
  port: number;
  /** Derived from the SSH server's actual host public key, not a test constant. */
  hostKeyFingerprint: string;
  /** 中继侧 SSH 连接**认证通过并 ready** 过几次。 */
  readonly readyCount: number;
  /** 服务端当前还挂着几个客户端连接。 */
  readonly liveClients: number;
  /** 服务端一共看到过几个客户端连接(含已断的)。 */
  readonly totalClients: number;
  /** 服务端有几次看到客户端连接**断掉**了。 */
  readonly closedClients: number;
  /** 收到过的全部 `exec` 命令,按顺序。 */
  readonly execCommands: string[];
  /** 中继请求建立的隧道端口(它自己的 `forwardIn`)。 */
  readonly tunnelPorts: number[];
  /** "手机"那一侧的监听端口。 */
  readonly phonePorts: number[];
  /** SFTP 上传到达的**文件名 → 内容**。 */
  readonly uploaded: Map<string, string>;
  /** 被 mkdir 过的远程路径。 */
  readonly mkdirs: string[];
  /** 端口上现在有没有人听 —— 与中继 `grep -c` 得到的是同一个答案。 */
  portHeld(port: number): boolean;
  /** 当场往某个端口上放一个占用者(场景里才知道端口号时用)。
   *  `"stale"` = 上一轮留下的转发器(pkill 清得掉),`"stubborn"` = SIGTERM 打不死、
   *  只有 `pkill -9` 清得掉,`"foreign"` = 别的服务(清不掉)。 */
  holdPort(port: number, kind: "stale" | "stubborn" | "foreign"): void;
  /** 服务端主动把当前连接掐掉(模拟 VPS 重启 / 网络断)。 */
  killClients(): void;
  /** 从这一刻起拒绝一切认证(模拟"服务器还在,但凭据失效了")。
   *  退避链要靠它把每一次重连都变成失败,而**不关掉端口** —— 关掉的话报的是
   *  `ECONNREFUSED`,走的是另一条错误分支。 */
  refuseAuthFromNow(): void;
  close(): Promise<void>;
}

/** 造一份 **ssh2 自己解析得了**的 host key。
 *
 *  ⚠️ **不能直接用 `generateKeyPairSync()` 的结果 —— 它大约 1/256 的概率是坏的。**
 *  ssh2 把 DER 里的 ed25519 公钥转回 OpenSSH 二进制时,首字节是 `0x00` 的那种会被
 *  削成 31 字节而不是 32(把那个 0 当成了 INTEGER 的符号位),于是**它自己的**
 *  `new Server()` 都解析不了这份私钥:
 *
 *      Cannot parse privateKey: Malformed OpenSSH private key
 *
 *  首字节为 0 的概率正好 1/256 —— 实测 120 次起落里复现过 1 次,而且崩在一个与
 *  中继毫无关系的地方(整场挂掉)。本套一次要起十几个假 VPS,不处理就是"偶尔全红"。
 *
 *  所以:生成之后拿 **`new Server()` 自己验一遍**(那正是后面要做的操作),
 *  不行就重来。ed25519 的这一手是纯随机的,重试必然收敛。
 */
function usableHostKey(): { private: string; public: string } {
  for (let i = 0; i < 32; i += 1) {
    const pair = ssh2.utils.generateKeyPairSync("ed25519");
    try {
      // 这一步就是"ssh2 能不能用这份私钥"的判据(不 listen,建完即弃)。
      new ssh2.Server({ hostKeys: [pair.private] }, () => {
        /* 只为验证 hostKey 能不能解析 */
      });
      return pair;
    } catch {
      /* 抽到了那份坏的(见上),换一份 */
    }
  }
  throw new Error("连着 32 次都抽到 ssh2 解析不了的 ed25519 私钥 —— 不该发生,查 keygen");
}

/** 起一个假 VPS。 */
/** 起一个假 VPS。 */
export async function startFakeVps(opts: FakeVpsOptions = {}): Promise<FakeVpsHandle> {
  /** `let` 而不是 `const`:`refuseAuthFromNow()` 会在场景中途把它翻成 false。 */
  let acceptAuth = opts.acceptAuth ?? true;
  const acceptForward = opts.acceptForward ?? true;
  const sftpMode = opts.sftp ?? "reject";
  const rules = opts.execReplies ?? [];
  const connectPhone = opts.connectPhone ?? true;

  const keys = usableHostKey();
  const hostKeyBlob = keys.public.split(/\s+/)[1];
  if (!hostKeyBlob) throw new Error("假 VPS 无法解析自己的 SSH 主机公钥");
  const hostKeyFingerprint = "SHA256:" + createHash("sha256")
    .update(Buffer.from(hostKeyBlob, "base64")).digest("base64").replace(/=+$/, "");

  let readyCount = 0;
  let liveClients = 0;
  let totalClients = 0;
  let closedClients = 0;
  const execCommands: string[] = [];
  const tunnelPorts: number[] = [];
  const phonePorts: number[] = [];
  const uploaded = new Map<string, string>();
  const mkdirs: string[] = [];
  const phoneServers: net.Server[] = [];
  const clients = new Set<SshClient>();
  let current: SshClient | null = null;
  /** 每条客户端连接各自的上传缓冲(按文件名拼)。 */
  const openFiles = new Map<string, string[]>();
  /** 中继 `forwardIn` 要服务端监听的隧道端口(真 sshd 会替你 bind,这里也照做)。 */
  const tunnelBindings: number[] = [];
  /** 真的"转发"出去的服务:`bindPort → 监听它的 net.Server`。 */
  const tunnelServers = new Map<number, net.Server>();

  /* ─────────────── 端口模型 ───────────────
   *
   * 中继对 VPS 的观察全靠 `exec` 的几句问话:`grep -c ":PORT$"` 问"端口上有人听吗",
   * `pgrep -f` 问"上次那个转发器还在吗",`tail ~/.mcode/forwarder.log` 问"它怎么没起来"。
   * 答案全从这里出 —— 转发器一起端口就占上,被 pkill 掉就放开,端口被别人占着时
   * **命令回 0 但没绑上**。
   *
   * ⚠️ 它必须**像那么回事**。第一版把 `grep -c` 写死成"永远 1",于是每次部署都先空转
   * 5.5 秒(两个 `waitForPortState` 各跑到超时)再去报"端口释放失败" —— 那不是中继的
   * bug,是假 VPS 摆错了档。
   *
   * 占着端口的**是谁**决定中继能不能清掉它,这正是 2026-08-28 那次事故的分水岭:
   *
   *   "stale"  —— 上一轮留下的转发器。`pkill -f "[T]CP-LISTEN:<port>"` 匹配得到它,
   *               所以清得掉;清掉之后新转发器起得来。**这是中继该走通的那条路。**
   *   "stubborn" —— 上一轮留下的、**SIGTERM 打不死**的转发器(卡住的 socket)。
   *               `pkill`(SIGTERM)清不掉,得等中继升级到 `pkill -9` 才走。
   *               这条路才会真的把 `waitForPortState` 的轮询循环走起来。
   *   "foreign" —— 别的服务(nginx 之类)。pkill 匹配不到它,端口永远清不出来 ——
   *               中继该**大声报错**并把它是什么也说给用户听,而不是假装部署成功。
   */
  const holders = new Map<number, "ours" | "stale" | "stubborn" | "foreign">();
  /** 最近一次"起转发器"为什么没绑上 —— 转发器的日志里就是它。null = 没失败过。 */
  let lastBindError: string | null = null;

  /** 转发器起不来时它往 `~/.mcode/forwarder.log` 里写的那一行(真工具的原文)。 */
  function bindErrorText(kind: "socat" | "python3", port: number): string {
    return kind === "socat"
      ? `2050/01/01 00:00:00 socat[8123] E bind(5, {AF=2 0.0.0.0:${port}}, 16): Address already in use`
      : `Traceback (most recent call last):\n  File "/root/.mcode/forwarder.py", line 42\nOSError: [Errno 98] Address already in use`;
  }

  /** 中继的每一句"观测类"问话在这里被回答。不认识就回 null,交回给 `execReplies`。 */
  function answer(cmd: string): string | null {
    // —— 起转发器 ——(必须认 `nohup`:pgrep/pkill 的命令行里也有 `TCP-LISTEN:<port>`)
    const socat = /nohup socat TCP-LISTEN:(\d+)/.exec(cmd);
    const py = /nohup python3 \S*forwarder\.py (\d+)/.exec(cmd);
    if (socat || py) {
      const port = socat ? Number(socat[1]) : Number(py![1]);
      const kind: "socat" | "python3" = socat ? "socat" : "python3";
      if (holders.has(port) || opts.bindFails) {
        // ⚠️ **"命令执行成功"与"真的绑上了"是两件事。** 端口被别人占着(或那个二进制
        //    坏掉)时 `nohup … &` 照样回 0,但端口上没有任何人听 —— 这正是 2026-08-28
        //    那次事故的形状:中继以为转发器起来了,手机连过去是死的。
        lastBindError = bindErrorText(kind, port);
      } else {
        holders.set(port, "ours");
        lastBindError = null;
      }
      return "";
    }
    // —— 端口上有人听吗 ——
    if (cmd.includes("grep -c")) {
      const m = /grep -c ":(\d+)\$"/.exec(cmd);
      return `${holders.has(m ? Number(m[1]) : 0) ? 1 : 0}\n`;
    }
    // —— 端口被谁占着(中继清不掉时才会问这一句) ——
    if (cmd.includes("ss -ltnp")) {
      const port = Number(/:(\d+)/.exec(cmd)?.[1] ?? 0);
      const who = holders.get(port);
      if (!who) return "";
      const proc =
        who === "foreign" ? 'users:(("nginx",pid=812,fd=6))' : `users:(("socat",pid=8123,fd=5))`;
      return `LISTEN 0 128 0.0.0.0:${port} 0.0.0.0:* ${proc}\n`;
    }
    // —— 上次那个转发器还在吗 / 把它杀了 ——
    //
    // ⚠️ SIGTERM 与 SIGKILL 要分开:"stubborn" 那种 SIGTERM 打不死(真实世界里是卡在
    //    socket 上的转发器),只有 `-9` 才走得掉。中继的清理是两级的
    //    (pgrep→pkill→等→pkill -9→等→报错),这两级都得能摆出来,否则第二级永远是
    //    空跑的,而 `waitForPortState` 的轮询循环也跟着一次都不走。
    if (cmd.includes("pkill")) {
      const port = Number(/:(\d+)/.exec(cmd)?.[1] ?? 0);
      const who = holders.get(port);
      const sigkill = cmd.includes("-9");
      if (who === "ours" || who === "stale" || (who === "stubborn" && sigkill)) holders.delete(port);
      return "";
    }
    if (cmd.includes("pgrep")) {
      const port = Number(/:(\d+)/.exec(cmd)?.[1] ?? 0);
      return holders.has(port) ? "8123\n" : "";
    }
    // —— 它怎么没起来 ——
    if (cmd.includes("tail -c 300")) {
      return lastBindError ? `${lastBindError}\n` : "";
    }
    return null;
  }

  /** 执行一条命令:先按端口模型回,复述不出才走 `execReplies`,都不中就回空。 */
  function respond(cmd: string): string {
    const known = answer(cmd);
    if (known !== null) return known;
    const hit = rules.find((r) => cmd.includes(r.match));
    return hit?.stdout ?? "";
  }

  interface SessionLike {
    on(event: string, cb: (...args: never[]) => void): void;
  }
  interface ExecStreamLike {
    exit(code: number): void;
    end(data?: string): void;
  }
  interface SftpLike {
    on(event: string, cb: (...args: never[]) => void): void;
    handle(reqid: number, handle: Buffer): void;
    status(reqid: number, code: number): void;
    attrs(reqid: number, attrs: Record<string, number>): void;
    name(reqid: number, entries: Array<Record<string, unknown>>): void;
  }

  const srv: SshServer = new ssh2.Server({ hostKeys: [keys.private] }, (client) => {
    totalClients += 1;
    liveClients += 1;
    clients.add(client);
    current = client;

    /* ⚠️ **`'tcpip'` 必须挂上。** 中继的 `pipeToLocal()` 是**回调式**的
     * (`conn.forwardOut(…, cb)`),而 ssh2 服务端只在**有 `'tcpip'` 监听者**时才会去
     * 完成 `direct-tcpip` 那个 channel(server.js:`if (listenerCount(this,'tcpip'))`)。
     * 换句话说不挂它、光靠回环上直连"手机",那条数据通路**根本不是反向隧道** ——
     * 中继这一侧的 `forwardOut` 会一直挂到超时。第一版就是这样,于是
     * "手机穿过 VPS 拿回正文"那条断言查的是假 VPS 的回环直连,与中继无关。
     *
     * 真 sshd 的行为:在 VPS 上 `sshd` 自己 bind 隧道端口,手机连它,sshd 把连接以
     * `direct-tcpip` 交回客户端。这里照着做:连进来的 socket 交给中继,中继再把流
     * 接回本机的移动端服务。
     *
     * `accept()` 还回来的那个 stream 就是对面 `forwardOut(…, cb)` 收到的那一个 ——
     * ssh2 两端共用一个 channel,这里只要认了它,管道就通了。 */
    client.on("tcpip", ((accept: () => NodeJS.ReadWriteStream) => {
      accept();
    }) as never);

    client.on("authentication", ((ctx: { accept(): void; reject(m: string[]): void }) => {
      if (opts.hangAuth) return; // 挂着不答 —— 见 `hangAuth` 的注释
      if (acceptAuth) ctx.accept();
      else ctx.reject(["password", "publickey"]);
    }) as never);

    client.on("ready", (() => {
      readyCount += 1;
    }) as never);

    client.on("session", ((accept: () => SessionLike) => {
      const session = accept();

      session.on("exec", ((acceptExec: () => ExecStreamLike, _reject: () => void, info: { command: string }) => {
        execCommands.push(info.command);
        const stream = acceptExec();
        // ⚠️ 这里是**唯一**回话的地方:端口模型先答,答不上来才查 `execReplies`。
        //    早先这一行写的是 `rules.find(...)` —— 于是端口模型整个是死的,所有
        //    `grep -c` 都走 `execReplies` 里那个写死的 "1\n"。
        stream.exit(0);
        stream.end(respond(info.command));
      }) as never);

      session.on("sftp", ((acceptSub: () => SftpLike, rejectSub: (why: string) => void) => {
        if (sftpMode === "swallow") return;
        if (sftpMode === "reject") {
          rejectSub("no sftp here");
          return;
        }
        const sftp = acceptSub();
        const handles = new Map<string, string>();
        let n = 0;
        sftp.on("MKDIR", ((reqid: number, path: string) => {
          mkdirs.push(path);
          sftp.status(reqid, 0);
        }) as never);
        sftp.on("OPEN", ((reqid: number, filename: string) => {
          const h = Buffer.alloc(4);
          h.writeUInt32BE((n += 1), 0);
          handles.set(h.toString("hex"), filename);
          openFiles.set(filename, []);
          sftp.handle(reqid, h);
        }) as never);
        sftp.on("WRITE", ((reqid: number, handle: Buffer, _offset: number, data: Buffer) => {
          const name = handles.get(handle.toString("hex"));
          if (name) openFiles.get(name)!.push(data.toString("utf8"));
          sftp.status(reqid, 0);
        }) as never);
        sftp.on("FSTAT", ((reqid: number) => {
          sftp.attrs(reqid, { mode: 0o100755, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 });
        }) as never);
        sftp.on("CLOSE", ((reqid: number, handle: Buffer) => {
          const name = handles.get(handle.toString("hex"));
          if (name) uploaded.set(name, (openFiles.get(name) ?? []).join(""));
          sftp.status(reqid, 0);
        }) as never);
        sftp.on("REALPATH", ((reqid: number) => {
          sftp.name(reqid, [{ filename: "/root", longname: "/root", attrs: {} }]);
        }) as never);
        sftp.on("STAT", ((reqid: number) => sftp.status(reqid, 2)) as never);
        sftp.on("LSTAT", ((reqid: number) => sftp.status(reqid, 2)) as never);
        sftp.on("OPENDIR", ((reqid: number) => sftp.status(reqid, 2)) as never);
      }) as never);
    }) as never);

    client.on("request", ((accept: () => void, reject: () => void, name: string, info: { bindPort: number }) => {
      if (name !== "tcpip-forward" || !acceptForward) {
        reject();
        return;
      }
      accept();
      tunnelPorts.push(info.bindPort);
      if (!connectPhone) return;
      /* 真 sshd 会为 `tcpip-forward` 在指定地址上**真的 bind 一个口**,手机连的就是它,
       * 它再把连接以 `direct-tcpip` 交回客户端。这里照做。
       *
       * ⚠️ 监听 **0**(临时端口)而不是 `info.bindPort`:那是个随机端口,真去 bind 有
       *    撞上本机已占端口的风险 —— 报出来的是 `EADDRINUSE` 而不是中继的问题。 */
      const s = net.createServer((sock) => {
        const cl = current;
        if (!cl) {
          sock.destroy();
          return;
        }
        cl.forwardOut("127.0.0.1", info.bindPort, "127.0.0.1", sock.remotePort ?? 0, (err, ch) => {
          if (err) {
            sock.destroy();
            return;
          }
          ch.pipe(sock);
          sock.pipe(ch);
        });
      });
      s.on("error", () => {
        /* 端口被占之类,场景自己会看出来 */
      });
      s.listen(0, "127.0.0.1", () => {
        const a = s.address();
        if (a && typeof a !== "string") phonePorts.push(a.port);
        tunnelServers.set(info.bindPort, s);
      });
    }) as never);

    client.on("close", (() => {
      closedClients += 1;
      liveClients -= 1;
      clients.delete(client);
      if (current === client) current = null;
      for (const s of tunnelServers.values()) s.close();
      tunnelServers.clear();
    }) as never);

    client.on("error", (() => {
      /* 掐连接是这套的常规操作,不算错 */
    }) as never);
  });

  await new Promise<void>((resolve, reject) => {
    srv.on("error", reject as never);
    srv.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = srv.address();
  if (!addr || typeof addr === "string") throw new Error("假 VPS 拿不到端口");

  /**
   * 在回环上起一个"手机"监听口;谁连它,就 forwardOut 回中继那条反向隧道。
   *
   * ⚠️ **`close()` 不能只关服务端就完事。** ssh2 的 `Server.close()` 只停 listen,
   * 还挂着的客户端连接会让它**不回调** —— 本轮因此整场挂死过一次(跑到第 5 节停住,
   * 最后被外面的 timeout 杀掉)。所以先把活着的连接掐掉再关。
   */
  function killAllClients(): void {
    for (const c of clients) {
      try {
        c.end();
      } catch {
        /* */
      }
      try {
        c.destroy();
      } catch {
        /* */
      }
    }
  }

  return {
    port: addr.port,
    hostKeyFingerprint,
    get readyCount() {
      return readyCount;
    },
    get liveClients() {
      return liveClients;
    },
    get totalClients() {
      return totalClients;
    },
    get closedClients() {
      return closedClients;
    },
    execCommands,
    tunnelPorts,
    phonePorts,
    uploaded,
    mkdirs,
    portHeld(port: number) {
      return holders.has(port);
    },
    holdPort(port: number, kind: "stale" | "stubborn" | "foreign") {
      holders.set(port, kind);
    },
    killClients() {
      killAllClients();
      current = null;
    },
    refuseAuthFromNow() {
      acceptAuth = false;
    },
    async close() {
      killAllClients();
      for (const p of phoneServers) await new Promise<void>((r) => p.close(() => r()));
      for (const s of tunnelServers.values()) s.close();
      tunnelServers.clear();
      await new Promise<void>((r) => srv.close(() => r()));
    },
  };
}

/** 从"手机"连到假 VPS 给的那个口,发一个 HTTP 请求,收回来的正文。
 *
 *  ⚠️ **超时必须走真定时器。** 本套装着的定时器观察台会把**每一个** `setTimeout`
 *  都改成 1ms 后执行(它要靠这个把 62 秒的退避链压到毫秒级)。`phoneGet` 自己的那个
 *  超时因此也会立刻触发,函数还没等到隧道那边的回复就返回 `<timeout>` —— 看上去
 *  **像数据通路坏了**(而且它把"真的连上了"这件事也一起藏住)。所以这里的超时不走
 *  `globalThis.setTimeout`(可能已被换掉),而是从观察台借那个**没被换过**的原始引用。 */
export function phoneGet(phonePort: number, path = "/api/health", timeoutMs = 3000): Promise<string> {
  const realSetTimeout = realTimers.setTimeout;
  return new Promise((resolve) => {
    let buf = "";
    const sock = net.connect({ host: "127.0.0.1", port: phonePort }, () => {
      sock.write(`GET ${path} HTTP/1.0\r\nHost: phone\r\n\r\n`);
    });
    const done = (v: string) => {
      try {
        sock.destroy();
      } catch {
        /* */
      }
      resolve(v);
    };
    const timer = realSetTimeout(() => done(buf || "<timeout>"), timeoutMs);
    sock.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
    });
    sock.on("close", () => {
      clearTimeout(timer);
      done(buf);
    });
    sock.on("error", (e: Error) => {
      clearTimeout(timer);
      done(`<error: ${e.message}>`);
    });
  });
}

/** 磁盘上那份真 `forwarder.py` 的字节 —— 中继 SFTP 上传的正是它(`?raw` 内联)。
 *
 *  ⚠️ **不能拿 `import.meta.url` 往上找。** 本套是用 esbuild 打包到临时目录再跑的,
 *  模块求值那一刻 `import.meta.url` 指的是**产物**所在的位置(`/tmp/mcode-relay-smoke.XXXX/smoke.mjs`),
 *  从那儿往上数三级落到的是一处毫不相干的路径,报出来是 `ENOENT` —— 看着像本套写坏了。
 *  run.sh 已经把仓库那份的根(`apps/desktop`)从环境变量给进来。 */
export function realForwarderPy(): string {
  const root = process.env.MCODE_SMOKE_APP_ROOT;
  if (!root) {
    throw new Error(
      "MCODE_SMOKE_APP_ROOT 没设 —— 本套要拿磁盘上那份真的 forwarder.py 与 SFTP 上传的逐字节对比,run.sh 里给了它。",
    );
  }
  return readFileSync(join(root, "src", "main", "relay", "forwarder.py"), "utf8");
}
