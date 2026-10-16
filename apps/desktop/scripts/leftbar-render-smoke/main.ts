// 入口（`.ts` 形态）—— `smokes-for.py` 只从 `.ts` / `.mjs` 入口顺 import 找覆盖，
// 而探针本身要写 JSX 得是 `.tsx`。这一行让 `smokes-for.sh` 能顺藤摸到
// `LeftBar.tsx` / `LeftBarParts.tsx`，探针主体在 `probe.tsx`。
import "./probe.js";
