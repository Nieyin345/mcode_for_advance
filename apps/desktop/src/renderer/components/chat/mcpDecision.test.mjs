import test from 'node:test';
import assert from 'node:assert/strict';
import { mcpDecisionView, mcpApprovalVerdict } from './mcpDecision.ts';

test('MCP tool real execution lifecycle and settle reasons never report fake success', () => {
  assert.equal(mcpDecisionView('running',''), 'running');
  assert.equal(mcpDecisionView('done',''), 'success');
  assert.equal(mcpDecisionView('error','User denied tool execution'), 'user_denied');
  assert.equal(mcpDecisionView('error','policy_denied: blocked'), 'policy_denied');
  assert.equal(mcpDecisionView('error','PERMISSIONS_ERROR'), 'permissions_error');
  assert.equal(mcpDecisionView('error','unknown'), 'error');
});
test('MCP allow once, allow always and deny pass correct engine decisions', () => {
  assert.deepEqual(mcpApprovalVerdict('allow_once'), {granted:true,always:false});
  assert.deepEqual(mcpApprovalVerdict('always_allow'), {granted:true,always:true});
  assert.deepEqual(mcpApprovalVerdict('deny'), {granted:false,always:false});
});
