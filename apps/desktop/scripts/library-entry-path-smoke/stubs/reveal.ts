/**
 * `@main/lib/reveal.js` 的替身 —— 只给本套无头脚本用。
 *
 * 真的 `openDirectory` 会**真的弹开文件管理器**。这一套要验的是"条目 id → 该揭哪个
 * 目录"(路径解析),不是"能不能弹开 Finder/资源管理器" —— 后者在无头环境里无从断言,
 * 而且真去弹会打断跑测试的人。
 *
 * 记下每个被请求打开或"在文件夹中显示"的**绝对路径**,用例据此断言路径算得对不对。
 * "不静默"由调用方保证:真的 `openDirectory` 返回错误字符串时上层如实回 `{ok:false}`,
 * 这里也照那个形状返回(永远成功),因为它只负责记录。
 */
export const openedDirectories: string[] = [];
export const revealedItems: string[] = [];

export function resetReveal(): void {
  openedDirectories.length = 0;
  revealedItems.length = 0;
}

export async function openDirectory(dir: string): Promise<string | null> {
  openedDirectories.push(dir);
  return null;
}

/** 与真的一致:不抛,失败以字符串返回。 */
export async function showItemInFolder(itemPath: string): Promise<string | null> {
  revealedItems.push(itemPath);
  return null;
}
