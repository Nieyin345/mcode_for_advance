import test from 'node:test';
import assert from 'node:assert/strict';
import { sortSessionsForSidebar, moveSidebarSession, keyboardMoveSidebarSession } from './sessionDragOrder.ts';

test('pinned and recent drag drop preserves order with correct downward offsets', () => {
  const initial = {pinned:['p1','p2'],recent:['a','b','c']};
  assert.deepEqual(moveSidebarSession(initial,'a','c',true), {...initial,recent:['b','c','a'],changedPin:false,toPinned:false});
  assert.deepEqual(moveSidebarSession(initial,'b','b',false).recent, initial.recent);
  assert.deepEqual(moveSidebarSession(initial,'b','p2',false), {pinned:['p1','b','p2'],recent:['a','c'],changedPin:true,toPinned:true});
  assert.deepEqual(moveSidebarSession(initial,'p1','b',true), {pinned:['p2'],recent:['a','b','p1','c'],changedPin:true,toPinned:false});
});
test('Alt+Up/Down is bounded to current pin zone; sort keeps default if no user order', () => {
  const initial = {pinned:['p1','p2'],recent:['a','b','c']};
  assert.deepEqual(keyboardMoveSidebarSession(initial,'b',-1).recent, ['b','a','c']);
  assert.deepEqual(keyboardMoveSidebarSession(initial,'p1',-1), initial);
  const rows = [{id:'c'}, {id:'b'}, {id:'a'}];
  assert.deepEqual(sortSessionsForSidebar(rows,['b','a','c']).map(x=>x.id), ['b','a','c']);
  assert.deepEqual(sortSessionsForSidebar(rows,[]), rows);
});
