# T117｜🔴 许可证门禁缺第三种载体：GitHub API 取到的原文无法登记

- Status: **ready-for-human**（需要裁决，不是执行卡：改门禁必须先决定「认不认 API 载体」）
- Category: **发布工程**（阻塞「Office 编辑器进打包版」）
- Priority: **P1 —— 它是 Office 进打包版剩下的四道门里的第一道**
- Depends on: T11（许可证载体门禁）、T87（provenance 证据链）、T9（路线图证据）
- Exclusive writable files:
  - `apps/desktop/build/stage-genoffice-resources.cjs`（**改门禁本体，需重跑全套变异**）
  - `apps/desktop/scripts/t11-genoffice-license-carrier-smoke/main.cjs`
  - `apps/desktop/build/vendor-licenses/genoffice/manifest.json` + 其 SHA-256 钉（`:38`）

## Required Skills
- `mcode-smoke`：这一套的改动必须过 t11 的变异矩阵，不能只跑绿。

---

## 背景：Office 进打包版的四道门

`MCODE_INCLUDE_GENOFFICE_BUNDLE=1 MCODE_INCLUDE_GENOFFICE_EDITORS=1` 跑 staging：

```
GenOffice strict release blocked: full upstream license text is unresolved for
  @electron-internal/extract-zip@1.0.5 (BSD-2-Clause), lazy-val@1.0.5 (MIT),
  ot-text-unicode@4.0.0 (ISC), react-remove-scroll-bar@2.3.8 (MIT).
Do not infer license text from SPDX metadata or a similar release.
```

**四个包，四种不同的病。** 本卡只解决其中**一个**（`react-remove-scroll-bar`），
因为只有它的原文**确实存在且已取得**，卡住的纯粹是「门禁不认这种来源」。

## 一、四个包的现状（2026-10-24 实测，`manifest.json`）

| 包 | SPDX（声明） | status | 障碍性质 |
|---|---|---|---|
| `@electron-internal/extract-zip` | BSD-2-Clause | blocked | **声明与实物不符**（上游 LICENSE 是 MIT） |
| `lazy-val` | MIT | blocked | **上游 404**（`develar/lazy-val` 仓库不存在） |
| `ot-text-unicode` | ISC | blocked | **声明与实物不符**（README 是完整 MIT 全文） |
| `react-remove-scroll-bar` | MIT | blocked | **原文取得到，门禁不认那种来源** ← 本卡 |

**清单汇总**：`expectedPackageCount: 18`、`resolvedCount: 14`、`blockedCount: 4`、`releaseEligible: false`。

## 二、门禁现有的两种载体

`stage-genoffice-resources.cjs:41-54`：

| # | `licenseSourceKind` | 要求 |
|---|---|---|
| 1 | `exact-upstream-source-file` | 从**固定 revision 的 `raw.githubusercontent.com`** 取独立许可文件 |
| 2 | `exact-npm-release-readme-section` | npm tarball 的 README 里的完整许可章节（README 路径/标题/整份 SHA-256/字节区间/区间 SHA-256） |

**只有两种**（`GENOFFICE_LICENSE_SOURCE_KINDS:55`）。没有第三种。

## 三、★ `react-remove-scroll-bar` 为什么两条都走不通

### 载体 2：README 里根本没有正文

从 `https://registry.npmjs.org/react-remove-scroll-bar/-/react-remove-scroll-bar-2.3.8.tgz`
解出的 `package/README.md`，第 51-52 行：

```
# License
MIT
```

**就这两行。** 全文 grep：

```
"Permission is hereby granted"                                    → 0 次
"the above copyright notice and this permission notice shall..."   → 0 次
```

**MIT 的 grant 与 retention 条款一个都不存在。** 载体 2 不是「差一点」，是没有材料。

### 载体 1：`raw.githubusercontent.com` 在本机不通

```
raw.githubusercontent.com/theKashey/react-remove-scroll-bar/master/LICENSE → HTTP 000
raw.githubusercontent.com/theKashey/react-remove-scroll-bar/HEAD/LICENSE   → HTTP 000
```

