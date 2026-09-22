import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

function scenario(fx) {
  return JSON.parse(execFileSync(process.execPath, ['scripts/profit-scenarios.mjs'], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8',
    env: { ...process.env, SCENARIO_JPY_PER_USD: String(fx) }
  }));
}

test('profit documentation agrees with authoritative package prices at assumed FX 150', () => {
  const data = scenario(150);
  assert.deepEqual(data.packs.map(p => [p.yen, p.replies]), [[100, 40], [300, 140], [1000, 500]]);
  assert.deepEqual(data.packs.map(p => p.plannedContributionYen), [69.4, 194.7, 626.5]);
  assert.deepEqual(data.packs.map(p => p.maximumCostContributionYen), [45.1, 109.65, 322.75]);
  assert.deepEqual(data.packs.map(p => p.monthlyAfterTrialApiFeesVercelYen), [-1555, 4710, 26300]);
  assert.deepEqual(data.packs.map(p => p.monthlyAlsoSupabaseProYen), [-5305, 960, 22550]);
  assert.deepEqual(data.packs.map(p => p.breakEvenBuyersFor1000Trials), [73, 26, 9]);
  assert.deepEqual(data.packs.map(p => p.requiredTotalApiBudgetUsd), [22.5, 45, 126]);
  assert.equal(data.initialTrialBudgetCapacity.plannedFullTrialsPerMonth, 370);
  assert.equal(data.initialTrialBudgetCapacity.maximumCostFullTrialsPerMonth, 194);
});

test('scenario FX can change without changing actual sale prices or budget limits', () => {
  const data = scenario(180);
  assert.deepEqual(data.packs.map(p => p.yen), [100, 300, 1000]);
  assert.equal(data.packs[2].maximumCostContributionYen, 194.5);
  assert.equal(data.initialTrialBudgetCapacity.plannedFullTrialsPerDay, 37);
});
