import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CONFIGURABLE_DAILY_TOKENS,
  canAccessModel,
  checkQuotaAllowance,
  clampDailyQuota,
  reconcileTokenRecord,
} from './quotas';

test('clampDailyQuota enforces 1,000,000 token ceiling and non-negative floor', () => {
  assert.equal(clampDailyQuota(2_500_000), MAX_CONFIGURABLE_DAILY_TOKENS);
  assert.equal(clampDailyQuota(-50), 0);
  assert.equal(clampDailyQuota(50_000), 50_000);
});

test('canAccessModel enforces Free vs Premium vs Developer privileges', () => {
  assert.equal(canAccessModel({ role: 'user', plan: 'free' }, { requiredPlan: 'free' }).allowed, true);
  assert.equal(canAccessModel({ role: 'user', plan: 'free' }, { requiredPlan: 'premium' }).allowed, false);
  assert.equal(canAccessModel({ role: 'user', plan: 'premium' }, { requiredPlan: 'premium' }).allowed, true);
  assert.equal(canAccessModel({ role: 'developer', plan: 'free' }, { requiredPlan: 'premium' }).allowed, true);
});

test('checkQuotaAllowance blocks requests when daily or monthly limits are exceeded', () => {
  const ok = checkQuotaAllowance({
    dailyUsed: 1000,
    dailyLimit: 25000,
    monthlyUsed: 10000,
    monthlyLimit: 300000,
    estimatedRequestTokens: 500,
  });
  assert.equal(ok.allowed, true);
  assert.equal(ok.warningThreshold, false);

  const warn = checkQuotaAllowance({
    dailyUsed: 21000,
    dailyLimit: 25000,
    monthlyUsed: 21000,
    monthlyLimit: 300000,
  });
  assert.equal(warn.allowed, true);
  assert.equal(warn.warningThreshold, true);

  const blocked = checkQuotaAllowance({
    dailyUsed: 25000,
    dailyLimit: 25000,
    monthlyUsed: 25000,
    monthlyLimit: 300000,
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
