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
});
const failed = results.filter(r => !r.ok).length;
writeFileSync(join(dir, 'results.json'), JSON.stringify({ passed: results.length - failed, failed, results }, null, 2));
console.log(`${results.length - failed}/${results.length} skills-management UI checks passed; ${failed} failed`);
if (failed) throw Error(`${failed} UI checks failed; artifacts: ${dir}`);
