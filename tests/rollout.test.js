import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDecision, decide, formatPercent, nextStep, selectRelease } from '../src/rollout.js';
import { parseSteps } from '../src/inputs.js';

const STEPS = [10, 25, 50, 100];

function staged(status, percent) {
  return { index: 0, status, percent, versionName: '1.2.3', versionCodes: ['123'] };
}

test('nextStep picks the smallest step strictly above the current percentage', () => {
  assert.equal(nextStep(10, STEPS), 25);
  assert.equal(nextStep(24.9, STEPS), 25);
  assert.equal(nextStep(25, STEPS), 50);
  assert.equal(nextStep(50, STEPS), 100);
  assert.equal(nextStep(1, STEPS), 10);
  assert.equal(nextStep(100, STEPS), null);
});

test('nextStep works with custom steps', () => {
  const steps = parseSteps('1,5,20,60');
  assert.equal(nextStep(5, steps), 20);
  assert.equal(nextStep(20, steps), 60);
  assert.equal(nextStep(60, steps), null);
  assert.equal(nextStep(0.5, steps), 1);
});

test('advance moves to the next step', () => {
  const decision = decide({ command: 'advance', release: staged('inProgress', 10), steps: STEPS });
  assert.equal(decision.action, 'advanced');
  assert.equal(decision.toStatus, 'inProgress');
  assert.equal(decision.toPercent, 25);
  assert.equal(decision.changes, true);
});

test('advance from 24.9% goes to 25%', () => {
  const decision = decide({ command: 'advance', release: staged('inProgress', 24.9), steps: STEPS });
  assert.equal(decision.toPercent, 25);
});

test('advance from 50% to the 100% step completes the rollout', () => {
  const decision = decide({ command: 'advance', release: staged('inProgress', 50), steps: STEPS });
  assert.equal(decision.action, 'completed');
  assert.equal(decision.toStatus, 'completed');
  assert.equal(decision.toPercent, 100);
});

test('advance skips when the release is already completed', () => {
  const decision = decide({ command: 'advance', release: staged('completed', 100), steps: STEPS });
  assert.equal(decision.action, 'skipped');
  assert.equal(decision.reason, 'release is already completed');
  assert.equal(decision.changes, false);
});

test('advance never touches a halted release', () => {
  const decision = decide({ command: 'advance', release: staged('halted', 25), steps: STEPS });
  assert.equal(decision.action, 'skipped');
  assert.equal(decision.reason, 'release is halted');
  assert.equal(decision.toStatus, 'halted');
  assert.equal(decision.changes, false);
});

test('advance skips when no configured step is above the current percentage', () => {
  const decision = decide({ command: 'advance', release: staged('inProgress', 60), steps: [10, 25, 50] });
  assert.equal(decision.action, 'skipped');
  assert.match(decision.reason, /no configured step above 60%/);
});

test('set raises the percentage and completes at 100', () => {
  const raised = decide({ command: 'set', release: staged('inProgress', 25), steps: STEPS, percentage: 40 });
  assert.equal(raised.action, 'set');
  assert.equal(raised.toPercent, 40);
  assert.equal(raised.toStatus, 'inProgress');
  const full = decide({ command: 'set', release: staged('inProgress', 25), steps: STEPS, percentage: 100 });
  assert.equal(full.action, 'completed');
  assert.equal(full.toStatus, 'completed');
});

test('set refuses to lower the rollout and skips no-op or halted releases', () => {
  assert.throws(() => decide({ command: 'set', release: staged('inProgress', 50), steps: STEPS, percentage: 25 }), /Cannot lower the rollout from 50% to 25%/);
  assert.equal(decide({ command: 'set', release: staged('inProgress', 50), steps: STEPS, percentage: 50 }).action, 'skipped');
  const halted = decide({ command: 'set', release: staged('halted', 25), steps: STEPS, percentage: 50 });
  assert.equal(halted.action, 'skipped');
  assert.match(halted.reason, /halted; run resume first/);
  assert.equal(decide({ command: 'set', release: staged('completed', 100), steps: STEPS, percentage: 50 }).action, 'skipped');
});

test('halt keeps the fraction and only applies to inProgress releases', () => {
  const halted = decide({ command: 'halt', release: staged('inProgress', 25), steps: STEPS });
  assert.deepEqual([halted.action, halted.toStatus, halted.toPercent], ['halted', 'halted', 25]);
  assert.equal(decide({ command: 'halt', release: staged('halted', 25), steps: STEPS }).action, 'skipped');
  assert.equal(decide({ command: 'halt', release: staged('completed', 100), steps: STEPS }).action, 'skipped');
});

