# 第三轮 · E 渲染端状态

范围:`renderer/stores`、`renderer/lib`、`renderer/hooks`、`renderer/*.tsx` 根目录。
验证:增量 tsc 通过;lint-changed 无新增问题(`sessionStore.ts:2316` 的 no-misused-promises 是原有代码);
相关 smoke 全过:session-store、ui-interaction、chat-derived、maint-audit、mobile-sync、engine-regressions、workflow-view、module-catalog-ui、maint-m35。

## 修复的问题

| 编号 | 位置 | 问题 | 修复 |
|---|---|---|---|
| E1 | `stores/customUiStore.ts` `save` | 乐观更新失败时无条件回滚到「这次保存前」的配置:连续两次保存、前一次失败时,会把后一次(已经写进去的)配置也从界面上撤掉,界面与磁盘不一致 | 只有界面上仍是这次的配置时才回滚 |
| E2 | `stores/sessionStore.ts` `submitQuestion` | 回答 AskUserQuestion 后,等 IPC 返回期间如果 agent 已经接着问了下一题,返回时会把**新问题的卡片**一起清掉,agent 一直等一个用户看不到的问题 | 只清掉刚回答的那一张(同一对象或同一 requestId) |

## 已排查(无需再查)

- `stores/libraryStore.ts`(每类请求都有序号,过期响应丢弃)、`stores/fileViewStore.ts`、`stores/customUiStore.ts` 其余部分。
- `stores/sessionStore.ts`:selectSession / openTab / prefetchSessionMessages(按会话 id 分桶写入,不会写进别的会话)、书签增删改的回滚、decideApproval、rewindTurn、saveFileContent(写失败会抛出并返回 false)。
- `lib/serializedFileWrites.ts`、`lib/markdownFileWrites.ts`(按文件串行写,失败会抛)。
- `hooks/useRpc.ts`(序号防过期)、`hooks/useClaudeEvents.ts`(订阅都有退订)、`hooks/useVoiceInput.ts`(卸载时停麦克风、关 AudioContext)。
- 全渲染端 `addEventListener` / `setInterval` 与移除 / 清理的配对检查:剩下的未配对项都是全局一次性的(`lib/webApi.ts`、`pair.ts`)。

## 打包后请验证

1. 让 agent 连续问两个问题(例如要求它「先问我 A,再问我 B」):回答第一个后,第二个问题卡片能正常出现并可回答。
