/**
 * 站点适配器 —— "通用"的落点。
 *
 * 新增一个网页版站点 = 写一份这个对象 + 在 `index.ts` 注册一行。核心代码
 * （抓流、事件回传、会话映射、provider）**一行都不用改**。
 */
import type { ParserStrategy } from "../parsers/types.js";

export interface SiteAdapter {
  /** 稳定 id。同时是 provider `builtinModels` 的项 id —— 也就是会话里选的"模型"。 */
  id: string;
  /** UI 上显示的站点名。 */
  label: string;
  /** 站点首页：引擎视图导航到这里，用户在这里登录。 */
  homeUrl: string;
  /**
   * 旁听哪些请求的响应。
   *
   * 用**子串**而不是正则：这份清单要被序列化进页面脚本，正则的转义与不同
   * 引擎的方言差异都是无谓的坑；实测中这些接口路径本身已足够特异。
   */
  streamUrlPatterns: string[];
  /** 载荷解析策略（见 `../parsers/`）。 */
  parser: ParserStrategy;
  /**
   * 元素定位覆盖 —— 每一项都可选，缺省落 `elementResolver` 的启发式。
   *
   * 只填启发式搞不定的项，且要写**语义化特征**（placeholder 文案、"登录"
   * 字样的位置），**不要写构建哈希类名** —— 那些每次发版都会变，写进来等于
   * 给自己埋一个必然要修的雷。
   */
  selectors?: {
    /** 输入框（textarea 或 contenteditable）。 */
    input?: string;
    /** 发送按钮（仅 `submit: "click"` 时需要）。 */
    send?: string;
    /** 停止生成按钮（interrupt 用；找不到就降级为"仅停止监听"）。 */
    stop?: string;
    /** 出现即视为**未登录**的元素。 */
    loginIndicator?: string;
    /** "新建对话"按钮。 */
    newChat?: string;
  };
  /** 提交方式。默认 `"enter"`。 */
  submit?: "enter" | "click";
  /**
   * 发首轮前是否先点"新建对话"。
   *
   * 网页版通常把"当前会话"记在 localStorage 里，而同一个浏览器分区下的多个
   * 引擎视图**共享**这份存储 —— 于是两个 mcode 会话可能互相串历史。需要复位
   * 的站点打开它。
   * ️ DeepSeek 是否需要，待真机实测确认（实施计划 W4）。
   */
  newChatFirst?: boolean;
}