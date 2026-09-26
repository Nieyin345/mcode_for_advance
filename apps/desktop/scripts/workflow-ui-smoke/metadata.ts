import { writeFileSync } from 'node:fs';
import { builtinManifestById } from '@main/orchestration/nodeTypes.js';
import { isDocDirty } from '@renderer/components/settings/workflows/workflowView.js';
import { newWorkflowDoc } from '@renderer/components/settings/workflows/workflowEdit.js';
import type { NodeTypeCatalog } from '@contracts/nodeType';
const ids = ['mcode.main','mcode.agent','mcode.conversation','mcode.branch','mcode.condition','mcode.command','mcode.code','mcode.trigger'];
const catalog: NodeTypeCatalog = {entries: ids.map(id => {
  const manifest = builtinManifestById(id);
  if (!manifest) throw new Error('Missing builtin: ' + id);
  return {id,source:'builtin',from:'MCode',manifest};
}),problems:[]};
writeFileSync(process.argv[2], JSON.stringify(catalog,null,2));
console.log('Builtin catalog: ' + catalog.entries.map(e => `${e.id}=${e.manifest.runner.kind}`).join(', '));
const base = {...newWorkflowDoc('audit-pure','Audit'),frameworkNote:'original'};
const cases = [
  {name:'frameworkNote-only change, custom workflow',expected:true,actual:isDocDirty({...base,frameworkNote:'changed'},base)},
  {name:'frameworkNote-only change, builtin workflow',expected:true,actual:isDocDirty({...base,builtin:true,frameworkNote:'changed'},{...base,builtin:true})},
  {name:'prompt change control',expected:true,actual:isDocDirty({...base,prompt:'changed'},base)},
  {name:'unchanged control',expected:false,actual:isDocDirty(base,base)},
];
for (const row of cases) console.log(JSON.stringify({probe:'actual-isDocDirty',...row,passes:row.actual===row.expected}));
// Building the preview must still proceed when a product defect is reproduced.
writeFileSync(process.argv[2].replace(/catalog\.json$/, 'pure-probes.json'), JSON.stringify(cases,null,2));
