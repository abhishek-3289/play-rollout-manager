import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSteps, readInputs } from '../src/inputs.js';
import { createCore } from '../src/core.js';
import { makeEnv, serviceAccountJson } from './helpers.js';

test('readInputs applies defaults', () => {
  const inputs = readInputs(makeEnv());
  assert.equal(inputs.packageName, 'com.example.app');
  assert.equal(inputs.track, 'production');
  assert.equal(inputs.command, 'advance');
  assert.deepEqual(inputs.steps, [10, 25, 50, 100]);
  assert.equal(inputs.minHoursBetweenSteps, 20);
  assert.equal(inputs.maxCrashRate, null);
  assert.equal(inputs.dryRun, false);
  assert.equal(inputs.deploymentEnvironment, 'play-production-rollout');
  assert.equal(inputs.playApiBaseUrl, 'https://androidpublisher.googleapis.com');
  assert.equal(inputs.reportingApiBaseUrl, 'https://playdeveloperreporting.googleapis.com');
  assert.equal(inputs.tokenUrl, 'https://oauth2.googleapis.com/token');
  assert.equal(inputs.githubApiUrl, 'https://api.github.com');
});

test('readInputs reads dashed input names exactly as the runner sets them', () => {
  const env = makeEnv({ track: 'beta', 'min-hours-between-steps': '0', 'dry-run': 'TRUE', 'deployment-environment': '' });
  assert.ok('INPUT_MIN-HOURS-BETWEEN-STEPS' in env);
  const inputs = readInputs(env);
  assert.equal(inputs.minHoursBetweenSteps, 0);
  assert.equal(inputs.dryRun, true);
  assert.equal(inputs.deploymentEnvironment, 'play-beta-rollout');
});

test('readInputs uses the testing overrides for every API host', () => {
  const inputs = readInputs(makeEnv({ 'api-base-url': 'http://127.0.0.1:8787/', 'token-url-override': 'http://127.0.0.1:8787/token', 'github-api-url': 'http://127.0.0.1:8787' }));
  assert.equal(inputs.playApiBaseUrl, 'http://127.0.0.1:8787');
  assert.equal(inputs.reportingApiBaseUrl, 'http://127.0.0.1:8787');
  assert.equal(inputs.tokenUrl, 'http://127.0.0.1:8787/token');
  assert.equal(inputs.githubApiUrl, 'http://127.0.0.1:8787');
});

test('parseSteps sorts and validates percentages', () => {
  assert.deepEqual(parseSteps('50, 10,100 ,25'), [10, 25, 50, 100]);
  assert.deepEqual(parseSteps('0.5,2.5,100'), [0.5, 2.5, 100]);
  assert.throws(() => parseSteps(''), /at least one/);
  assert.throws(() => parseSteps('10,abc'), /invalid percentage 'abc'/);
  assert.throws(() => parseSteps('0,50'), /greater than 0/);
  assert.throws(() => parseSteps('50,101'), /at most 100/);
  assert.throws(() => parseSteps('-5,50'), /invalid percentage/);
  assert.throws(() => parseSteps('25,25,50'), /duplicate/);
});

test('readInputs rejects invalid values', () => {
  assert.throws(() => readInputs(makeEnv({ 'package-name': '' })), /package-name is required/);
  assert.throws(() => readInputs(makeEnv({ 'package-name': 'not a package' })), /not a valid Android package name/);
  assert.throws(() => readInputs(makeEnv({ 'service-account-json': '' })), /service-account-json is required/);
  assert.throws(() => readInputs(makeEnv({ 'service-account-json': '{oops' })), /not valid JSON/);
  assert.throws(() => readInputs(makeEnv({ 'service-account-json': '{"client_email":"a@b"}' })), /missing 'private_key'/);
  assert.throws(() => readInputs(makeEnv({ command: 'rollback' })), /command must be one of/);
  assert.throws(() => readInputs(makeEnv({ command: 'set' })), /percentage is required/);
  assert.throws(() => readInputs(makeEnv({ command: 'set', percentage: '0' })), /between 1 and 100/);
  assert.throws(() => readInputs(makeEnv({ command: 'set', percentage: '150' })), /between 1 and 100/);
  assert.throws(() => readInputs(makeEnv({ 'dry-run': 'yes' })), /dry-run must be true or false/);
  assert.throws(() => readInputs(makeEnv({ 'max-crash-rate': '0' })), /max-crash-rate/);
  assert.throws(() => readInputs(makeEnv({ 'min-hours-between-steps': 'soon' })), /min-hours-between-steps/);
});

test('readInputs error messages never contain the private key', () => {
  const json = serviceAccountJson({ client_email: '' });
  assert.throws(() => readInputs(makeEnv({ 'service-account-json': json })), (error) => {
    assert.doesNotMatch(error.message, /PRIVATE KEY/);
    return true;
  });
});

test('createCore writes single and multi-line outputs to GITHUB_OUTPUT', () => {
  const dir = mkdtempSync(join(tmpdir(), 'core-'));
  try {
    const file = join(dir, 'output');
    const lines = [];
    const core = createCore({ GITHUB_OUTPUT: file }, (line) => lines.push(line));
    core.setOutput('status', 'inProgress');
    core.setOutput('reason', 'line one\nline two');
    core.mask('secret-token');
    core.warning('50% done\nnext');
    const text = readFileSync(file, 'utf8');
    assert.match(text, /^status=inProgress\n/);
    assert.match(text, /reason<<(ghadelimiter_[0-9a-f-]+)\nline one\nline two\n\1\n/);
    assert.deepEqual(lines, ['::add-mask::secret-token', '::warning::50%25 done%0Anext']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
