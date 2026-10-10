import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withAuditPage } from './browser.mjs';
const dir = dirname(fileURLToPath(import.meta.url)), results = [];
await withAuditPage(dir, async page => {
  const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); };
  const go = async (query = '') => { await page.goto(query); await page.waitFor("[...document.querySelectorAll('button')].some(e=>e.textContent.includes('alpha'))"); };
  const button = text => `[...document.querySelectorAll('button')].find(e=>e.offsetParent!==null && e.textContent.trim()===${JSON.stringify(text)})`;
  const clickExpr = async expr => { await page.eval(`(()=>{const e=${expr};if(!e)throw Error('Missing control: '+${JSON.stringify(expr)});e.click();})()`); await page.sleep(110); };
  const click = async selector => {
    const point = await page.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, ...point, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) });
    await page.sleep(150);
  };
  const key = async (key, code, vk) => { for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk }); await page.sleep(100); };
  const input = async value => { await page.eval(`(()=>{const e=document.querySelector('[data-testid=skill-source-input]')??document.querySelector('textarea');if(!e)throw Error('No editor');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`); await page.sleep(100); };
  const openSkill = async name => { await clickExpr(`[...document.querySelectorAll('button')].find(e=>e.offsetParent!==null && e.querySelector('span')?.textContent===${JSON.stringify(name)})`); await page.sleep(100); };
  // Find the existing row by its actual displayed name, not a newly added test
  // marker: a red result therefore proves the missing action, not just a marker.
  const row = name => `[...document.querySelectorAll('button')].find(e=>e.offsetParent!==null && [...e.querySelectorAll('span')].some(s=>s.textContent===${JSON.stringify(name)}))?.parentElement`;
  const deleteRow = name => `(${row(name)})?.querySelector('button[title="删除此 skill"],button[title="Delete this skill"],button[data-testid="skill-row-delete"]')`;
  const confirm = async () => { await page.waitFor("document.querySelector('[role=dialog]')"); await clickExpr(`[...document.querySelectorAll('[role=dialog] button')].find(e=>['删除','Delete'].includes(e.textContent.trim()))`); await page.sleep(150); };
  const projectTab = async () => { await clickExpr(`document.querySelectorAll('[role=tab]')[1]`); await page.sleep(180); };
  const chooseProject = async id => {
    await click('[data-testid=skill-project-select]');
    await page.waitFor(`document.querySelector('[data-project-option="${id}"]')`, 3000);
    await click(`[data-project-option="${id}"]`);
    await page.sleep(180);
  };
  const test = async (name, run) => {
    try { await run(); assert.deepEqual(page.exceptions, []); check(name, true); }
    catch (e) { check(name, false, String(e)); }
    await page.screenshot(name + '.png');
  };

  await test('direct-row-delete-without-reading', async () => {
    await go();
    assert.equal(await page.eval(`!!(${deleteRow('alpha')})`), true, 'Skill row must have its own delete action before the source editor is opened');
    assert.equal(await page.eval(`getComputedStyle(${deleteRow('alpha')}).opacity`), '1', 'delete action stays discoverable without hover');
    await clickExpr(deleteRow('alpha'));
    assert.equal(await page.eval("labEvents.filter(e=>e.method==='read').length"), 0);
    assert.match(await page.eval("document.querySelector('[role=dialog]').innerText"), /alpha/);
    await clickExpr(`[...document.querySelectorAll('[role=dialog] button')].find(e=>e.textContent.trim()==='取消')`);
    assert.equal(await page.eval("labEvents.filter(e=>e.method==='delete').length"), 0);
    await clickExpr(deleteRow('alpha')); await confirm();
    assert.deepEqual(await page.eval("labEvents.filter(e=>e.method==='delete').map(e=>e.input)"), [{ source: 'global', name: 'alpha' }]);
    assert.equal(await page.eval("'alpha' in labContents.global"), false);
    assert.equal(await page.eval("'beta' in labContents.global"), true);
    assert.equal(await page.eval("labEvents.filter(e=>e.method==='read').length"), 0);
    assert.equal(await page.eval("document.querySelector('input[aria-label=alpha]')!==null"), false);
  });
  await test('delete-failure-visible-without-editor', async () => {
    await go(); await clickExpr(deleteRow('delete-error')); await confirm();
    assert.equal(await page.eval("[...document.querySelectorAll('[role=alert]')].some(e=>e.offsetParent!==null&&e.textContent.includes('delete fixture denied'))"), true);
    assert.equal(await page.eval("'delete-error' in labContents.global"), true);
  });
  await test('group-delete-and-readonly-guards-retained', async () => {
    await go();
    assert.equal(await page.eval(`!!(${deleteRow('plugin-skill')})`), false);
    await click('button[title="删除整组技能"]');
    assert.match(await page.eval("document.querySelector('[role=dialog]').innerText"), /Example Kit/);
    // Cancel is deliberately used: the one-skill test above must not be
    // implemented by repurposing a group deletion action.
    await clickExpr(`[...document.querySelectorAll('[role=dialog] button')].find(e=>e.textContent.trim()==='取消')`);
    assert.equal(await page.eval("labEvents.filter(e=>e.method==='delete').length"), 0);
  });
  await test('global-library-not-shadowed-by-current-project', async () => {
    await go();
    assert.equal(await page.eval("!!document.querySelector('input[aria-label=shared]')"), true, 'global same-name skill must remain selectable for copying');
    await openSkill('shared');
    assert.equal(await page.eval("document.querySelector('textarea').value"), 'GLOBAL SHARED');
  });
  await test('read-failure-is-not-an-editable-empty-source', async () => {
    await go(); await openSkill('read-error');
    assert.equal(await page.eval("[...document.querySelectorAll('[role=alert]')].some(e=>e.textContent.includes('read fixture unavailable'))"), true);
    assert.equal(await page.eval(`(${button('保存')})?.disabled`), true, 'failed read cannot be saved back as an empty document');
    assert.equal(await page.eval("!document.querySelector('textarea') || document.querySelector('textarea').disabled || document.querySelector('textarea').readOnly"), true);
    assert.equal(await page.eval(`!!(${button('重试')})`), true);
    await page.eval('labReadsFail=false'); await clickExpr(button('重试'));
    await page.waitFor("document.querySelector('textarea')?.value==='UNREADABLE'", 3000);
  });
  await test('genuinely-empty-source-has-an-explanation', async () => {
    await go(); await openSkill('empty-source');
    assert.equal(await page.eval("document.querySelector('textarea').value"), '');
    assert.equal(await page.eval("[...document.querySelectorAll('[role=status]')].some(e=>e.textContent.includes('SKILL.md')&&e.textContent.includes('空'))"), true);
  });
  await test('late-read-cannot-overwrite-new-selection', async () => {
    await go(); await page.eval("labHoldRead.add('slow')"); await openSkill('slow'); await openSkill('fast');
    assert.equal(await page.eval("document.querySelector('textarea').value"), 'FAST CONTENT');
    await page.eval('labReadHolds.splice(0).forEach(resolve=>resolve())'); await page.sleep(150);
    assert.equal(await page.eval("document.querySelector('textarea').value"), 'FAST CONTENT');
    await input('FAST EDITED'); await clickExpr(button('保存'));
    assert.equal(await page.eval('labContents.global.fast'), 'FAST EDITED');
    assert.equal(await page.eval('labContents.global.slow'), 'SLOW CONTENT');
  });
  await test('project-dropdown-copy-and-delete-use-selected-project', async () => {
    await go(); await click('input[aria-label=alpha]'); await projectTab();
    assert.equal(await page.eval("!!document.querySelector('[role=combobox]')"), true, 'project tab must offer a project dropdown');
    await chooseProject('B');
    assert.equal(await page.eval('labState.activeProjectId'), 'A');
    assert.match(await page.eval("document.querySelector('[data-testid=project-skills-view]').innerText"), /\/workspace\/B/);
    assert.equal(await page.eval("!!document.querySelector('[data-project-skill=" + '"b-only"' + "]')"), true);
    assert.equal(await page.eval("!!document.querySelector('[data-project-skill=" + '"a-only"' + "]')"), false);
    await clickExpr(button('复制选中的 1 个'));
    await page.waitFor("labContents['/workspace/B'].alpha==='GLOBAL ALPHA'", 3000);
    assert.equal(await page.eval("'alpha' in labContents['/workspace/A']"), false);
    await click('[data-project-skill="b-only"] button[title="从项目移除"]'); await confirm();
    assert.deepEqual(await page.eval("labEvents.filter(e=>e.method==='delete').at(-1).input"), { source: 'project', projectPath: '/workspace/B', name: 'b-only' });
    assert.equal(await page.eval("'a-only' in labContents['/workspace/A']"), true);
  });
  await test('checked-rows-bulk-toggle-engines', async () => {
    // 用户原话：「每个集合没有批量管理，批量选择」。勾选以前只服务「复制到项目」，
    // 这条钉住它现在也能**一次给多条切同一个引擎**。
    await go();
    await click('input[aria-label=alpha]');
    await click('input[aria-label=beta]');
    await page.waitFor("!!document.querySelector('[data-testid=skills-bulk-bar]')", 3000);
    await page.eval(`document.querySelector('[data-bulk-engine=codex]').click()`);
    await page.sleep(150);
    const bulk = await page.eval("labEvents.filter(e=>e.method==='enginesSetBulk')");
    assert.equal(bulk.length, 1, 'one bulk write for the checked pair');
    assert.deepEqual(bulk[0].input.names.slice().sort(), ['alpha', 'beta']);
    assert.equal(bulk[0].input.codex, false, 'codex turned off for both');
    assert.equal(bulk[0].input.claude, true, 'the other engines keep their current value');
    assert.equal(bulk[0].input.pi, true);
  });
  await test('checked-rows-bulk-delete-with-confirm', async () => {
    await go();
    await click('input[aria-label=alpha]');
    await click('input[aria-label=beta]');
    await page.waitFor("!!document.querySelector('[data-testid=skills-bulk-bar]')", 3000);
    await page.eval(`document.querySelector('[data-testid=skills-bulk-delete]').click()`);
    await page.waitFor("document.querySelector('[role=dialog]')", 3000);
    await clickExpr(`[...document.querySelectorAll('[role=dialog] button')].find(e=>e.textContent.trim()==='删除')`);
    await page.sleep(200);
    assert.deepEqual(await page.eval("labEvents.filter(e=>e.method==='delete').map(e=>e.input.name).sort()"), ['alpha', 'beta']);
    assert.equal(await page.eval("'alpha' in labContents.global"), false);
    assert.equal(await page.eval("'beta' in labContents.global"), false);
    assert.equal(await page.eval("'shared' in labContents.global"), true, 'unchecked skills are untouched');
    assert.equal(await page.eval("!!document.querySelector('[data-testid=skills-bulk-bar]')"), false, 'bar disappears once the checked rows are gone');
  });
  await test('row-shows-engine-switches-without-opening-editor', async () => {
    // 用户报的原话：「不能单独控制一个 skill 的引擎权限」。它以前只在右侧编辑区
    // （要先选中一条才看得到），列表行上完全不可见。这条钉住"行上就有、且点了真
    // 会写" —— 判据落在看得见的按钮和真实的 API 调用上，不落在源码写了什么。
    await go();
    const rowHasSwitches = `!!document.querySelector('[data-testid=skill-row-engines]')`;
    assert.equal(await page.eval(rowHasSwitches), true, 'a global library row must expose its engine switches inline');
    // 不用先点开编辑器 —— 这一点本身就是需求。
    assert.equal(await page.eval("!!document.querySelector('textarea')"), false, 'switches must be reachable without opening the source editor');
    // 点这一行的 Codex 开关 → 必须真的发出一条 enginesSet，且 codex 翻成 false。
    // 按 aria-label 里的技能名精确定位到 alpha 那一行（列表里还有 plugin-skill 等）。
    await page.eval(`(()=>{const b=[...document.querySelectorAll('[data-testid=skill-row-engines] button')].find(e=>e.getAttribute('aria-label')==='Codex · alpha');if(!b)throw Error('no codex switch on alpha row');b.click();})()`);
    await page.sleep(150);
    const calls = await page.eval("labEvents.filter(e=>e.method==='enginesSet')");
    assert.equal(calls.length, 1, 'toggling a row switch writes exactly one enginesSet');
    assert.deepEqual(calls[0].input, { name: 'alpha', claude: true, codex: false, pi: true });
  });
  await test('copy-keeps-selection-for-the-next-project', async () => {
    // 用户报的原话：把同一批 skill 复制到不同项目要勾两次。
    // 勾选是「复制到项目」的源；复制成功后**不该**清空 —— 否则切到下一个项目
    // 时源已经没了，用户得从头再勾一遍。
    await go();
    await click('input[aria-label=alpha]');
    await click('input[aria-label=beta]');
    await projectTab();
    assert.equal(await page.eval(`!!(${button('复制选中的 2 个')})`), true, 'two skills must be checked before copying');
    await clickExpr(button('复制选中的 2 个'));
    await page.waitFor("labContents['/workspace/A'].alpha==='GLOBAL ALPHA'", 3000);
    assert.equal(await page.eval("labContents['/workspace/A'].beta==='GLOBAL BETA'"), true, 'both skills copied into project A');
    // 切到项目 B —— 勾选必须还在，按钮仍报「2 个」。
    await chooseProject('B');
    assert.equal(await page.eval(`!!(${button('复制选中的 2 个')})`), true,
      'selection must survive the copy so the same batch can go to another project');
    await clickExpr(button('复制选中的 2 个'));
    await page.waitFor("labContents['/workspace/B'].alpha==='GLOBAL ALPHA'", 3000);
    assert.equal(await page.eval("labContents['/workspace/B'].beta==='GLOBAL BETA'"), true, 'the same batch copied into project B without re-checking');
  });
  await test('project-editor-keeps-selected-project-identity', async () => {
    await go(); await projectTab(); await chooseProject('B');
    await click('[data-project-skill="shared"] [data-testid=project-skill-edit]');
    await page.waitFor("document.querySelector('[role=dialog] textarea')?.value==='PROJECT B SHARED'", 3000);
    await input('EDITED B'); await clickExpr(button('保存'));
    assert.equal(await page.eval("labContents['/workspace/B'].shared"), 'EDITED B');
    assert.equal(await page.eval("labContents['/workspace/A'].shared"), 'PROJECT A SHARED');
    assert.equal(await page.eval("labContents.global.shared"), 'GLOBAL SHARED');
  });
  await test('project-switch-drops-old-list-and-late-replies', async () => {
    await go(); await projectTab(); await page.eval("labHoldProjects.add('/workspace/B')"); await chooseProject('B');
    assert.equal(await page.eval("document.querySelector('[data-project-skill=" + '"a-only"' + "]')!==null"), false, 'no A rows actionable while B loads');
    await chooseProject('A');
    await page.waitFor("document.querySelector('[data-project-skill=" + '"a-only"' + "]')", 3000);
    await page.eval('labProjectHolds.splice(0).forEach(resolve=>resolve())'); await page.sleep(150);
    assert.equal(await page.eval("document.querySelector('[data-project-skill=" + '"b-only"' + "]')!==null"), false);
    assert.match(await page.eval("document.querySelector('[data-testid=skill-project-select]').textContent"), /Project A/);
  });
  await test('project-target-locked-during-copy', async () => {
    await go(); await click('input[aria-label=alpha]'); await projectTab(); await chooseProject('B');
    await page.eval('labCopyHold=true'); await clickExpr(button('复制选中的 1 个'));
    assert.equal(await page.eval("document.querySelector('[data-testid=skill-project-select]').disabled"), true);
    await page.eval('labCopyResolve()'); await page.sleep(180);
    assert.equal(await page.eval("document.querySelector('[data-testid=skill-project-select]').disabled"), false);
    assert.equal(await page.eval('labState.activeProjectId'), 'A');
  });
  await test('list-error-visible-and-retryable', async () => {
    await go(); await page.eval('labListFailure=true');
    // Re-mount without touching the fixture or real session.
    await page.eval('window.labRemount()'); await page.sleep(200);
    assert.equal(await page.eval("[...document.querySelectorAll('[role=alert]')].some(e=>e.textContent.includes('list fixture unavailable'))"), true);
    await page.eval('labListFailure=false'); await clickExpr(button('重试')); await page.sleep(180);
    assert.equal(await page.eval("!!document.querySelector('input[aria-label=alpha]')"), true);
  });
  await test('group-delete-reports-partial-failure-and-preserves-plugin', async () => {
    await go(); await click('button[title="删除整组技能"]'); await confirm();
    assert.deepEqual(await page.eval('Object.keys(labContents.global)'), ['delete-error']);
    assert.equal(await page.eval("'plugin-skill' in labContents.plugin"), true);
    assert.equal(await page.eval("[...document.querySelectorAll('[role=alert]')].some(e=>e.offsetParent!==null&&e.textContent.includes('delete fixture denied'))"), true);
  });
  await test('node-overview-retains-active-project-only-skills', async () => {
    await go(); await projectTab(); await chooseProject('B');
    await clickExpr(`document.querySelectorAll('[role=tab]')[2]`);
    await page.sleep(180);
    assert.match(await page.eval('document.body.innerText'), /Project A profile/, 'splitting the global list must not drop active-project-only node references');
    assert.equal(await page.eval('labState.activeProjectId'), 'A');
  });
  await test('duplicate-project-names-are-disambiguated-by-path', async () => {
    await go(); await page.eval("labPatchState({projects:labState.projects.map(p=>({...p,name:'Same project'}))})"); await projectTab();
    await click('[data-testid=skill-project-select]');
    assert.match(await page.eval("document.querySelector('[data-project-option=A]').textContent"), /\/workspace\/A/);
    assert.match(await page.eval("document.querySelector('[data-project-option=B]').textContent"), /\/workspace\/B/);
    await click('[data-project-option=B]');
    assert.match(await page.eval("document.querySelector('[data-testid=project-skills-view]').textContent"), /\/workspace\/B/);
  });
  await test('no-project-does-not-disable-global-management', async () => {
    await go(); await page.eval("labPatchState({projects:[],activeProjectId:null})"); await projectTab();
    assert.match(await page.eval('document.body.innerText'), /还没有项目/);
    await clickExpr(`document.querySelectorAll('[role=tab]')[0]`);
    assert.equal(await page.eval(`!!(${deleteRow('alpha')})`), true);
  });
  await test('english-and-keyboard-project-selection', async () => {
    await go('locale=en'); await projectTab();
    assert.equal(await page.eval("/settings\\.skills\\./.test(document.body.innerText)"), false);
    await page.eval("document.querySelector('[data-testid=skill-project-select]').focus()");
    await key('ArrowDown', 'ArrowDown', 40);
    await page.waitFor("document.querySelector('[role=option]')", 3000);
    await key('End', 'End', 35); await key('Enter', 'Enter', 13);
    await page.waitFor("document.querySelector('[data-testid=skill-project-select]').textContent.includes('Project B')", 3000);
    assert.equal(await page.eval('labState.activeProjectId'), 'A');
  });
  // The GitHub-import field is a text box (users paste "owner/repo"). Pressing
  // Enter to confirm a pinyin candidate must not fire the import; only a real
  // Enter does. The sibling text inputs in this repo carry the same guard.
  await test('github-import-enter-respects-ime', async () => {
    await go();
    await clickExpr(`[...document.querySelectorAll('button')].find(e=>e.offsetParent!==null && e.textContent.trim()==='导入 Skill')`);
    await page.waitFor("document.querySelector('[role=dialog] input[placeholder*=github]')");
    await page.eval(`(()=>{const e=document.querySelector('[role=dialog] input[placeholder*=github]');e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'owner/repo');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await page.sleep(80);
    // Composing (Chinese IME confirming a candidate): must NOT import.
    await page.eval(`document.querySelector('[role=dialog] input[placeholder*=github]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}))`);
    await page.sleep(120);
    assert.equal(await page.eval("labEvents.filter(e=>e.method==='importGithub').length"), 0, 'composing Enter must not trigger the GitHub import');
    // A genuine Enter imports exactly once.
    await page.eval(`document.querySelector('[role=dialog] input[placeholder*=github]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
    await page.sleep(120);
    assert.deepEqual(await page.eval("labEvents.filter(e=>e.method==='importGithub').map(e=>e.input)"), [{ url: 'owner/repo' }], 'plain Enter imports once with the typed url');
  });
});
const failed = results.filter(r => !r.ok).length;
writeFileSync(join(dir, 'results.json'), JSON.stringify({ passed: results.length - failed, failed, results }, null, 2));
console.log(`${results.length - failed}/${results.length} skills-management UI checks passed; ${failed} failed`);
if (failed) throw Error(`${failed} UI checks failed; artifacts: ${dir}`);
