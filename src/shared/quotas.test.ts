import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PLAN_LIMITS,
  MAX_CONFIGURABLE_DAILY_TOKENS,
  canAccessModel,
  checkQuotaAllowance,
  clampDailyQuota,
  getPerModelDailyCap,
  getUtcQuotaResetTimestamps,
  reconcileTokenRecord,
} from './quotas';

test('clampDailyQuota enforces 1,000,000 token ceiling and non-negative floor', () => {
  assert.equal(clampDailyQuota(2_500_000), MAX_CONFIGURABLE_DAILY_TOKENS);
  assert.equal(clampDailyQuota(-50), 0);
  assert.equal(clampDailyQuota(50_000), 50_000);
});

test('DEFAULT_PLAN_LIMITS provides generous Free-tier allowance and UTC reset timestamps', () => {
  assert.deepEqual(DEFAULT_PLAN_LIMITS.free, { daily: 150_000, monthly: 2_500_000 });
  assert.equal(getPerModelDailyCap('free', 'sonic-3'), 60_000);
  assert.equal(getPerModelDailyCap('free', 'lodie-5.5'), 35_000);
  assert.equal(getPerModelDailyCap('free', 'fables-5.3'), 40_000);

  const resets = getUtcQuotaResetTimestamps(new Date('2026-11-24T15:30:00.000Z'));
  assert.equal(resets.dailyResetAtUtc, '2026-11-25T00:00:00.000Z');
  assert.equal(resets.monthlyResetAtUtc, '2026-12-01T00:00:00.000Z');
});

test('canAccessModel enforces Free vs Premium vs Developer privileges', () => {
  assert.equal(canAccessModel({ role: 'user', plan: 'free' }, { requiredPlan: 'free' }).allowed, true);
  assert.equal(canAccessModel({ role: 'user', plan: 'free' }, { requiredPlan: 'premium' }).allowed, false);
  assert.equal(canAccessModel({ role: 'user', plan: 'premium' }, { requiredPlan: 'premium' }).allowed, true);
  assert.equal(canAccessModel({ role: 'developer', plan: 'free' }, { requiredPlan: 'premium' }).allowed, true);
});

test('checkQuotaAllowance enforces daily, monthly, and per-model daily caps cleanly', () => {
  const ok = checkQuotaAllowance({
    dailyUsed: 1_000,
    dailyLimit: 150_000,
    monthlyUsed: 10_000,
    monthlyLimit: 2_500_000,
    modelId: 'Sonic 3',
    modelDailyUsed: 5_000,
    modelDailyLimit: 60_000,
    estimatedRequestTokens: 500,
  });
  assert.equal(ok.allowed, true);
  assert.equal(ok.warningThreshold, false);
  assert.equal(ok.dailyRemaining, 149_000);
  assert.equal(ok.monthlyRemaining, 2_490_000);
  assert.equal(ok.modelDailyRemaining, 55_000);

  const warn = checkQuotaAllowance({
    dailyUsed: 125_000,
    dailyLimit: 150_000,
    monthlyUsed: 125_000,
    monthlyLimit: 2_500_000,
  });
  assert.equal(warn.allowed, true);
  assert.equal(warn.warningThreshold, true);

  const perModelBlocked = checkQuotaAllowance({
    dailyUsed: 35_000,
    dailyLimit: 150_000,
    monthlyUsed: 35_000,
    monthlyLimit: 2_500_000,
    modelId: 'LOODY 5.5',
    modelDailyUsed: 35_000,
    modelDailyLimit: 35_000,
  });
  assert.equal(perModelBlocked.allowed, false);
  assert.equal(perModelBlocked.modelDailyRemaining, 0);
  assert.match(perModelBlocked.reason ?? '', /LOODY 5\.5/);

  const blocked = checkQuotaAllowance({
    dailyUsed: 150_000,
    dailyLimit: 150_000,
    monthlyUsed: 150_000,
    monthlyLimit: 2_500_000,
  });
  assert.equal(blocked.allowed, false);
});

test('reconcileTokenRecord never mislabels estimated tokens as provider_reported', () => {
  const exact = reconcileTokenRecord({
    providerReported: { inputTokens: 120, outputTokens: 340, cachedTokens: 20 },
    fallbackInputText: 'hello',
    fallbackOutputText: 'world',
  });
  assert.equal(exact.accountingType, 'provider_reported');
  assert.equal(exact.inputTokens, 120);
  assert.equal(exact.outputTokens, 340);

  const est = reconcileTokenRecord({
    providerReported: undefined,
    fallbackInputText: '12345678',
    fallbackOutputText: '123456789012',
  });
  assert.equal(est.accountingType, 'estimated');
  assert.equal(est.inputTokens, 2);
  assert.equal(est.outputTokens, 3);
});
