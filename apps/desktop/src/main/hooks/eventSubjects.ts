/**
 * 一条事件流的**匹配主语**是怎么算出来的 —— 钩子(`HookRunner`)和自动化触发器
 * (`automationRunner`)共用这一份。
 *
 * 「共用」不是洁癖:`tool.result` 那个事件本身**不带工具名**(三个提供方都不带,见
 * `ToolResultEvent`),得靠前面那条 `tool.use`/`approval.request` 记下来的小表回查 ——
 * 而那是一次**有状态**的动作。两份各记一份的话,这种"要回查状态"的规则迟早会分家(比如
 * 一边把上界设成 500 另一边没设),而分家之后的表现是"同一条规则在钩子里生效、在触发器
 * 里不生效"。
 *
 * 所以两边各持一个 {@link createEventSubjects} 的**实例**(状态是每次调用新起的,不共享),
 * 逻辑只有这一份。
 */
import { relative } from "node:path";
import type { RuntimeEvent } from "@contracts/runtime";

/** 一次事件的解析结果。两件事一起给,是因为它们共用那份状态(见下)。 */
export interface EventSubjectsOf {
  /** 工具名(载荷里那个 `toolName`)。事件不带工具名时是 undefined。 */
  toolName?: string;
  /** `matcher` 拿去比的主语。空/缺省 = 这条事件没有主语,只有"事件名"可比。 */
  subjects?: readonly string[];
}

export interface EventSubjects {
  of(e: RuntimeEvent, cwd: string): EventSubjectsOf;
}

/**
 * 起一个实例。**有状态**(见 `toolNames`),所以每次要用的地方各起一个 —— 不要当纯函数用。
 */
export function createEventSubjects(): EventSubjects {
  /**
   * `toolCallId → 工具名`。**只为了 `tool.result`**:那个事件本身不带工具名(三个
   * 提供方都不带,见 `ToolResultEvent`),而"Write 跑完之后做点什么"是最自然的一种
   * 钩子。用完即删,顺带把内存兜住。
   */
  const toolNames = new Map<string, string>();

  return {
    /**
     * 这次事件的**主语**(`matcher` 拿去比的东西)和**工具名**(载荷里的 `toolName`)。
     *
     * 两件事一起做,是因为它们共用一份状态:工具名得先记下来,`tool.result` 那种只带
     * `toolCallId` 的事件才查得到(见 `toolNames`)。
     */
    of(e: RuntimeEvent, cwd: string): EventSubjectsOf {
      switch (e.type) {
        case "tool.use":
        case "approval.request":
          // 记下来给后面的 `tool.result` 用(见 `toolNames` 的注释)。
          toolNames.set(e.toolCallId, e.toolName);
          // 上界:异常情况下(结果一直没回来)不让它无限长。
          if (toolNames.size > 500) toolNames.clear();
          return { toolName: e.toolName, subjects: [e.toolName] };
        case "tool.result": {
          const name = toolNames.get(e.toolCallId);
          toolNames.delete(e.toolCallId);
          return name === undefined ? {} : { toolName: name, subjects: [name] };
        }
        case "turn.files":
          return { subjects: fileSubjects(e.files.map((f) => f.filePath), cwd) };
        default:
          return {};
      }
    },
  };
}

/**
 * `turn.files` 的匹配主语:每个文件的**绝对路径**和**相对会话目录的路径**,都换成 `/`。
 *
 * 两份都给,是因为用户脑子里想的是哪种都有 —— `src/*.ts`(相对)和 `*.ts`(哪儿都
 * 算)。只给绝对路径的话前者永远匹配不上(它是 `D:/…/src/a.ts`);只给相对的则拿不到
 * 会话目录之外的文件。两边都试一次最省心,代价只是模式匹配多跑一遍。
 */
export function fileSubjects(paths: readonly string[], cwd: string): string[] {
  const out: string[] = [];
  for (const path of paths) {
    const abs = path.replace(/\\/g, "/");
    out.push(abs);
    const rel = relative(cwd, path).replace(/\\/g, "/");
    if (rel.length > 0 && rel !== abs) out.push(rel);
  }
  return out;
}