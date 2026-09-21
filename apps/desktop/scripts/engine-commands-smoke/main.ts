/**
 * 源级 + 行为级:**引擎报上来的斜杠命令清单真的会走到界面,本地命令的输出真的会落下来。**
 *
 * ## 这一套防的是什么
 *
 * 用户 2026-09-21:「我发现这个mcode用不了claude code内置的命令呀,对话框里面没有」。
 *
 * 根因不是"没实现",是**一直有一份数据没人接** —— Claude Code CLI 每轮的
 * `system/init` 消息里带着 `slash_commands`(实测 57 条,含 `/usage` `/context`
 * `/model` `/mcp`),而 `SdkMessageAdapter.handleSystem` 在那之前只取了
 * `session_id` / `model` / `permissionMode`,把这个字段整个丢了;`dispatch` 的
 * subtype 分派里也没有 `local_command_output`,于是命令的执行结果同样进了那句
 * 「Unknown subtypes are silently ignored (forward-compatible)」。
 *
 * 这两处的形状都是**"字段在协议里、没人读"**:不报错、不告警,只是功能安静地不工作。
 * 所以这一套不去测"菜单画得对不对"(那要起 Electron),而是钉住**适配器这一层**:
 * 喂一条真实的 `system/init`,断言清单出来了;喂一条 `local_command_output`,
 * 断言输出出来了。
 *
 * ## 为什么是行为测试而不是源码扫描
 *
 * `dispatch` 是个大 if 链,以后还会加 subtype。源码扫描只能证明"字符串出现过",
 * 证明不了"它真的走了 handleSystem 而不是掉进 else"。而这个适配器**恰好可以在
 * 无头下实例化**(它只 import `@contracts/*` 和 `@main/lib/fileSnapshot.js`,
 * 后者是纯 fs;`ProviderContext` 是接口,自己造一个即可)。
 *
 * Run: scripts/engine-commands-smoke/run.sh
 */
import { SdkMessageAdapter } from "@main/providers/claude-sdk/SdkMessageAdapter.js";
import { FileSnapshot } from "@main/lib/fileSnapshot.js";
import type { ProviderContext } from "@contracts/provider";
import type { RuntimeEvent } from "@contracts/runtime";

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

