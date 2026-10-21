import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileStreamingRows, inlineDiffParts, feedUnifiedDiff } from './diffStreaming.ts';

test('streaming reuses settled rows while replacing changed tail without stale code', () => {
  const one = {op:'insert', text:'const a = 1', oldNo:null, newNo:1};
  const old = [one, {op:'insert',text:'con',oldNo:null,newNo:2}];
  const next = [{...one}, {op:'insert',text:'console.log(a)',oldNo:null,newNo:2}];
  const rows = reconcileStreamingRows(old, next);
  assert.equal(rows[0], one);
  assert.equal(rows[1].text, 'console.log(a)');
  assert.notEqual(rows[1], old[1]);
});
test('intra-line highlight isolates changed characters and keeps context', () => {
  const d = inlineDiffParts('const color = red;', 'const color = blue;');
  assert.deepEqual(d.before, [{text:'const color = ',changed:false},{text:'red',changed:true},{text:';',changed:false}]);
  assert.deepEqual(d.after, [{text:'const color = ',changed:false},{text:'blue',changed:true},{text:';',changed:false}]);
});
test('incoming unified diff chunks crossing a line boundary append once', () => {
  const a = feedUnifiedDiff({lines:[],rest:''}, '@@ -1 +1 @@\n-old\n+ne');
  const b = feedUnifiedDiff(a, 'w\n');
  assert.deepEqual(b, {lines:['@@ -1 +1 @@','-old','+new'],rest:''});
});
