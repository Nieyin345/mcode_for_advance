// MAINT-2026-09 / M25 assertions. Each check states the CORRECT behavior:
// before the fixes the targeted ones are RED (that is the red-light run),
// after the minimal fixes all must be green.
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {withAuditPage,sleep} from './browser.mjs';

const dir=dirname(fileURLToPath(import.meta.url));
let failures=0,total=0;
const check=(name,cond,detail)=>{total++;if(cond)console.log('  ok   '+name);else{failures++;console.log('  FAIL '+name+(detail===undefined?'':' — '+JSON.stringify(detail)));}};

await withAuditPage(dir,async(page)=>{
  const READY='window.__ready===true';
  await page.goto('',READY);

  /* ───────────── A. RuntimesPanel:错误可见性 + 可访问性 ───────────── */
  await page.waitFor(`[...document.querySelectorAll('#root span')].some(s=>s.textContent==='Codex')`);
  check('A1 三个内核行渲染(Claude 已装,Codex/Pi 未装)',
    await page.eval(`['Claude','Codex','Pi'].every(n=>[...document.querySelectorAll('#root span')].some(s=>s.textContent===n))`));

  // helper: the RuntimeRow container for one agent label
  const rowExpr=(name)=>`[...document.querySelectorAll('#root span')].find(s=>s.textContent==='${name}').closest('.px-4')`;

  // A2 accessibility: the expand toggle must expose its state
  const ariaCount=await page.eval(`[...document.querySelectorAll('#root button[aria-expanded]')].length`);
  check('A2 内核行展开开关暴露 aria-expanded(每行至少 1 个)',ariaCount>=3,{ariaCount});

  // A3 IPC rejection on install: error must be user-visible, no unhandled rejection
  await page.eval(`window.labUnhandled.length=0;window.labMode.install='reject';`);
  await page.eval(`(()=>{const row=${rowExpr('Codex')};const btn=[...row.querySelectorAll('button')].find(b=>b.textContent.includes('安装'));btn.click();})()`);
  await sleep(450);
  check('A3a 安装 IPC 拒绝时错误对用户可见(行内出现错误文本)',
    await page.eval(`${rowExpr('Codex')}.textContent.includes('mock-install-rejected')`));
  check('A3b 安装 IPC 拒绝不落成未处理 promise 拒绝',
    (await page.eval('window.labUnhandled.length'))===0,
    {unhandled:await page.eval('window.labUnhandled')});
  check('A3c 拒绝后按钮解除 busy(可重试)',
    await page.eval(`(()=>{const row=${rowExpr('Codex')};const btn=[...row.querySelectorAll('button')].find(b=>b.textContent.includes('安装'));return !btn.disabled;})()`));

  // A4 baseline: {ok:false} error path still shows the error (must stay green)
  await page.eval(`window.labMode.install='fail';`);
  await page.eval(`(()=>{const row=${rowExpr('Pi')};const btn=[...row.querySelectorAll('button')].find(b=>b.textContent.includes('安装'));btn.click();})()`);
  await sleep(450);
  check('A4 兼容:install 返回 ok:false 的错误仍然可见',
    await page.eval(`${rowExpr('Pi')}.textContent.includes('mock-install-failed')`));

  // A5 remove rejection (installed row, confirm() mocked true)
  await page.eval(`window.labUnhandled.length=0;window.labMode.remove='reject';`);
  await page.eval(`(()=>{const row=${rowExpr('Claude')};const btn=[...row.querySelectorAll('button')].find(b=>b.textContent.includes('卸载'));btn.click();})()`);
  await sleep(450);
  check('A5a 卸载 IPC 拒绝时错误对用户可见',
    await page.eval(`${rowExpr('Claude')}.textContent.includes('mock-remove-rejected')`));
  check('A5b 卸载 IPC 拒绝不落成未处理 promise 拒绝',
    (await page.eval('window.labUnhandled.length'))===0,
    {unhandled:await page.eval('window.labUnhandled')});

  // A6 local-install picker rejection (pickFolder throws before any try block today)
  await page.eval(`window.labUnhandled.length=0;window.labMode.pickFolder='reject';`);
  await page.eval(`(()=>{const row=${rowExpr('Codex')};const btn=[...row.querySelectorAll('button')].find(b=>b.title&&b.title.includes('本地'));btn.click();})()`);
  await sleep(450);
  check('A6 本地安装选目录失败不落成未处理 promise 拒绝',
    (await page.eval('window.labUnhandled.length'))===0,
    {unhandled:await page.eval('window.labUnhandled')});
  await page.eval(`window.labMode.pickFolder='ok';window.labMode.install='ok';window.labMode.remove='ok';`);

  /* ───────────── B. DataRootPanel:迁移错误可见性 ───────────── */
  await page.eval(`window.__mount('dataroot')`);
  await page.waitFor(`document.body.textContent.includes('D:/mcode-data')`);
  check('B1 数据根路径渲染',true);

  // B2 IPC rejection on moveDataRoot: error visible, no unhandled rejection
  await page.eval(`window.labUnhandled.length=0;window.labMode.moveDataRoot='reject';`);
  await page.eval(`(()=>{const btn=[...document.querySelectorAll('#root button')].find(b=>b.textContent.includes('迁移到新位置'));btn.click();})()`);
  await sleep(450);
  check('B2a 迁移 IPC 拒绝时错误对用户可见',
    await page.eval(`document.body.textContent.includes('mock-moveDataRoot-rejected')`));
  check('B2b 迁移 IPC 拒绝不落成未处理 promise 拒绝',
    (await page.eval('window.labUnhandled.length'))===0,
    {unhandled:await page.eval('window.labUnhandled')});
  check('B2c 拒绝后按钮解除 busy(可重试)',
    await page.eval(`(()=>{const btn=[...document.querySelectorAll('#root button')].find(b=>b.textContent.includes('迁移到新位置'));return !!btn&&!btn.disabled;})()`));

  // B3 baseline: {ok:false} error path stays visible (green before and after)
  await page.eval(`window.labMode.moveDataRoot='fail';`);
  await page.eval(`(()=>{const btn=[...document.querySelectorAll('#root button')].find(b=>b.textContent.includes('迁移到新位置'));btn.click();})()`);
  await sleep(450);
  check('B3 兼容:moveDataRoot 返回 ok:false 的错误仍然可见',
    await page.eval(`document.body.textContent.includes('mock-moveDataRoot-failed')`));

  // B4 pickFolder rejection must not crash silently either
  await page.eval(`window.labUnhandled.length=0;window.labMode.pickFolder='reject';`);
  await page.eval(`(()=>{const btn=[...document.querySelectorAll('#root button')].find(b=>b.textContent.includes('迁移到新位置'));btn.click();})()`);
  await sleep(450);
  check('B4 选目录失败不落成未处理 promise 拒绝',
    (await page.eval('window.labUnhandled.length'))===0,
    {unhandled:await page.eval('window.labUnhandled')});
  await page.eval(`window.labMode.pickFolder='ok';window.labMode.moveDataRoot='ok';`);

  // B5 baseline: successful move flips to the restarting note
  await page.eval(`(()=>{const btn=[...document.querySelectorAll('#root button')].find(b=>b.textContent.includes('迁移到新位置'));btn.click();})()`);
  await sleep(450);
  check('B5 兼容:迁移成功后出现“等待重启”提示(原文案,不断言字面量)',
    await page.eval(`[...document.querySelectorAll('#root button')].every(b=>!b.textContent.includes('迁移到新位置'))`));

  /* ───────────── D. 设置页「静默失败」:读失败不再永远停在加载 ───────────── */
  // 判据立在**用户看到的那行字**上:失败原因出现、重试钮可点、加载态消失。
  //
  // 两个读 RPC 由这里注入到页内 mock(`labApi` 的代理会把赋值写回它的底层对象),
  // 于是不用动共享的 mocks.js —— 只有这一段需要失败注入。
  await page.eval(`(()=>{
    window.labApi.app.getDataRoot = async () => {
      window.labCalls.push(['app.getDataRoot']);
      if (window.labMode.getDataRoot === 'reject') throw new Error('mock-getDataRoot-rejected');
      return {root:'D:/mcode-data',dbPath:'D:/mcode-data/mcode.db',libraryPath:'D:/mcode-data/library'};
    };
    window.labApi.voice = {
      modelList: async () => {
        window.labCalls.push(['voice.modelList']);
        if (window.labMode.voiceModelList === 'reject') throw new Error('mock-voiceModelList-rejected');
        return {
          models:[{id:'zipformer-zh',name:'Zipformer 中文',langLabel:'中文 (zh-CN)',sizeLabel:'~120 MB',dir:'zipformer-zh',files:[]}],
          downloaded:[],selected:null,modelDir:'D:/mcode-data/voice-models',isCustom:false,
        };
      },
    };
    window.labApi.on.voiceDownloadProgress = () => () => {};
    window.labMode.getDataRoot = 'ok';
    window.labMode.voiceModelList = 'ok';
  })()`);

  // D1/D2 DataRootPanel:getDataRoot 拒绝 → 错误横幅(标题 + 原因)替代“…”占位,
  // 不落成未处理 promise 拒绝。
  await page.eval(`window.__mount('dataroot')`);
  await page.waitFor(`document.body.textContent.includes('D:/mcode-data')`);
  await page.eval(`window.labUnhandled.length=0;window.labMode.getDataRoot='reject';`);
  await page.eval(`window.__mount('dataroot')`);
  await sleep(450);
  const drText = await page.eval(`document.getElementById('root').textContent`);
  check('D1 ★ 数据根读取失败:错误标题与原因对用户可见',
    drText.includes('数据根读取失败') && drText.includes('mock-getDataRoot-rejected'),
    {text:drText});
  check('D1b ★ 数据根读取失败:加载占位(“…”所在的位置)不再被当成加载中',
    !drText.includes('…') && !drText.includes('正在加载'),
    {text:drText});
  check('D1c 数据根读取失败不落成未处理 promise 拒绝',
    (await page.eval('window.labUnhandled.length'))===0,
    {unhandled:await page.eval('window.labUnhandled')});

  // D2 重试钮点下去真的重新发请求:恢复成功态后点「重试」→ 路径回来、错误消失。
  check('D2a ★ 数据根读取失败时给出「重试」钮',
    await page.eval(`[...document.querySelectorAll('#root button')].some(b=>b.textContent.trim()==='重试')`));
  await page.eval(`window.labMode.getDataRoot='ok';`);
  await page.eval(`(()=>{const btn=[...document.querySelectorAll('#root button')].find(b=>b.textContent.trim()==='重试');if(btn)btn.click();})()`);
  await sleep(450);
  check('D2b ★ 点「重试」后读到数据根、错误横幅消失',
    await page.eval(`document.getElementById('root').textContent.includes('D:/mcode-data')
      && !document.getElementById('root').textContent.includes('数据根读取失败')`));
  await page.eval(`window.labMode.getDataRoot='ok';`);

  // D3/D4 VoicePanel:modelList 拒绝 → 错误横幅替代永远转圈的「正在加载模型列表…」。
  await page.eval(`window.labUnhandled.length=0;window.labMode.voiceModelList='reject';`);
  await page.eval(`window.__mount('voice')`);
  await page.waitFor(`document.getElementById('root').textContent.includes('模型列表加载失败')`,5000).catch(()=>{});
  await sleep(450);
  const vText = await page.eval(`document.getElementById('root').textContent`);
  check('D3 ★ 模型列表读取失败:错误标题与原因对用户可见',
    vText.includes('模型列表加载失败') && vText.includes('mock-voiceModelList-rejected'),
    {text:vText});
  check('D3b ★ 模型列表读取失败:不再永远停在「正在加载模型列表…」',
    !vText.includes('正在加载模型列表'), {text:vText});
  check('D3c 模型列表读取失败不落成未处理 promise 拒绝',
    (await page.eval('window.labUnhandled.length'))===0,
    {unhandled:await page.eval('window.labUnhandled')});

  // D4 重试钮可点,点后加载成功、失败横幅消失、卡片出现。
  check('D4a ★ 模型列表读取失败时给出「重试」钮',
    await page.eval(`[...document.querySelectorAll('#root button')].some(b=>b.textContent.trim()==='重试')`));
  await page.eval(`window.labMode.voiceModelList='ok';`);
  await page.eval(`(()=>{const btn=[...document.querySelectorAll('#root button')].find(b=>b.textContent.trim()==='重试');if(btn)btn.click();})()`);
  await sleep(450);
  const vOk = await page.eval(`document.getElementById('root').textContent`);
  check('D4b ★ 点「重试」后模型列表读到、错误横幅消失',
    vOk.includes('Zipformer 中文') && !vOk.includes('模型列表加载失败'),
    {text:vOk});

  /* ───────────── C. GeneralPanel:阈值输入的草稿保持 ───────────── */
  await page.eval(`window.__mount('general')`);
  await page.waitFor(`document.getElementById('setting-paste-threshold')`);
  const setVal=(v)=>`(()=>{const el=document.getElementById('setting-paste-threshold');const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;set.call(el,'${v}');el.dispatchEvent(new Event('input',{bubbles:true}));})()`;
  const inputVal=`document.getElementById('setting-paste-threshold').value`;

  check('C1 兼容:输入框初值来自 store(默认 200)',
    (await page.eval(inputVal))==='200',
    {value:await page.eval(inputVal)});

  // C2 clearing the field must keep it cleared (draft), not snap to the min
  await page.eval(`window.labCalls.length=0`);
  await page.eval(setVal(''));
  await sleep(150);
  check('C2a 清空输入框时保持空(草稿),不被 clamp 抢改成 50',
    (await page.eval(inputVal))==='',
    {value:await page.eval(inputVal)});
  check('C2b 清空(未完成输入)不写入设置',
    (await page.eval(`window.labCalls.filter(c=>c[0]==='setting.set'&&String(c[1]&&c[1].key).includes('paste')).length`))===0,
    {calls:await page.eval(`window.labCalls.filter(c=>c[0]==='setting.set')`)});

  // C3 typing a partial low value must not snap either
  await page.eval(setVal('3'));
  await sleep(150);
  check('C3 键入未完成的 “3” 不被抢改成 50',
    (await page.eval(inputVal))==='3',
    {value:await page.eval(inputVal)});

  // C4 finishing the number in range applies it (live)
  await page.eval(setVal('300'));
  await sleep(150);
  check('C4a 合法值 300 即时生效(store)',
    (await page.eval(`window.labStore.getState().pasteTagThresholdChars`))===300);
  check('C4b 合法值 300 已持久化',
    (await page.eval(`window.labCalls.some(c=>c[0]==='setting.set'&&c[1]&&String(c[1].key).includes('paste')&&c[1].value==='300')`))===true);

  // C5 blur with an out-of-range draft commits the clamped value
  await page.eval(setVal('7'));
  await page.eval(`document.getElementById('setting-paste-threshold').dispatchEvent(new FocusEvent('focusout',{bubbles:true}))`);
  await sleep(150);
  check('C5a 失焦提交:越界草稿 “7” clamp 到 50',
    (await page.eval(`window.labStore.getState().pasteTagThresholdChars`))===50,
    {store:await page.eval(`window.labStore.getState().pasteTagThresholdChars`)});
  check('C5b 失焦后输入框回显最终值',
    (await page.eval(inputVal))==='50',
    {value:await page.eval(inputVal)});

  // C6 blur with an empty draft reverts to the stored value (no accidental write)
  await page.eval(setVal(''));
  await page.eval(`document.getElementById('setting-paste-threshold').dispatchEvent(new FocusEvent('focusout',{bubbles:true}))`);
  await sleep(150);
  check('C6 失焦时空草稿回退到已存值,不写库',
    (await page.eval(inputVal))==='50',
    {value:await page.eval(inputVal)});

  check('Z1 全程无页面级异常',page.exceptions.length===0,{exceptions:page.exceptions});
});

console.log(`\nmaint-m25-smoke: ${total-failures}/${total} passed`);
if(failures>0){console.error(`${failures} assertion(s) failed`);process.exit(1);}