/** 收事件的桩:适配器只用到 `emit` / `log` / `onProviderSessionId`。 */
function makeCtx(): { ctx: ProviderContext; events: RuntimeEvent[] } {
  const events: RuntimeEvent[] = [];
  const ctx: ProviderContext = {
    emit: (e) => events.push(e),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
  return { ctx, events };
}

function makeAdapter(ctx: ProviderContext): SdkMessageAdapter {
  return new SdkMessageAdapter(
    ctx,
    "sess-1",
    /* askUserQuestionAvailable */ false,
    /* cwd */ process.cwd(),
    new FileSnapshot(),
  );
}

/** 造一条 CLI 发来的 `system/init`。字段照 SDK 的 `SDKSystemMessage` 抄,
 *  只留适配器会读的那几个 + 本次要验的两个。 */
function initMessage(extra: Record<string, unknown>): unknown {
  return {
    type: "system",
    subtype: "init",
    session_id: "cli-session-abc",
    model: "claude-opus-5",
    permissionMode: "default",
    ...extra,
  };
}

async function main(): Promise<void> {
  console.log("engine-commands-smoke — 引擎命令清单 + 本地命令输出");

  /* ── 1. init 里的 slash_commands 真的发出来了 ── */

  {
    const { ctx, events } = makeCtx();
    const a = makeAdapter(ctx);
    await a.dispatch(
      initMessage({
        slash_commands: ["usage", "context", "model", "mcp", "compact"],
        terminal_slash_commands: ["doctor", "color"],
      }) as never,
    );

    const ev = events.find((e) => e.type === "commands.available");
    check("init → 发出一条 commands.available", ev !== undefined);
    if (ev && ev.type === "commands.available") {
      check(
        "命令名逐条带过来（顺序保持）",
        JSON.stringify(ev.commands.map((c) => c.name)) ===
          JSON.stringify(["usage", "context", "model", "mcp", "compact"]),
        ev.commands.map((c) => c.name),
      );
      check(
        "terminal 标记也带过来（CLI 说这两条绑在本地终端上）",
        JSON.stringify(ev.terminalCommands) === JSON.stringify(["doctor", "color"]),
        ev.terminalCommands,
      );
      // init 那条路**只有名字**。这条断言是刻意的:如果哪天有人以为 init 带说明、
      // 于是菜单里那行字永远空着,这里会提醒说明要等 `commands_changed`。
      check(
        "init 只有名字、没有说明（说明在 commands_changed）",
        ev.commands.every((c) => c.description === "" && c.argumentHint === ""),
      );
      check("会话 id 对得上", ev.sessionId === "sess-1", ev.sessionId);
    }
  }

  /* ── 2. 老版本 CLI 不给 terminal_slash_commands 时不能炸 ── */

  {
    const { ctx, events } = makeCtx();
    const a = makeAdapter(ctx);
    await a.dispatch(
      initMessage({ slash_commands: ["usage"] }) as never, // 没有 terminal 字段
    );
    const ev = events.find((e) => e.type === "commands.available");
    check("缺 terminal_slash_commands 仍发出事件", ev !== undefined);
    if (ev && ev.type === "commands.available") {
      check("缺失时给空数组，不给 undefined", Array.isArray(ev.terminalCommands) && ev.terminalCommands.length === 0);
    }
  }

  /* ── 3. 完全没有 slash_commands 的 init（真正的老 CLI）不发空事件 ── */

  {
    const { ctx, events } = makeCtx();
    const a = makeAdapter(ctx);
    await a.dispatch(initMessage({}) as never);
    check(
      "没有 slash_commands 就不发 commands.available（别拿空表覆盖已有清单）",
      events.every((e) => e.type !== "commands.available"),
      events.map((e) => e.type),
    );
  }

  /* ── 4. commands_changed 带说明，且不清掉 terminal 标记 ── */

  {
    const { ctx, events } = makeCtx();
    const a = makeAdapter(ctx);
    // 先来一条 init（它记下 terminal 标记）…
    await a.dispatch(
      initMessage({ slash_commands: ["usage"], terminal_slash_commands: ["doctor"] }) as never,
    );
    // …再来一条 commands_changed（这条带说明、但没有 terminal 字段）。
    await a.dispatch({
      type: "system",
      subtype: "commands_changed",
      session_id: "cli-session-abc",
      commands: [
        { name: "usage", description: "Show usage", argumentHint: "", aliases: ["cost", "stats"] },
      ],
    } as never);

    const available = events.filter((e) => e.type === "commands.available");
    check("commands_changed → 又发一条 commands.available", available.length === 2, available.length);
    const last = available[available.length - 1];
    if (last && last.type === "commands.available") {
      check(
        "带上了说明和别名",
        last.commands[0]?.description === "Show usage" &&
          JSON.stringify(last.commands[0]?.aliases) === JSON.stringify(["cost", "stats"]),
        last.commands[0],
      );
      // 这条是防坑的:`commands_changed` 的载荷里**没有** terminal 标记,
      // 直接报空数组会把 `/doctor` 的标记冲掉。
      check(
        "不清掉上一份的 terminal 标记",
        JSON.stringify(last.terminalCommands) === JSON.stringify(["doctor"]),
        last.terminalCommands,
      );
    }
  }

  /* ── 5. local_command_output 落成事件（从前被静默丢弃） ── */

  {
    const { ctx, events } = makeCtx();
    const a = makeAdapter(ctx);
    await a.dispatch({
      type: "system",
      subtype: "local_command_output",
      session_id: "cli-session-abc",
      content: "Total cost: $0.42\nTotal duration: 1m 3s",
    } as never);

    const ev = events.find((e) => e.type === "local_command.output");
    check("local_command_output → 发出一条 local_command.output", ev !== undefined);
    if (ev && ev.type === "local_command.output") {
      check("内容原样带过来（含换行）", ev.content.includes("Total cost: $0.42") && ev.content.includes("\n"));
    }
  }

  /* ── 6. 空内容的 local_command_output 不发（别在流里落一个空卡片） ── */

  {
    const { ctx, events } = makeCtx();
    const a = makeAdapter(ctx);
    await a.dispatch({
      type: "system",
      subtype: "local_command_output",
      session_id: "cli-session-abc",
      content: "",
    } as never);
    check(
      "空内容不发事件",
      events.every((e) => e.type !== "local_command.output"),
      events.map((e) => e.type),
    );
  }

  /* ── 7. 未知 subtype 仍然被安静忽略（既有行为没被这次的 if 链破坏） ── */

  {
    const { ctx, events } = makeCtx();
    const a = makeAdapter(ctx);
    await a.dispatch({
      type: "system",
      subtype: "some_future_subtype",
      session_id: "cli-session-abc",
    } as never);
    check("未知 subtype 不发事件、不抛错", events.length === 0, events.map((e) => e.type));
  }

  console.log(`\nengine-commands-smoke: ${checks} 项断言, ${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