**而 `api.github.com` 是通的。** 这就是本卡的全部问题。

## 四、★ 证明方法：git blob SHA-1 自证（这一段可复用）

**问题**：从 API 取到的字节，凭什么说是那个 commit 下的那份文件？

**做法**（四步，全部可复现）：

**1. 取 contents 元数据**

```bash
curl -s -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/theKashey/react-remove-scroll-bar/contents/LICENSE"
```

返回：

```json
{
  "name": "LICENSE",
  "sha": "7c08c3990396ecefd90f99ff5d9a34f26f5b5616",
  "size": 1093,
  "download_url": "https://raw.githubusercontent.com/theKashey/react-remove-scroll-bar/master/LICENSE"
}
```

**`download_url` 是 GitHub 自己声明「这个 blob 的内容在那条 raw 端点」**。

**2. 从 git blob 端点取字节**

```bash
curl -s -H "Accept: application/vnd.github.raw" \
  "https://api.github.com/repos/theKashey/react-remove-scroll-bar/git/blobs/7c08c3990396ecefd90f99ff5d9a34f26f5b5616" \
  -o LICENSE.bin
# 1093 字节
```

**3. 自己算 git blob SHA-1**

```python
h = hashlib.sha1()
h.update(b"blob %d\0" % len(data))
h.update(data)
# → 7c08c3990396ecefd90f99ff5d9a34f26f5b5616
```

**4. 比对**

```
computed = 7c08c3990396ecefd90f99ff5d9a34f26f5b5616
expected = 7c08c3990396ecefd90f99ff5d9a34f26f5b5616   (contents API 给的)
→ MATCH
```

**为什么这是证明而不是推断**：git blob sha 是**内容寻址** —— 它由
`"blob " + 字节数 + "\0" + 内容` 唯一决定，改一个字节结果就变。所以
「这 1093 字节就是 `7c08c399…` 这个 blob」是密码学结论，与传输路径无关。

### 落盘证据

| 项 | 值 |
|---|---|
| blob SHA-1 | `7c08c3990396ecefd90f99ff5d9a34f26f5b5616` |
| **sha256（门禁要的 `licenseTextSha256`）** | `a79aae0c0f21990d9d963bb3c5a79cdcea9a46f8523ba55c58d7fe776b6ebc84` |
| 字节数 | **1093** |
| 仓库 / 路径 | `theKashey/react-remove-scroll-bar`，`LICENSE` |
| 分支（`download_url` 里） | `master` |
| 内容首行 | `MIT License` / `Copyright (c) 2025 Anton Korzunov <thekashey@gmail.com>` |

**MIT 四要素全部命中**（对着 `GENOFFICE_LICENSE_ELEMENTS.MIT` 的四条正则跑过）：
copyright notice / grant / retention notice / warranty disclaimer。

**证据文件位置**：`.tmp/lic/LICENSE.bin`（1093 字节）+ `.tmp/lic/meta.json`。
`.tmp/` 不进版本库 —— **如果这两个文件将来不在了，按上面四步重取即可**，
blob sha 是这个文件的不变身份。

### ⚠️ 为什么当时没有直接登记

**因为门禁的判据是 URL 前缀，不是内容证明。**

我手上的链条是「API content 端点 + 自算 blob sha 匹配」，**造不出一条我能自证的
`raw.githubusercontent.com` URL 的字节**（那个域名在这台机器上根本不通）。

用一条伪造的 raw URL 配上实打实取到的字节去登记，会让：
- 门禁过（它只查前缀 + sha）；
- notice 里有正确的 MIT 全文；
- **但登记表里那个 URL 永远指向一个「声称来自 raw、实际从 API 取」的来源** ——
  下一个人复核时，他会发现 raw 不通，然后不知道这段字节到底从哪来。

**那是 `missingEvidence` 里那句 `MUST NOT be backfilled` 禁止的事。**
宁可卡住，不让来源记录说谎。

