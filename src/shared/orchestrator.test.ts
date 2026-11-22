import test from 'node:test';
import assert from 'node:assert/strict';
import {
  arrangeImagesOnVoiceoverTimeline,
  buildDagExecutionBatches,
  classifyIntentMode,
  classifyProviderError,
  computeUnifiedLineDiff,
  evaluateToolPermission,
  validateSkillDefinition,
} from './orchestrator';
import { COMMERCIAL_PLANS, DEFAULT_PLAN_LIMITS, canAccessModel, checkQuotaAllowance } from './quotas';

test('classifyIntentMode routes explicit modes and natural language intents accurately', () => {
  assert.equal(classifyIntentMode('hello there', 'deep_thinking'), 'deep_thinking');
  assert.equal(classifyIntentMode('hello there', 'creative'), 'creative');
  assert.equal(classifyIntentMode('Refactor this TypeScript API endpoint and fix the SQL bug'), 'coding');
  assert.equal(classifyIntentMode('Research latest citations and verify sources on WebGPU'), 'research');
  assert.equal(classifyIntentMode('Create a storyboard and music video animation concept'), 'creative');
  assert.equal(classifyIntentMode('Analyze this CSV dataset metrics and regression table'), 'analysis');
  assert.equal(classifyIntentMode('Build a project roadmap milestone schedule'), 'work');
  assert.equal(classifyIntentMode('Hi'), 'fast');
});

test('classifyProviderError distinguishes auth, rate limit, quota, latency, and availability failures', () => {
  const authErr = classifyProviderError('Invalid API key', 401);
  assert.equal(authErr.errorClass, 'auth_error');
  assert.equal(authErr.healthStatus, 'authentication_error');
  assert.equal(authErr.retryable, false);

  const cfgErr = classifyProviderError('Provider API key is not configured', 401);
  assert.equal(cfgErr.errorClass, 'configuration_error');
  assert.equal(cfgErr.healthStatus, 'configuration_error');

  const rateErr = classifyProviderError('Rate limit exceeded', 429);
  assert.equal(rateErr.errorClass, 'rate_limit');
  assert.equal(rateErr.healthStatus, 'temporarily_unavailable');
  assert.equal(rateErr.retryable, true);

  const quotaErr = classifyProviderError('insufficient_quota billing cap reached');
  assert.equal(quotaErr.errorClass, 'quota_exceeded');
  assert.equal(quotaErr.healthStatus, 'temporarily_unavailable');
  assert.equal(quotaErr.retryable, false);

  const latencyErr = classifyProviderError('Request timed out after 15000ms', 504);
  assert.equal(latencyErr.errorClass, 'latency');
  assert.equal(latencyErr.healthStatus, 'temporarily_unavailable');
  assert.equal(latencyErr.retryable, true);

  const notFoundErr = classifyProviderError('Model does not exist', 404);
  assert.equal(notFoundErr.errorClass, 'configuration_error');
  assert.equal(notFoundErr.healthStatus, 'configuration_error');
  assert.equal(notFoundErr.retryable, false);

  const unavailErr = classifyProviderError('Upstream unavailable', 503);
  assert.equal(unavailErr.errorClass, 'provider_unavailable');
  assert.equal(unavailErr.healthStatus, 'temporarily_unavailable');
  assert.equal(unavailErr.retryable, true);
});

test('buildDagExecutionBatches topologically groups waves and rejects cycles/unknown deps', () => {
  const batches = buildDagExecutionBatches([
    { id: 'step-a', dependsOn: [] },
    { id: 'step-b', dependsOn: [] },
    { id: 'step-c', dependsOn: ['step-a', 'step-b'] },
    { id: 'step-d', dependsOn: ['step-c'] },
  ]);

  assert.equal(batches.length, 3);
  assert.deepEqual(
    batches[0].map((s) => s.id),
    ['step-a', 'step-b']
  );
  assert.deepEqual(
    batches[1].map((s) => s.id),
    ['step-c']
  );
  assert.deepEqual(
    batches[2].map((s) => s.id),
    ['step-d']
  );

  assert.throws(
    () =>
      buildDagExecutionBatches([
        { id: 'x', dependsOn: ['y'] },
        { id: 'y', dependsOn: ['x'] },
      ]),
    /Cycle detected/
  );

  assert.throws(
    () => buildDagExecutionBatches([{ id: 'x', dependsOn: ['missing'] }]),
    /unknown step/
  );
});

