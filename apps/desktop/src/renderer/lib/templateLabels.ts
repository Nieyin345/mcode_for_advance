/**
 * 五个类目在界面上的名字 —— **整个渲染端只有这一份**。
 *
 * ## 为什么单独一个文件
 *
 * 这个映射早先在四个文件里各抄了一份(那几个组件后来都随模版库并进统一资料库
 * 一道撤掉了),每一份上面都写着"类目名只有一处定义,几处
 * 必须一致"。靠注释维系的约定迟早会破:改一个键名只会在其它地方静默失配,而且
 * **不会报错** —— 它会原样把 `settings.templates.kind.latex` 这串键显示给用户。
 *
 * 为什么不写成模板字面量 `` `settings.templates.kind.${kind}` ``:那样要靠模板字面量
 * 类型去凑 `MessageId` 联合,键名改了同样不会报错(与 contentTag 里同一个坑)。
 * 一次显式映射 + 一处 import,是这里唯一能防住"漏改一处"的形态。
 *
 * 与 `@contracts/templates` 的 `TEMPLATE_KINDS` 一一对应 —— 加了第六个类目,
 * 这里的类型检查会立刻报出来。
 */
import type { Locale } from "@contracts/ipc";
import {
  TEMPLATE_KEY_PREFIX,
  isTemplateKind,
  type TemplateKind,
} from "@contracts/templates";
import { translate, type MessageId } from "@renderer/lib/i18n/core.js";

export const TEMPLATE_KIND_LABEL: Record<TemplateKind, MessageId> = {
  ppt: "settings.templates.kind.ppt",
  latex: "settings.templates.kind.latex",
  word: "settings.templates.kind.word",
  code: "settings.templates.kind.code",
  image: "settings.templates.kind.image",
};

/**
 * 「全部 <类目> 模版」—— 左栏那行「全部内容」的字,也是它挂进对话时 chip 上的字。
 *
 * 给 App 之外的调用方(比如 `ChatPane` 里认领 `composer:attach` 的那段)用:那里只有
 * `locale`,没有 `t`。挂整个类目时主进程也会发一个 `name` 过来,但那是**给模型读的
 * 中文清单标题**,不该当界面文案用 —— 英文界面下它会显示成中文。
 */
export function templateKindAllLabel(kind: TemplateKind, locale: Locale): string {
  return translate(locale, "templates.section.all", {
    kind: translate(locale, TEMPLATE_KIND_LABEL[kind]),
  });
}

/**
 * 一条模版附件在 chip 上该显示什么 —— 附件键 + 主进程给的 `name` → 界面文案。
 *
 * 一条模版(`t:<类目>/<目录名>`)的显示名就是目录名,主进程给的 `name` 正是它,直接用。
 * **整个类目**(`t:<类目>`)不一样:键里没有目录名,而主进程发来的 `name` 是它那份
 * 清单的标题(中文,给模型读的),拿它当界面文案会让英文界面冒出中文 —— 所以这里用
 * 界面语言自己拼一遍。
 *
 * 认不出来的键就退回主进程给的 `name`(总比显示一个空 chip 强)。
 */
export function templateAttachChipLabel(key: string, name: string, locale: Locale): string {
  if (!key.startsWith(TEMPLATE_KEY_PREFIX)) return name;
  const rest = key.slice(TEMPLATE_KEY_PREFIX.length);
  // 带斜杠 = 一条模版,显示名就是目录名
  if (rest.includes("/") || !isTemplateKind(rest)) return name;
  return templateKindAllLabel(rest, locale);
}