## 五、第三种载体：为什么是「补齐」而不是「放宽」

**候选**：`exact-github-api-blob` —— 登记时要求

```json
{
  "licenseSourceKind": "exact-github-api-blob",
  "licenseSourceUrl": "https://api.github.com/repos/<owner>/<repo>/git/blobs/<40-hex>",
  "licenseSourceBlobSha1": "<40-hex>，必须与 URL 里的那个相同",
  "licenseSourceVersion": "<tag 或 commit>"
}
```

**它不是放宽，理由有三条**：

1. **判据没有变弱，变强了。** 现有载体 1 的 sha 校验是
   `hashFile(licenseFile) !== licenseTextSha256` —— 一个 sha256，**只能证明
   「文件没被改动」，不能证明「它来自哪里」**。而 blob sha 是**内容寻址**：
   它同时绑定了内容与来源身份。**新载体比旧的更强，不是更弱。**

2. **它和载体 2 是同一种思路。** 载体 2 绑的是「SRI 校验过的 npm tarball 的字节区间」，
   **也是一个内容哈希**，不是 URL 形状。载体 1 的 URL 前缀只是**当时唯一能做的弱代理**
   （没有内容寻址可用）。现在有了。

3. **它堵的是同一个缺口。** 载体 1 要求 raw URL，实质是想说「这是原始文件」。
   blob API 说的是同一件事，且**证据更强**（raw 端点的字节无法自证，blob 可以）。

**现有门禁为什么能拦住发布，也说清了**：它拦的是
**「`licenses/` 目录里没有对应文件」**（`fileReady`）和**「sha 对不上」**
（`hashFile(licenseFile) !== item.licenseTextSha256`），**不是 URL 本身**。

**`licenseSourceUrl` 在构建期一共出现 7 处**（`:105/107/112/343/426/450/465`），它们的角色是：

| 位置 | 作用 |
|---|---|
| `:105` | 必须是 https |
| `:107` | **载体 1 的 raw 前缀检查**（本卡的焦点） |
| `:112` | 载体 2 必须等于 `npmTarballUrl` |
| `:343` | blocked 条目必须把 url 置 null |
| `:426/450/465` | **写进生成的 notice 文本** `Source: <url>`，并回查 notice 里有没有那一行 |

**所以 URL 不是「只看一眼就丢」——它会出现在最终发布的通知里。**
这意味着一条伪造的 raw URL **会被印进随产品发出的 `THIRD-PARTY-NOTICES`**，
而不只是躺在清单里。这一点比卡初稿的判断更严重。

## 六、改门禁时必须重跑什么

**这是本卡最重要的一节** —— 门禁的质量证据全在 `t11` 里，改它就要重新证明。

`t11-genoffice-license-carrier-smoke` 当前 **47 条断言**，2026-10-24 回滚后实测 **47/47 PASS**。

**其中「应该被拒绝」的负控有 10 个检测点**（`grep -c 'rejects('` = 8 处字面 + 2 处
`rejects(label, ...)` 循环，后者各跑 7 个 `carrierCases`）：

| # | 变异 | 期望 |
|---|---|---|
| 1 | README 载体指向网页而非精确 tarball ⓛ | 拒 |
| 2 | README 字节区间不一致 ⓛ | 拒 |
| 3 | 区间 hash ≠ 许可证文本 hash ⓛ | 拒 |
| 4 | 缺 README byte-equality proof ⓛ | 拒 |
| 5 | 弱链 proof 无 review signoff ⓛ | 拒 |
| 6 | 未知 `licenseSourceKind` ⓛ | 拒 |
| 7 | **standalone 载体用非 raw URL** ⓛ | 拒 |
| 8 | **保留条款缺失**的自洽 MIT 文本 | 拒（按元素） |
| 9 | blocked 条目带伪造的 text hash | 拒 |
| 10 | **翻转一个 hex 位**（range-hash 绑定 / 文件 SHA-256） | 拒 |
| — | 同尺寸替换一个 README 载体的材料 | 拒 |
| — | 撤回一个 verified 包的材料 | 拒（release 不能少一份） |
| — | 把一个包降级为 blocked | 拒（并点名） |
| — | notice 生成时缺包 | 拒（`incomplete package license sections`） |