test('resume un-halts and keeps the fraction', () => {
  const resumed = decide({ command: 'resume', release: staged('halted', 25), steps: STEPS });
  assert.deepEqual([resumed.action, resumed.toStatus, resumed.toPercent], ['resumed', 'inProgress', 25]);
  assert.equal(decide({ command: 'resume', release: staged('inProgress', 25), steps: STEPS }).reason, 'release is not halted');
  assert.equal(decide({ command: 'resume', release: staged('completed', 100), steps: STEPS }).action, 'skipped');
});

test('complete finishes an inProgress release but not a halted one', () => {
  const completed = decide({ command: 'complete', release: staged('inProgress', 25), steps: STEPS });
  assert.deepEqual([completed.action, completed.toStatus, completed.toPercent], ['completed', 'completed', 100]);
  assert.match(decide({ command: 'complete', release: staged('halted', 25), steps: STEPS }).reason, /halted; run resume first/);
  assert.equal(decide({ command: 'complete', release: staged('completed', 100), steps: STEPS }).action, 'skipped');
});

test('status only reports', () => {
  const decision = decide({ command: 'status', release: staged('inProgress', 25), steps: STEPS });
  assert.equal(decision.action, 'none');
  assert.equal(decision.changes, false);
  assert.equal(decision.reason, 'release is inProgress at 25%');
});

test('selectRelease prefers the staged release over the completed one', () => {
  const track = {
    releases: [
      { name: '1.2.2', versionCodes: ['122'], status: 'completed' },
      { name: '1.2.3', versionCodes: [123, 124], status: 'halted', userFraction: 0.1 },
    ],
  };
  assert.deepEqual(selectRelease(track, 'production'), { index: 1, status: 'halted', percent: 10, versionName: '1.2.3', versionCodes: ['123', '124'] });
});

test('selectRelease reports a completed rollout at 100%', () => {
  const selected = selectRelease({ releases: [{ name: '1.2.2', versionCodes: ['122'], status: 'completed' }] }, 'production');
  assert.equal(selected.status, 'completed');
  assert.equal(selected.percent, 100);
});

test('selectRelease fails when there is no usable release', () => {
  assert.throws(() => selectRelease({ releases: [{ name: 'x', status: 'draft' }] }, 'beta'), /Track 'beta' has no inProgress, halted or completed release \(found: draft\)/);
  assert.throws(() => selectRelease({}, 'beta'), /found: none/);
  assert.throws(() => selectRelease({ releases: [{ status: 'inProgress' }] }, 'beta'), /no valid userFraction/);
});

test('applyDecision sets userFraction for staged statuses', () => {
  const track = { track: 'production', releases: [{ name: '1.2.3', versionCodes: ['123'], status: 'inProgress', userFraction: 0.1 }, { name: '1.2.2', status: 'completed' }] };
  const release = selectRelease(track, 'production');
  const updated = applyDecision(track, release, { toStatus: 'inProgress', toPercent: 25 });
  assert.deepEqual(updated.releases, [{ name: '1.2.3', versionCodes: ['123'], status: 'inProgress', userFraction: 0.25 }, { name: '1.2.2', status: 'completed' }]);
  assert.equal(track.releases[0].userFraction, 0.1);
  const halted = applyDecision(track, release, { toStatus: 'halted', toPercent: 10 });
  assert.equal(halted.releases[0].status, 'halted');
  assert.equal(halted.releases[0].userFraction, 0.1);
  assert.equal(halted.releases.length, 2);
});

test('applyDecision completing removes userFraction and the previous completed release', () => {
  const track = { track: 'production', releases: [{ name: '1.2.2', status: 'completed' }, { name: '1.2.3', versionCodes: ['123'], status: 'inProgress', userFraction: 0.5 }] };
  const updated = applyDecision(track, selectRelease(track, 'production'), { toStatus: 'completed', toPercent: 100 });
  assert.deepEqual(updated.releases, [{ name: '1.2.3', versionCodes: ['123'], status: 'completed' }]);
});

test('formatPercent trims floating point noise', () => {
  assert.equal(formatPercent(0.1 * 3 * 100), '30%');
  assert.equal(formatPercent(12.5), '12.5%');
  assert.equal(formatPercent(null), '-');
});
