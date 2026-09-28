# 复查:「文献导入(PDF / DOI)」这条链跑不通(2026-09-28)

自主选的方向:**刚提交的 `f87c6fe` 那条新链路,从右键到入库端到端对一遍**。理由是它是全新代码、
跨了四层(自定义 UI → automationRunner → 条件/代码节点 → adoptFromCode),而现有冒烟一条都没钉它
—— tsc 和 10 个 suite 全绿只说明"类型对、老行为没退",说明不了这条新链走得通。

结论:**走不通。** 三处硬断点,其中 P0 两处会让这个入口在最常见的用法下 100% 无效,且**不报错**。

---

## P0-1 代码节点永远读不到表单里的文件(`LIT_IMPORT_PY` 取值路径与载荷形状不符)

**证据链:**

1. `automationPayload.ts` 的 `inputFactsOf()`:`out[\`input.${k}\`] = v` —— 运行前输入是**拍平**成
   字符串键 `"input.files"` / `"input.doi"` 的,**不是**嵌套对象 `input: {files, doi}`。
   `TriggerPayloadFacts` 的索引签名写得很清楚:`[key: \`input.${string}\`]`。
   这套拍平是**有意的**:`expandTriggerVars` 按字面查一个键,`{{trigger.input.doi}}` 才解得出。
2. `nodeInputBuilders.buildNodeInput`:载荷**原样**(即那份平面事实)放进 `data.trigger`。
3. `codeRunner.runCodeNode`:`stdin = JSON.stringify(input) + "\n"` —— 代码节点收到的
   `payload["trigger"]` 就是那个平面字典。
4. 而 `assets.ts` 的 `LIT_IMPORT_PY`:

```python
for key in ("trigger", "data"):
    inner = scope.get(key)
    if isinstance(inner, dict) and ("input" in inner or "collectionId" in inner):
        scope = inner          # ← 平面字典里没有 "input" 这个键,永不进入
        break
form = scope.get("input") if isinstance(scope.get("input"), dict) else {}   # ← 恒为 {}
files = as_list(form.get("files"))                                          # ← 恒为 []
```

`"input" in inner` 对 `{"kind":..., "input.files":[...], "input.doi":"..."}` 是 **False**;
退一万步就算进去了,`inner.get("input")` 也还是 None。

**后果:** 无论用户在表单里选了几个 PDF,这一步都走"这次没有选文件"那一支,报
`outputs.importFiles = None`,`adoptFromCode.importOf()` 认不出 → **一个文件都不入库,整次运行还是
success**。"选 PDF"这半个功能等于不存在,而且界面上看不出来。

**改法(两个都行,选一个):**

- 脚本侧按平面键取:`files = as_list(trig.get("input.files"))`,其中
  `trig = payload.get("trigger") if isinstance(payload.get("trigger"), dict) else payload`;
- 或载荷侧在拍平之外**再给一份嵌套的** `input`(代码节点按对象取更顺手),但那要改
  `TriggerPayloadFacts`,影响面比改脚本大。

建议改脚本 + 在 `custom-ui-smoke` 里钉一条:喂一份 `payloadFactsOf({kind:"event", input:{files:[...]}})`
的真实输出给那段解析逻辑,断言 `importFiles.paths` 不为空。

---

## P0-2 入口挂在分类右键上,而**空分类必然被拒**

`seedDefaults.ts` 把 `seed-lit-import` 放在 `library.collection` / `library.subcategory` 两个槽位,
`runCustomUiAutomation` 对这两种目标的处理是**把分类里现有的条目展开成 items**:

```ts
if (count === 0) return { ok:false, error: skipped>0 ? "...都满足跳过条件..." : "这个范围里没有条目" };
```

可"往一个新建的空分类里导文献"恰恰是这个入口最典型的用法 —— 用户右键 → 填表 → 选了三个 PDF →
回一句**「这个范围里没有条目」**。表单里明明有东西,系统说范围是空的。