（ⓛ = 属于 `carrierCases` 循环的 7 项之一。表中 10 行是**检测点**，
「—」那四行是同套件里另外几个独立负控，一并列出以免遗漏。）

**改门禁后必须**：

1. **上面这些全部仍为红**（特别是第 7 项 —— 它验的是「非 raw URL 被拒」，
   加新载体后**必须收窄成「既不是 raw、也不是 API blob 的 URL 被拒」**，
   而不是整条删掉）；
2. **新增至少三组针对新载体的负控**：
   - API URL 里的 blob sha 与内容自算的 sha 不一致 → 拒；
   - `licenseSourceBlobSha1` 与 URL 里的那一段不同 → 拒；
   - 用 `exact-github-api-blob` 但 `licenseSourceVersion` 缺失 → 拒；
3. **`manifest.json` 的 SHA-256 钉（`:38`）重算**，且 `t11` 里有两处会核对它
   （`assert.equal(stage.GENOFFICE_LICENSE_MANIFEST_SHA256, sha256(...))`）；
4. **`t11` 全绿**；顺带跑 `t87-genoffice-provenance-license-smoke`、`t88-node-red-license-closure-smoke`。

## 七、为什么不批准现在改

**① 那是门禁目前唯一的质量证据。** 上面 12 组负控是它「真的在拒绝」的全部证明。
改判据就要重跑全部并新增三组 —— 不是改一行。

**② 还有更急的事。** 全量第四轮在跑，`electron-builder` 从没跑过。
在这个节骨眼上动发布门禁，风险与收益不匹配。

**③ 这一条不解决也不影响另外三个。** 那三个是产品裁决
（声明与实物不符 ×2、上游 404 ×1），改门禁对它们一点帮助都没有。

**所以本卡的状态是 `ready-for-human`**：先有人决定「认不认 API 载体」，
再决定谁来做。

## 八、另外三个包（不在本卡范围，但同一批要裁决）

| 包 | 事实 | 三条可能的路 |
|---|---|---|
| `@electron-internal/extract-zip` | 声明 BSD-2，上游 `electron/extract-zip` 的 LICENSE 是 **MIT**。1.0.5 那个 tarball 里无 LICENSE、README 只有 14 字节的 `BSD-2-Clause`。上游 2026-09-10 才加 LICENSE，且是 MIT。 | ① 按实物 MIT 登记（改清单 SPDX）② 换依赖 ③ 登记例外 |
| `ot-text-unicode` | 声明 **ISC**，README 里是**完整 MIT 全文**（含 retention）。`ottypes/text` 仓库 **404**。 | ① 按实物 MIT 登记 ② 登记例外 |
| `lazy-val` | `develar/lazy-val` 仓库 **404**；tarball 无 LICENSE；readme 158 字节无许可。chain：`electron-updater` ← `apps/docs/src/main/updater.ts`（**真实运行时**）。 | ① 换掉自动更新 ② 登记例外 |

**⚠️ 这三个的共同点**：**不是「取不到」，是「上游没有 / 声明与实物不符」。**
工程手段解决不了 —— 需要一个决定。

## 九、一条给后来者的判据

**「这个不该在这里」这个判断，依据必须是「谁在用它」，不能是「它是什么」。**

2026-10-24 差点因此删错一条：`@electron-internal/extract-zip` 的依赖链是
`electron` → 七个 editor app 的 devDependencies，看起来「不属于 genoffice」，于是被删。
但上游 `THIRD-PARTY-NOTICES.txt` 第 858 行确实列了它 —— **删掉会让发布出去的 notice
少一节，而门禁不再拦**。`t11` 当场抓住。

详见 `stage-genoffice-resources.cjs` 里 `REQUIRED_GENOFFICE_LICENSE_PACKAGES` 上方的注释
（提交 `dc298ec5`）。