test('evaluateToolPermission blocks disabled and unapproved restricted tools', () => {
  assert.equal(
    evaluateToolPermission({ permissionLevel: 'read_only', enabled: false }).allowed,
    false
  );

  const unapproved = evaluateToolPermission({
    permissionLevel: 'restricted',
    requiresApproval: true,
    approvedByUser: false,
    enabled: true,
  });
  assert.equal(unapproved.allowed, false);
  assert.equal(unapproved.requiresApproval, true);

  const approved = evaluateToolPermission({
    permissionLevel: 'restricted',
    requiresApproval: true,
    approvedByUser: true,
    enabled: true,
  });
  assert.equal(approved.allowed, true);
});

test('validateSkillDefinition enforces semver and field lengths', () => {
  const valid = validateSkillDefinition({
    name: 'TS Audit Skill',
    version: '1.2.0',
    description: 'Audits TypeScript modules safely',
    promptTemplate: 'Review this code carefully:\n\n{{input}}',
    allowedTools: ['utc_clock', 'js_ts_ast_static_check'],
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.errors.length, 0);

  const invalid = validateSkillDefinition({
    name: 'A',
    version: 'v1',
    description: 'short',
    promptTemplate: 'short',
    allowedTools: [],
  });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.errors.length, 4);
});

test('arrangeImagesOnVoiceoverTimeline synchronizes clips across voiceover duration', () => {
  const clips = arrangeImagesOnVoiceoverTimeline(
    [
      { assetId: 'img-1-abcdef', name: 'scene1.png' },
      { assetId: 'img-2-abcdef', name: 'scene2.png' },
      { assetId: 'img-3-abcdef', name: 'scene3.png' },
    ],
    9.0
  );

  assert.equal(clips.length, 3);
  assert.equal(clips[0].startSec, 0);
  assert.equal(clips[0].transition, 'none');
  assert.equal(clips[1].transition, 'fade');
  const totalDuration = clips.reduce((acc, c) => acc + c.durationSec, 0);
  assert.equal(Number(totalDuration.toFixed(2)), 9.0);
});

test('COMMERCIAL_PLANS and quota helpers enforce tier access & limits', () => {
  assert.equal(COMMERCIAL_PLANS.length, 3);
  assert.equal(COMMERCIAL_PLANS[0].priceUsdMonthly, 0);
  assert.ok(COMMERCIAL_PLANS[2].dailyTokens > COMMERCIAL_PLANS[1].dailyTokens);

  assert.equal(canAccessModel({ role: 'user', plan: 'free' }, { requiredPlan: 'premium' }).allowed, false);
  assert.equal(canAccessModel({ role: 'developer', plan: 'free' }, { requiredPlan: 'premium' }).allowed, true);

  const warn = checkQuotaAllowance({
    dailyUsed: DEFAULT_PLAN_LIMITS.free.daily * 0.85,
    dailyLimit: DEFAULT_PLAN_LIMITS.free.daily,
    monthlyUsed: 1000,
    monthlyLimit: DEFAULT_PLAN_LIMITS.free.monthly,
  });
  assert.equal(warn.allowed, true);
  assert.equal(warn.warningThreshold, true);
});

test('computeUnifiedLineDiff produces accurate context, add, and remove lines', () => {
  const before = ['const a = 1;', 'const b = 2;', 'return a + b;'].join('\n');
  const after = ['const a = 1;', 'const b = 3;', 'const c = 4;', 'return a + b + c;'].join('\n');
  const diff = computeUnifiedLineDiff(before, after);

  assert.equal(diff[0].type, 'context');
  assert.equal(diff[0].text, 'const a = 1;');
  assert.ok(diff.some((d) => d.type === 'remove' && d.text === 'const b = 2;'));
  assert.ok(diff.some((d) => d.type === 'add' && d.text === 'const b = 3;'));
  assert.ok(diff.some((d) => d.type === 'add' && d.text === 'const c = 4;'));

  const same = computeUnifiedLineDiff('hello\nworld', 'hello\nworld');
  assert.ok(same.every((d) => d.type === 'context'));
  assert.equal(same.length, 2);
});

