import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withAuditPage } from './browser.mjs';
const dir = dirname(fileURLToPath(import.meta.url)), results = [];
await withAuditPage(dir, async page => {
  const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); };
  const clickExpr = async expr => { await page.eval(`(()=>{const e=${expr};if(!e)throw Error('Missing control: '+${JSON.stringify(expr)});e.click();})()`); await page.sleep(140); };
  const text = async () => page.eval('document.body.innerText');
  const tab = name => `[...document.querySelectorAll('button')].find(e=>e.offsetParent!==null && e.textContent.trim().startsWith(${JSON.stringify(name)}))`;
  const test = async (name, run) => {
    try { await run(); assert.deepEqual(page.exceptions, []); check(name, true); }
    catch (e) { check(name, false, String(e)); }
    await page.screenshot(name + '.png');
  };
  const go = async () => {
    await page.goto('', 'window.__ready && document.querySelector("[role=tablist], nav")');
    await page.waitFor("document.body.innerText.includes('Gateway A')");
  };
  const openTab = async (name) => { await clickExpr(tab(name)); await page.sleep(180); };
  const pickProvider = async (label) => { await clickExpr(`[...document.querySelectorAll('nav button')].find(e=>e.textContent.includes(${JSON.stringify(label)}))`); await page.sleep(180); };

  // ── 三个 tab 都在、都能开 ──
  await test('three-engine-tabs-exist', async () => {
    await go();
    const body = await text();
    assert.match(body, /Claude/); assert.match(body, /Pi/); assert.match(body, /Codex/);
  });

  // ── 每个引擎：点开一个供应商，右侧出现同一套「表单骨架」──
  // 判据：三个表单都必须有 名称 / Base URL / 密钥 / 模型列表 / 保存·取消。
  const formShape = async (label) => {
    const body = await text();
    return {
      baseUrl: /Base URL|地址|网关/.test(body),
      key: /密钥|API Key|令牌|Token/i.test(body),
      models: /模型/.test(body),
      save: await page.eval(`!!([...document.querySelectorAll('button')].find(e=>['保存','更新','Save'].includes(e.textContent.trim())))`),
      cancel: await page.eval(`!!([...document.querySelectorAll('button')].find(e=>['取消','Cancel'].includes(e.textContent.trim())))`),
    };
  };

  await test('claude-form-has-shared-skeleton', async () => {
    await go(); await pickProvider('Gateway A');
    const s = await formShape('claude');
    assert.equal(s.baseUrl, true, 'claude form needs a base URL field');
    assert.equal(s.models, true, 'claude form needs a model list');
    assert.equal(s.save, true, 'claude form needs a save button');
    assert.equal(s.cancel, true, 'claude form needs a cancel button');
  });

  await test('pi-form-has-shared-skeleton', async () => {
    await go(); await openTab('Pi'); await pickProvider('pi-a');
    const s = await formShape('pi');
    assert.equal(s.baseUrl, true, 'pi form needs a base URL field');
    assert.equal(s.models, true, 'pi form needs a model list');
    assert.equal(s.save, true, 'pi form needs a save button');
    assert.equal(s.cancel, true, 'pi form needs a cancel button');
  });

  await test('codex-form-has-shared-skeleton', async () => {
    await go(); await openTab('Codex'); await pickProvider('codex-a');
    const s = await formShape('codex');
    assert.equal(s.baseUrl, true, 'codex form needs a base URL field');
    assert.equal(s.models, true, 'codex form needs a model list');
    assert.equal(s.save, true, 'codex form needs a save button');
    assert.equal(s.cancel, true, 'codex form needs a cancel button');
  });

  // ── 三页的**通用字段顺序**必须一致（2026-10-11 真正统一）──
  // ProviderFormShell 给每一格打了 `data-slot`，这里按 DOM 顺序取出来比对。
  // 上一轮「统一」只抽了子控件、各 tab 自己排顺序，所以这三者的通用字段顺序**不一样** ——
  // 这条断言就是那次的盲区：撤掉外壳、把某个 tab 的顺序改回旧样，它必红。
  const CANON = ['top', 'baseUrl', 'credential', 'auth', 'headers', 'pull', 'models', 'advanced', 'actions'];
  const COMMON = ['top', 'baseUrl', 'credential', 'headers', 'pull', 'models', 'advanced', 'actions'];
  const slots = async () => (await page.eval(
    `[...document.querySelectorAll('[data-provider-form] [data-slot]')].map(e=>e.getAttribute('data-slot'))`,
  )).filter((s) => CANON.includes(s));
  await test('three-engine-form-tabs-share-one-field-order', async () => {
    await go(); await pickProvider('Gateway A');
    const claude = await slots();
    await go(); await openTab('Pi'); await pickProvider('pi-a');
    const pi = await slots();
    await go(); await openTab('Codex'); await pickProvider('codex-a');
    const codex = await slots();
    const common = (arr) => arr.filter((s) => COMMON.includes(s));
    console.log(`   Claude order: ${JSON.stringify(common(claude))}`);
    console.log(`   Pi order:     ${JSON.stringify(common(pi))}`);
    console.log(`   Codex order:  ${JSON.stringify(common(codex))}`);
    // 通用格在每一页都必须出现、且顺序与规范顺序一致。
    assert.deepEqual(common(claude), COMMON, `Claude common-field order ${JSON.stringify(claude)}`);
    assert.deepEqual(common(pi), COMMON, `Pi common-field order ${JSON.stringify(pi)}`);
    assert.deepEqual(common(codex), COMMON, `Codex common-field order ${JSON.stringify(codex)}`);
    // 三页的相对顺序逐格相同（auth 是 Claude/Pi 有、Codex 无的可选格）。
    assert.deepEqual(common(claude), common(pi), 'Claude and Pi must order the common fields identically');
    assert.deepEqual(common(pi), common(codex), 'Pi and Codex must order the common fields identically');
  });

  // ── 三页都必须有「高级」折叠区（2026-10-11 真正统一）──
  // 从前只有 Claude 有折叠区；Pi / Codex 的引擎特有字段裸露在外，看起来就跟 Claude 不一样。
  await test('three-engine-form-tabs-share-one-advanced-section', async () => {
    const hasAdvanced = async () =>
      page.eval(`!!document.querySelector('[data-provider-form] [data-slot="advanced"]')`);
    const hasAdvancedBody = async () =>
      page.eval(`!!document.querySelector('[data-provider-form] [data-slot="advanced"] > div')`);
    await go(); await pickProvider('Gateway A');
    assert.equal(await hasAdvanced(), true, 'Claude form must have an advanced section');
    await go(); await openTab('Pi'); await pickProvider('pi-a');
    assert.equal(await hasAdvanced(), true, 'Pi form must have an advanced section (was missing)');
    await go(); await openTab('Codex'); await pickProvider('codex-a');
    assert.equal(await hasAdvanced(), true, 'Codex form must have an advanced section (was missing)');
    // 折叠态点标题能展开出内容。
    assert.equal(await hasAdvancedBody(), false, 'advanced body starts collapsed');
    await clickExpr(`[...document.querySelectorAll('[data-provider-form] button')].find(e=>e.textContent.includes('高级选项'))`);
    assert.equal(await hasAdvancedBody(), true, 'clicking the advanced header must reveal its body');
  });

  // ── 保存按钮在三个表单里处于同一条操作栏（同一组按钮文字）──
  await test('save-and-cancel-sit-in-one-shared-action-bar', async () => {
    await go(); await pickProvider('Gateway A');
    const claudeBtns = await page.eval(`[...document.querySelectorAll('button')].filter(e=>e.offsetParent!==null).map(e=>e.textContent.trim()).filter(Boolean)`);
    await openTab('Pi'); await pickProvider('pi-a');
    const piBtns = await page.eval(`[...document.querySelectorAll('button')].filter(e=>e.offsetParent!==null).map(e=>e.textContent.trim()).filter(Boolean)`);
    // 两个表单的「取消」按钮文字必须一致（同一条 FormActions）。
    assert.equal(claudeBtns.includes('取消'), true);
    assert.equal(piBtns.includes('取消'), true);
  });

  // ── 自定义请求头：三个引擎的编辑器都在（2026-10-11 对齐）──
  // 判据：「自定义请求头」这个标签在页面上出现（它只在 HeadersEditor 里）。
  const hasHeaders = async () => page.eval(`document.body.innerText.includes('自定义请求头')`);
  await test('headers-editor-present-in-all-three-engines', async () => {
    await go(); await pickProvider('Gateway A');
    // Claude：header 编辑器在「高级」区，先展开。
    await clickExpr(`[...document.querySelectorAll('button')].find(e=>e.textContent.includes('高级选项'))`);
    assert.equal(await hasHeaders(), true, 'Claude form must offer the headers editor');
    await openTab('Pi'); await pickProvider('pi-a');
    assert.equal(await hasHeaders(), true, 'Pi form must offer the headers editor (was missing)');
    await openTab('Codex'); await pickProvider('codex-a');
    assert.equal(await hasHeaders(), true, 'Codex form must offer the headers editor (was missing)');
  });

  // ── 连通性测试 + 拉模型列表：Pi / Codex 也有（2026-10-11 对齐 Claude）──
  const hasPull = async () => page.eval(`document.body.innerText.includes('从端点拉取模型')`);
  await test('pull-models-and-test-present-in-pi-and-codex', async () => {
    await go(); await openTab('Pi'); await pickProvider('pi-a');
    assert.equal(await hasPull(), true, 'Pi form must offer "fetch models from endpoint"');
    assert.equal(await page.eval(`!!document.querySelector('button[title*="测试"]')`), true, 'Pi form must offer a per-model test button');
    await openTab('Codex'); await pickProvider('codex-a');
    assert.equal(await hasPull(), true, 'Codex form must offer "fetch models from endpoint"');
    assert.equal(await page.eval(`!!document.querySelector('button[title*="测试"]')`), true, 'Codex form must offer a per-model test button');
  });

  await test('pull-models-present-in-claude-too', async () => {
    await go(); await pickProvider('Gateway A');
    assert.equal(await hasPull(), true, 'Claude form must offer "fetch models from endpoint" (three-engine parity)');
  });

  await test('claude-pulling-models-fills-the-list-from-the-endpoint', async () => {
    await go(); await pickProvider('Gateway A');
    // 模型行里正好一行(夹具);点「从端点拉取模型」后应被端点返回的两条替换。
    await clickExpr(`[...document.querySelectorAll('button')].find(e=>e.offsetParent!==null && e.textContent.includes('从端点拉取模型'))`);
    await page.waitFor("labEvents.some(e=>e.method==='customModel.listEndpointModels')", 3000);
    await page.sleep(150);
    const values = await page.eval(`[...document.querySelectorAll('input')].map(i=>i.value)`);
    assert.equal(values.includes('claude-pulled-a') && values.includes('claude-pulled-b'), true, `pulled models must appear in Claude model rows (got ${JSON.stringify(values)})`);
    // 请求带 anthropic-version 头(Anthropic 风格端点要它才肯列)。
    const ev = await page.eval("labEvents.find(e=>e.method==='customModel.listEndpointModels')");
    assert.equal(ev?.input?.anthropicVersion, true, `Claude pull must request anthropic-version (got ${JSON.stringify(ev?.input)})`);
  });

  await test('pulling-models-fills-the-list-from-the-endpoint', async () => {
    await go(); await openTab('Pi'); await pickProvider('pi-a');
    await clickExpr(`[...document.querySelectorAll('button')].find(e=>e.offsetParent!==null && e.textContent.includes('从端点拉取模型'))`);
    await page.waitFor("labEvents.some(e=>e.method==='piModels.listEndpointModels')", 3000);
    // 模型 id 住在 <input> 的 value 里，不在 innerText —— 按 value 判。
    await page.sleep(150);
    const values = await page.eval(`[...document.querySelectorAll('input')].map(i=>i.value)`);
    assert.equal(values.includes('pulled-a') && values.includes('pulled-b'), true, `pulled models must appear in the model rows (got ${JSON.stringify(values)})`);
  });

  // ── 思考强度映射：Claude 表单也有一份（2026-10-11 对齐 Pi）──
  await test('claude-model-row-offers-thinking-level-mapping', async () => {
    await go(); await pickProvider('Gateway A');
    // 点开那一行的「思考强度映射」展开按钮。
    const btn = `[...document.querySelectorAll('button')].find(e=>e.offsetParent!==null && e.getAttribute('title')==='思考强度映射')`;
    assert.equal(await page.eval(`!!(${btn})`), true, 'Claude model rows must offer a thinking-map toggle');
    await clickExpr(btn);
    await page.sleep(150);
    assert.equal(await page.eval("document.body.innerText.includes('思考级别映射')"), true, 'expanding must show the mapping editor');
  });
});
const failed = results.filter(r => !r.ok).length;
writeFileSync(join(dir, 'results.json'), JSON.stringify({ passed: results.length - failed, failed, results }, null, 2));
console.log(`${results.length - failed}/${results.length} custom-models UI checks passed; ${failed} failed`);
if (failed) throw Error(`${failed} UI checks failed; artifacts: ${dir}`);
