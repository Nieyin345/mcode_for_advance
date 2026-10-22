# GenOffice 未决许可证：总控预取证据（2026-10-23）

> 这份是**总控并行预取**的原始证据，供 T9 执行对话直接采用或反驳。每条都能独立复核。

## 来源与方法

- 来源：npm registry 精确版本的 tarball（`https://registry.npmjs.org/<pkg>/-/<pkg>-<version>.tgz`），不是相邻版本，不是仓库 HEAD。
- 提取：tarball 内 `package/README.md` 的许可证章节。这 6 个包**都没有独立的 LICENSE 文件**，README 内嵌全文是唯一的原始载体。
- 落盘：`docs/research/genoffice-license/evidence/<pkg>-<version>-LICENSE.txt`（逐字复制，未改写）。

## 六个从未被 T89/T90 查过的包

| 包 | 版本 | npm 声明 | 证据形态 | tarball SHA-256 前 16 位 | 正文长度 |
|---|---|---|---|---|---|
| fastdom | 1.0.12 | MIT | README 内嵌全文 | `15e452be64ae3661` | 1106 字符 |
| hash.js | 1.1.7 | MIT | README 内嵌全文 | `8eadfe0cbd33052f` | 1119 字符 |
| isarray | 1.0.0 | MIT | README 内嵌全文 | `e23c76f14f5222e0` | 1108 字符 |
| ot-json1 | 1.0.2 | ISC | README 内嵌全文 | `4ef9cb668a9ab57a` | 773 字符 |
| strictdom | 1.0.1 | MIT | README 内嵌全文 | `824b654d671c7936` | 1106 字符 |
| unicount | 1.1.0 | ISC | README 内嵌全文 | `a41314ccb5821427` | 738 字符 |

**六个全部有完整的授权段落和免责声明。** ISC 的两个（ot-json1、unicount）都是标准 ISC 全文，不是缩写或占位。

## 为什么它们原先被判 blocked

`apps/desktop/build/vendor-licenses/genoffice/manifest.json` 的判定要求**独立许可证文件**。这 6 个包只把全文写在 README 里，因此被机械判据挡住——**不是许可不明，是载体形态不同**。

这是 T9/T11 需要裁决的**策略问题**，不是取证问题：

> README 内嵌的许可证全文，是否满足「可追溯完整许可证全文」的门槛？

支持「满足」的理由：
- 是精确版本 tarball 里的原件，逐字可复核；
- 作者本人以该 README 作为许可载体（这些包历史上从未发布独立 LICENSE 文件）；
- MIT/ISC 都只要求「保留版权声明与许可声明」，未指定文件形态。

反对的理由：
- 现有 manifest 策略若按「独立文件」定，放宽需要显式决策，不能由取证方单方面决定。

## 已确认的 8 个 resolved（不要重研）

`@napi-rs/canvas-win32-x64-msvc` 1.0.3、`@nodable/entities` 3.0.0、`@univerjs/protocol` 0.25.1、`emoji-regex` 8.0.0、`franc-min` 6.2.0、`is-potential-custom-element-name` 1.0.1、`punycode` 2.3.1、`saxes` 6.0.0。

## 仍是真难点的 4 个（T89/T90 已查，未解）

| 包 | 版本 | 已有结论 | 缺什么 |
|---|---|---|---|
| `@electron-internal/extract-zip` | 1.0.5 | UNRESOLVED | 精确版本无完整许可全文 |
| `lazy-val` | 1.0.5 | UNRESOLVED | 同上 |
| `ot-text-unicode` | 4.0.0 | CONFLICT | ISC metadata 与 MIT README 冲突，需裁决 |
| `react-remove-scroll-bar` | 2.3.8 | UNRESOLVED | 仅 MIT 标签，无精确版全文 |

## 复核方法

```bash
# 重新取任一份
curl -sL https://registry.npmjs.org/fastdom/-/fastdom-1.0.12.tgz | tar -xzO package/README.md | sed -n '/## License/,/SOFTWARE./p'
```
