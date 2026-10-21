import test from 'node:test';
import assert from 'node:assert/strict';
import { modelTokenGauge } from './modelTokenGauge.ts';

test('live model capacity gauge uses provider context-window counts and r=10 SVG', () => {
  const half = modelTokenGauge(100_000, 200_000);
  assert.equal(half.percent, 50);
  assert.ok(Math.abs(half.dashoffset - Math.PI * 10) < 1e-8);
  assert.equal(half.nearLimit, false);
  assert.equal(modelTokenGauge(162_000, 200_000).nearLimit, true);
  assert.equal(modelTokenGauge(350_000, 200_000).percent, 100);
  assert.deepEqual([modelTokenGauge(0, 0).known, modelTokenGauge(0, 0).percent], [false, null]);
});
