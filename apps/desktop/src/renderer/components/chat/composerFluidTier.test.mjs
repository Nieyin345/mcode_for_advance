import test from 'node:test';
import assert from 'node:assert/strict';
import { composerFluidTier } from './composerFluidTier.ts';

test('composer fluid compression resolves all four measured container thresholds', () => {
  assert.deepEqual([620, 576, 575, 480, 479, 384, 383, 320, 319].map(composerFluidTier),
    ['full','full','medium','medium','narrow','narrow','tight','tight','micro']);
});
