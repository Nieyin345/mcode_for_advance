import test from 'node:test';
import assert from 'node:assert/strict';
import { reasoningAmbientState } from './reasoningAmbient.ts';

test('reasoning glow is live-only (no lingering animation after turn settles)', () => {
  assert.deepEqual(reasoningAmbientState(true), { glow: true, shimmer: true, sweep: true });
  assert.deepEqual(reasoningAmbientState(false), { glow: false, shimmer: false, sweep: false });
});
