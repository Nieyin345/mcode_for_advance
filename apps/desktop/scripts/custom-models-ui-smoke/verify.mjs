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
});
const failed = results.filter(r => !r.ok).length;
writeFileSync(join(dir, 'results.json'), JSON.stringify({ passed: results.length - failed, failed, results }, null, 2));
console.log(`${results.length - failed}/${results.length} custom-models UI checks passed; ${failed} failed`);
if (failed) throw Error(`${failed} UI checks failed; artifacts: ${dir}`);
