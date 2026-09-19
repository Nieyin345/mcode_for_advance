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
 *
 * ## 为什么分成"事实"和"主语"两半
 *
 * 因为它们一个**有状态**、一个没有,而混在一个 `of()` 里会让"问主语"顺带消费状态 ——
 * 于是**问第二遍的答案和第一遍不一样**。那不是理论问题:`automationRunner` 是对**每条
 * 触发器**各问一次的(每条的项目目录不同,路径主语要按各自的算),而 `tool.result` 的
 * 工具名是**回查即消费**的。混着用的结果是第一条触发器把工具名取走,后面几条拿到空,
 * 带着 `matcher` 的触发器**安静地不响**。
 *
 * 所以:
 *  - {@link EventSubjects.factsOf} —— 有状态,**一次事件只调一次**(谁调谁负责只调一次);
 *  - {@link EventSubjects.subjectsOf} —— 纯函数,想算几遍算几遍,`cwd` 是它的入参;
 *  - {@link EventSubjects.of} —— 两半合起来跑一遍,给"一条事件只处理一次"的调用方
 *    (钩子就是这种:一条事件要么匹配某条钩子、要么不匹配,只问一次)。
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

/**
 * 事件里那部分**与 cwd 无关**的事实。目前只有工具名。
 *
 * 单独拆出来,是因为它**有状态**(见下)而主语那部分没有 —— 混在一起的结果是调用方
 * 每"问一次主语"就顺带消费一次状态,于是**问第二遍的答案和第一遍不一样**。
 */
export interface EventFacts {
  toolName?: string;
}

export interface EventSubjects {
  /** 事件里与 cwd 无关的事实。⚠️ **一次事件只调一次** —— 它是有状态的(见下)。 */
  factsOf(e: RuntimeEvent): EventFacts;
  /**
   * `matcher` 拿去比的主语。**纯函数** —— 同一条事件、不同的 cwd 各算一遍都对,
   * 想要几遍要几遍。`cwd` 只影响 `turn.files` 那种路径主语;工具名由调用方从
   * {@link EventSubjects.factsOf} 取一次传进来。
   */
  subjectsOf(e: RuntimeEvent, cwd: string, toolName?: string): readonly string[] | undefined;
  /** 一次算完 = `factsOf` + `subjectsOf`。一条事件只跑一遍的调用方(钩子)用这个。 */
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

  const factsOf = (e: RuntimeEvent): EventFacts => {
    switch (e.type) {
      case "tool.use":
      case "approval.request":
        // 记下来给后面的 `tool.result` 用(见 `toolNames` 的注释)。
        toolNames.set(e.toolCallId, e.toolName);
        // 上界:异常情况下(结果一直没回来)不让它无限长。
        if (toolNames.size > 500) toolNames.clear();
        return { toolName: e.toolName };
      case "tool.result": {
        const name = toolNames.get(e.toolCallId);
        // ⚠️ **回查即消费。** 这就是"一次事件只能问一遍"的来源。
        toolNames.delete(e.toolCallId);
        return name === undefined ? {} : { toolName: name };
      }
      default:
        return {};
    }
  };

  /** 纯的那一半 —— 只依赖事件本身、toolName 和 cwd,不碰 `toolNames`。 */
  const subjectsOf = (
    e: RuntimeEvent,
    cwd: string,
    toolName?: string,
  ): readonly string[] | undefined => {
    if (e.type === "turn.files") {
      return fileSubjects(e.files.map((f) => f.filePath), cwd);
    }
    // 有工具名的事件:主语就是那个名字。查不到工具名的 `tool.result` 给 `undefined`
    // —— "没有主语"和"主语不限制"是两件事(见 `matchesHook`)。
    return toolName === undefined ? undefined : [toolName];
  };

  return {
    factsOf,
    subjectsOf,
    of(e: RuntimeEvent, cwd: string): EventSubjectsOf {
      const facts = factsOf(e);
      const subjects = subjectsOf(e, cwd, facts.toolName);
      return {
        ...(facts.toolName !== undefined ? { toolName: facts.toolName } : {}),
        ...(subjects !== undefined ? { subjects } : {}),
      };
    },
  };
}

/**
 * `turn.files` 的匹配主语:每个文件的**绝对路径**和**相对会话目录的路径**。
 *
 * ## 为什么要给两种「写法」而不只是两种「路径」
 *
 * 路径那两种(绝对/相对)是因为用户脑子里想的是哪种都有 —— `src/*.ts`(相对)和
 * `*.ts`(哪儿都算)。只给绝对路径的话前者永远匹配不上(它是 `D:/…/src/a.ts`);
 * 只给相对的则拿不到会话目录之外的文件。
 *
 * ⚠️ 而**分隔符也有两种,这一层必须都给** —— 这是踩过的坑。事件里的路径在 Windows 上
 * 是**反斜杠**过来的(`D:\proj\src\a.ts`),而用户填 `matcher` 时有两条路都会写出反斜杠:
 *
 *  1. 从界面上粘一个路径进来,或者照着资源管理器里的写法填 —— 那时手里就是反斜杠;
 *  2. 想到"绝对路径",于是照着事件里看到的样子写。
 *
 * 早先这里把路径一律换成 `/` 再发出去,于是上面两种写法**一条都匹配不上**,而且
 * **一个字都不报** —— 用户看到的就是"我的钩子该响的时候没响"。所以现在:每个路径
 * **按原样**发一份,再发一份换成 `/` 的;相对路径同理。多出来的条数只在 Windows 上
 * 才出现(那里的输入本身就是反斜杠),而匹配多跑一遍正则的代价远小于一条安静的钩子。
 *
 * 顺序稳定(绝对、相对,各自原样在前),所以调用方的断言看得见它。
 */
export function fileSubjects(paths: readonly string[], cwd: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  /** 按原样和换成 `/` 两种写法各发一份,空串与重复的丢掉。 */
  const push = (value: string): void => {
    if (value.length === 0) return;
    for (const form of value.includes("\\") ? [value, value.replace(/\\/g, "/")] : [value]) {
      if (seen.has(form)) continue;
      seen.add(form);
      out.push(form);
    }
  };
  for (const path of paths) {
    push(path);
    push(relative(cwd, path));
  }
  return out;
}