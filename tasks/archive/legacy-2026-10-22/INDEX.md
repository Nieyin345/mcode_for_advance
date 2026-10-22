# Mcode Legacy Task-System Archive

- Archive date: 2026-10-22
- Pre-archive HEAD: b7db387abf241c8a0a47909748d13ddfc5be9c1f
- 98 legacy T task cards are preserved unchanged.
- The legacy index, prompt template, GenOffice roadmap, and extension roadmap are also preserved.
- New execution cards start at tasks/T0-*.md. Legacy T numbers remain historical source identifiers and are not reused.
- MC/ARC/UXG IDs and statuses in `audit-ledgers/` are not reset.
- Historical card statuses are not fresh acceptance. Use the new carry-forward cards below for unresolved work; `audit-ledgers/README.md` and the current unified audit ledger remain the source of truth for formal defect and architecture status.

## Carry-Forward Map

| New card | Legacy source | Carry-forward |
|---|---|---|
| tasks/T0-genoffice-native-tool-roundtrip.md | T92, T83, T86, T98 | Complete the renderer tool execution and same-SDK-turn result path; protocol prerequisite exists but end-to-end integration is incomplete. |
| tasks/T1-worktree-owner-failclosed.md | T99, T101, T105 | Current source still contains mergeBackWorktree ownership probe .catch(() => true); prove old-red/new-green for a narrow fail-closed fix. |
| tasks/T2-node-red-deploy-reconciliation.md | T93 | Reconciliation/recovery evidence for native Deploy versus Mcode Library. |
| tasks/T3-node-red-trigger-owner-guard.md | T94 | Prevent legacy AutomationRunner from double-triggering Node-RED-owned flows. |
| tasks/T4-workflow-owner-cross-process-cas.md | T97 | Prove and minimally fix owner CAS with real OS child processes. |
| tasks/T5-visual-probe-integrity.md | T95, T78 | Prevent UI visual-probe false positives; DOM/E1 first, Electron U1 scheduled separately. |
| tasks/T6-approval-keyboard-safety.md | T96 | Isolated regression coverage for approval keyboard/focus/denial paths. |
| tasks/T7-genoffice-native-editors-u1.md | T71 | Six real native editor U1 journeys; depends on T0 stability and exclusive Electron use. |
| tasks/T8-node-red-electron-u1.md | T77 | Node-RED Electron U1; depends on T2/T3/T4 and runs serially with T7. |
| tasks/T9-genoffice-license-provenance.md | T89, T90, T87, T76 | Continue exact-version evidence for four unresolved package licenses; never infer text or weaken release gates. |
| tasks/T10-node-red-license-integration.md | T91, T88, T76 | Integrate the verified original MIT material for pause@0.0.1 according to policy; unresolved licenses remain fail-closed. |
| tasks/T11-genoffice-license-integration.md | T89, T90, T87, T76 | Integrate only acceptable evidence after T9 establishes source/notice policy; unresolved packages continue to block release. |

Cards not listed above remain archived evidence and are not automatically re-dispatched. Archiving does not mark unresolved work complete.

## Archived File Inventory and SHA-256

