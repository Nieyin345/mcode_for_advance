/**
 * DeepSeek 网页版（chat.deepseek.com）—— 一期唯一的适配器。
 *
 * ️ 合规：其用户协议 4.3(3) 禁止反向工程及"通过任何机器人、爬虫、其他自动
 *    设置"抓取服务内容。本适配器正属于该条款禁止的用法，**存在封号风险**
 *    （用户已知情确认）。
 *
 * ⚠️ 稳定性：网页端内部接口是 `/api/v0/`（无版本承诺），DOM 类名是构建哈希。
 *    所以这里**刻意只写语义化特征**，并且尽量少写选择器 —— 能靠启发式定位的
 *    就留空，让官方改版时只有极少数地方需要修。
 */
import type { SiteAdapter } from "./types.js";

export const deepseekAdapter: SiteAdapter = {
  id: "deepseek",
  label: "DeepSeek 网页版",
  homeUrl: "https://chat.deepseek.com/",
  streamUrlPatterns: ["/api/v0/chat/completion", "/api/v0/chat/regenerate"],
  parser: "deepseek-web",
  selectors: {
    // placeholder 是**用户可见的文案**，比哈希类名稳定得多；但仍然可能被官方
    // 改字 —— 失配时 elementResolver 的启发式会兜底（页面主体区的 textarea）。
    input: 'textarea[placeholder="给 DeepSeek 发送消息"]',
  },
  submit: "enter",
};