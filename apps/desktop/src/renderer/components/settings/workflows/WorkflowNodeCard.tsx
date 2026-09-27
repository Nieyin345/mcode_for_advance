/**
 * 画布上的一张节点卡片。
 *
 * ## 为什么是 DOM 而不是 SVG
 *
 * 和 git 提交图同一个理由:文字排版、截断、选中态、hover 全部交给浏览器。SVG 只
 * 用来画**边**(见 `WorkflowCanvas`),那里没有文字。
 *
 * ## 卡片要说清三件事
 *
 * 1. **这一步是什么** —— 标题(用户起的)。
 * 2. **它靠什么跑** —— 类型 id(等宽,与作者在 README 里读到的一致,不翻译)。
 * 3. **它现在有没有问题** —— 类型没装、参数没填齐、执行方式还没实现。这三种都
 *    不该等到发消息才发现,所以直接在卡片上标出来。
 *
 * ## 四种执行方式各有各的样子
 *
 * 卡片按 `runner.kind` 分色:左边一道竖条 + 标题前一个图标 + 一点底色。这不是装饰
 * —— 一张图里"哪几步是子 agent、哪一步会跑在你的对话里、哪儿是岔路口",是看图时
 * 最要紧的一件事,而原来四种节点长得一模一样,只能去读那行小字里的类型 id。
 *
 * **主代理单独一档**:它和子 agent 是同一种执行方式,但它是这张图的入口、而且删不掉,
 * 所以给它品牌色 + 一颗星(星上那句提示回答的正是"为什么删不掉")。
 *
 * 下面那张表是 `Record<NodeRunnerKind, …>` —— 以后加一种执行方式,**漏了样式会编译
 * 不过**,不用等画布上多出一张和别人一样的卡片才发现。
 *
 * ## 两行,不三行
 *
 * 卡片固定两行高(见 `NODE_W` / `NODE_H` 那段注释)。"出了什么问题"那一句**顶掉能力
 * 标签**,不另起一行 —— 三种提示同时最多出现一种,专门为它留一行是白留,而多留的那
 * 14px 每张卡片都要付。
 *
 * ## 上下两个圆点
 *
 * 下面那个是**出线口**:按住它拖到另一张卡片上就连一条依赖(见 `WorkflowCanvas`)。
 * 上面那个是入线口,只是把"线从这边进"画出来,**不吃指针事件** —— 落到哪张卡片上
 * 是画布按坐标算的,不需要一个真的投放目标(那反而会让"拖到边上"落空)。
 *
 * 两个点都**压在卡片边缘上**(各露出一半)。所以外层不能 `overflow-hidden` ——
 * 那会把露在外面的一半连同它的点击区一起剪掉。圆角改由里面两段各自带(见下面)。
 *
 * 拖动整张卡片是"移动",所以出线口必须 `stopPropagation` —— 不拦的话按住圆点会
 * 同时开始拖卡片,两个都写回文档。出线口是 `div` 而不是 `button`:拖拽这件事没有
 * 键盘等价物,做成按钮只会让 Tab 停在一个按了没反应的东西上;键盘用户的等价路径
 * 是检查器里那组依赖勾选框,那条路一直都在。
 */
import type { MouseEvent as ReactMouseEvent } from "react";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import {
  isNodeRunnable,
  showsNodeCapability,
  validateNodeParams,
  type NodeRunnerKind,
  type NodeTypeEntry,
} from "@contracts/nodeType";
import { validateOutputRules } from "@contracts/outputConstraint";
import type { WorkflowNode } from "@contracts/workflow";
import {
  IconAlertTriangle,
  IconArrowsSplit,
  IconBolt,
  IconHelpCircle,
  IconMessages,
  IconPuzzle,
  IconRobotFace,
  IconStar,
  IconTerminal2,
} from "@renderer/lib/icons.js";
import { NODE_H, NODE_W } from "./workflowLayout.js";
import { isProtectedNode, nodeTitle } from "./workflowView.js";