| File | Type | Original title | SHA-256 |
|---|---|---|---|
| EXTENSION-ROADMAP-legacy.md | legacy index/template/roadmap | 扩展系统路线图（总控维护） | db96ee37bee256d08ac1e6a54d2d3e49332e32315f164cd782251ae847730c61 |
| GENOFFICE-ROADMAP-legacy.md | legacy index/template/roadmap | GenOffice 长远路线图（总控维护） | da7c4361d5360195dad444392f58e0d9b780d3b83e8012716ce14266c6d6ca80 |
| PROMPT_TEMPLATE-legacy.md | legacy index/template/roadmap | 派活指令模板（固定，只改一个路径） | d8f0b5d926ee5e25dfc956a8f6d9f257ad3b6ba86596b0db95ed17a4dcf8f145 |
| README-legacy.md | legacy index/template/roadmap | Mcode 任务分派台 | e1b37ddcdd3b9fe1a938caaa55728d8f68f740dcd23f027c07b37a01b8f88a30 |
| T01-electron-visual-baseline.md | legacy task card | T01｜真 Electron 逐屏视觉基线（浅色 / 深色 / 窄窗） | 9917f7e8a986dd279d419e6c40a8be8a85af3f2155be6b700618760dbf9cdfd2 |
| T02-free-pane-grid.md | legacy task card | T02｜自由 Pane 停靠（**直接抄 `open-claude-ui` 的逆向成果**） | 9364bd9ff7d60f6dce4ee61d16634e6be08a43d9d50621d8b18669370429c448 |
| T03-arc006-gate-d-executor.md | legacy task card | T03｜ARC-006 Gate D：唯一执行器 / 唯一触发器接线 | bb4d0e181b431ebaea3437573feca7fa6b5aabb4ea757d2793030ea0b1eaa2ac |
| T04-mobile-ui-parity.md | legacy task card | T04｜手机远程全量 UI 对齐 | 982178bbf13ddd4c5f2c43b682c5f6b0d1d82c3f8d48dbc93274e4c646ff3376 |
| T05a-docs-pure-operations.md | legacy task card | T05a｜GenOffice Docs 迁移（一）：纯文档操作 | f172e68824d16a20bdfc647b14ca93b55c071621e5e73258ae7eb4b630548189 |
| T05b-docs-privileged-operations.md | legacy task card | T05b｜GenOffice Docs 迁移（二）：需要权限的操作 | e532986cb0b06be9effb1aee9c4e4c738594448d9dfab3b74246de6bae659a68 |
| T05c-docs-ai-panel.md | legacy task card | T05c｜Docs 的 AI 面板：默认拒绝 + 显式审批后可用 | f7e81a45e9c86c84d601ff2a09778e3e3fd236b920e0c757c1d16d1c5b5e7e02 |
| T05-genoffice-docs-migration.md | legacy task card | T05｜GenOffice Docs 全功能迁移（第二轮） | f430b5f761dd1edc510232c136cdbfc50a3ee089692ac9b84cd5257c54ca4701 |
| T06-mc035-os-egress-isolation.md | legacy task card | T06｜MC-035：OS 级网络出站隔离 | 940a5b356a46c0aea8450c0cb4bb568cdf7efd3c6cac2fe12d0f834bf431ef1d |
| T07-doc-nodered-shell-integration.md | legacy task card | T07｜文档 / Node-RED 同壳整合 | 2f32ef8c21c2f0225bb18ae11f128efd57717f3352ed5258d22077358fb2c589 |
| T08-three-engine-parity.md | legacy task card | T08｜三引擎能力对齐收尾（ARC-003） | 5bde3ef5d0cf99b8e510f60e2c830801e9071d0eb030fad8630783a9d0fa05d8 |
| T09-aoci-index-catchup.md | legacy task card | T09｜AOCI 索引补录 —— **已取消（2026-10-20 用户决定不再使用 AOCI）** | b51825bec517f7b49984bc903a5b35baa4ebc20e6ddd3f8eb81ae88a03ddb846 |
| T100-agent-runtime-pty.md | legacy task card | T100｜Orca↔Mcode 多 Agent/PTY/会话生命周期与恢复源码对照 | 404d48048ff76ba1e951fccf7767467eb95c99150ba7ad851935a44f71772b50 |
| T101-diff-review.md | legacy task card | T101｜Orca↔Mcode Git Diff/代码审查/交付闭环源码对照 | adf509507eecb732d4423b4433f1602d456d5042d9cd4ac0e292484a4454c1b9 |
| T102-remote-cli.md | legacy task card | T102｜Orca↔Mcode CLI/SSH/远程工作区与移动端源码对照 | 517684dcb531e53e51e8a7d0ce617cf0bb83fd3d4357e39c0473a80f2fcf1eab |
| T103-ui-ux.md | legacy task card | T103｜Orca↔Mcode 三栏 UI/Agent 任务看板与可用性架构对照 | b8dc8b06126ffb13a58d5765d18196957e0a6bfa3703cf81e9420f30ff83bf90 |
| T104-ipc-extensibility.md | legacy task card | T104｜Orca↔Mcode 安全授权/IPC/Agent 自控与插件扩展源码对照 | 7caa1b551842a04c7292590ff950865e62b0a57308a16941191825a0b77631d2 |
| T105-integration-decision.md | legacy task card | T105｜Orca→Mcode 六域源码证据汇总与首个优化切片选型 | 0bc208cb85348a08eecb1fe1fb7cbfb93783fadb2b3ee1af1ac2d5841510b9ba |
| T10-executor-ownership-persistence.md | legacy task card | T10｜executor owner 注册表落盘（T03 的未完成部分） | e975f386628d3138275b3fdf71684bfad1afbbfa7c2cb5f33a8554ac6c3a96f6 |
| T11-windows-egress-failclosed-narrowing.md | legacy task card | T11｜Windows 上把 fail-closed 收窄到「真正需要网络」的扩展 | 57a34f8de2aeb85d293e088bc5a5072d6cb5ecf90560dda6ed991ad2bbd5a81c |
| T12-visual-baseline-fixtures.md | legacy task card | T12｜视觉基线补完：7 类高依赖屏的真实夹具 | 23b9498648f0d4a59644f4e12d5d3d7354f68fd80a59b1b8c71e186c0a8f8eeb |
| T13-node-red-vendor-investigation.md | legacy task card | T13｜Node-RED 源码集成调查（按 GenOffice 模式） | b88988603798f0fcdb84bf7e667c46cb783dc232c8cb84db9b884781d90bca1a |
| T14-extension-vscode-l2.md | legacy task card | T14｜扩展系统二开（复用 ModuleHost + Theia plugin-ext-vscode） | 8e2d9b474b712d83b5b261106b2db0e84feda0b2af8a7725cfedf1d12cdbb8be |
| T15-pane-electron-u1.md | legacy task card | T15｜真 Electron 下的 Pane U1 验收（T02 剩余两条） | c8aee1a1aba9776a2a7566002b4d4cc49841685021156500f4acd6a3c3eea2fb |
| T16-mc035-platform-egress.md | legacy task card | T16｜MC-035 补齐：平台级 egress 与五路实证 | 459911b67e7e5ceeac1a9ed1f220714e7e519e65e0d0853ff87ddcdbe4ec5351 |
| T17-reverse-engineered-ui-batch2.md | legacy task card | T17｜把还没用的逆向件接进 UI（第二批） | 64a42eb342b663c28d5bbd79302df4b587cf6eea9cd98b6df53c578839e58d06 |
| T18-composer-redo.md | legacy task card | T18｜输入框重做（复用 RichComposerWithMentions + ChatComposer） | a2efc75b756073c873f43386588f9d966d212979bb6a301e5442e9bf6b36d7b8 |
| T19-node-red-vendor-step1.md | legacy task card | T19｜Node-RED 源码 vendor 第一步：正式落地 + 解析链路 | ad76c937a6d6c7aec353fb02dc671550a83cdecd6264e31c767bd4d323c72845 |
| T20-sandbox-and-mic-bars.md | legacy task card | T20｜工件预览沙箱 + 语音活动条（第三批逆向件） | 61a666376675ccb62a814374a3ccbde5f88fa84c5a2779eb32c246a60ec9726d |
| T21-titlebar-and-attachment.md | legacy task card | T21｜顶栏与附件磁贴（第四批逆向件） | 5c0fb37cab165db98440f03bbc02fd5ce86132ac60844e276e4ab5ebee90c0ce |
| T22-docs-remaining-gaps.md | legacy task card | T22｜补完 T05b 的三处遗留（exportPdf / lazy-media / files:read） | e13f7ace06a4c436f8ea6c4151c36a0d4bc866662a19e2b1acaecf43ff62baa5 |
| T23-pane-resize-presets.md | legacy task card | T23｜Pane 的剩余能力：可调分割线 + 布局预设 + 重置 | b5c369fbda4dcdb67043292273db45a5ac304ca9cea62327f4843bc06318c0bb |
| T24-settings-full-rebuild.md | legacy task card | T24｜设置页全面重构（63 个面板对齐 CDS） | e30fc44148d490cf4e46824cb0402e2af6e96eb209882370f0d0ff6887c8ca0c |
| T25-atomic-write-fault-tolerance.md | legacy task card | T25｜原子写与冲突副本的故障注入回归（maint-m07 9 红） | 697fa1e0da9eb21b02cedc6bb09f8d7700440c2b2c1809c93349393a75acf4ad |
| T26-smoke-scaffold-repair.md | legacy task card | T26｜修好三套自坏的 smoke 脚手架（maint-m22 / maint-m35-pickers / updater-tools） | 06531f8197bd8f268f8e99b086d3b5d8a6699f8c2e6d0a33a6dc50a2d43f3409 |
| T28-genoffice-pdf-markdown-html.md | legacy task card | T28｜GenOffice pdf / markdown / html：**直接调原厂 `createXxxView`** | b971c699f477734fe71953d4b208048a7717aaaab717ae7fe258b6617a26cd94 |
| T29-genoffice-sheets-slides.md | legacy task card | T29｜GenOffice sheets + slides：**直接调原厂 `createXxxView`** | 11f2b4120e5ca774281fb0a304d6dc79e84932440fe301604e37d02182423217 |
| T30-genoffice-unified-file-routing.md | legacy task card | T30｜GenOffice 六编辑器文件路由收敛：统一格式判据 | 00d3a24c685f268adba11a78e3cffbb55d96baf2b9368efa47eaa8a6af52dc2a |
| T42-node-red-node-pack-install.md | legacy task card | T42｜把 Mcode 节点包装进 Node-RED（补上唯一的断点） | 305a6298a7410008e910eae98e030e6ac50e69c6a7185b900facfc049c92bba4 |
| T43-node-red-agent-port.md | legacy task card | T43｜`McodeAgentPort` 的生产实现 —— 节点真正跑在 Mcode 三引擎上 | 9a5c7e826fb7016fe1c34427096d11d09d085df88e51ed9aa588b8dfd02f3f3d |
| T44-node-red-node-pack-i18n.md | legacy task card | T44｜mcode 节点包：表单本地化、图标、分类与调色板 | 8434e3c496f6b817e3c2caf640f7e16297cd4849d5510ca27a088acc30a7967e |
| T45-workflow-canvas-to-node-red.md | legacy task card | T45｜工作流 UI：删掉手写画布，用 Node-RED 原厂编辑器 | 4da97ea432827bbb1f99466fa052be23c2747800a9253799cf0c246f7faa68e9 |
| T46-execution-ownership.md | legacy task card | T46｜执行归属：Mcode 原生调度器 vs Node-RED 运行时 | 1593cc75476f387847729720a569e20854fe2fc71b0d6b2ce956ea2e9e33d1b6 |
| T47-node-red-editor-theme.md | legacy task card | T47｜Node-RED 编辑器主题：让它的风格与 Mcode 一致 | 8bddc9f6f58d63e71563a460e663950b916716b05c8250a0936174b304b1b7e4 |
| T48-extension-permission-model.md | legacy task card | T48｜扩展权限模型：安装时一次性授权，之后直接执行 | 8a868bf8eed9148d2ccfb247d2929252f8414020dc581ef56d9878b4e169391b |
| T49-extension-api-surface.md | legacy task card | T49｜扩展调用面：把 438 个 RPC 暴露给扩展 | bf8b46ae7ea21d9c92068b84328693b606651acf8c7aba2f6362ea6583e31812 |
| T50-extension-ui-contributions.md | legacy task card | T50｜扩展 UI 贡献点：从「只有文件右键」到「到处都能挂」 | e947cf8cad053b15f04546e6e0bd8c39451ca0bff4f8cc05ce8621fb31ca3e41 |
| T51-ai-writes-extensions.md | legacy task card | T51｜让 Mcode 的 AI 会写扩展：文档、模板、校验闭环 | 872c25798be38127ca04ced8c633142cc0fa2efeacba0eda0ae22df7c82c6314 |
| T51-real-ai-regression.md | legacy task card | T51｜真 AI 从零编写扩展 U1 回归卡（待人工实跑） | 94c5139b0f8cc90f5a307fa90bf1e59db8c57f8f98190ab8957d2fb00af5afc0 |
| T52-smoke-rescue.md | legacy task card | T52｜smoke 急救：501 套里 25 套红，其中 15 套是构建就崩 | 2f6d8d16c4fa4507743ffb6b51f5afc6f2f38745c107ff13d86f322b0c3aa567 |
| T53-genoffice-sheet-slide-verification.md | legacy task card | T53｜T29 续篇：用真实 sidecar 验完 xlsx / pptx | c57cc6b84c1374c955c241f0f5ae62b3cafefe86039ba6c800207283d21c0fac |
| T54-vendor-pane-ipc-fencing.md | legacy task card | T54｜原厂 sheets/slides 的 Pane 外 IPC 围栏 + T42 报的红项 | 6a37faf926a3a6067f30170d667d66b4cdbb8c8758fb96d6bd62ef6059cbb078 |
| T55-node-red-regressions.md | legacy task card | T55｜Node-RED 两条回归：主题 manifest 版本 + e2e 断言 | a948cf18c0cb15809db2dbe2329029666870c249ac93be4541b13dd55a728d7a |
| T56-ui-policy-regressions.md | legacy task card | T56｜三套 UI/策略回归：module-ui / skills-nodes-ui / vscode-l1 | 9b91ac71fc2822512e00a6232643d26305e923c7360e6b189537b9094b4222dc |
| T57-pptx-noop-save.md | legacy task card | T57｜PPTX 无修改保存不该改写文件字节 | 0a5c9804d520688bf2a4c134b4cdbf58ed56dbe03d83ef2d9f55f9154cfc34b9 |
| T58-workflow-canvas-followup.md | legacy task card | T58｜T45 删画布后的三处遗留：两个套件红 + 一条功能缺失 | 3f3f9e5ff1e9ad8d54d532ec4c0730d72450c31ba06e2ce83e28c8c54812c514 |
| T59-load-workflow-into-canvas.md | legacy task card | T59｜选中的库文档要能装进 Node-RED 画布 | 7dfe2150f5d6545ac61ce18997efc3d94891ff2ff5e704438f54c356777b19ca |
| T60-native-nodes-in-runboard.md | legacy task card | T60｜Node-RED 原生节点也要进运行看板 | 740df2ff536466397b9dc3404c3f9e10fb788869bbe1b23466a4c349fa2a4b7f |
| T61-smoke-missing-electron-stub.md | legacy task card | T61｜两套 smoke 引用了不存在的 electron 桩 | 987af7b1d5d4db6092e29a83ab612807b3c178b0637452a70400de166519324e |
| T62-memory-write-tools.md | legacy task card | T62｜给 AI 加记忆写入工具（记忆系统只进不出的另一半） | 9d4340f3786cd9732e1a812570e83370ff0d2660c46150283ca15d27bb826c24 |
| T63-hook-agent-action.md | legacy task card | T63｜hook 加第二种动作：交给某个代理 | 6bf1f0562ce3589d482118a7cd87beaf0a539d2e6b1b760174b284500d38f927 |
| T64-framework-prompt-customization.md | legacy task card | T64｜框架层提示词可自定义（中间那一层） | b68cb395187d78f306b0edf29ce0858f3154ddbe8dd782c8e28b14fde61a59cd |
| T65-monaco-selection-citation.md | legacy task card | T65｜Monaco 编辑器的选段引用（三处里的最后一处） | cfe40da32493a8a302e50a34a4cdc98b0879aa6a63dbc153c6b67172358ca6ed |
| T66-reference-audit.md | legacy task card | T66 — sessionStore 全量引用清单（静态巡检） | 0bcd8e24122705c4b98fe84e5c5554bef659885a9da7c3e201d63ce4be3255c7 |
| T66-session-store-split.md | legacy task card | T66｜sessionStore 按域切片（7603 行 → 多个小 store） | 8d3a719ec3094b260f5fa1956fa0f29db26d9b0824a75ccc4401194d84deb38a |
| T67-catalog-drift.md | legacy task card | T67｜T59 加了新 RPC 但没更新 apiCatalog | ebec0d37c0a949c3e900fa37e52e6d4977f852cf80cbf3796683d72523be445f |
| T68-smoke-baseline-recheck.md | legacy task card | T68｜smoke 基线复查：四套旧红例 | ebb371fa198e5aae54374843e7eeba4f5a181473e0a8b1b3ecc0df4a68d21271 |
| T69-60-smoke-failure-triage.md | legacy task card | T69｜T68 全量 60 套 Smoke 失败：冻结、归因与分派清单（只读诊断） | f5cabe0c4452e715ff5615ea794531f532f0c3e9c8a65bc36c4da08a0f29e5bd |
| T70-node-red-t43-t44-gap-audit.md | legacy task card | T70｜Node-RED T42 与 T43/T44 交叉验收：消除重复派工（只读审计） | 9fd040dbe01afbe94dc958996a23f0728283325e1f0b249bf6244c866ee81bd6 |
| T71-genoffice-six-native-gui-acceptance.md | legacy task card | T71｜GenOffice 六原生编辑器：真实 Electron 用户旅程验收与缺口矩阵 | ce32a3318f681b1d0c2e299087f47107645d6152e2c54e89fdb3a0db004e963e |
| T72-node-red-single-authority-gap-audit.md | legacy task card | T72｜Node-RED 最终唯一工作流权威：T46 双引擎过渡与 FULL-3 差距审计 | 7092f335ce9cf8b0d782fc74389306dc5db000f731ee05c4121ab4780744156e |
| T73-browser-sandbox-preload-migration.md | legacy task card | T73｜修复内嵌浏览器 sandbox:false：隔离 preload 并保持元素选取 | 242ac03b518462746660f33290e23f560ad906b0e95233fff92c792d7bb03049 |
| T74-genoffice-cli-headless-operations.md | legacy task card | T74｜T34 GenOffice 无头能力第一批：create / merge / selection / render 原厂 CLI 薄适配 | 54bc1066734b7c143c239c758a5645f342214a8f50b7a49c30530c50b8d7f415 |
| T75-genoffice-agent-skills-six-app-audit.md | legacy task card | T75｜GenOffice 六编辑器原厂 AgentSkill 与 Mcode AI 的真实调用链审计 | 1fc0955b7fd8235fa68e0c38a3a7b1478c43d5d063fd193d07b46d5339fc9936 |
| T76-vendor-release-resource-integrity.md | legacy task card | T76｜GenOffice + Node-RED 打包资源、上游来源与依赖许可证完整性门禁 | 670ea799ee62cf380bd9d9df5abd43f884adb5d00a2997df93310f2a17cf617f |
| T77-node-red-native-electron-ui-acceptance.md | legacy task card | T77｜Node-RED 真 Electron 编辑器：六节点拖拽、Deploy、库回写与看板 U1 验收 | 636c356fa7ed56438b438e7ebcdac0d9676b80dfd4717354b233629186c11228 |
| T78-arc005-visual-baseline-gap-audit.md | legacy task card | T78｜ARC-005 视觉基线验收：39 场景的真实内容覆盖与差异分类 | fd827247122acbb075fa8ea92fa1b32f09d5d523f0d9a00c30653a3ca585f561 |
| T79-node-red-node-palette-i18n-help.md | legacy task card | T79｜T70 确定缺口：Node-RED 六节点辨识度、全字段双语、帮助内容 | a87a90331deff25df0bcfb302709ee838c0a8117c97ac5d4026d4fc763dd5e7f |
| T80-windows-sort-v-smoke-portability.md | legacy task card | T80｜T69 环境阻断 A1：22 套 Smoke 的 Windows sort -V 入口修复 | 8f0d9bcf2b97fce60e6af02899c7199f9c8f445edd8227b0646ddc59ef81db81 |
| T81-windows-node-modules-symlink-smokes.md | legacy task card | T81｜T69 环境阻断 A2：27 套 Smoke 临时 node_modules 链接修复 | 29562b00fb3b2126c4ffe02d18ffee246cfe1b04dae87b6255875eb56c5c75d3 |
| T82-emit-path-smoke-event-shape.md | legacy task card | T82｜T69 确认的 emit-path-smoke 事件扫描器误判修复 | 9c1e8ac39846282c5e2767e4f15e6fde1901e7b05837d70d4c6d5888c29cec9d |
| T83-genoffice-mcode-native-tool-calls.md | legacy task card | T83｜T75 确认断点：Mcode SDK 到 GenOffice 原生 AgentSkill 的结构化工具调用能力门 | f1573bd7766c7e1eb8495a825f14c7a7f9d5ccf6f85e54cf0273c4377e0fe6a7 |
| T84-genoffice-slides-ai-ipc-boundary.md | legacy task card | T84｜Slides Mcode 宿主中的原厂 ai:* 云媒体 IPC 隔离（T75 发现） | 18cbc540920327012cc7bbf65974ac444d2bcff3e063d916602a35a2636f1bfb |
| T85-node-red-migration-preflight-proof.md | legacy task card | T85｜Node-RED 唯一内核迁移 G0/G1：旧工作流无损预检与可恢复清单 | 79fcab16ac847158e8b71d866a4fb174fd59fa03b1acc105cdea88686fa2c705 |
| T86-mcode-runtime-native-tool-protocol.md | legacy task card | T86｜Mcode 三 SDK 的请求级结构化工具协议前置能力 | 888c288d5207da797d72bef05fe9e4d36f8f5b768779a4a0587ed2339bcc68a1 |
| T87-genoffice-patch-lineage-and-license-notices.md | legacy task card | T87｜GenOffice 上游补丁链与 18 项第三方许可证闭环 | e0323d3f16fc44f2f06f829553576952757bb240e1ba952e24918c92105a7b88 |
| T88-node-red-third-party-license-closure.md | legacy task card | T88｜Node-RED 生产依赖第三方许可证覆盖闭环 | 9b809d5298ddce5540c7bc6d31259a854ad52e7cfd90537b502c0e91348489ea |
| T89-genoffice-license-source-research-a.md | legacy task card | T89｜GenOffice 缺失许可证来源取证 A 组 | 3527f066cdcbc8a2b8fd924db9bd513ce00f8e6297ac3020bcf01c037f83df9c |
| T90-genoffice-license-source-research-b.md | legacy task card | T90｜GenOffice 缺失许可证来源取证 B 组 | 537e18b3351db53f1f5710e30d0098359ba81022d770e397460b4dc5a3a9d1fb |
| T91-node-red-pause-license-source-research.md | legacy task card | T91｜Node-RED pause@0.0.1 许可证来源取证 | 7d8197bde9494e33950864c92beac0b7443ff3716511a8d595ec428c101bc154 |
| T92-genoffice-renderer-tool-roundtrip-integration.md | legacy task card | T92｜GenOffice 原生 AgentSkill 工具往返接线 | e1627e4772c19f2b520b564c67bf2c56912fbcb676d82505a884ed027a486e09 |
| T93-node-red-deploy-library-reconciliation-gate.md | legacy task card | T93｜Node-RED 原生 Deploy 与工作流库双版本对账/恢复门（NR-M1） | aa068a343fb6cd2b696903604b41b17d453d8c5e8cd376c03babc9072ead4931 |
| T94-legacy-trigger-owner-handoff-guard.md | legacy task card | T94｜Node-RED 迁移前旧触发器不双挂：AutomationRunner 身份门与阴影事件验证（NR-M2 前置） | d104a17ff121680105580f3dc32d25ca7a9836e201fea0bae9fe2a685aa08fa5 |
| T95-arc005-visual-probe-false-positive-gates.md | legacy task card | T95｜T78 实证缺口：ARC-005 视觉探针准确性与可观测性修复 | a53d006a0ce0df5d2d876033777adfbd6f4c742dee3f70a155d9f82d9aec9dde |
| T96-approval-card-keyboard-denial-regression.md | legacy task card | T96｜桌面审批卡键盘拒绝与焦点回归（T78 UI 安全交互） | 9ee5a40bb964972805d1f7a44209051afa0619262d03aac70d3c9bffdfe66853 |
| T97-executor-ownership-cross-process-cas.md | legacy task card | T97｜持久化工作流 owner 双进程争抢 CAS 证明及最小修复（G3 前置） | 1a426e52eb67ec50f1f73717b684d8b2aa7c32352132f6c6efac98255ce724c3 |
| T98-genoffice-scoped-tool-result-ack.md | legacy task card | T98｜GenOffice Docs 原生工具结果 ACK 协议前置（解除 T92 阻断） | 45c741288688177ff5321745ae3d7c891cbeedb7c85814a5e75f1e51ceeb1327 |
| T99-worktree-lifecycle.md | legacy task card | T99｜Orca↔Mcode Worktree/项目身份与隔离生命周期源码对照 | 02e7d7db6b8238049dd187bd731ccef59320c3511aa364b2f171a5fb7f501e85 |
