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

    /* ═══ 渲染端全程无未捕获异常(整树卸载探针) ═══ */
    await check("★ 全程无渲染端未捕获异常(最后一页仍完整)", async () => {
      const errors = await rendererErrors();
      assert(errors.length === 0, "渲染端未捕获异常:" + errors.join("\n").slice(0, 800));
      assert((await bodyText()).includes("字号"), "页面在最后一次断言后不完整:" + (await bodyText()).slice(0, 300));
    });
  } finally {
    win?.destroy();
  }
}
