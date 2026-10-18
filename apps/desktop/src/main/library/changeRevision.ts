/**
 * 资料库**变更版本号** —— 进程内缓存靠它判断手里那份数据还新不新。
 *
 * ## 为什么要有它(而不是只靠时间窗)
 *
 * `mcp/sandboxReadPolicy.ts` 缓存「条目 → 它在磁盘上占的路径 + 屏蔽原因」,原来只有
 * 3 秒 TTL。于是 `library.suppressSave` 刚保存的屏蔽规则、刚被挪进被屏蔽分类的条目,
 * 在这 3 秒里对公网只读门**不生效** —— 屏蔽是硬过滤,「晚 3 秒才挡」等于把用户明确
 * 要挡的东西又放开了一会儿(反方向的解除屏蔽只是晚 3 秒,是安全的一侧;这一侧不是)。
 * `library.groups` / `library.suppress` 的缓存则更糟:除了各自的 save 口没有任何失效
 * 信号,通用 `setting.set` 直写同一个键后,进程会一直停在旧表上直到重启。
 *
 * 版本号把"写入口自己宣布变了"变成唯一判据:没变就命中缓存,变了立刻重读 ——
 * 不靠时钟猜。
 *
 * ## 谁来 bump
 *
 * 只由**既有的写入入口**调(硬规矩:共享实现只有一份,不另起一条通知旁路):
 *   - `library/broadcast.ts` 的 `notifyLibraryChanged` —— 条目/分类的增删改在两类写者
 *     (IPC 与 MCP)里都经它;
 *   - `library/suppress.ts` 的 `saveSuppress` / `invalidateSuppressCache`、
 *     `library/groupRegistry.ts` 的 `saveLibraryGroups` / `invalidateLibraryGroupsCache`
 *     —— 设置本身的改写不进上面那条广播;
 *   - `ipc/claude.ts` 的通用 `setting.set`(Agent / 自定义面板可绕过 save 口直写
 *     上面两个键)经那两个 invalidate 接上。
 *
 * ## 为什么是叶子模块
 *
 * 零 import、不碰 DB/electron。缓存持有者(`sandboxReadPolicy` → `suppress`)与
 * 广播(`broadcast` → `fileImport` → …)之间若直接互相 import 会成环;两边都只认这
 * 一个版本号,依赖图上就不会有回路。
 */

let revision = 0;

/** 宣布「资料库相关的东西变了」。只增不减;Number.MAX_SAFE_INTEGER 在现实中不可达。 */
export function bumpLibraryChangeRevision(): void {
  revision += 1;
}

/** 当前版本号。缓存持有者在读数据**之前**取一次,连同数据存下;命中时要求仍然相等。 */
export function libraryChangeRevision(): number {
  return revision;
}
