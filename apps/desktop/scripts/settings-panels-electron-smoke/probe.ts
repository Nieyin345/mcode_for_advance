/**
 * 【MC-026 复核】真 Electron 探针:三个设置面板的读失败 / 重试 / 保存失败保留输入。
 *
 * 每个场景一个页面(重新 loadFile 换 `?panel=&case=`),失败由 `api-stub.js` 注入
 * **一次**:第一次调用拒,重试自然成功 —— 于是:
 *   - 「错误可见」= 页面 innerText 里出现注入原因(真 DOM);
 *   - 「重试真重发」= `window.__calls[rpc]` 计数 +1 且错误消失;
 *   - 「保存失败保留输入」= 真点保存(注入失败)后输入框 value 仍是用户输入。
 * 全部判据都来自**真 DOM**,不是组件内部状态。
 */
import { BrowserWindow, ipcMain, nativeTheme } from "electron";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

interface Check {
  name: string;
  status: "PASS" | "FAIL";
  error?: string;
}

export async function runSettingsPanelsProbe(dir: string): Promise<void> {
  const evidence = join(dir, "checks.json");
  const checks: Check[] = [];
  let win: BrowserWindow | undefined;

  async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
      await fn();
      checks.push({ name, status: "PASS" });
      console.log("PASS SPE " + name);
    } catch (error) {
      checks.push({ name, status: "FAIL", error: String(error) });
      console.log("FAIL SPE " + name + " — " + String(error));
      throw error;
    } finally {
      writeFileSync(evidence, JSON.stringify(checks, null, 2));
    }
  }
  const assert = (cond: unknown, message: string): void => {
    if (!cond) throw new Error(message);
  };

  const pageUrl = (panel: string, scenario: string): string =>
    pathToFileURL(join(dir, "page.html")).href + `?panel=${encodeURIComponent(panel)}&case=${encodeURIComponent(scenario)}`;

  win = new BrowserWindow({
    width: 1500,
    height: 950,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      preload: join(dir, "bridge.cjs"),
    },
  });
  const wc = win.webContents;
  /**
   * 真 `theme:get` / `theme:set` —— 与生产 `main/ipc/theme.ts` 同一条语义(本套件不
   * 起真 DB,所以持久化用一个内存变量替代):set 把偏好写进 `nativeTheme.themeSource`,
   * Chromium 的 `prefers-color-scheme` 随之翻转;渲染端 `useTheme` 通过 `theme.changed`
   * 推送收到 effective 并切 `<html>.dark`。再包一层工装:让 `?case=` 指定的那一次
   * `theme.set` **落盘失败**(拒绝 + 不碰 nativeTheme),断言"失败后控件回到真实值"。
   */
  let themePreference: "dark" | "light" | "system" = "light";
  let themeSetFailures = 0;
  /** `theme-set-fail` 场景下由页面加载时设置:让下一次 `theme:set` 失败。 */
  wc.on("did-finish-load", () => {
    const caseName = new URL(wc.getURL()).searchParams.get("case");
    if (caseName === "theme-set-fail") themeSetFailures = 1;
  });
  const effectiveTheme = () => (nativeTheme.shouldUseDarkColors ? "dark" : "light");
  ipcMain.handle("theme:get", () => ({ theme: themePreference, effective: effectiveTheme() }));
  ipcMain.handle("theme:set", (_e, raw: { theme?: unknown }) => {
    if (themeSetFailures > 0) {
      themeSetFailures -= 1;
      throw new Error("AUDIT_E2E_THEME_SET_FAILED");
    }
    const next = raw?.theme;
    if (next !== "dark" && next !== "light" && next !== "system") throw new Error("invalid theme");
    themePreference = next;
    nativeTheme.themeSource = next;
    const result = { theme: themePreference, effective: effectiveTheme() };
    wc.send("theme:changed", { channel: "theme:changed", ...result });
    return result;
  });
  /** 页面 console / 未捕获异常 —— 面板整树炸掉时 body 会是空的,单看 innerText
   *  分不清"没渲染"与"渲染时抛错"。这两份诊断随失败信息一起报出来。 */
  const consoleLog: string[] = [];
  wc.on("console-message", (_e, level, message) => {
    consoleLog.push(`[console:${level}] ${message}`);
  });

  async function js<T = unknown>(expr: string): Promise<T> {
    return (await wc.executeJavaScript(expr, true)) as T;
  }
  async function until(label: string, expr: string, timeout = 15000): Promise<void> {
    const start = Date.now();
    while (true) {
      if (await js<boolean>(`!!(${expr})`)) return;
      if (Date.now() - start > timeout) {
        const diag = await js<string>(
          "JSON.stringify({ body: document.body.innerText.slice(0, 800), renderError: window.__probe?.renderError ?? null })",
        );
        throw new Error("等待超时:" + label + "; " + diag + "; console=" + consoleLog.slice(-12).join(" | "));
      }
      await delay(60);
    }
  }
  const bodyText = (): Promise<string> => js<string>("document.body.innerText");
  const clickButton = (label: string): Promise<void> =>
    js<void>(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
      if (!b) throw new Error('找不到按钮: ' + ${JSON.stringify(label)});
      if (b.disabled) throw new Error('按钮被禁用: ' + ${JSON.stringify(label)});
      b.click();
    })()`);
  const calls = (rpc: string): Promise<number> => js<number>(`window.__calls[${JSON.stringify(rpc)}] ?? 0`);
  const rendererErrors = (): Promise<string[]> =>
    js<string[]>(`(() => { const e = window.__probe?.renderError; return e ? [e] : []; })()`);

  const open = async (panel: string, scenario: string, ready: string): Promise<void> => {
    await wc.loadURL(pageUrl(panel, scenario));
    await until("页面就绪:" + panel + "/" + scenario, `window.__ready === true`);
    await until("面板内容出现:" + panel + "/" + scenario, ready);
  };

  try {
    /* ═══ 模型配置:README 错误可见 / 重试真重发 / 健康路径 ═══ */
    await check("★ 模型配置:读失败时错误条可见、点名原因,且不冒充「还没有供应商配置」", async () => {
      await open("custom-models", "custom-model-load-fail", `document.body.innerText.includes('供应商')`);
      const text = await bodyText();
      const diag = await js<string>("JSON.stringify({ renderError: window.__probe?.renderError ?? null })");
      assert(text.includes("AUDIT_E2E_CUSTOM_MODEL_LOAD"), "错误条里没有注入原因:" + text.slice(0, 400) + " diag=" + diag + " console=" + consoleLog.slice(-8).join(" | "));
      assert(!text.includes("还没有供应商配置"), "读失败仍画成空态(会诱导用户重建设置)");
    });
    await check("★ 模型配置:点「重试」真的重发 customModel.list,成功后错误消失", async () => {
      const before = await calls("customModel.list");
      await clickButton("重试");
      await until("错误条消失", `!document.body.innerText.includes('AUDIT_E2E_CUSTOM_MODEL_LOAD')`);
      const after = await calls("customModel.list");
      assert(after === before + 1, `customModel.list 调用次数应 +1,实际 ${before} → ${after}`);
    });
    await check("★ 模型配置健康路径:面板有内容、无错误条", async () => {
      await open("custom-models", "healthy", `document.body.innerText.includes('供应商')`);
      const text = await bodyText();
      assert(!text.includes("供应商清单读取失败"), "健康路径出现了读失败错误条");
      assert(text.includes("Claude") && text.includes("Pi") && text.includes("Codex"), "三个家族标签不在页面上:" + text.slice(0, 300));
    });
    await check("★ 模型配置:保存失败错误可见,且用户输入仍在(真输入框 value)", async () => {
      await open("custom-models", "custom-model-save-fail", `document.body.innerText.includes('供应商')`);
      // 新建一个 Claude 端点并填必填项(真实 DOM 输入,走 React 的受控 onChange)。
      await clickButton("Claude 端点");
      await until("表单出现", `document.querySelector('[data-provider-form="claude"]') !== null`);
      const setField = async (labelText: string, value: string): Promise<void> => {
        await js<void>(`(() => {
          const label = [...document.querySelectorAll('[data-provider-form="claude"] label')]
            .find((l) => (l.textContent || '').includes(${JSON.stringify(labelText)}));
          if (!label) throw new Error('找不到字段: ' + ${JSON.stringify(labelText)});
          const input = label.querySelector('input, textarea');
          if (!input) throw new Error('字段没有输入框: ' + ${JSON.stringify(labelText)});
          const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, ${JSON.stringify(value)});
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
      };
      await setField("名称", "用户填的网关");
      await setField("Base URL", "https://example.invalid/v1");
      await setField("Token / API Key", "sk-user-typed");
      // 至少一个模型 id("添加模型"按钮的文本里带图标,不是「= 添加模型」,
      // 按包含匹配点它,然后把占位符是「模型 id…」的那个输入框填上)。
      await js<void>(`(() => {
        const b = [...document.querySelectorAll('[data-provider-form="claude"] button')]
          .find((x) => (x.textContent || '').includes('添加模型'));
        if (!b) throw new Error('找不到「添加模型」按钮');
        b.click();
      })()`);
      await until("模型行出现", `[...document.querySelectorAll('[data-provider-form="claude"] input')].some((i) => (i.placeholder || '').includes('模型 id'))`);
      await js<void>(`(() => {
        const model = [...document.querySelectorAll('[data-provider-form="claude"] input')]
          .find((i) => (i.placeholder || '').includes('模型 id'));
        if (!model) throw new Error('找不到模型 id 输入框');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(model, 'm1');
        model.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await clickButton("保存");
      await until("保存失败错误出现", `document.body.innerText.includes('AUDIT_E2E_CUSTOM_MODEL_SAVE')`);
      const value = await js<string>(`(() => {
        const label = [...document.querySelectorAll('[data-provider-form="claude"] label')]
          .find((l) => (l.textContent || '').includes('名称'));
        return label?.querySelector('input')?.value ?? '';
      })()`);
      assert(value === "用户填的网关", `保存失败后名称输入框被回弹/清空:${JSON.stringify(value)}`);
      // Base URL 也保持(多一个字段一起证"表单没被回弹")。
      const baseUrl = await js<string>(`(() => {
        const label = [...document.querySelectorAll('[data-provider-form="claude"] label')]
          .find((l) => (l.textContent || '').includes('Base URL'));
        return label?.querySelector('input')?.value ?? '';
      })()`);
      assert(baseUrl === "https://example.invalid/v1", `保存失败后 Base URL 被回弹:${JSON.stringify(baseUrl)}`);
    });

    /* ═══ 引擎工具:错误 + 重试 ═══ */
    await check("★ 引擎工具:读失败错误条可见(带原因)", async () => {
      await open("engine-tools", "engine-tools-load-fail", `document.body.innerText.includes('AUDIT_E2E_ENGINE_TOOLS_LOAD')`);
      const text = await bodyText();
      assert(text.includes("AUDIT_E2E_ENGINE_TOOLS_LOAD"), "错误原因不在页面上:" + text.slice(0, 400));
    });
    await check("★ 引擎工具:点「重试」真的重发 engineTools.get,成功后错误消失且三张引擎卡片出现", async () => {
      const before = await calls("engineTools.get");
      await clickButton("重试");
      await until("错误条消失", `!document.body.innerText.includes('AUDIT_E2E_ENGINE_TOOLS_LOAD')`);
      await until("引擎卡片出现", `document.body.innerText.includes('Bash') && document.body.innerText.includes('read')`);
      const after = await calls("engineTools.get");
      assert(after === before + 1, `engineTools.get 调用次数应 +1,实际 ${before} → ${after}`);
    });
    await check("★ 引擎工具健康路径:无错误条、面板正常", async () => {
      await open("engine-tools", "healthy", `document.body.innerText.includes('Bash')`);
      const text = await bodyText();
      assert(!text.includes("AUDIT_E2E_ENGINE_TOOLS_LOAD"), "健康路径出现读失败错误条");
    });
    await check("★ 引擎工具:保存失败错误可见且不吞掉用户的说明输入", async () => {
      await open("engine-tools", "engine-tools-save-fail", `document.body.innerText.includes('Bash')`);
      const guidance = "用户写的工具使用说明 E2E";
      const setGuidance = await js<string>(`(() => {
        const areas = [...document.querySelectorAll('textarea')];
        if (!areas.length) return 'no-textarea';
        const area = areas[0];
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, ${JSON.stringify("用户写的工具使用说明 E2E")});
        area.dispatchEvent(new Event('input', { bubbles: true }));
        return 'ok';
      })()`);
      assert(setGuidance === "ok", "设置说明输入失败:" + setGuidance);
      // 「保存」按钮没有文字节点(内联 Spinner 或图标时 trim 后为空):按**所有 button 的
      // 下标**定位 —— 每个引擎卡片尾部最后一个按钮就是保存(见 EngineCard 的 DOM 顺序)。
      const clicked = await js<string>(`(() => {
        const card = [...document.querySelectorAll('section')].find((s) => {
          const h3 = s.querySelector('h3');
          return h3 && h3.textContent.trim() === 'Claude';
        });
        if (!card) return 'no-card';
        const buttons = [...card.querySelectorAll('button')];
        if (buttons.length === 0) return 'no-button';
        const btn = buttons[buttons.length - 1];
        if (btn.disabled) return 'disabled';
        btn.click();
        return 'ok';
      })()`);
      assert(clicked === "ok", "点 Claude 卡片的保存失败:" + clicked);
      await until("保存失败错误出现", `document.body.innerText.includes('AUDIT_E2E_ENGINE_TOOLS_SAVE')`);
      const value = await js<string>(`[...document.querySelectorAll('textarea')][0]?.value ?? ''`);
      assert(value === guidance, `保存失败后说明输入被清空/回弹:${JSON.stringify(value)}`);
    });

    /* ═══ 自动化:库列表错误 + 重试 ═══ */
    await check("★ 自动化:库列表读失败错误可见(不是空白左栏)", async () => {
      await open("automation", "automation-load-fail", `document.body.innerText.includes('工作流库读不出来')`);
      const text = await bodyText();
      assert(text.includes("AUDIT_E2E_WORKFLOW_LIST_LOAD"), "错误原因不在页面上:" + text.slice(0, 400));
    });
    await check("★ 自动化:点「重试」真的重发 workflow.list,成功后错误消失、列表出现", async () => {
      const before = await calls("workflow.list");
      await clickButton("重试");
      await until("错误消失", `!document.body.innerText.includes('工作流库读不出来')`);
      await until("列表出现", `document.body.innerText.includes('每日整理')`);
      const after = await calls("workflow.list");
      assert(after === before + 1, `workflow.list 调用次数应 +1,实际 ${before} → ${after}`);
    });
    await check("★ 自动化健康路径:列表与检查器正常(文档打开、无「打不开」)", async () => {
      await open("automation", "healthy", `document.body.innerText.includes('每日整理')`);
      const text = await bodyText();
      assert(!text.includes("工作流库读不出来") && !text.includes("这个工作流打不开"), "健康路径出现错误:" + text.slice(0, 400));
    });
    await check("★ 自动化:保存失败错误可见,且编辑器里用户输入仍在(真输入框 value)", async () => {
      await open("automation", "automation-save-fail", `document.body.innerText.includes('每日整理')`);
      // 检查器里的「名称」字段:改成用户输入(真实输入事件)。
      const setInspectorName = async (value: string): Promise<string> =>
        js<string>(`(() => {
          // ParamField 的 Field 是 div(不是 label,见那里文件头):按「直接子 span 文本
          // === 名称」的字段块找,与 workflow-ui-smoke 的 __ui.field 同形。
          const field = [...document.querySelectorAll('div.mb-2.block.w-full')].find((f) => {
            const title = f.firstElementChild;
            return title && title.textContent.trim() === '名称';
          });
          if (!field) return 'no-field';
          const input = field.querySelector('input');
          if (!input) return 'no-input';
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return 'ok';
        })()`);
      const setNameResult = await setInspectorName("用户改过的自动化名");
      assert(setNameResult === "ok", "设置检查器名称失败:" + setNameResult);
      await until("保存按钮可用", `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '保存' && !b.disabled)`);
      await clickButton("保存");
      await until("保存失败可见", `document.body.innerText.includes('AUDIT_E2E_WORKFLOW_SAVE')`);
      const value = await js<string>(`(() => {
        const field = [...document.querySelectorAll('div.mb-2.block.w-full')].find((f) => {
          const title = f.firstElementChild;
          return title && title.textContent.trim() === '名称';
        });
        return field?.querySelector('input')?.value ?? '';
      })()`);
      assert(value === "用户改过的自动化名", `保存失败后输入被回弹:${JSON.stringify(value)}`);
    });

    /* ═══ 自动化:运行前预检(界面对齐) ═══ */
    // 判定全部来自真 DOM + `__calls` 计数:预检说不能跑 → 原因画在页面上且
    // `automation.run` 一次都没调;预检通过 → 照常派发;预检自己抛错 → 错误可见、
    // 同样不派发(不静默继续)。
    const clickRunOnce = (): Promise<string> =>
      js<string>(`(() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '立刻运行一次');
        if (!b) return 'no-button';
        if (b.disabled) return 'disabled';
        b.click();
        return 'ok';
      })()`);

    await check("★ 自动化预检:missing-executor → 原因与下一步可见,且没有派发", async () => {
      await open("automation", "preflight-missing-executor", `document.body.innerText.includes('每日整理')`);
      await until("运行按钮出现", `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '立刻运行一次')`);
      const before = await calls("automation.run");
      const clicked = await clickRunOnce();
      assert(clicked === "ok", "点「立刻运行一次」失败:" + clicked);
      await until("预检原因出现", `document.body.innerText.includes('缺执行器「node-red」')`);
      const text = await bodyText();
      assert(text.includes("引擎"), "没有给出下一步(引擎面板):" + text.slice(0, 600));
      const after = await calls("automation.run");
      assert(after === before, `预检失败时仍派发了运行:${before} → ${after}`);
      assert((await calls("automation.preflight")) >= 1, "没有调用预检");
    });

    await check("★ 自动化预检:ok → 照常派发(防空过)", async () => {
      await open("automation", "healthy", `document.body.innerText.includes('每日整理')`);
      await until("运行按钮出现", `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '立刻运行一次')`);
      const before = await calls("automation.run");
      const clicked = await clickRunOnce();
      assert(clicked === "ok", "点「立刻运行一次」失败:" + clicked);
      await until("运行真的派发", `(window.__calls['automation.run'] ?? 0) > ${before}`);
      const after = await calls("automation.run");
      assert(after === before + 1, `预检通过后应派发一次:${before} → ${after}`);
      const text = await bodyText();
      assert(!text.includes("缺执行器"), "健康路径出现预检错误:" + text.slice(0, 400));
    });

    await check("★ 自动化预检:预检本身抛错 → 错误可见且不派发(不静默继续)", async () => {
      await open("automation", "preflight-throw", `document.body.innerText.includes('每日整理')`);
      await until("运行按钮出现", `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '立刻运行一次')`);
      const before = await calls("automation.run");
      const clicked = await clickRunOnce();
      assert(clicked === "ok", "点「立刻运行一次」失败:" + clicked);
      await until("预检错误出现", `document.body.innerText.includes('AUDIT_E2E_PREFLIGHT_FAILED')`);
      const after = await calls("automation.run");
      assert(after === before, `预检抛错时仍派发了运行:${before} → ${after}`);
    });

    /* ═══ 外观 / 语言 / 文本大小:即时生效 + 保存失败回退 ═══ */

    // 读 `<html>` 的真实状态:类、属性、以及**计算值**(不是内联字符串)。
    const htmlState = (): Promise<{ dark: boolean; lang: string; surface: string; bodyFont: number }> =>
      js(`(() => {
        const root = document.documentElement;
        const body = document.querySelector('main');
        return {
          dark: root.classList.contains('dark'),
          lang: root.lang,
          surface: getComputedStyle(root).getPropertyValue('--surface').trim(),
          bodyFont: body ? parseFloat(getComputedStyle(body).fontSize) : -1,
        };
      })()`);

    /** 选中一个 Base UI Select 的选项:点 trigger → 等 listbox → 点目标项。 */
    const pickSelect = async (triggerSelector: string, optionText: string): Promise<void> => {
      await js<void>(`(() => {
        const trigger = document.querySelector(${JSON.stringify(triggerSelector)});
        if (!trigger) throw new Error('找不到下拉框: ' + ${JSON.stringify(triggerSelector)});
        trigger.click();
      })()`);
      await until(
        "下拉选项出现:" + optionText,
        `[...document.querySelectorAll('[role="option"]')].some((o) => (o.textContent || '').includes(${JSON.stringify(optionText)}))`,
      );
      await js<void>(`(() => {
        const item = [...document.querySelectorAll('[role="option"]')]
          .find((o) => (o.textContent || '').includes(${JSON.stringify(optionText)}));
        if (!item) throw new Error('找不到选项: ' + ${JSON.stringify(optionText)});
        item.click();
      })()`);
    };

    await check("★ 主题:切到深色 → <html>.dark 真的加上,且 surface token 的计算值随主题变化", async () => {
      await open("appearance", "healthy", `document.body.innerText.includes('界面主题')`);
      const before = await htmlState();
      // 健康路径防空过:初始必须是浅色(否则下面的翻转断言两边同值)。
      assert(before.dark === false, "初始不是浅色:" + JSON.stringify(before));
      await pickSelect("#setting-theme", "深色");
      await until("html.dark 出现", `document.documentElement.classList.contains('dark')`);
      const after = await htmlState();
      assert(after.dark === true, "切深色后 html 没有 .dark");
      assert(after.surface !== before.surface, `surface token 计算值没变:${before.surface} → ${after.surface}`);
      // 深色下 --surface 应解析成暗色（#151515 → "21 21 21"）。
      assert(after.surface.replace(/\s+/g, " ") === "21 21 21", "深色 surface 不是 21 21 21:" + after.surface);
    });
    await check("★ 主题:切回浅色 → .dark 移除、surface 恢复", async () => {
      await pickSelect("#setting-theme", "浅色");
      await until("html.dark 移除", `!document.documentElement.classList.contains('dark')`);
      const state = await htmlState();
      assert(state.surface.replace(/\s+/g, " ") === "252 252 251", "浅色 surface 不是 252 252 251:" + state.surface);
    });
    await check("★ 主题:保存失败 → 错误 toast 可见,且控件回到真实值(不回弹成看起来成功)", async () => {
      // theme-set-fail:页面加载后主进程让下一次 theme:set 失败。控件值只看
      // `useTheme().theme`(来自 theme.get/changed),失败时不会变 —— 这条断言同时钉
      // "错误可见"与"没有假成功"。
      await open("appearance", "theme-set-fail", `document.body.innerText.includes('界面主题')`);
      const before = await htmlState();
      await pickSelect("#setting-theme", "深色");
      await until("主题失败 toast 出现", `document.body.innerText.includes('切换主题失败')`);
      const text = await bodyText();
      assert(text.includes("AUDIT_E2E_THEME_SET_FAILED"), "toast 里没有注入原因:" + text.slice(0, 400));
      const after = await htmlState();
      assert(after.dark === before.dark, `失败后主题被假切换:${before.dark} → ${after.dark}`);
      const triggerText = await js<string>(`document.querySelector('#setting-theme')?.textContent ?? ''`);
      assert(triggerText.includes("浅色"), "失败后下拉控件没有停在真实值(浅色):" + triggerText);
    });
    await check("★ 语言:切到 English → 界面文案真的换成英文(稳定 key:界面语言 → Interface language),且 <html lang> 变化", async () => {
      await open("general", "healthy", `document.body.innerText.includes('界面语言')`);
      await pickSelect("#setting-locale", "English");
      await until("英文文案出现", `document.body.innerText.includes('Interface language')`);
      const text = await bodyText();
      assert(!text.includes("界面语言"), "旧语言文案仍在:" + text.slice(0, 300));
      const lang = await js<string>("document.documentElement.lang");
      assert(lang === "en", "<html lang> 没有变成 en:" + lang);
    });
    await check("★ 语言:切回中文 → 文案与 <html lang> 一起恢复", async () => {
      await pickSelect("#setting-locale", "简体中文");
      await until("中文文案回来", `document.body.innerText.includes('界面语言')`);
      const lang = await js<string>("document.documentElement.lang");
      assert(lang === "zh-CN", "<html lang> 没有回到 zh-CN:" + lang);
    });
    await check("★ 语言:保存失败 → 错误可见,界面语言回到真实值(不回弹成看起来成功)", async () => {
      await open("general", "locale-save-fail", `document.body.innerText.includes('界面语言')`);
      await pickSelect("#setting-locale", "English");
      await until("设置保存失败 toast 出现", `document.body.innerText.includes('设置没能保存') || document.body.innerText.includes("Couldn't save the setting")`);
      const text = await bodyText();
      assert(text.includes("AUDIT_E2E_LOCALE_SAVE"), "toast 里没有注入原因:" + text.slice(0, 400));
      // 【回退】store 与 <html lang> 都要回到失败前的中文 —— 这条会红在旧实现上。
      await until("界面语言回退到中文", `document.body.innerText.includes('界面语言')`);
      const lang = await js<string>("document.documentElement.lang");
      assert(lang === "zh-CN", "失败后 <html lang> 没回退:" + lang);
    });
    // FontSizeStepper 的容器 id 就是 SettingRow 的 htmlFor(#setting-fontsize /
    // #setting-sidepanel-fontsize,见 AppearancePanel)—— 比按文案猜最内层稳定。
    const clickStepper = async (title: string, scopeId: string): Promise<void> => {
      const result = await js<string>(`(() => {
        const scope = document.querySelector(${JSON.stringify(scopeId)});
        if (!scope) return 'no-scope';
        const buttons = [...scope.querySelectorAll('button')]
          .filter((b) => b.getAttribute('title') === ${JSON.stringify(title)} && !b.disabled);
        if (!buttons.length) return 'no-button:' + [...scope.querySelectorAll('button')].map((b) => b.getAttribute('title')).join(',');
        buttons[0].click();
        return 'ok';
      })()`);
      assert(result === "ok", `步进按钮(${title}, ${scopeId})不可用:` + result);
    };

    await check("★ 文本大小:改聊天字号 → --chat-font-size 真的变、正文计算字号变化;再改回来", async () => {
      await open("appearance", "healthy", `document.body.innerText.includes('字号')`);
      const chatFont = (): Promise<number> =>
        js<number>(`parseFloat(getComputedStyle(document.querySelector('[data-testid="chat-font-probe"]')).fontSize)`);
      const before = await chatFont();
      const beforeVar = await js<string>(`document.documentElement.style.getPropertyValue('--chat-font-size')`);
      await clickStepper("增大", "#setting-fontsize");
      await until("聊天字号变量写入", `document.documentElement.style.getPropertyValue('--chat-font-size') !== ''`);
      const after = await chatFont();
      const afterVar = await js<string>(`document.documentElement.style.getPropertyValue('--chat-font-size')`);
      assert(beforeVar === "", "初始不该有内联 --chat-font-size:" + beforeVar);
      assert(afterVar === "15px", "--chat-font-size 不是 15px:" + afterVar);
      assert(after === before + 1, `聊天正文计算字号没 +1px:${before} → ${after}`);
      // 改回 14px:内联变量应被移除(样式表默认重新生效)。
      await clickStepper("减小", "#setting-fontsize");
      await until("内联字号移除", `document.documentElement.style.getPropertyValue('--chat-font-size') === ''`);
      const restored = await chatFont();
      assert(restored === before, `改回后计算字号没恢复:${before} → ${restored}`);
    });
    await check("★ 文本大小:改全局字号 → --right-panel-font-size 与设置页正文计算字号一起变;再改回来", async () => {
      const panelFont = (): Promise<number> =>
        js<number>(`parseFloat(getComputedStyle(document.querySelector('main')).fontSize)`);
      const before = await panelFont();
      await clickStepper("增大", "#setting-sidepanel-fontsize");
      await until("全局字号变量写入", `document.documentElement.style.getPropertyValue('--right-panel-font-size') !== ''`);
      const after = await panelFont();
      const afterVar = await js<string>(`document.documentElement.style.getPropertyValue('--right-panel-font-size')`);
      assert(afterVar === "15px", "--right-panel-font-size 不是 15px:" + afterVar);
      assert(after === before + 1, `设置页正文计算字号没 +1px:${before} → ${after}`);
      await clickStepper("减小", "#setting-sidepanel-fontsize");
      await until("全局字号变量移除", `document.documentElement.style.getPropertyValue('--right-panel-font-size') === ''`);
      assert((await panelFont()) === before, "改回后设置页正文计算字号没恢复");
    });
    await check("★ 文本大小:保存失败 → 可见错误,字号回到真实值(不回弹成看起来成功)", async () => {
      await open("appearance", "chatfont-save-fail", `document.body.innerText.includes('字号')`);
      const probeFont = (): Promise<number> =>
        js<number>(`parseFloat(getComputedStyle(document.querySelector('[data-testid="chat-font-probe"]')).fontSize)`);
      const before = await probeFont();
      await clickStepper("增大", "#setting-fontsize");
      await until("保存失败错误可见", `document.body.innerText.includes('设置没能保存') || document.body.innerText.includes("Couldn't save the setting")`);
      assert((await bodyText()).includes("AUDIT_E2E_CHAT_FONT_SAVE"), "错误里没有注入原因");
      // 【回退】字号必须回到 14px、内联变量被移除 —— 旧实现会把 15px 留在界面上。
      await until("字号回退到原值", `document.documentElement.style.getPropertyValue('--chat-font-size') === ''`);
      assert((await probeFont()) === before, `失败后字号没有回退:${before} → ${await probeFont()}`);
    });
    await check("★ 全局字号:保存失败 → 错误可见,设置页正文字号回到真实值", async () => {
      await open("appearance", "panel-font-save-fail", `document.body.innerText.includes('字号')`);
      const panelFont = (): Promise<number> =>
        js<number>(`parseFloat(getComputedStyle(document.querySelector('main')).fontSize)`);
      const before = await panelFont();
      await clickStepper("增大", "#setting-sidepanel-fontsize");
      await until("保存失败错误可见", `document.body.innerText.includes('设置没能保存') || document.body.innerText.includes("Couldn't save the setting")`);
      assert((await bodyText()).includes("AUDIT_E2E_PANEL_FONT_SAVE"), "错误里没有注入原因");
      await until("全局字号回退", `document.documentElement.style.getPropertyValue('--right-panel-font-size') === ''`);
      assert((await panelFont()) === before, `失败后全局字号没有回退:${before} → ${await panelFont()}`);
    });

    /* ═══ 【ARC-005】审批卡输入保护（Claude 工具审批 + 节点安装审批） ═══ */
    //
    // 判据来自**真 DOM + 真输入事件**：
    //   - 打开卡片时 activeElement 是卡片本身（不是「允许」）；
    //   - 「允许」在短延迟内 disabled（防回车/连击），等待后可用（健康路径防空过）；
    //   - Esc 应答为**拒绝**（respond 参数 approved:false），且拒绝按钮从不被延迟。
    // 键盘走 `webContents.sendInputEvent`（Electron 输入管线），不是页内合成事件。
    const pressEscape = async (): Promise<void> => {
      wc.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      wc.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      await delay(120);
    };
    /** 焦点描述：activeElement 是不是审批卡、是不是「允许」按钮。 */
    const approvalFocus = (cardSel: string, allowText: string): Promise<{
      isCard: boolean; isAllow: boolean; allowDisabled: boolean; denyDisabled: boolean;
    }> =>
      js(`(() => {
        const card = document.querySelector(${JSON.stringify(cardSel)});
        const a = document.activeElement;
        const buttons = card ? [...card.querySelectorAll('button')] : [];
        const allow = buttons.find((b) => (b.textContent || '').includes(${JSON.stringify(allowText)}));
        const deny = buttons.find((b) => (b.textContent || '').trim() === '拒绝');
        return {
          isCard: !!(card && a === card),
          isAllow: !!(allow && a === allow),
          allowDisabled: allow ? allow.disabled : null,
          denyDisabled: deny ? deny.disabled : null,
        };
      })()`);

    await check("★ 工具审批卡:打开时焦点在卡片本身,不在「允许」;「允许」延迟期内不可点、「拒绝」立即可用", async () => {
      await open("approval", "healthy", `document.querySelector('[role=alertdialog]') !== null`);
      const f = await approvalFocus("[role=alertdialog]", "允许");
      assert(f.isCard === true, "焦点没有落在审批卡上:" + JSON.stringify(f));
      assert(f.isAllow === false, "焦点错误地落在「允许」按钮上(回车即批准):" + JSON.stringify(f));
      assert(f.allowDisabled === true, "「允许」在开卡瞬间就可点(连击/回车可误批):" + JSON.stringify(f));
      assert(f.denyDisabled === false, "「拒绝」被延迟了(fail-closed 不该等):" + JSON.stringify(f));
    });

    await check("★ 工具审批卡:延迟到期后「允许」可点,点它真的批准(健康路径防空过)", async () => {
      await until("「允许」变为可点", `(() => {
        const b = [...document.querySelectorAll('[role=alertdialog] button')]
          .find((x) => (x.textContent || '').includes('允许'));
        return !!b && !b.disabled;
      })()`, 5000);
      await js<void>(`(() => {
        const b = [...document.querySelectorAll('[role=alertdialog] button')]
          .find((x) => (x.textContent || '').includes('允许'));
        if (!b) throw new Error('找不到「允许」');
        b.click();
      })()`);
      await until("批准决策被记录", `(window.__approvalDecisions || []).some((d) => d.granted === true)`);
      const decisions = await js<Array<{ granted: boolean }>>("window.__approvalDecisions || []");
      assert(decisions.length === 1 && decisions[0]!.granted === true, "批准没有经 onDecide 送达:" + JSON.stringify(decisions));
    });

    await check("★ 工具审批卡:Esc 应答为拒绝(approved:false),不是悄悄关掉", async () => {
      // 上一次批准后夹具重挂了一张新卡 —— 等它渲染,焦点应在卡上,再按真 Esc。
      await until("新审批卡出现", `document.querySelector('[role=alertdialog]') !== null`);
      await until("焦点回到卡片", `document.activeElement === document.querySelector('[role=alertdialog]')`);
      await pressEscape();
      await until("拒绝决策被记录", `(window.__approvalDecisions || []).filter((d) => d.granted === false).length === 1`);
      const decisions = await js<Array<{ granted: boolean }>>("window.__approvalDecisions || []");
      assert(decisions[decisions.length - 1]!.granted === false, "Esc 没有产生拒绝决策:" + JSON.stringify(decisions));
    });

    await check("★ 节点安装审批卡:焦点在卡片本身;「允许安装」延迟期内不可点;Esc 应答 approved:false", async () => {
      // 主进程推送一张真审批请求（字段与契约 WorkflowEngineNodeInstallApprovalMessage 同形）。
      let responded: Array<{ requestId: string; approved: boolean }> = [];
      ipcMain.removeHandler("workflowEngine:respondNodeInstallApproval");
      ipcMain.handle("workflowEngine:respondNodeInstallApproval", (_e, input: { requestId: string; approved: boolean }) => {
        responded.push(input);
        return { ok: true };
      });
      await open("engine-runtime", "healthy", `document.querySelector('[data-engine-nodes]') !== null`);
      const push = (requestId: string): void => {
        wc.send("workflowEngine:nodeInstallApproval", {
          channel: "workflowEngine:nodeInstallApproval",
          requestId,
          name: "danger-node",
          version: "1.0.0",
          source: "https://example.invalid/pkg.tgz",
          license: "MIT",
          capabilities: ["network"],
          network: true,
          sha256: "a".repeat(64),
          intent: "install",
        });
      };
      push("arc005-esc");
      await until("审批卡出现", `document.querySelector('[data-engine-approval]') !== null`);
      const f = await approvalFocus("[data-engine-approval]", "允许安装");
      assert(f.isCard === true, "焦点没有落在安装审批卡上:" + JSON.stringify(f));
      assert(f.isAllow === false, "焦点错误地落在「允许安装」上:" + JSON.stringify(f));
      assert(f.allowDisabled === true, "「允许安装」在开卡瞬间就可点:" + JSON.stringify(f));
      assert(f.denyDisabled === false, "「拒绝」被延迟了:" + JSON.stringify(f));
      // 焦点在卡片上时按真 Esc → 应答必须是拒绝。
      await pressEscape();
      for (let i = 0; i < 100 && responded.length === 0; i++) await delay(50);
      assert(responded.length === 1, "Esc 之后没有应答:" + JSON.stringify(responded));
      assert(responded[0]!.requestId === "arc005-esc" && responded[0]!.approved === false,
        "Esc 的应答不是拒绝:" + JSON.stringify(responded));
      await until("审批卡收起", `document.querySelector('[data-engine-approval]') === null`);
    });

    await check("★ 节点安装审批卡:延迟到期后可批准(健康路径防空过)——approved:true", async () => {
      let responded: Array<{ requestId: string; approved: boolean }> = [];
      ipcMain.removeHandler("workflowEngine:respondNodeInstallApproval");
      ipcMain.handle("workflowEngine:respondNodeInstallApproval", (_e, input: { requestId: string; approved: boolean }) => {
        responded.push(input);
        return { ok: true };
      });
      wc.send("workflowEngine:nodeInstallApproval", {
        channel: "workflowEngine:nodeInstallApproval",
        requestId: "arc005-allow",
        name: "danger-node",
        version: "1.0.0",
        source: "https://example.invalid/pkg.tgz",
        license: "MIT",
        capabilities: [],
        network: false,
        sha256: "b".repeat(64),
        intent: "install",
      });
      await until("审批卡再次出现", `document.querySelector('[data-engine-approval]') !== null`);
      await until("「允许安装」变为可点", `(() => {
        const b = [...document.querySelectorAll('[data-engine-approval] button')]
          .find((x) => (x.textContent || '').includes('允许安装'));
        return !!b && !b.disabled;
      })()`, 5000);
      await js<void>(`(() => {
        const b = [...document.querySelectorAll('[data-engine-approval] button')]
          .find((x) => (x.textContent || '').includes('允许安装'));
        if (!b) throw new Error('找不到「允许安装」');
        b.click();
      })()`);
      for (let i = 0; i < 100 && responded.length === 0; i++) await delay(50);
      assert(responded.length === 1 && responded[0]!.requestId === "arc005-allow" && responded[0]!.approved === true,
        "延迟到期后批准没有正确应答:" + JSON.stringify(responded));
    });

    /* ═══ 【MC-045 复核·U1】真 App 里的跨面板深链 ═══
     *
     * 台账验收:设置先开在「常规」,再收到指向「工作流」的深链 ——
     *   **左侧高亮**、**内容区**、以及带上 workflowId 时**内部打开的那一份**都要当场到位;
     *   手动切换不被过期请求抢回;关闭后重开语义一致;设置未打开时深链要打开并直达。
     *
     * 判据全部来自真 DOM:
     *   - 高亮 = 左栏 `<nav>` 里 accent 竖条所在的按钮文字(active 的唯一用户可见判据);
     *   - 内容 = 内容区标题(「工作流」页的 PanelHeader)+ 库列表里的条目名;
     *   - 焦点图 = `workflow.get:<id>` 的调用计数(桩按 id 分开记,不只看"页面有字")。
     *
     * 调用形状是**生产调用端**的两条真实入口:
     *   1. MCP/插件/技能面板的 `useSessionStore.getState().setSettingsOpen(true, section, workflowId)`;
     *   2. Agent 的 `open_settings` —— 经真 App 里安装的 `window.__mcodeAppControl`
     *      (appControlHost)走 JSON 入参/回参,不是直接摸 store。
     */
    const ACTIVE_NAV = `(() => {
      const nav = document.querySelector('.settings-root nav');
      if (!nav) return null;
      const marker = nav.querySelector('span.bg-accent');
      return marker && marker.closest('button') ? marker.closest('button').innerText.trim() : null;
    })()`;
    /** 内容区(设置页 center pane)可见文本 —— 高亮之外的第二个判据。 */
    const CENTER_TEXT = `(() => {
      const root = document.querySelector('.settings-root');
      if (!root) return '';
      const center = root.querySelector('main');
      return center ? center.innerText : '';
    })()`;
    const openSettings = async (): Promise<void> => {
      // 本套件的 `__ready` 只表示"入口脚本跑完";真 App 的挂载要等 React 提交,
      // 所以这里等的是工作区外壳真的出现在 DOM 里。
      await open("app", "healthy", `document.querySelector('[data-testid=workspace-main]') !== null`);
      await until("工作区外壳就绪", `document.querySelector('[data-testid=workspace-main]') !== null`, 30000);
    };

    await check("★ MC-045 前置:真 App 能挂起来,设置初始是关闭的(深链要能自己把它打开)", async () => {
      await openSettings();
      const openNow = await js<boolean>("window.__store.getState().settingsOpen === true");
      assert(openNow === false, "夹具启动时设置就是打开的,后面「未打开→深链打开」一条会空过");
      assert((await js<boolean>("document.querySelector('.settings-root') === null")), "设置层已挂但 store 说没开:夹具不同步");
    });

    await check("★ MC-045 未打开时深链:设置被打开并直达「工作流」(高亮 + 内容 + 指定图真被打开)", async () => {
      // Agent `open_settings` 的真实形状(JSON 字符串进,JSON 字符串出)。
      const reply = await js<string>(`window.__mcodeAppControl(JSON.stringify({ op: "open_settings", section: "workflows" }))`);
      const parsed = JSON.parse(reply) as { ok: boolean; error?: string };
      assert(parsed.ok === true, "open_settings 回执不是 ok:" + reply);
      await until("设置层出现", `document.querySelector('.settings-root') !== null`, 15000);
      await until("内容区出现工作流页", `${CENTER_TEXT}.includes('工作流库')`, 30000);
      const active = await js<string | null>(ACTIVE_NAV);
      assert(active === "工作流", "左侧高亮没落在「工作流」,而是:" + JSON.stringify(active));
      const center = await js<string>(CENTER_TEXT);
      assert(!center.includes("界面语言"), "内容区还停在「常规」(语言设置还在):" + center.slice(0, 200));
      // 没有 workflowId 的深链只切栏,不该擅自打开某一份图。
      assert((await calls("workflow.get:wf-mc045")) === 0, "未指定 workflowId 却打开了 wf-mc045");
    });

    await check("★ MC-045 未打开时深链带 workflowId:栏切过去后真的 openWorkflow 指定的那一份,且一次性意图用完即清", async () => {
      // 关掉再深链 —— 覆盖"关闭后重开"的语义。
      await js<void>(`window.__store.getState().setSettingsOpen(false)`);
      await until("设置层卸载", `document.querySelector('.settings-root') === null`, 15000);
      const reply = await js<string>(`window.__mcodeAppControl(JSON.stringify({ op: "open_settings", section: "workflows" }))`);
      assert((JSON.parse(reply) as { ok: boolean }).ok === true, "open_settings(重开)回执不是 ok:" + reply);
      await until("设置层重新出现", `document.querySelector('.settings-root') !== null`, 15000);
      // 先按生产调用端带 workflowId 的第二次深链(MCP/插件/技能面板的形状)。
      await js<void>(`window.__store.getState().setSettingsOpen(true, "workflows", "wf-mc045")`);
      await until("指定的图被打开", `(window.__calls['workflow.get:wf-mc045'] ?? 0) >= 1`, 20000);
      await until("图上标题出现", `${CENTER_TEXT}.includes('MC045 深链取证图')`, 20000);
      const cleared = await js<string | null>("window.__store.getState().settingsFocusWorkflowId");
      assert(cleared === null, "一次性焦点用完后没有清掉:" + JSON.stringify(cleared));
      const active = await js<string | null>(ACTIVE_NAV);
      assert(active === "工作流", "左侧高亮没在「工作流」:" + JSON.stringify(active));
    });

    await check("★ MC-045 已打开时跨面板深链:停在「工作流」再收到「外观」,左栏高亮与内容区当场一起切(不是只改了 state)", async () => {
      // 此刻设置是开着的(上一条收尾在「工作流」)。先断言起点有效(防空过)。
      const before = await js<string | null>(ACTIVE_NAV);
      assert(before === "工作流", "起点不在「工作流」,这条没有判别力:" + JSON.stringify(before));
      await js<void>(`window.__store.getState().setSettingsOpen(true, "appearance")`);
      await until("内容区换成外观页", `${CENTER_TEXT}.includes('界面主题')`, 15000);
      const active = await js<string | null>(ACTIVE_NAV);
      assert(active === "外观", "左栏高亮没有当场切到「外观」,而是:" + JSON.stringify(active));
      const center = await js<string>(CENTER_TEXT);
      assert(!center.includes("工作流库"), "内容区还留着工作流页:" + center.slice(0, 200));
    });

    await check("★ MC-045 已打开、设置先停在「常规」时再深链「工作流」:高亮与内容当场切(台账原始红例的复现路径)", async () => {
      // 走真实鼠标点左栏「常规」—— 生产里用户就是这样切栏的,顺便把"手动切换生效"钉住。
      const clicked = await js<string>(`(() => {
        const nav = document.querySelector('.settings-root nav');
        if (!nav) return 'no-nav';
        const b = [...nav.querySelectorAll('button')].find((x) => x.innerText.trim() === '常规');
        if (!b) return 'no-button';
        b.click();
        return 'ok';
      })()`);
      assert(clicked === "ok", "点「常规」失败:" + clicked);
      await until("高亮回到「常规」", `${ACTIVE_NAV} === '常规'`, 15000);
      await until("内容区回到常规页", `${CENTER_TEXT}.includes('界面语言')`, 15000);

      // 台账红例的调用形状(MCP/插件/技能页的「跳转到工作流」)。
      await js<void>(`window.__store.getState().setSettingsOpen(true, "workflows")`);
      await until("内容区再次出现工作流页", `${CENTER_TEXT}.includes('工作流库')`, 20000);
      const active = await js<string | null>(ACTIVE_NAV);
      assert(active === "工作流", "Store 改成 workflows 了,左栏高亮仍停在:" + JSON.stringify(active));
      const center = await js<string>(CENTER_TEXT);
      assert(!center.includes("界面语言"), "内容区仍停在「常规」:" + center.slice(0, 200));
    });

    await check("★ MC-045 手动切换不被过期深链抢回:深链到「工作流」后手动点「外观」,停留后仍在「外观」", async () => {
      const clicked = await js<string>(`(() => {
        const nav = document.querySelector('.settings-root nav');
        if (!nav) return 'no-nav';
        const b = [...nav.querySelectorAll('button')].find((x) => x.innerText.trim() === '外观');
        if (!b) return 'no-button';
        b.click();
        return 'ok';
      })()`);
      assert(clicked === "ok", "点「外观」失败:" + clicked);
      await until("高亮切到「外观」", `${ACTIVE_NAV} === '外观'`, 15000);
      // 给消费 effect / 订阅任何晚到的重放留足时间:若旧修订号被重放,这里会弹回「工作流」。
      await delay(700);
      const active = await js<string | null>(ACTIVE_NAV);
      assert(active === "外观", "手动选择被过期深链弹回:" + JSON.stringify(active));
      const section = await js<string | null>("window.__store.getState().settingsSection");
      // Store 里仍是上次请求的 section 是**设计如此**(修订号才是"新请求"的判据),
      // 但界面必须跟着用户走 —— 这条断言同时把这两件事分开。
      assert(section === "workflows", "store 的 settingsSection 被手动切换改写了(契约是只有深链写它):" + JSON.stringify(section));
    });

    await check("★ MC-045 遗留 id 深链(data-root → 文档管理):仍走同一状态机并当场切栏", async () => {
      await js<void>(`window.__store.getState().setSettingsOpen(true, "data-root")`);
      await until("内容区出现文档管理页", `${CENTER_TEXT}.includes('数据位置')`, 20000);
      const active = await js<string | null>(ACTIVE_NAV);
      assert(active === "文档管理", "遗留 id 没映射到「文档管理」,高亮是:" + JSON.stringify(active));
    });

    await check("★ MC-045 未知栏目深链:显式回退「常规」并留下诊断,不停在没有内容的旧栏目", async () => {
      const before = await js<string | null>(ACTIVE_NAV);
      assert(before === "文档管理", "起点不在「文档管理」,回退断言没有判别力:" + JSON.stringify(before));
      const consoleBefore = consoleLog.length;
      await js<void>(`window.__store.getState().setSettingsOpen(true, "definitely-retired")`);
      await until("高亮回退到「常规」", `${ACTIVE_NAV} === '常规'`, 15000);
      const warned = consoleLog.slice(consoleBefore).some((l) => l.includes('未知的深链栏目'));
      assert(warned === true, "回退没有留下 console.warn 诊断:" + consoleLog.slice(consoleBefore).join(" | "));
    });

    /* ═══ 【MC-047 复核·U1】终端/浏览器设置读失败:真 Electron 里的可见错误 + 重试 ═══
     *
     * 台账 remaining 的「真 Electron U1」:设置行读失败时必须是
     *   **错误行可见(role=alert + 注入原因)+ 重试真的重发 + 不锁死无关行**,
     * 而不是从前那个「disabled 永远灰、屏幕上没有一句话」。
     * 判据全部来自真 DOM(`input.disabled` / `[role=switch]` 的禁用态 / role=alert 文本),
     * 不是组件内部 state。注入面见 `api-stub.js` 的 `__failNextGet` / `__seedSetting`。
     */
    /** 页面里含 `marker` 的 ErrorNote(role=alert/status)是否出现;返回其文本。 */
    const errorRowText = (marker: string): Promise<string | null> =>
      js<string | null>(`(() => {
        const rows = [...document.querySelectorAll('.settings-root [role=alert], .settings-root [role=status]')];
        const hit = rows.find((r) => (r.innerText || '').includes(${JSON.stringify(marker)}));
        return hit ? hit.innerText : null;
      })()`);
    /** 在含 `marker` 的错误行里点「重试」——按行定向,避免多行同时报错时点错。 */
    const clickRetryWithin = (marker: string): Promise<void> =>
      js<void>(`(() => {
        const rows = [...document.querySelectorAll('.settings-root [role=alert], .settings-root [role=status]')];
        const row = rows.find((r) => (r.innerText || '').includes(${JSON.stringify(marker)}));
        if (!row) throw new Error('找不到含标记的错误行: ' + ${JSON.stringify(marker)});
        const b = [...row.querySelectorAll('button')].find((x) => x.textContent.trim() === '重试');
        if (!b) throw new Error('错误行里没有「重试」: ' + ${JSON.stringify(marker)});
        b.click();
      })()`);
    /** 浏览器两行目录输入框:终端行有 id,浏览器行没有 —— 按 placeholder 定位。 */
    const inputByPlaceholder = (placeholder: string): Promise<{ disabled: boolean; value: string } | null> =>
      js<{ disabled: boolean; value: string } | null>(`(() => {
        const el = [...document.querySelectorAll('.settings-root input')]
          .find((i) => (i.placeholder || '') === ${JSON.stringify(placeholder)});
        return el ? { disabled: el.disabled, value: el.value } : null;
      })()`);
    /** 登录开关的禁用态(@base-ui 的 Switch 根是 button / role=switch)。 */
    const switchState = (): Promise<{ found: boolean; disabled: boolean; checked: boolean }> =>
      js(`(() => {
        const el = document.querySelector('.settings-root [role="switch"]');
        if (!el) return { found: false, disabled: true, checked: false };
        const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('data-disabled');
        return { found: true, disabled, checked: el.getAttribute('aria-checked') === 'true' || el.checked === true };
      })()`);

    await check("★ MC-047 终端 Shell:读失败时错误行可见(点名原因)+ 输入框禁用 + 有「重试」", async () => {
      await js<void>(`window.__seedSetting("terminal.shell", "/bin/zsh")`);
      await js<void>(`window.__failNextGet("terminal.shell", "AUDIT_E2E_MC047_TERMINAL_READ")`);
      await js<void>(`window.__store.getState().setSettingsOpen(true, "terminal")`);
      await until("终端页内容出现", `${CENTER_TEXT}.includes('Shell 路径')`, 20000);
      await until("终端读错误行出现", `(() => {
        const rows = [...document.querySelectorAll('.settings-root [role=alert], .settings-root [role=status]')];
        return rows.some((r) => (r.innerText || '').includes('AUDIT_E2E_MC047_TERMINAL_READ'));
      })()`, 15000);
      const rowText = await errorRowText("AUDIT_E2E_MC047_TERMINAL_READ");
      assert(rowText !== null && rowText.includes("读取失败"), "错误行没有「读取失败」标题:" + JSON.stringify(rowText));
      const shell = await js<{ disabled: boolean; value: string } | null>(`(() => {
        const el = document.querySelector('#setting-terminal-shell');
        return el ? { disabled: el.disabled, value: el.value } : null;
      })()`);
      assert(shell !== null, "终端 Shell 输入框不存在");
      assert(shell!.disabled === true, "读失败时输入框仍可编辑(未知值可能被当空值写回):" + JSON.stringify(shell));
      const hasRetry = await js<boolean>(`(() => {
        const rows = [...document.querySelectorAll('.settings-root [role=alert], .settings-root [role=status]')];
        const row = rows.find((r) => (r.innerText || '').includes('AUDIT_E2E_MC047_TERMINAL_READ'));
        return !!row && [...row.querySelectorAll('button')].some((b) => b.textContent.trim() === '重试');
      })()`);
      assert(hasRetry === true, "错误行里没有「重试」入口(用户只能切走再切回来)");
    });

    await check("★ MC-047 终端 Shell:点「重试」真的重发 setting.get,成功后错误消失、控件恢复且值就位", async () => {
      const before = await calls("setting.get:terminal.shell");
      await clickRetryWithin("AUDIT_E2E_MC047_TERMINAL_READ");
      await until("终端读错误消失", `(() => {
        const rows = [...document.querySelectorAll('.settings-root [role=alert], .settings-root [role=status]')];
        return !rows.some((r) => (r.innerText || '').includes('AUDIT_E2E_MC047_TERMINAL_READ'));
      })()`, 15000);
      const after = await calls("setting.get:terminal.shell");
      assert(after === before + 1, `重试没有重发 setting.get:terminal.shell:${before} → ${after}`);
      const shell = await js<{ disabled: boolean; value: string } | null>(`(() => {
        const el = document.querySelector('#setting-terminal-shell');
        return el ? { disabled: el.disabled, value: el.value } : null;
      })()`);
      assert(shell!.disabled === false, "重试成功后输入框仍禁用:" + JSON.stringify(shell));
      assert(shell!.value === "/bin/zsh", "重试成功后没有显示真实值:" + JSON.stringify(shell));
    });

    await check("★ MC-047 终端 Shell 健康路径(防空过):重新进入面板无错误行、控件可用", async () => {
      await js<void>(`window.__store.getState().setSettingsOpen(true, "general")`);
      await until("回到常规页", `${CENTER_TEXT}.includes('界面语言')`, 15000);
      await js<void>(`window.__store.getState().setSettingsOpen(true, "terminal")`);
      await until("终端页再次出现", `${CENTER_TEXT}.includes('Shell 路径')`, 20000);
      await until("Shell 输入框出现", `document.querySelector('#setting-terminal-shell') !== null`);
      await delay(300);
      const rowText = await errorRowText("读取失败");
      assert(rowText === null, "健康路径出现读失败错误行(永远在报):" + JSON.stringify(rowText));
      const shell = await js<{ disabled: boolean; value: string } | null>(`(() => {
        const el = document.querySelector('#setting-terminal-shell');
        return el ? { disabled: el.disabled, value: el.value } : null;
      })()`);
      assert(shell!.disabled === false && shell!.value === "/bin/zsh", "健康路径控件状态不对:" + JSON.stringify(shell));
    });

    await check("★ MC-047 浏览器截图/数据目录:各自读失败各自可见、两行同时禁用(不是整页死锁的假象)", async () => {
      await js<void>(`window.__seedSetting("browser.screenshotDir", "C:/shots")`);
      await js<void>(`window.__seedSetting("browser.dataDir", "D:/browser-data")`);
      await js<void>(`window.__failNextGet("browser.screenshotDir", "AUDIT_E2E_MC047_SHOT_READ")`);
      await js<void>(`window.__failNextGet("browser.dataDir", "AUDIT_E2E_MC047_DATA_READ")`);
      await js<void>(`window.__store.getState().setSettingsOpen(true, "browser")`);
      await until("浏览器页内容出现", `${CENTER_TEXT}.includes('截图目录') && ${CENTER_TEXT}.includes('数据目录')`, 20000);
      await until("两行错误行都出现", `(() => {
        const rows = [...document.querySelectorAll('.settings-root [role=alert], .settings-root [role=status]')];
        const t = rows.map((r) => r.innerText || '').join('\\n');
        return t.includes('AUDIT_E2E_MC047_SHOT_READ') && t.includes('AUDIT_E2E_MC047_DATA_READ');
      })()`, 15000);
      const shot = await inputByPlaceholder("留空使用系统图片目录");
      const data = await inputByPlaceholder("留空使用默认位置");
      assert(shot !== null && shot.disabled === true, "截图目录读失败时输入框仍可编辑:" + JSON.stringify(shot));
      assert(data !== null && data.disabled === true, "数据目录读失败时输入框仍可编辑:" + JSON.stringify(data));
      assert((await errorRowText("AUDIT_E2E_MC047_SHOT_READ")) !== null, "截图目录的错误行不可见");
      assert((await errorRowText("AUDIT_E2E_MC047_DATA_READ")) !== null, "数据目录的错误行不可见");
    });

    await check("★ MC-047 浏览器:只重试截图行 → 它单独恢复,数据目录仍禁用(按行恢复,不是整页刷新)", async () => {
      const before = await calls("setting.get:browser.screenshotDir");
      await clickRetryWithin("AUDIT_E2E_MC047_SHOT_READ");
      await until("截图行错误消失", `(() => {
        const rows = [...document.querySelectorAll('.settings-root [role=alert], .settings-root [role=status]')];
        return !rows.some((r) => (r.innerText || '').includes('AUDIT_E2E_MC047_SHOT_READ'));
      })()`, 15000);
      const after = await calls("setting.get:browser.screenshotDir");
      assert(after === before + 1, `截图行重试没有重发:${before} → ${after}`);
      const shot = await inputByPlaceholder("留空使用系统图片目录");
      assert(shot!.disabled === false && shot!.value === "C:/shots", "截图行没有单独恢复:" + JSON.stringify(shot));
      const data = await inputByPlaceholder("留空使用默认位置");
      assert(data!.disabled === true, "数据目录的错误行被截图行的重试连带清掉了(错误状态串行):" + JSON.stringify(data));
      assert((await errorRowText("AUDIT_E2E_MC047_DATA_READ")) !== null, "数据目录的错误行消失了(不该被无关重试清掉)");
    });

    await check("★ MC-047 浏览器:再重试数据目录行 → 恢复;两行都恢复后无错误行(健康路径防空过)", async () => {
      await clickRetryWithin("AUDIT_E2E_MC047_DATA_READ");
      await until("数据目录错误消失", `(() => {
        const rows = [...document.querySelectorAll('.settings-root [role=alert], .settings-root [role=status]')];
        return !rows.some((r) => (r.innerText || '').includes('AUDIT_E2E_MC047_DATA_READ'));
      })()`, 15000);
      const data = await inputByPlaceholder("留空使用默认位置");
      assert(data!.disabled === false && data!.value === "D:/browser-data", "数据目录行没有恢复:" + JSON.stringify(data));
      assert((await errorRowText("读取失败")) === null, "两行都恢复后仍留着读失败错误行");
    });

    await check("★ MC-047 登录开关:读失败时开关禁用 + 错误行 + 重试;重试后启用且不写默认值", async () => {
      const setsBefore = await calls("setting.set:browser.persistLogin");
      // 离开再回来,让 PersistLoginRow 重新挂载并撞上这一次注入的失败。
      await js<void>(`window.__store.getState().setSettingsOpen(true, "general")`);
      await until("回到常规页", `${CENTER_TEXT}.includes('界面语言')`, 15000);
      await js<void>(`window.__seedSetting("browser.persistLogin", "0")`);
      await js<void>(`window.__failNextGet("browser.persistLogin", "AUDIT_E2E_MC047_PERSIST_READ")`);
      await js<void>(`window.__store.getState().setSettingsOpen(true, "browser")`);
      await until("浏览器页再次出现", `${CENTER_TEXT}.includes('记住网站登录状态')`, 20000);
      await until("登录开关错误行出现", `(() => {
        const rows = [...document.querySelectorAll('.settings-root [role=alert], .settings-root [role=status]')];
        return rows.some((r) => (r.innerText || '').includes('AUDIT_E2E_MC047_PERSIST_READ'));
      })()`, 15000);
      const sw = await switchState();
      assert(sw.found === true, "登录开关没有渲染出来");
      assert(sw.disabled === true, "读失败时开关仍可切换(会拿默认值覆盖真实设置):" + JSON.stringify(sw));
      assert((await errorRowText("AUDIT_E2E_MC047_PERSIST_READ")) !== null, "登录开关的读失败错误行不可见");
      // 读失败期间不写任何东西 —— 尤其不能把默认值写回。
      assert((await calls("setting.set:browser.persistLogin")) === setsBefore, "读失败期间发出了 setting.set:browser.persistLogin");
      await clickRetryWithin("AUDIT_E2E_MC047_PERSIST_READ");
      await until("登录开关错误消失", `(() => {
        const rows = [...document.querySelectorAll('.settings-root [role=alert], .settings-root [role=status]')];
        return !rows.some((r) => (r.innerText || '').includes('AUDIT_E2E_MC047_PERSIST_READ'));
      })()`, 15000);
      const swAfter = await switchState();
      assert(swAfter.disabled === false, "重试成功后登录开关仍禁用:" + JSON.stringify(swAfter));
      assert(swAfter.checked === false, "读到 \"0\" 后开关应关闭(没把未知当默认 true):" + JSON.stringify(swAfter));
      // 【防空过】证明 `setting.set:<key>` 计数不是恒 0 的死探针:真点一下开关,
      // 写入必须被计数、且落的是 "1"(上一条「读失败期间不写」才因此有判别力)。
      const setsBeforeToggle = await calls("setting.set:browser.persistLogin");
      await js<void>(`(() => {
        const el = document.querySelector('.settings-root [role="switch"]');
        if (!el) throw new Error('找不到登录开关');
        el.click();
      })()`);
      await until("开关写入被计数", `(window.__calls['setting.set:browser.persistLogin'] ?? 0) > ${setsBeforeToggle}`, 15000);
      const setsAfterToggle = await calls("setting.set:browser.persistLogin");
      assert(setsAfterToggle === setsBeforeToggle + 1, "点一下开关应恰好写一次:" + setsBeforeToggle + " → " + setsAfterToggle);
      const lastSetValue = await js<string | null>(`(() => {
        const log = window.__lastSettingSet;
        return log && log.key === 'browser.persistLogin' ? String(log.value) : null;
      })()`);
      assert(lastSetValue === "1", "点开开关写入的不是 \"1\":" + JSON.stringify(lastSetValue));
    });

    /* 收尾:回到「常规」—— 下一条(全程无异常)沿用原判据。 */
    await js<void>(`window.__store.getState().setSettingsOpen(true, "general")`);
    await until("收尾回到常规页", `${CENTER_TEXT}.includes('界面语言')`, 15000);

    /* ═══ 渲染端全程无未捕获异常(整树卸载探针) ═══ */
    await check("★ 全程无渲染端未捕获异常(最后一页仍完整)", async () => {
      const errors = await rendererErrors();
      assert(errors.length === 0, "渲染端未捕获异常:" + errors.join("\n").slice(0, 800));
      // 最后一页是 MC-045 的真 App 场景:设置层开着、停在未知栏目回退后的「常规」。
      // 整树仍在(不是被一次异常卸载成空 body)。
      const text = await bodyText();
      assert(text.includes("界面语言"), "页面在最后一次断言后不完整:" + text.slice(0, 300));
      assert((await js<boolean>("document.querySelector('.settings-root') !== null")), "设置层在最后一次断言后不在了");
    });
  } finally {
    win?.destroy();
  }
}
