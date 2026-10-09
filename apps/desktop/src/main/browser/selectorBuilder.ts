/**
 * 「元素 → 稳定 CSS 选择器」那一段页内 JS 的**唯一一份**。
 *
 * ## 为什么单开这个文件
 *
 * 同一段 `buildSelector`(先 id、再 class 链、回退 nth-of-type 路径)**在三个页内脚本里
 * 各内联过一份**:
 *
 *  - `snapshotScript.ts` 的 `SNAPSHOT_SCRIPT`(agent 快照收集交互元素时给每个元素算选择器)
 *  - `snapshotScript.ts` 的 `FIND_SCRIPT`(`browser_find` 命中元素后给选择器)
 *  - `pickerScript.ts` 的 `PICKER_INJECT_SCRIPT`(用户手点元素时算选择器)
 *
 * 三份各自是**字符串常量里的一段源码** —— 编译器不会校验它们一致,而 `snapshotScript.ts`
 * 的注释一直声称自己 "Mirrors pickerScript's buildSelector"。**已经漂了一次**:
 * SNAPSHOT/FIND 两份的祖先深度上限一个 `>= 5`、一个 `>= 4`(pickerScript 是 5)。后果不是报错,
 * 是——`browser_find` 给模型一个选择器、模型拿它去 `browser_click`,同一个元素两边算出的
 * 路径深浅不同,点击可能落空或命中别处(用户看到"模型说点了那个按钮,但没反应")。
 *
 * 现在三个脚本都用 `${"${SELECTOR_BUILDER_SNIPPET}"}` 插这一段,深度统一 **5**,要改只有一处。
 *
 * ## 为什么是"插值"不是"函数调用"
 *
 * 这三段都是 `executeJavaScript` 跑在**页面主世界**的字符串,拿不到我们进程的模块作用域
 * (见 `snapshotScript.ts` 文件头)。所以共享只能靠**文本插值** —— 把同一段源码拼进去。
 * 这是个**模板字面量片段**(不含反引号,注入安全;`$` 序列也不怕,因为它是在**我们进程里**
 * 做插值的,不经过 `String.replace` 的替换模式解释)。
 */
export const SELECTOR_BUILDER_SNIPPET = `
  // Stable CSS selector for an element: prefer id, then a class chain, falling
  // back to an nth-of-type path. 三个人/机入口(snapshot / find / picker)共用这一段,
  // 深度上限统一为 5 —— 见 browser/selectorBuilder.ts 文件头。
  function buildSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      var part = node.tagName.toLowerCase();
      if (node.id) { part += '#' + CSS.escape(node.id); parts.unshift(part); break; }
      var classes = Array.from(node.classList).filter(Boolean);
      if (classes.length) part += '.' + classes.map(function (c) { return CSS.escape(c); }).join('.');
      // Add nth-of-type only when siblings of the same tag exist, to keep it short.
      // nth-of-type, NOT nth-child: 位置算的是"同标签兄弟里的第几个"
      // (sameTag.indexOf),而 :nth-child 数的是**全部**元素子节点。两者只在
      // "同标签兄弟之间没有别的标签"时才相等。例 <div><h1/><p/><p/></div> 里第二个
      // <p> 会算出 :nth-child(2) —— 而它命中的是第一个 <p>,模型拿这个选择器去 click
      // 就落到错的元素上。正确的 CSS 是 :nth-of-type。
      var parent = node.parentElement;
      if (parent) {
        var sameTag = Array.from(parent.children).filter(function (c) { return c.tagName === node.tagName; });
        if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = node.parentElement;
      if (parts.length >= 5) break; // cap depth
    }
    return parts.join(' > ');
  }
`;
