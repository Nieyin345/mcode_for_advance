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
import { BrowserWindow } from "electron";
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
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
  });
  const wc = win.webContents;
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

    /* ═══ 渲染端全程无未捕获异常(整树卸载探针) ═══ */
    await check("★ 全程无渲染端未捕获异常(最后一页仍完整)", async () => {
      const errors = await rendererErrors();
      assert(errors.length === 0, "渲染端未捕获异常:" + errors.join("\n").slice(0, 800));
      assert((await bodyText()).includes("每日整理"), "页面在最后一次断言后不完整");
    });
  } finally {
    win?.destroy();
  }
}
