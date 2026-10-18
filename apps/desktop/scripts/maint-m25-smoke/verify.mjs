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

  /* ───────────── E. LspLanguagesPanel:读失败不再永远转「加载 LSP 状态…」 ───────────── */
  // 与 D 段同一判据形态:`api.lsp.list` 拒绝 → 错误标题+原因+重试可见,
  // 加载态消失;重试恢复后列表回来、横幅消失。失败注入经页内 mock 的
  // `labApi.lsp` 赋值(不改共享 mocks.js)。
  await page.eval(`(()=>{
    window.labApi.lsp = {
      list: async () => {
        window.labCalls.push(['lsp.list']);
        if (window.labMode.lspList === 'reject') throw new Error('mock-lsp-list-rejected');
        return {languages:[{
          language:'typescript', enabled:true, installed:true,
          serverPath:'D:/bin/typescript-language-server',
          running:false, installing:false, installLog:'', lastError:'',
        }]};
      },
    };
    window.labMode.lspList = 'ok';
    window.labStore.setState({lspLanguages:[], lspLoadError:null});
  })()`);

  // E0 基线:读成功 → 语言行渲染,无错误横幅、无加载态。
  await page.eval(`window.__mount('lsp');`);
  await page.eval(`window.labStore.getState().reloadLspLanguages()`);
  await sleep(450);
  const lText0 = await page.eval(`document.getElementById('root').textContent`);
  check('E0 基线:LSP 读成功时语言行渲染、无错误横幅',
    lText0.includes('TypeScript / JavaScript') && !lText0.includes('LSP 状态加载失败') && !lText0.includes('加载 LSP 状态'),
    {text:lText0});

  // E1 读失败(列表为空,正是"永远转圈"的原现场)——错误标题与原因可见,
  // 加载占位消失,且不落成未处理 promise 拒绝。
  await page.eval(`window.labUnhandled.length=0;window.labMode.lspList='reject';window.labStore.setState({lspLanguages:[],lspLoadError:null});`);
  await page.eval(`window.labStore.getState().reloadLspLanguages()`);
  await sleep(450);
  const lFail = await page.eval(`document.getElementById('root').textContent`);
  check('E1a ★ LSP 读取失败:错误标题与原因对用户可见',
    lFail.includes('LSP 状态加载失败') && lFail.includes('mock-lsp-list-rejected'),
    {text:lFail});
  check('E1b ★ LSP 读取失败:不再永远停在「加载 LSP 状态…」',
    !lFail.includes('加载 LSP 状态'), {text:lFail});
  check('E1c LSP 读取失败不落成未处理 promise 拒绝',
    (await page.eval('window.labUnhandled.length'))===0,
    {unhandled:await page.eval('window.labUnhandled')});
  check('E1d ★ LSP 读取失败时给出「重试」钮',
    await page.eval(`[...document.querySelectorAll('#root button')].some(b=>b.textContent.trim()==='重试')`));

  // E2 点「重试」真的重新发请求:恢复成功态后点重试 → 列表回来、横幅消失。
  await page.eval(`window.labMode.lspList='ok';`);
  await page.eval(`(()=>{const btn=[...document.querySelectorAll('#root button')].find(b=>b.textContent.trim()==='重试');if(btn)btn.click();})()`);
  await sleep(450);
  const lOk = await page.eval(`document.getElementById('root').textContent`);
  check('E2a ★ 点「重试」后 LSP 列表读到、错误横幅消失',
    lOk.includes('TypeScript / JavaScript') && !lOk.includes('LSP 状态加载失败') && !lOk.includes('加载 LSP 状态'),
    {text:lOk});
  check('E2b 重试确实重新发了 lsp.list 请求',
    (await page.eval(`window.labCalls.filter(c=>c[0]==='lsp.list').length`))>=3,
    {calls:await page.eval(`window.labCalls.filter(c=>c[0]==='lsp.list')`)});

  /* ───────────── F. RemoteControlPanel:status 读失败不得伪装成「已关闭」 ───────────── */
  // 这里失败的不是"列表空不空",而是**状态本身未知**。从前 catch 静默吞掉,
  // status 停在 null,开关按 `?? false` 画成"关" —— 用户以为远程控制是关的,
  // 实际可能正开着。判据:错误标题+原因可见;「已关闭/已开放」一个都不许出现;
  // 开关本体也不许以"关"的位置出现(未知不是关);重试后真实状态回来。
  await page.eval(`(()=>{
    const st=(enabled)=>({
      enabled, port:enabled?17331:0, secret:enabled?'s3cret':'' , sessionId:null,
      tunnelUrl:null, tunnelPhase:'stopped', tunnelError:null,
      sandboxRoot:null, sandboxProjectId:null, sandboxProjectMissing:false, sandboxProjectMissingId:null,
      availableProjects:[], tunnelMode:'quick', tunnelHostname:'', mobileHostname:'',
      tokenHint:'', fixedPort:0, mobilePort:0, agentDelegate:false, projectLinks:[],
    });
    window.labApi.publicMcp = {
      status: async () => {
        window.labCalls.push(['publicMcp.status']);
        if (window.labMode.publicMcpStatus === 'reject') throw new Error('mock-publicMcp-status-rejected');
        return st(window.labMode.publicMcpEnabled === 'on');
      },
    };
    window.labMode.publicMcpStatus = 'ok';
    window.labMode.publicMcpEnabled = 'off';
  })()`);

  // F0 基线:读成功且真的是关 → 徽标「已关闭」、开关 aria-checked=false。
  await page.eval(`window.__mount('remote');`);
  await page.waitFor(`document.getElementById('root').textContent.includes('已关闭')`,5000).catch(()=>{});
  const rcText0 = await page.eval(`document.getElementById('root').textContent`);
  const rcAria0 = await page.eval(`document.querySelector('#root [role=switch]')?.getAttribute('aria-checked')`);
  check('F0 基线:状态读成功(真关闭)时徽标「已关闭」、开关 aria-checked=false',
    rcText0.includes('已关闭') && rcAria0==='false', {text:rcText0, aria:rcAria0});

  // F1 status 拒绝(初始读,status 停在 null —— 正是"未知被画成关"的原现场)。
  await page.eval(`window.labUnhandled.length=0;window.labMode.publicMcpStatus='reject';`);
  await page.eval(`window.__mount('remote');`);
  await sleep(450);
  const rcFail = await page.eval(`document.getElementById('root').textContent`);
  const rcSwitchFail = await page.eval(`document.querySelectorAll('#root [role=switch]').length`);
  check('F1a ★ 远程控制状态读取失败:错误标题与原因对用户可见',
    rcFail.includes('远程控制状态读取失败') && rcFail.includes('mock-publicMcp-status-rejected'),
    {text:rcFail});
  check('F1b ★ 远程控制状态读取失败:不显示成「已关闭」(未知不等于关)',
    !rcFail.includes('已关闭') && !rcFail.includes('已开放') && rcSwitchFail===0,
    {text:rcFail, switches:rcSwitchFail});
  check('F1c ★ 远程控制状态读取失败时给出「重试」钮',
    await page.eval(`[...document.querySelectorAll('#root button')].some(b=>b.textContent.trim()==='重试')`));
  check('F1d 远程控制状态读取失败不落成未处理 promise 拒绝',
    (await page.eval('window.labUnhandled.length'))===0,
    {unhandled:await page.eval('window.labUnhandled')});

  // F2 点「重试」真的重新发请求:恢复成功(且真的开着)→ 徽标「已开放」、开关打开。
  await page.eval(`window.labMode.publicMcpStatus='ok';window.labMode.publicMcpEnabled='on';`);
  await page.eval(`(()=>{const btn=[...document.querySelectorAll('#root button')].find(b=>b.textContent.trim()==='重试');if(btn)btn.click();})()`);
  await sleep(450);
  const rcOk = await page.eval(`document.getElementById('root').textContent`);
  const rcAriaOk = await page.eval(`document.querySelector('#root [role=switch]')?.getAttribute('aria-checked')`);
  check('F2a ★ 点「重试」后真实状态读到:「已开放」出现、错误横幅消失',
    rcOk.includes('已开放') && !rcOk.includes('远程控制状态读取失败') && rcAriaOk==='true',
    {text:rcOk, aria:rcAriaOk});
  check('F2b 重试确实重新发了 publicMcp.status 请求',
    (await page.eval(`window.labCalls.filter(c=>c[0]==='publicMcp.status').length`))>=3,
    {calls:await page.eval(`window.labCalls.filter(c=>c[0]==='publicMcp.status')`)});

  /* ───────────── G. SkillProjectOverview:读失败不得伪装成「还没有项目」 ───────────── */
  // 从前 catch → `setData({rows:[],problems:[]})`,界面画成"还没有项目。" ——
  // 用户以为真的没有项目,实际是一次读取失败。判据:错误标题+原因+重试可见,
  // 空态文案不出现;重试后项目行回来。
  await page.eval(`(()=>{
    window.labApi.skills = {
      projectOverview: async () => {
        window.labCalls.push(['skills.projectOverview']);
        if (window.labMode.projectOverview === 'reject') throw new Error('mock-projectOverview-rejected');
        return {
          rows:[{projectId:'p1',projectName:'Project Alpha',path:'D:/projects/alpha',skills:['paper-writing'],missing:false}],
          problems:[],
        };
      },
    };
    window.labMode.projectOverview = 'ok';
  })()`);

  // G0 基线:读成功 → 项目行 + 技能名渲染,无错误横幅、无空态。
  await page.eval(`window.__mount('overview');`);
  await page.waitFor(`document.getElementById('root').textContent.includes('Project Alpha')`,5000).catch(()=>{});
  const ovText0 = await page.eval(`document.getElementById('root').textContent`);
  check('G0 基线:总览读成功时项目行渲染、无错误横幅、无空态',
    ovText0.includes('Project Alpha') && ovText0.includes('paper-writing')
      && !ovText0.includes('跨项目总览读取失败') && !ovText0.includes('还没有项目。'),
    {text:ovText0});

  // G1 初始读拒绝(rows 从未到过手 —— 正是"空表伪装"的原现场)。
  await page.eval(`window.labUnhandled.length=0;window.labMode.projectOverview='reject';`);
  await page.eval(`window.__mount('overview');`);
  await sleep(450);
  const ovFail = await page.eval(`document.getElementById('root').textContent`);
  check('G1a ★ 跨项目总览读取失败:错误标题与原因对用户可见',
    ovFail.includes('跨项目总览读取失败') && ovFail.includes('mock-projectOverview-rejected'),
    {text:ovFail});
  check('G1b ★ 跨项目总览读取失败:不伪装成「还没有项目。」(空表)',
    !ovFail.includes('还没有项目。') && !ovFail.includes('Project Alpha'), {text:ovFail});
  check('G1c ★ 跨项目总览读取失败时给出「重试」钮',
    await page.eval(`[...document.querySelectorAll('#root button')].some(b=>b.textContent.trim()==='重试')`));
  check('G1d 跨项目总览读取失败不落成未处理 promise 拒绝',
    (await page.eval('window.labUnhandled.length'))===0,
    {unhandled:await page.eval('window.labUnhandled')});

  // G2 重试 → 项目行回来、横幅消失。
  await page.eval(`window.labMode.projectOverview='ok';`);
  await page.eval(`(()=>{const btn=[...document.querySelectorAll('#root button')].find(b=>b.textContent.trim()==='重试');if(btn)btn.click();})()`);
  await sleep(450);
  const ovOk = await page.eval(`document.getElementById('root').textContent`);
  check('G2a ★ 点「重试」后总览读到、错误横幅消失',
    ovOk.includes('Project Alpha') && !ovOk.includes('跨项目总览读取失败'), {text:ovOk});
  check('G2b 重试确实重新发了 skills.projectOverview 请求',
    (await page.eval(`window.labCalls.filter(c=>c[0]==='skills.projectOverview').length`))>=3,
    {calls:await page.eval(`window.labCalls.filter(c=>c[0]==='skills.projectOverview')`)});

  /* ───────────── H. SkillPresetsView:读失败不得伪装成「还没有预设」 ───────────── */
  // 从前 catch → `setPresets([])`,界面画成「还没有预设。」—— 用户以为真的一套都
  // 没存,可能照着空表去新建、覆盖掉原有预设。判据:错误标题+原因+重试可见,
  // 空态文案不出现;重试后预设行回来、横幅消失。
  //
  // 注意:`api.skills` 在 G 段已被整体替换 —— 这里必须把 presetsList 加到**同一个**
  // 对象上,不能重新赋一个只有 presetsList 的对象(那会把 projectOverview 抹掉)。
  await page.eval(`(()=>{
    window.labApi.skills.presetsList = async () => {
      window.labCalls.push(['skills.presetsList']);
      if (window.labMode.presetsList === 'reject') throw new Error('mock-presetsList-rejected');
      return {presets:[{id:'sp_1',name:'论文项目',skills:['paper-writing'],createdAt:1,updatedAt:1}]};
    };
    window.labMode.presetsList = 'ok';
  })()`);

  // H0 基线:读成功 → 预设行渲染,无错误横幅、无空态。
  await page.eval(`window.__mount('presets');`);
  await page.waitFor(`document.getElementById('root').textContent.includes('论文项目')`,5000).catch(()=>{});
  const prText0 = await page.eval(`document.getElementById('root').textContent`);
  check('H0 基线:预设读成功时预设行渲染、无错误横幅、无空态',
    prText0.includes('论文项目') && !prText0.includes('预设读取失败') && !prText0.includes('还没有预设。'),
    {text:prText0});

  // H1 初始读拒绝(presets 从未到过手 —— 正是"空表伪装"的原现场)。
  await page.eval(`window.labUnhandled.length=0;window.labMode.presetsList='reject';`);
  await page.eval(`window.__mount('presets');`);
  await sleep(450);
  const prFail = await page.eval(`document.getElementById('root').textContent`);
  check('H1a ★ 预设读取失败:错误标题与原因对用户可见',
    prFail.includes('预设读取失败') && prFail.includes('mock-presetsList-rejected'),
    {text:prFail});
  check('H1b ★ 预设读取失败:不伪装成「还没有预设。」(空表)',
    !prFail.includes('还没有预设。') && !prFail.includes('论文项目'), {text:prFail});
  check('H1c ★ 预设读取失败时给出「重试」钮',
    await page.eval(`[...document.querySelectorAll('#root button')].some(b=>b.textContent.trim()==='重试')`));
  check('H1d 预设读取失败不落成未处理 promise 拒绝',
    (await page.eval('window.labUnhandled.length'))===0,
    {unhandled:await page.eval('window.labUnhandled')});

  // H2 重试 → 预设行回来、横幅消失。
  await page.eval(`window.labMode.presetsList='ok';`);
  await page.eval(`(()=>{const btn=[...document.querySelectorAll('#root button')].find(b=>b.textContent.trim()==='重试');if(btn)btn.click();})()`);
  await sleep(450);
  const prOk = await page.eval(`document.getElementById('root').textContent`);
  check('H2a ★ 点「重试」后预设读到、错误横幅消失',
    prOk.includes('论文项目') && !prOk.includes('预设读取失败'), {text:prOk});
  check('H2b 重试确实重新发了 skills.presetsList 请求',
    (await page.eval(`window.labCalls.filter(c=>c[0]==='skills.presetsList').length`))>=3,
    {calls:await page.eval(`window.labCalls.filter(c=>c[0]==='skills.presetsList')`)});

  /* ───────────── I. HooksPanel:执行记录读失败不得伪装成「还没有执行过」 ───────────── */
  // `hooks.runs` 一次拒绝同时决定两栏(本次启动执行 / 落盘审计)。从前 catch 静默
  // 吞掉,两栏都画成各自的空态 —— 「读不出来」与「一次没跑」长得一样。
  await page.eval(`(()=>{
    window.labApi.hooks = {
      list: async () => {
        window.labCalls.push(['hooks.list']);
        if (window.labMode.hooksList === 'reject') throw new Error('mock-hooks-list-rejected');
        if (window.labMode.hooksList === 'one') return {hooks:[{
          id:'h1',name:'自动格式化',event:'turn.files',command:'prettier --check .',enabled:true,
        }],problems:[],fileHealth:'valid'};
        return {hooks:[],problems:[],fileHealth:'valid'};
      },
      runs: async () => {
        window.labCalls.push(['hooks.runs']);
        if (window.labMode.hooksRuns === 'reject') throw new Error('mock-hooks-runs-rejected');
        if (window.labMode.hooksRuns === 'one') return {runs:[{
          runId:'r1',hookId:'h1',hookName:'格式检查',event:'turn.files',sessionId:'s1',
          sessionKind:'chat',startedAt:1750000000000,status:'ok',
        }],audit:[],auditError:null};
        return {runs:[],audit:[],auditError:null};
      },
    };
    window.labMode.hooksRuns = 'empty';
    window.labMode.hooksList = 'empty';
  })()`);

  // I0 基线:读成功且真的没有记录 → 两栏各自的空态、无错误横幅。
  await page.eval(`window.__mount('hooks');`);
  await page.waitFor(`document.getElementById('root').textContent.includes('本次启动以来的执行')`,5000).catch(()=>{});
  await sleep(300);
  const hkText0 = await page.eval(`document.getElementById('root').textContent`);
  check('I0 基线:执行记录读成功时两栏各自空态、无错误横幅',
    hkText0.includes('本次启动以来还没有执行过') && hkText0.includes('还没有钩子被执行过')
      && !hkText0.includes('执行记录读不出来'),
    {text:hkText0});

  // I1 runs 拒绝 → 两栏都不得画成「没执行过」;原因与重试可见。
  await page.eval(`window.labUnhandled.length=0;window.labMode.hooksRuns='reject';`);
  await page.eval(`window.__mount('hooks');`);
  await sleep(450);
  const hkFail = await page.eval(`document.getElementById('root').textContent`);
  check('I1a ★ 执行记录读取失败:错误标题与原因对用户可见',
    hkFail.includes('执行记录读不出来') && hkFail.includes('mock-hooks-runs-rejected'),
    {text:hkFail});
  check('I1b ★ 执行记录读取失败:两栏都不伪装成「没执行过」(空态)',
    !hkFail.includes('本次启动以来还没有执行过') && !hkFail.includes('还没有钩子被执行过'),
    {text:hkFail});
  check('I1c ★ 执行记录读取失败时给出「重试」钮',
    await page.eval(`[...document.querySelectorAll('#root button')].some(b=>b.textContent.trim()==='重试')`));
  check('I1d 执行记录读取失败不落成未处理 promise 拒绝',
    (await page.eval('window.labUnhandled.length'))===0,
    {unhandled:await page.eval('window.labUnhandled')});

  // I2 点「重试」→ 恢复成功(带回一条真实记录),错误消失、记录行出现。
  // 断言真实记录行而不是空态文案 —— 否则修复前"没有重试钮、但空态本来就在"也会绿。
  await page.eval(`window.labMode.hooksRuns='one';`);
  await page.eval(`(()=>{const btn=[...document.querySelectorAll('#root button')].find(b=>b.textContent.trim()==='重试');if(btn)btn.click();})()`);
  await sleep(450);
  const hkOk = await page.eval(`document.getElementById('root').textContent`);
  check('I2a ★ 点「重试」后执行记录读到、错误横幅消失',
    !hkOk.includes('执行记录读不出来') && !hkOk.includes('本次启动以来还没有执行过')
      && hkOk.includes('格式检查'),
    {text:hkOk});
  check('I2b 重试确实重新发了 hooks.runs 请求',
    (await page.eval(`window.labCalls.filter(c=>c[0]==='hooks.runs').length`))>=3,
    {calls:await page.eval(`window.labCalls.filter(c=>c[0]==='hooks.runs')`)});

  /* ───────────── J. HooksPanel:hooks.list 读失败要有「重试」 ───────────── */
  // `hooks.list` 失败已有 `listError` 横幅(不重做),但没有重试入口 —— 用户只能去
  // 保存/开关别的东西,借那些操作顺带重拉。判据:失败态横幅里有「重试」;点它真的
  // 重新发 `hooks.list`,恢复后钩子行回来、横幅消失。
  //
  // 只断言真实钩子行而不是空态文案 —— 修复前挂载本来就会把空态画出来,只看
  // "空态消失"会假绿。重试钮按**所在横幅**定位(`hooks.list` 的失败横幅是
  // warning 色 → `role=status`),不点页头/记录栏的其它按钮;本段 runs 恒为成功,
  // 记录栏不会有自己的重试钮混进来。
  await page.eval(`window.labUnhandled.length=0;window.labMode.hooksList='reject';`);
  await page.eval(`window.__mount('hooks');`);
  await page.waitFor(`document.getElementById('root').textContent.includes('钩子读不出来')`,5000).catch(()=>{});
  await sleep(300);
  const hlFail = await page.eval(`document.getElementById('root').textContent`);
  check('J1 ★ hooks.list 读取失败:错误标题与原因对用户可见',
    hlFail.includes('钩子读不出来') && hlFail.includes('mock-hooks-list-rejected'),
    {text:hlFail});
  check('J1b ★ hooks.list 读取失败:不伪装成「还没有钩子。」(空表)',
    !hlFail.includes('还没有钩子。'), {text:hlFail});
  check('J2 ★ hooks.list 读取失败时给出「重试」钮(与错误横幅同处)',
    await page.eval(`(()=>{
      const note=[...document.querySelectorAll('#root [role=alert],#root [role=status]')].find(n=>n.textContent.includes('钩子读不出来'));
      return !!note && [...note.querySelectorAll('button')].some(b=>b.textContent.trim()==='重试');
    })()`));
  check('J3 hooks.list 读取失败不落成未处理 promise 拒绝',
    (await page.eval('window.labUnhandled.length'))===0,
    {unhandled:await page.eval('window.labUnhandled')});

  // J4 点「重试」真的重发 hooks.list → 钩子行回来、错误横幅消失。
  // 计数要在点击**前**取:前面 I/J 段已挂载过几次,绝对值 >=3 在没点重试时也成立。
  const hlCallsBefore = await page.eval(`window.labCalls.filter(c=>c[0]==='hooks.list').length`);
  await page.eval(`window.labMode.hooksList='one';`);
  await page.eval(`(()=>{
    const note=[...document.querySelectorAll('#root [role=alert],#root [role=status]')].find(n=>n.textContent.includes('钩子读不出来'));
    const btn=note&&[...note.querySelectorAll('button')].find(b=>b.textContent.trim()==='重试');
    if(btn)btn.click();
  })()`);
  await sleep(450);
  const hlOk = await page.eval(`document.getElementById('root').textContent`);
  check('J4a ★ 点「重试」后钩子列表读到、错误横幅消失',
    hlOk.includes('自动格式化') && !hlOk.includes('钩子读不出来'), {text:hlOk});
  check('J4b 重试确实重新发了 hooks.list 请求',
    (await page.eval(`window.labCalls.filter(c=>c[0]==='hooks.list').length`))>hlCallsBefore,
    {before:hlCallsBefore,calls:await page.eval(`window.labCalls.filter(c=>c[0]==='hooks.list')`)});
  await page.eval(`window.labMode.hooksList='empty';`);

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