/** 出线口的尺寸(px)。画布那边算连线起点时用的是卡片边缘,与它无关。 */
const PORT = 10;

/** 一张卡片的样子:`bar` 是左边缘那道竖条,`tint` 是底色,`icon` 是标题前那个图标的颜色。 */
interface NodeLook {
  bar: string;
  tint: string;
  icon: string;
  Icon: typeof IconStar;
}

/** 认不出类型的卡片(别人分享来的图引用了没装的类型)。**中性**,只把"这里有事"说出来。 */
const UNKNOWN_LOOK: NodeLook = {
  bar: "bg-edge",
  tint: "",
  icon: "text-content-subtle",
  Icon: IconHelpCircle,
};

/** 主代理:入口节点,和子 agent 同一种执行方式,但它是这张图的起点、而且删不掉。 */
const ENTRY_LOOK: NodeLook = {
  bar: "bg-accent",
  tint: "bg-accent/10",
  icon: "text-accent",
  Icon: IconStar,
};

/**
 * 每一种执行方式长什么样。
 *
 * 颜色的分工:**子 agent 最中性**(它是默认的那一种,一张图里多半全是它);对话节点
 * 是 `info`(它"跑到你的对话里去了");分支是 `warning` 同色系(它会让整张图**停下来**
 * 等人 —— 「决定权给模型」的那种分支不等人,但图标与说明在检查器里,卡片同色不算说谎);
 * 命令是 `success`(它真的**起一个进程**,"动手"的那一步 —— 绿灯放行的那种绿)。
 *
 * 底色用 `/<alpha>` 而不是实色:`--*` 那几个变量本身是"R G B"三元组,`bg-info/10`
 * 会在浅色和深色两套主题下各自算出合适的淡色,不用手写两份。
 *
 * 触发器 = `accent`。它是整张图的**开头**(那次运行就是从它开始的),和入口
 * 节点(`ENTRY_LOOK`)同一档 —— 一张自动化里,"运行从哪儿开始"是第一个要看出来的。
 *
 * (决策节点并进了分支 —— 「决定权」长在分支的参数上,卡片不按它分色;模型选还是
 * 用户选,检查器里那个下拉说了算。)
 */
const KIND_LOOK: Record<NodeRunnerKind, NodeLook> = {
  prompt: { bar: "bg-edge", tint: "", icon: "text-content-subtle", Icon: IconRobotFace },
  conversation: { bar: "bg-info", tint: "bg-info/10", icon: "text-info", Icon: IconMessages },
  branch: { bar: "bg-warning", tint: "bg-warning/10", icon: "text-warning", Icon: IconArrowsSplit },
  condition: { bar: "bg-info", tint: "bg-info/10", icon: "text-info", Icon: IconArrowsSplit },
  trigger: { bar: "bg-accent", tint: "bg-accent/10", icon: "text-accent", Icon: IconBolt },
  command: { bar: "bg-success", tint: "bg-success/10", icon: "text-success", Icon: IconTerminal2 },
  code: { bar: "bg-success", tint: "bg-success/10", icon: "text-success", Icon: IconTerminal2 },
  // 模块能力调用:经宿主调用一个**只读**内置能力,不起进程、不跑模型 —— 所以不用
  // 命令那档「动手」的绿;拼图图标表示「接进来的能力」。在门禁激活前它会被上面的
  // `isNodeRunnable` 判为跑不了,卡片走 DEAD_LOOK,这一档届时才显示。
  "module-capability": { bar: "bg-info", tint: "bg-info/10", icon: "text-info", Icon: IconPuzzle },
};

/** 跑不起来的节点(`isNodeRunnable` 不过:执行方式没实现、或命令写在清单自带的脚本里
 *  还没接)。**danger 不看种类看死活** —— 以前 command 整种跑不了,danger 长在种类上;
 *  现在命令节点能跑了,danger 改挂在"这一个跑不了"上,否则一颗地雷混在一图绿色里。 */
const DEAD_LOOK: NodeLook = {
  bar: "bg-danger",
  tint: "bg-danger/10",
  icon: "text-danger",
  Icon: IconAlertTriangle,
};

