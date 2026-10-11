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
  const rowCheck = name => `document.querySelector('[data-mcp-check="${name}"]')`;
  const test = async (name, run) => {
    try { await run(); assert.deepEqual(page.exceptions, []); check(name, true); }
    catch (e) { check(name, false, String(e)); }
    await page.screenshot(name + '.png');
  };
  // mocks.js 每次导航都重跑（末尾自调 labReset），逐条测试各拿干净夹具。
  const go = async () => {
    await page.goto('', 'window.__ready && document.querySelector("[role=tablist]")');
    await page.waitFor("!!document.querySelector('[data-mcp-check=alpha-mcp]')");
  };

  await test('only-user-level-rows-are-selectable', async () => {
    // 插件带来的、内置的都不该能勾 —— 它们不归这一页管（同技能页/插件页的规矩）。
    await go();
    assert.equal(await page.eval(`!!(${rowCheck('alpha-mcp')})`), true, 'a user-level server is selectable');
    assert.equal(await page.eval(`!!(${rowCheck('plug-mcp')})`), false, 'a plugin-provided server must not be selectable here');
    assert.equal(await page.eval(`!!(${rowCheck('builtin-mcp')})`), false, 'the built-in server must not be selectable');
    assert.equal(await page.eval("!!document.querySelector('[data-testid=mcp-bulk-bar]')"), false, 'no bulk bar before anything is checked');
  });

  await test('checking-user-rows-reveals-the-bulk-bar', async () => {
    await go();
    await clickExpr(rowCheck('alpha-mcp'));
    await clickExpr(rowCheck('beta-mcp'));
    await page.waitFor("!!document.querySelector('[data-testid=mcp-bulk-bar]')", 3000);
    assert.match(await page.eval("document.querySelector('[data-testid=mcp-bulk-bar]').innerText"), /2/, 'bar reports the checked count');
  });

  await test('bulk-disable-writes-every-checked-user-server', async () => {
    await go();
    await clickExpr(rowCheck('alpha-mcp'));
    await clickExpr(rowCheck('beta-mcp'));
    await clickExpr(button('停用选中的'));
    await page.waitFor("labEvents.filter(e=>e.method==='toggle').length>=2", 3000);
    const calls = await page.eval("labEvents.filter(e=>e.method==='toggle')");
    assert.deepEqual(calls.map(c => c.input.name).sort(), ['alpha-mcp', 'beta-mcp'], 'one toggle per checked server');
    assert.equal(calls.every(c => c.input.enabled === false), true, 'all writes turn the server off');
  });

  await test('bulk-delete-confirms-then-removes-and-reports-partial-failure', async () => {
    await go();
    await clickExpr(rowCheck('alpha-mcp'));
    await clickExpr(rowCheck('beta-mcp'));
    await clickExpr(button('删除选中的'));
    await page.waitFor("document.querySelector('[role=dialog]')", 3000);
    assert.match(await page.eval("document.querySelector('[role=dialog]').innerText"), /删除/);
    await clickExpr(`[...document.querySelectorAll('[role=dialog] button')].find(e=>['删除','Delete'].includes(e.textContent.trim()))`);
    await page.waitFor("labEvents.filter(e=>e.method==='remove').length>=2", 3000);
    const calls = await page.eval("labEvents.filter(e=>e.method==='remove')");
    assert.deepEqual(calls.map(c => c.input.name).sort(), ['alpha-mcp', 'beta-mcp']);
    // 夹具让 beta-mcp 的删除失败 —— 必须如实报出来。（MCP 页的错误横幅是个普通
    // div，没有 role=alert，所以按文字找，不按角色找。）
    assert.equal(await page.eval("document.body.innerText.includes('remove fixture denied')"), true,
      'the failed delete must surface, not vanish');
    assert.equal(await page.eval(`!!(${rowCheck('alpha-mcp')})`), false, 'the deleted server is gone from the list');
    assert.equal(await page.eval(`!!(${rowCheck('beta-mcp')})`), true, 'the server whose delete failed stays on the list');
  });

  await test('checking-does-not-toggle-the-server', async () => {
    await go();
    await clickExpr(rowCheck('alpha-mcp'));
    await page.sleep(120);
    assert.equal(await page.eval("labEvents.filter(e=>e.method==='toggle').length"), 0, 'ticking a checkbox must not toggle the server');
  });

  // MSP1:用户级 server 存在 ~/.mcode/.claude.json 的 mcpServers 里,但这格由 Mcode
  // **整体重写**(派生视图)。绕过本页直接手改文件会被静默覆盖 —— 面板必须如实告知,
  // 而且要**露出来**(不是藏在 ⓘ 里),否则就是对用户不可见的脚枪。
  await test('user-section-discloses-the-managed-claude-json-file', async () => {
    await go();
    const text = await page.eval("document.body.innerText");
    assert.match(text, /由 Mcode 整体管理/, 'the panel must say Mcode owns the mcpServers object');
    assert.match(text, /手改/, 'and warn that hand-editing the file is overwritten');
    // 必须是**可见**的文字,不是收在 InfoHint 气泡里(气泡要悬停/点击才出现)。
    assert.equal(
      await page.eval("!!document.querySelector('[role=tooltip]')"),
      false,
      'the managed-file notice must be visible without opening a tooltip',
    );
  });
});
const failed = results.filter(r => !r.ok).length;
writeFileSync(join(dir, 'results.json'), JSON.stringify({ passed: results.length - failed, failed, results }, null, 2));
console.log(`${results.length - failed}/${results.length} MCP UI checks passed; ${failed} failed`);
if (failed) throw Error(`${failed} UI checks failed; artifacts: ${dir}`);