同一根因还有第二个表现:分类里已有 **> 200** 条时(`CUSTOM_UI_MAX_BATCH`),导入被
「条目太多」挡下 —— 一次导入因为**库里已有多少旧条目**而被拒,说不通。

**根因:** `runWithTarget` 的目标语义是"对这些已有条目办事"(批量转录那种),而文献导入的目标语义
只是"**归到这个分类**"。两件事复用了同一条展开路径。

**改法:** 给 `CustomUiRunAutomationInput` 加一个"目标只用于定位、不展开条目"的口径
(例如 `targetMode: "scope" | "context"`,或动作上声明 `carriesTarget: false`),
`context` 时跳过展开与 `count`/`MAX_BATCH` 检查,直接把 `collectionId` 放进载荷。

---

## P0-3 `trigger.collectionId` 这个事实压根不存在 → 导进来的文件不会归类

`LIT_IMPORT_PY` 读 `scope.get("collectionId")` 拼 `importFiles.collectionIds`,而:

- `TriggerPayloadFacts` 里**没有** `collectionId` 字段;
- `runWithTarget` 建载荷时只放 `files` / `items` / `input`,右键点的是哪个分类**没往下传**;
- `itemFactsOf` 给的是 itemId / itemTitle / pdfPath / filePath,也没有它。

所以 `collection_id` 恒为 `""`,`collectionIds: []` —— 就算 P0-1 修好,文件也只会散落在库根,
不进用户右键的那个分类。修 P0-2 时应一并把分类 id 作为载荷事实带下去(命名建议
`collectionId`,与脚本现有读法对齐)。

---

## P1-4 这条自动化会被自己的导入再叫起来一次(空转一轮)

触发器订的是 `library.item.imported`,而这条流程自己就会 `importAnyFiles` → 发同一个事件 →
再触发自己。第二轮没有 `input.doi`,条件走 false、收文件那步也没文件,所以**会收敛**,不是死循环;
但每次导入都会多一条空运行进历史,用户看到"跑了两次"。自触发抑制(`selfTriggerCount` / `eventChain`)
能挡住一部分,但那是**兜底**,不该当成设计。建议给这条触发器加一条"只认非自身来源"的判据,
或让收文件那步的导入走一个不发事件的入口。

---

## P1-5 条件节点在"没有触发器载荷"时是**硬失败**,不是 false

`readConditionRef`:`scope.trigger === undefined` → `{ok:false, error:"这次运行没有触发器载荷"}`
→ 条件节点 failed → 整次运行失败。内置注释只说了"缺失键给 found=false"(那句是对的),
但没说"整份载荷缺失"是另一回事。这条流程被当成**对话模式**手动跑(`entry` 为空)时会直接炸。
它现在不出现在模式下拉里,所以暂时撞不上 —— 属于写在纸面上的隐患,建议在
`builtins.ts` 那段注释里补一句,免得下一个人把带 `{{trigger.*}}` 的条件节点放进普通工作流。

---

## P2-6 两处小的

- `evaluateConditionExpression` 的 `contains` 在**数组**上是**逐项全等**,不是子串包含
  (`raw.some(item => textOf(item) === rule.value)`)。DOI 那条规则的引用是字符串,不受影响;
  但用户照着这条内置去写 `{{trigger.input.files}} contains ".pdf"` 会恒为 false,而界面上
  同一个 op 名字读起来是"包含"。
- `as_list` 用逗号切字符串 —— 路径里带逗号的文件会被切成两半。files 类输入正常是数组,
  走不到这一支,但那支存在就该稳:数组分支优先已经做了,字符串分支建议只对 DOI 用。

---

## 我没做的事

- 没改任何代码(这次只是检查);
- 没起 Electron 实跑 —— 上面 P0-1/P0-3 是**读代码得出的确定结论**(载荷形状与取值路径逐行对得上),
  P0-2 是 `runCustomUiAutomation` 的显式 early-return,P1-4 是事件订阅关系的推论;