export function WorkflowNodeCard({
  node,
  entry,
  selected,
  left,
  top,
  connecting,
  connectHint,
  onMouseDown,
  onStartConnect,
  onSelect,
}: {
  node: WorkflowNode;
  /** 这个节点引用的类型清单。**可能是 undefined** —— 别人分享来的图引用了没装的类型。 */
  entry: NodeTypeEntry | undefined;
  selected: boolean;
  left: number;
  top: number;
  /** 画布上正拉着一条线(不管拉的是不是这一张)。 */
  connecting: boolean;
  /** 正在拉连线时这张卡片扮演的角色(不拉的时候是 null)。 */
  connectHint: "source" | "ok" | "blocked" | null;
  onSelect?: () => void;
  onMouseDown: (event: ReactMouseEvent) => void;
  onStartConnect: (event: ReactMouseEvent) => void;
}) {
  const { t } = useI18n();
  const missingType = entry === undefined;
  const badParams = entry ? !validateNodeParams(entry.manifest, node.params).ok : false;
  // 产出约束配矛盾了(选了 JSON 数组又填必备字段……)—— 和参数不齐一样,是**画布上
  // 就该看得见**的问题:它会让存盘被拒,而用户不会想到去看检查器里那一段。
  const badRules = entry ? !validateOutputRules(entry.manifest, node.params).ok : false;
  // 跑不跑得起来是**清单 + 参数**的事(命令节点里"命令来自参数"的能跑、"来自清单
  // 自带脚本"的还不能)—— 判据收口在 `isNodeRunnable`,与调度器的拒绝同一份答案。
  const deadRunner = entry ? !isNodeRunnable(entry.manifest) : false;
  const problem = missingType || badParams || badRules || deadRunner;
  const isEntry = isProtectedNode(node) || entry?.manifest.runner.kind === "trigger";
  const look = missingType
    ? UNKNOWN_LOOK
    : deadRunner
      ? DEAD_LOOK
      : isEntry
        ? ENTRY_LOOK
        : KIND_LOOK[entry.manifest.runner.kind];
  const { Icon } = look;
  /**
   * 能力标签(`read` / `write` / `exec`)**只在它真的算数时显示** —— 也就是**只有
   * 子 agent**(`prompt`)。
   *
   * 另外四种的清单里那一项都是**为了形状完整**填的:分支与触发器什么都不跑、对话节点
   * 与主代理用的是主对话那套权限、命令与 code 起的是进程(而进程没有"权限模式"这回事)。
   * 给它们显示一个 `read`,是在说一句不成立的话。顺带也把这一行的宽度让给了类型 id,
   * 而它恰恰是最长的那一个(`mcode.conversation`)。
   *
   * ⚠️ **判据不能在这儿自己写。** 检查器里也有同一项(那个下拉框),两边给不出同一个
   * 答案时的现象是"卡片上写着 `read`、检查器里却让你改成 `write`,而那个 `write` 不
   * 起任何作用" —— 用户按界面说的做了,行为一点没变。所以两处都读
   * `@contracts/nodeType` 的 `showsNodeCapability`。
   */
  const capability = node.capability ?? entry?.manifest.capability;
  const showsCapability = showsNodeCapability(entry?.manifest) && capability !== undefined;
  const bad = connectHint === "blocked";

  // 三种问题最多同时出现一种(类型没装就没法查参数)。**顺序即优先级**:先报最靠前的
  // 那个原因,因为它是后面那些的前提。产出约束的矛盾(选了 JSON 数组又填必备字段……)
  // 和参数不齐归同一句话 —— 都是"这张卡片现在存不下去",而这一行就那么宽。
  const problemLabel = missingType
    ? t("settings.workflows.nodeTypeMissing")
    : badParams || badRules
      ? t("settings.workflows.nodeParamsIncomplete")
      : deadRunner
        ? t("settings.workflows.nodeRunnerMissing")
        : null;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={t("settings.workflows.nodeSelect", { name: nodeTitle(node, entry) })}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect?.(); }
      }}
      onMouseDown={onMouseDown}
      title={nodeTitle(node, entry)}
      style={{ left, top, width: NODE_W, height: NODE_H }}
      className={cn(
        "group absolute flex select-none rounded-md border",
        // 拉线的时候整块画布都是"投放区",光标要跟着变 —— 卡片自己写了 cursor-grab,
        // 只改 body 是盖不住它的(子元素的 cursor 优先)。
        connecting ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing",
        "bg-surface shadow-sm transition-colors",
        bad
          ? "border-danger ring-1 ring-danger/40"
          : connectHint !== null || selected
            ? "border-accent ring-1 ring-accent/40"
            : "border-edge hover:border-accent/50",
      )}
    >
      {/* 左边缘那道竖条 —— 四种执行方式最一眼能认出来的那处不同。圆角自己带:外层
          为了不剪掉端口圆点没有 overflow-hidden(见文件头)。 */}
      <span aria-hidden className={cn("w-1 shrink-0 self-stretch rounded-l-[5px]", look.bar)} />

      <div
        className={cn(
          "flex min-w-0 flex-1 flex-col justify-center gap-0.5 rounded-r-[5px] px-2",
          look.tint,
        )}
      >
        <div className="flex items-center gap-1">
          {/* 图标这一格是**固定的** —— 每张卡片都有,认不出类型的那张也有(问号)。
              这样一列卡片扫过去时,图标都在同一条竖线上。 */}
          <span
            title={isEntry ? t(entry?.manifest.runner.kind === "trigger" ? "settings.workflows.nodeTriggerHint" : "settings.workflows.mainNodeHint") : undefined}
            className={cn("shrink-0", look.icon)}
          >
            <Icon size={12} />
          </span>
          <span className="min-w-0 flex-1 truncate text-[0.8571em] font-medium text-content">
            {nodeTitle(node, entry)}
          </span>
          {problem && <IconAlertTriangle size={12} className="shrink-0 text-warning" />}
        </div>
        <div className="flex items-center gap-1.5 text-[0.7143em]">
          <code className="min-w-0 truncate text-content-subtle">{node.type}</code>
          {/* 有问题就说是什么问题(顶掉能力标签),没问题才显示能力 —— 见文件头
              「两行,不三行」。 */}
          {problemLabel !== null ? (
            <span className="shrink-0 truncate text-warning">{problemLabel}</span>
          ) : showsCapability ? (
            <span className="shrink-0 rounded bg-surface-muted px-1 leading-tight text-content-subtle">
              {capability}
            </span>
          ) : null}
        </div>
      </div>

      {/* 入线口。**只是个记号** —— 见文件头最后一段。主代理是图的入口,不可能有
          入边 —— 上面那个圆点在它身上是个永远接不上线的空头承诺,所以不画;下面的
          引出点不受影响。(触发器同样没有入边,但那是自动化那条线的地盘,这里不动。) */}
      {!isEntry && (
        <span
          aria-hidden
          style={{ left: NODE_W / 2 - PORT / 2, top: -PORT / 2, width: PORT, height: PORT }}
          className={cn(
            "pointer-events-none absolute rounded-full border border-edge bg-surface-muted",
            "opacity-70 transition-opacity group-hover:opacity-100",
          )}
        />
      )}
      {/* 出线口。按住往下拖,松在另一张卡片上就连上。 */}
      <span
        title={t("settings.workflows.portConnectHint")}
        onMouseDown={onStartConnect}
        style={{ left: NODE_W / 2 - PORT / 2, bottom: -PORT / 2, width: PORT, height: PORT }}
        className={cn(
          "absolute cursor-crosshair rounded-full border bg-surface transition-[opacity,background-color,border-color]",
          connectHint === "source"
            ? "border-accent bg-accent opacity-100"
            : "border-edge opacity-60 group-hover:border-accent group-hover:opacity-100",
        )}
      />
    </div>
  );
}
