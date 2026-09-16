/**
 * 左栏右键「添加到当前对话」—— 文献库(分类 / 单篇)和模版库共用这一个入口。
 *
 * ## 为什么不是渲染端自己往输入框塞标签
 *
 * 左栏和输入框不是同一棵组件树,而附件要发给**指定会话**的输入框。主进程生成清单
 * (每次重写,所以不会读到过期内容)后用 `composer:attach` 广播回去,那个会话的
 * ChatPane 认领 —— 这正是「+ → 添加到上下文」和 AI 的 `library_attach_to_chat`
 * 走的路。这里只是替用户按了那个按钮,所以几条路挂出来的必然是同一种 chip、同一份
 * 清单。
 *
 * ## 键的词汇表
 *
 * 文献库:`c:<分类 id>`(清单是"这个分类里有什么")/ `i:<条目 id>`(清单是"这一篇
 * 该怎么读")/ `k:<库>`(「全部文献 / 全部教材 / 全部笔记」那一行,整个库的索引)。
 * 模版库:`t:<类目>/<目录名>`(一条模版)/ `t:<类目>`(「全部 LaTeX 模版」那一行)。
 * 都与「+」菜单里的 `LibraryPicker` / `TemplatePicker` 逐字一致 —— 连去重键都是
 * 同一个,所以同一份东西挂两次只会出现一个 chip。
 *
 * ## 失败必须说话
 *
 * 「+」菜单那条路失败只在 console 里留一行(用户没直接点它,静默可以接受);这两条是
 * 用户**亲手点的**,点了没反应会被当成功能坏了 —— 所以没有会话、窗口没开着、对象
 * 找不到,一律弹一条 toast。
 */
import { api } from "@renderer/lib/api.js";
import { translate, type MessageId } from "@renderer/lib/i18n/core.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useToastStore, type ToastKind } from "@renderer/stores/toastStore.js";
import type { TemplateKind } from "@contracts/templates";

/** 两条路的失败文案是同一句(「添加到当前对话失败」),所以共用一个键。
 *  它住在 `library.*` 区域文件里,模版段也用它 —— 同一个动作,同一句话。 */
const ATTACH_FAILED: MessageId = "library.ctx.attachFailed";

function toast(kind: ToastKind, key: MessageId, body?: string): void {
  const { locale } = useSessionStore.getState();
  useToastStore.getState().push({ kind, title: translate(locale, key), body });
}

/** 当前会话 id。没有打开的对话就提示一句并返回 null —— 没有能挂的地方。 */
function currentSessionId(): string | null {
  const id = useSessionStore.getState().activeSessionId;
  if (!id) toast("warning", "library.ctx.attachNoSession");
  return id;
}

function fail(err: unknown): void {
  toast("error", ATTACH_FAILED, err instanceof Error ? err.message : String(err));
}

/** 把文献库的一条附件挂到当前对话。`key` 是 `c:<分类 id>` 或 `i:<条目 id>`。 */
export async function attachToCurrentChat(key: string): Promise<void> {
  const sessionId = currentSessionId();
  if (!sessionId) return;
  try {
    const res = await api.library.attachToChat({ sessionId, key });
    // ok:false 只带一句话(主进程自己知道的失败原因),原样转出去
    if (!res.ok) toast("error", ATTACH_FAILED, res.error);
  } catch (err) {
    // 移动端的 web shim 对没有映射的命名空间是同步抛错的,必须接住
    fail(err);
  }
}

/**
 * 把模版库里的一条模版挂到当前对话。
 *
 * `dirName` **省略 = 整个类目**(左栏「全部 LaTeX 模版」那一行):主进程会生成一份
 * 索引清单(这个类目下有哪些模版、各自那份单条清单在哪),模型看完索引再决定读哪一份
 * —— 几十条模版不会一次把上下文吃光。与文献库的 `k:<库>` 是同一个粒度。
 */
export async function attachTemplateToCurrentChat(
  kind: TemplateKind,
  dirName?: string,
): Promise<void> {
  const sessionId = currentSessionId();
  if (!sessionId) return;
  try {
    const res = await api.templates.attachToChat({ sessionId, kind, dirName });
    if (!res.ok) toast("error", ATTACH_FAILED, res.error);
  } catch (err) {
    fail(err);
  }
}
