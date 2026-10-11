import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withAuditPage } from './browser.mjs';
const dir = dirname(fileURLToPath(import.meta.url)), results = [];
await withAuditPage(dir, async page => {
  const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); };
  const clickExpr = async expr => { await page.eval(`(()=>{const e=${expr};if(!e)throw Error('Missing control: '+${JSON.stringify(expr)});e.click();})()`); await page.sleep(130); };
  const button = text => `[...document.querySelectorAll('button')].find(e=>e.offsetParent!==null && e.textContent.trim()===${JSON.stringify(text)})`;
  const rowCheck = name => `document.querySelector('[data-plugin-check="${name}"]')`;
  const test = async (name, run) => {
    try { await run(); assert.deepEqual(page.exceptions, []); check(name, true); }
    catch (e) { check(name, false, String(e)); }
    await page.screenshot(name + '.png');
  };

  // 每一轮都重挂一次面板：`mocks.js` 每次导航都重新执行（末尾自调 `labReset()`），
  // 所以逐条测试各拿到一份干净夹具，互不污染。
  const go = async () => {
    await page.goto('', 'window.__ready && document.querySelector("[role=tablist]")');
    await page.waitFor("!!document.querySelector('[data-plugin-check=alpha]')");
  };

  await test('every-installed-row-has-a-checkbox', async () => {
    await go();
    assert.equal(await page.eval(`!!(${rowCheck('alpha')})`), true, 'alpha row must be selectable');
    assert.equal(await page.eval(`!!(${rowCheck('beta')})`), true, 'beta row must be selectable');
    // 勾选条在没勾之前不该出现。
    assert.equal(await page.eval("!!document.querySelector('[data-testid=plugins-bulk-bar]')"), false, 'no bulk bar before anything is checked');
  });

  await test('checking-rows-reveals-the-bulk-bar-with-a-count', async () => {
    await go();
    await clickExpr(rowCheck('alpha'));
    await clickExpr(rowCheck('beta'));
    await page.waitFor("!!document.querySelector('[data-testid=plugins-bulk-bar]')", 3000);
    assert.match(await page.eval("document.querySelector('[data-testid=plugins-bulk-bar]').innerText"), /2/, 'bar reports the checked count');
  });

  await test('bulk-disable-writes-every-checked-plugin', async () => {
    // 用户原话：「每个集合没有批量管理，批量选择」。插件页此前完全没有勾选。
    await go();
    await clickExpr(rowCheck('alpha'));
    await clickExpr(rowCheck('beta'));
    await clickExpr(button('停用选中的'));
    await page.waitFor("labEvents.filter(e=>e.method==='setEnabled').length>=2", 3000);
    const calls = await page.eval("labEvents.filter(e=>e.method==='setEnabled')");
    assert.deepEqual(calls.map(c => c.input.name).sort(), ['alpha', 'beta'], 'one setEnabled per checked plugin');
    assert.equal(calls.every(c => c.input.enabled === false), true, 'all writes turn the plugin off');
  });

  await test('bulk-delete-confirms-then-removes-and-reports-partial-failure', async () => {
    await go();
    await clickExpr(rowCheck('alpha'));
    await clickExpr(rowCheck('beta'));
    await clickExpr(button('卸载选中的'));
    // 危险动作必须先确认。
    await page.waitFor("document.querySelector('[role=dialog]')", 3000);
    assert.match(await page.eval("document.querySelector('[role=dialog]').innerText"), /卸载/);
    await clickExpr(`[...document.querySelectorAll('[role=dialog] button')].find(e=>['删除','Delete'].includes(e.textContent.trim()))`);
    await page.waitFor("labEvents.filter(e=>e.method==='remove').length>=2", 3000);
    const calls = await page.eval("labEvents.filter(e=>e.method==='remove')");
    assert.deepEqual(calls.map(c => c.input.name).sort(), ['alpha', 'beta']);
    // 夹具让 beta 的卸载失败 —— 必须如实报出来，不能静默吞掉。
    assert.equal(await page.eval("[...document.querySelectorAll('[role=alert]')].some(e=>e.offsetParent!==null&&e.textContent.includes('remove fixture denied'))"), true,
      'the failed uninstall must surface, not vanish');
    // 成功的那条从列表消失，失败的那条还在。
    assert.equal(await page.eval(`!!(${rowCheck('alpha')})`), false, 'the removed plugin is gone from the list');
    assert.equal(await page.eval(`!!(${rowCheck('beta')})`), true, 'the plugin whose removal failed stays on the list');
  });

  await test('checking-alone-does-not-toggle-or-expand', async () => {
    // 点勾选框不该顺带展开详情/开关插件 —— 两件事。
    await go();
    // 展开状态看行上那个展开按钮的 aria-expanded（按插件名精确定位），不看行数
    // —— 详情是行内嵌套的，行数根本不变，那正是第一版断言没鉴别力的原因。
    const expandedOf = name => `[...document.querySelectorAll('[aria-expanded]')].find(e=>e.textContent.includes(${JSON.stringify(name)}))`;
    assert.equal(await page.eval(`${expandedOf('alpha')}.getAttribute('aria-expanded')`), 'false', 'rows start collapsed');
    await clickExpr(rowCheck('alpha'));
    await page.sleep(120);
    assert.equal(await page.eval("labEvents.filter(e=>e.method==='setEnabled').length"), 0, 'ticking a checkbox must not mutate the plugin');
    assert.equal(await page.eval(`${expandedOf('alpha')}.getAttribute('aria-expanded')`), 'false', 'ticking a checkbox must not expand the row');
  });

  // ── MSP4:带 hooks 的插件不能被当成「装了挂钩就生效」 ──
  // 用户易以为「装了插件 = hooks 生效」,所以(a)启用带 hooks 的插件要给一个**明说
  // 不会执行**的确认框(标题不再是含糊的「包含 hooks」),(b)安装审查卡顶部要固定
  // 显示这条,不能只埋在可滚动的组件清单里。
  await test('enabling-a-hook-plugin-warns-that-its-hooks-will-not-run', async () => {
    await go();
    // delta 默认禁用;点它的启用开关应触发确认框,而不是直接启用。
    await clickExpr(`[...document.querySelectorAll('[role=switch]')].find(e=>(e.getAttribute('aria-label')||'').includes('delta'))`);
    await page.waitFor("document.querySelector('[role=dialog]')", 3000);
    const dialogText = await page.eval("document.querySelector('[role=dialog]').innerText");
    assert.match(dialogText, /不会执行/, 'the confirm dialog must state the hooks will NOT run, not just that hooks exist');
    // 确认前不该已经写下去。
    assert.equal(await page.eval("labEvents.filter(e=>e.method==='setEnabled'&&e.input.name==='delta').length"), 0,
      'the warn dialog gates the enable — nothing written before confirming');
  });

  await test('the-install-review-card-shows-a-fixed-hooks-not-executed-banner', async () => {
    await go();
    // 走「安装 ▾ → 本地目录」,夹具让这次安装带回一个带 hooks 的插件。
    await clickExpr(button('安装'));
    await page.waitFor("!!document.querySelector('[role=menuitem]')", 3000);
    await clickExpr(`[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent.trim()==='本地目录')`);
    await page.waitFor("document.querySelector('[data-testid=plugins-review-hooks-banner]')", 3000);
    const banner = await page.eval("document.querySelector('[data-testid=plugins-review-hooks-banner]').innerText");
    assert.match(banner, /不执行/, 'the review card must state the declared hooks will not execute');
    // 这条在可滚动清单**之外**,所以它不会随滚动滑走(定位在滚动容器之前)。
    const outside = await page.eval("!document.querySelector('[data-testid=plugins-review-hooks-banner]').closest('.overflow-y-auto')");
    assert.equal(outside, true, 'the banner sits outside the scrollable body so it cannot be scrolled away');
  });
});
const failed = results.filter(r => !r.ok).length;
writeFileSync(join(dir, 'results.json'), JSON.stringify({ passed: results.length - failed, failed, results }, null, 2));
console.log(`${results.length - failed}/${results.length} plugins UI checks passed; ${failed} failed`);
if (failed) throw Error(`${failed} UI checks failed; artifacts: ${dir}`);