- 现有冒烟为什么全绿:`custom-ui-smoke` 钉的是 `targets.ts` 那几个纯函数与 when 裁剪,
  没有一条断言跨过"载荷 → 脚本 → adoptFromCode"这道缝。这条缝正是这次三个 P0 的藏身处。

---

# 修复记录(2026-09-28,同一轮)

| # | 问题 | 改了什么 |
|---|---|---|
| P0-1 | 代码节点读不到表单文件 | `LIT_IMPORT_PY` 改按**拍平键** `input.files` 取(嵌套 `input` 只留作兜底);文件路径**不再按逗号切**(`as_list(split_commas=False)`),带逗号的路径不会被切成两半;docstring 写清"键名是拍平的字符串,不是嵌套字典"及其无声后果 |
| P0-2 | 空分类被「这个范围里没有条目」挡死 | 新增 `targetMode: "scope" \| "context"`(契约 + 运行请求)。`context` = 右键的分类只是**落点**:主进程走新的 `runInContext()`,不展开条目、不比 `expectCount`、不受 `CUSTOM_UI_MAX_BATCH`;渲染端跳过 dryRun 确认框,改报「已开始运行」。预置的文献导入两项与编辑器模板都置为 `context`,编辑器新增一个勾选框(zh/en 文案齐)让自建项也能用 |
| P0-3 | `trigger.collectionId` 不存在 | `TriggerPayload`(event)与 `TriggerPayloadFacts` 新增 `collectionId`,`payloadFactsOf` 带出;`runWithTarget` 接受第三种目标 `{ collectionId }`,载荷只带分类 id + 运行前输入(**不塞空 items**)。故意不进 `TRIGGER_PAYLOAD_FACTS_OF` 候选名单——真实事件没有这一项 |
| P1-4 | 宿主侧入库事件不带来源链,自触发看不见 | `automationEventOrigin` 新增 `AsyncLocalStorage` 版的 `runWithAutomationOrigin` / `currentAutomationOrigin` / `withAmbientAutomationOrigin`;`runner.ts` 把宿主执行器整段包进当前运行的来源链;`broadcast.emitItemImported` / `emitItemDownloaded` 给事件打标。A 靠"自己入库"触发 A(以及 A→B→A)从此在自触发额度里可见 |
| P1-5 | 载荷整份缺失时条件节点硬失败 | 在 `builtins.ts` 那道判断上写明:缺**键**是 false,缺**整份载荷**是当场判死——带 `{{trigger.*}}` 的条件节点别放进对话模式的工作流 |
| P2-6a | `contains` 在数组上是逐项全等 | 改成逐项**子串**,与字符串那一支同义(全等的用法用「等于」表达得了,子串对数组此前无从表达) |
| P2-6b | 逗号切路径 | 见 P0-1 |

**验证(改完后实跑):**

- `npx tsc --noEmit -p tsconfig.json`(cwd `apps/desktop`)→ **exit 0**
- `node scripts/run-smokes.mjs`(10 个 suite)→ **10 pass / 0 fail**;`custom-ui-smoke` 由 126 条加到 **133/133**

新增的断言把这次塌掉的那道缝从两头钉住:载荷侧断言 `input.files` / `collectionId` 的键名与"不带 items",脚本侧**真起一个 python 进程**把 `LIT_IMPORT_PY` 跑一遍,断言 `importFiles.paths` 两条、逗号路径完整、`collectionIds` 带上、只填 DOI 时报 `null` 且不失败。没装 python 的机器打印一行跳过(本轮实跑机器上是真跑的)。

**还留着的事:**

1. **自触发那一轮仍会空跑一次。** 这条自动化订的是 `library.item.imported`,而它自己收文件进库就会发这个事件 —— 第二轮没有 `input.doi`、也没有文件,两步都 no-op 后结束(会收敛,不是死循环),但运行历史里会多一条。真要去掉得让触发器能声明"不理会自己引出的事件",那是触发器配置的新维度,不在这次范围里。
2. **界面没起 Electron 实看**:编辑器里新增的那个勾选框、`context` 那条路的 toast,只有类型与冒烟背书。

