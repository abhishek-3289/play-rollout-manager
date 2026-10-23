import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/run.js';
import { PUBLISHER_SCOPE, REPORTING_SCOPE } from '../src/auth.js';
import {
  deployment,
  deploymentRoutes,
  fakeFetch,
  makeCore,
  makeEnv,
  NOW,
  playRoutes,
  release,
  REPORTING,
  sequence,
  SLACK,
  slackRoutes,
  TOKEN,
} from './helpers.js';

async function execute({ inputs = {}, extraEnv = {}, play = {}, deployments = {}, slackStatus = 200, extraRoutes = [], now = NOW } = {}) {
  const { fetchImpl, calls } = fakeFetch([...extraRoutes, ...playRoutes(play), ...deploymentRoutes(deployments), ...slackRoutes(slackStatus)]);
  const core = makeCore();
  const result = await run({ env: makeEnv(inputs, extraEnv), fetchImpl, now: () => now, core });
  return { result, calls, core };
}

function find(calls, method, pattern) {
  return calls.filter((call) => call.method === method && pattern.test(call.url));
}

function jwtClaims(calls) {
  const token = calls.find((call) => call.url === 'https://oauth2.googleapis.com/token');
  return JSON.parse(Buffer.from(new URLSearchParams(token.body).get('assertion').split('.')[1], 'base64url').toString());
}

test('advance applies the next step and records a deployment', async () => {
  const { result, calls, core } = await execute({
    play: { releases: [release(), release({ name: '1.2.2', versionCodes: ['122'], status: 'completed', userFraction: undefined })] },
  });
  assert.equal(result.failed, false);
  assert.deepEqual(sequence(calls), [
    'POST /token',
    'POST /androidpublisher/v3/applications/com.example.app/edits',
    'GET /androidpublisher/v3/applications/com.example.app/edits/edit-1/tracks/production',
    'GET /repos/octo/app/deployments?environment=play-production-rollout&task=play-rollout&per_page=50',
    'PUT /androidpublisher/v3/applications/com.example.app/edits/edit-1/tracks/production',
    'POST /androidpublisher/v3/applications/com.example.app/edits/edit-1:commit',
    'POST /repos/octo/app/deployments',
    'POST /repos/octo/app/deployments/77/statuses',
  ]);
  const put = find(calls, 'PUT', /tracks/)[0];
  assert.equal(put.headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(put.body.releases, [
    { name: '1.2.3', versionCodes: ['123'], status: 'inProgress', userFraction: 0.5 },
    { name: '1.2.2', versionCodes: ['122'], status: 'completed' },
  ]);
  const created = find(calls, 'POST', /deployments$/)[0];
  assert.equal(created.headers.Authorization, 'Bearer ghs_test');
  assert.deepEqual(created.body, {
    ref: 'abc123',
    task: 'play-rollout',
    environment: 'play-production-rollout',
    auto_merge: false,
    required_contexts: [],
    payload: {
      packageName: 'com.example.app',
      track: 'production',
      versionName: '1.2.3',
      versionCodes: ['123'],
      fromPercent: 25,
      toPercent: 50,
      command: 'advance',
      action: 'advanced',
    },
    description: '1.2.3 25% → 50%',
    production_environment: true,
  });
  const status = find(calls, 'POST', /statuses$/)[0];
  assert.deepEqual(status.body, {
    state: 'success',
    description: '1.2.3 25% → 50%',
    environment: 'play-production-rollout',
    log_url: 'https://github.com/octo/app/actions/runs/42',
  });
  assert.deepEqual(core.outputs, {
    'version-name': '1.2.3',
    'version-codes': '123',
    status: 'inProgress',
    'previous-percentage': '25',
    percentage: '50',
    'action-taken': 'advanced',
    reason: 'advanced from 25% to 50%',
  });
  assert.deepEqual(core.masked, [TOKEN]);
  assert.deepEqual(jwtClaims(calls).scope, PUBLISHER_SCOPE);
  assert.match(core.summaries[0], /\| Rollout \| 25% \| 50% \|/);
  assert.match(core.summaries[0], /\| Status \| inProgress \| inProgress \|/);
  assert.equal(calls.some((call) => call.url === SLACK), false);
  for (const line of [...core.infos, ...core.warnings, ...core.errors, ...core.summaries]) {
    assert.doesNotMatch(line, new RegExp(TOKEN));
    assert.doesNotMatch(line, /PRIVATE KEY/);
  }
});

test('advance from 50% completes the rollout and drops the previous completed release', async () => {
  const { result, calls, core } = await execute({
    play: { releases: [release({ name: '1.2.2', versionCodes: ['122'], status: 'completed', userFraction: undefined }), release({ userFraction: 0.5 })] },
  });
  assert.equal(result.actionTaken, 'completed');
  assert.deepEqual(find(calls, 'PUT', /tracks/)[0].body.releases, [{ name: '1.2.3', versionCodes: ['123'], status: 'completed' }]);
  assert.equal(core.outputs.status, 'completed');
  assert.equal(core.outputs.percentage, '100');
});

test('changes-not-sent-for-review is passed to edits.commit', async () => {
  const { calls } = await execute({ inputs: { 'changes-not-sent-for-review': 'true' } });
  assert.equal(find(calls, 'POST', /:commit/)[0].url.endsWith(':commit?changesNotSentForReview=true'), true);
});

test('status only reads and deletes the edit', async () => {
  const { result, calls, core } = await execute({ inputs: { command: 'status' } });
  assert.deepEqual(sequence(calls), [
    'POST /token',
    'POST /androidpublisher/v3/applications/com.example.app/edits',
    'GET /androidpublisher/v3/applications/com.example.app/edits/edit-1/tracks/production',
    'DELETE /androidpublisher/v3/applications/com.example.app/edits/edit-1',
  ]);
  assert.equal(result.actionTaken, 'none');
  assert.equal(core.outputs['action-taken'], 'none');
  assert.equal(core.outputs.percentage, '25');
});

test('advance does not touch a halted release', async () => {
  const { result, calls } = await execute({ play: { releases: [release({ status: 'halted' })] } });
  assert.equal(result.actionTaken, 'skipped');
  assert.equal(result.reason, 'release is halted');
  assert.equal(find(calls, 'PUT', /./).length, 0);
  assert.equal(find(calls, 'POST', /:commit/).length, 0);
  assert.equal(find(calls, 'DELETE', /edits\/edit-1$/).length, 1);
  assert.equal(find(calls, 'POST', /deployments/).length, 0);
});

test('halt sets the release to halted and keeps the fraction', async () => {
  const { result, calls } = await execute({ inputs: { command: 'halt' } });
  assert.equal(result.actionTaken, 'halted');
  assert.deepEqual(find(calls, 'PUT', /tracks/)[0].body.releases, [{ name: '1.2.3', versionCodes: ['123'], status: 'halted', userFraction: 0.25 }]);
  assert.equal(find(calls, 'GET', /deployments/).length, 0);
  assert.equal(find(calls, 'POST', /deployments$/)[0].body.payload.action, 'halted');
  assert.equal(find(calls, 'POST', /deployments$/)[0].body.description, '1.2.3 25% → 25%');
});

test('resume sets a halted release back to inProgress', async () => {
  const { result, calls } = await execute({ inputs: { command: 'resume' }, play: { releases: [release({ status: 'halted', userFraction: 0.1 })] } });
  assert.equal(result.actionTaken, 'resumed');
  assert.deepEqual(find(calls, 'PUT', /tracks/)[0].body.releases[0], { name: '1.2.3', versionCodes: ['123'], status: 'inProgress', userFraction: 0.1 });
});

test('set and complete apply their targets', async () => {
  const set = await execute({ inputs: { command: 'set', percentage: '40' } });
  assert.equal(set.result.actionTaken, 'set');
  assert.equal(find(set.calls, 'PUT', /tracks/)[0].body.releases[0].userFraction, 0.4);
  assert.equal(find(set.calls, 'GET', /deployments/).length, 0);
  const complete = await execute({ inputs: { command: 'complete' } });
  assert.equal(complete.result.actionTaken, 'completed');
  assert.equal(find(complete.calls, 'PUT', /tracks/)[0].body.releases[0].status, 'completed');
});

test('advance skips when the last increase is newer than min-hours-between-steps', async () => {
  const { result, calls, core } = await execute({ deployments: { list: [deployment({ hoursAgo: 5 })] } });
  assert.equal(result.actionTaken, 'skipped');
  assert.equal(core.outputs.reason, 'last rollout increase was 5.0 hours ago; min-hours-between-steps is 20');
  assert.equal(find(calls, 'PUT', /./).length, 0);
  assert.equal(find(calls, 'DELETE', /edits\/edit-1$/).length, 1);
  assert.equal(find(calls, 'POST', /deployments/).length, 0);
});

test('advance proceeds when the last increase is old enough', async () => {
  const { result } = await execute({ deployments: { list: [deployment({ hoursAgo: 30 })] } });
  assert.equal(result.actionTaken, 'advanced');
});

test('min-hours check ignores other packages, other tracks and non-increasing actions', async () => {
  const list = [
    deployment({ hoursAgo: 1, id: 9, packageName: 'com.example.other' }),
    deployment({ hoursAgo: 2, id: 8, track: 'beta' }),
    deployment({ hoursAgo: 3, id: 7, action: 'halted' }),
    { id: 6, created_at: new Date(NOW.getTime() - 3600000).toISOString(), payload: '' },
    deployment({ hoursAgo: 26, id: 5 }),
  ];
  const { result } = await execute({ deployments: { list } });
  assert.equal(result.actionTaken, 'advanced');
  const blocked = await execute({ deployments: { list: [...list, { ...deployment({ hoursAgo: 4, id: 4 }), payload: JSON.stringify(deployment({ hoursAgo: 4 }).payload) }] } });
  assert.equal(blocked.result.actionTaken, 'skipped');
});

test('min-hours-between-steps 0 skips the history lookup', async () => {
  const { result, calls } = await execute({ inputs: { 'min-hours-between-steps': '0' }, deployments: { list: [deployment({ hoursAgo: 1 })] } });
  assert.equal(result.actionTaken, 'advanced');
  assert.equal(find(calls, 'GET', /deployments/).length, 0);
});

test('deployments API failures warn and do not block the rollout', async () => {
  const { result, calls, core } = await execute({ deployments: { listStatus: 403, createStatus: 403 } });
  assert.equal(result.failed, false);
  assert.equal(result.actionTaken, 'advanced');
  assert.equal(find(calls, 'POST', /:commit/).length, 1);
  assert.equal(core.warnings.length, 2);
  assert.match(core.warnings[0], /Could not read rollout history.*HTTP 403 - Resource not accessible by integration/);
  assert.match(core.warnings[1], /recording rollout history failed/);
});

test('missing github-token disables history with a warning', async () => {
  const { result, calls, core } = await execute({ inputs: { 'github-token': '' } });
  assert.equal(result.actionTaken, 'advanced');
  assert.equal(find(calls, 'GET', /deployments/).length, 0);
  assert.match(core.warnings[0], /github-token or GITHUB_REPOSITORY is not set/);
});

test('require-history fails before applying when deployments cannot be read', async () => {
  const { result, calls, core } = await execute({ inputs: { 'require-history': 'true' }, deployments: { listStatus: 403 } });
  assert.equal(result.failed, true);
  assert.match(core.errors[0], /require-history is true/);
  assert.equal(find(calls, 'PUT', /./).length, 0);
  assert.equal(find(calls, 'DELETE', /edits\/edit-1$/).length, 1);
});

test('require-history fails the run when recording fails after the change', async () => {
  const { result, calls, core } = await execute({ inputs: { 'require-history': 'true' }, deployments: { createStatus: 500 } });
  assert.equal(result.failed, true);
  assert.equal(find(calls, 'POST', /:commit/).length, 1);
  assert.match(core.errors[0], /The change was applied in Google Play, but recording rollout history failed/);
});

test('dry-run reports the decision, deletes the edit and writes nothing', async () => {
  const { result, calls, core } = await execute({ inputs: { 'dry-run': 'true', 'slack-webhook-url': SLACK } });
  assert.equal(result.actionTaken, 'advanced');
  assert.equal(core.outputs.percentage, '50');
  assert.equal(core.outputs.reason, 'dry run, not applied: advanced from 25% to 50%');
  assert.equal(find(calls, 'PUT', /./).length, 0);
  assert.equal(find(calls, 'POST', /:commit/).length, 0);
  assert.equal(find(calls, 'POST', /deployments/).length, 0);
  assert.equal(find(calls, 'DELETE', /edits\/edit-1$/).length, 1);
  assert.equal(calls.some((call) => call.url === SLACK), false);
  assert.match(core.summaries[0], /dry run/);
});

test('dry-run notifies Slack only with notify-on-dry-run', async () => {
  const { calls } = await execute({ inputs: { 'dry-run': 'true', 'notify-on-dry-run': 'true', 'slack-webhook-url': SLACK } });
  const slack = calls.filter((call) => call.url === SLACK);
  assert.equal(slack.length, 1);
  assert.match(slack[0].body.text, /^:arrow_up: \[dry run\] \*Rollout advanced\*/);
});

test('Slack success message has package, track, version, percentages and run URL', async () => {
  const { calls, result } = await execute({ inputs: { 'slack-webhook-url': SLACK } });
  assert.equal(result.notified, true);
  const slack = calls.filter((call) => call.url === SLACK);
  assert.equal(slack.length, 1);
  assert.deepEqual(slack[0].body, {
    text: [
      ':arrow_up: *Rollout advanced*: com.example.app (production) 1.2.3',
      'Rollout: 25% → 50%',
      'Reason: advanced from 25% to 50%',
      'Run: https://github.com/octo/app/actions/runs/42',
    ].join('\n'),
  });
});

test('Slack is told about skips only with notify-on-skip', async () => {
  const quiet = await execute({ inputs: { 'slack-webhook-url': SLACK }, play: { releases: [release({ status: 'halted' })] } });
  assert.equal(quiet.calls.some((call) => call.url === SLACK), false);
  const loud = await execute({ inputs: { 'slack-webhook-url': SLACK, 'notify-on-skip': 'true' }, play: { releases: [release({ status: 'halted' })] } });
  const slack = loud.calls.filter((call) => call.url === SLACK);
  assert.equal(slack.length, 1);
  assert.match(slack[0].body.text, /^:fast_forward: \*Rollout step skipped\*: com\.example\.app \(production\) 1\.2\.3\nRollout: 25% → 25%\nReason: release is halted\n/);
});

test('Slack is not notified for the status command', async () => {
  const { calls } = await execute({ inputs: { command: 'status', 'slack-webhook-url': SLACK, 'notify-on-skip': 'true' } });
  assert.equal(calls.some((call) => call.url === SLACK), false);
});

test('Play API errors are surfaced, the edit is deleted and Slack is told', async () => {
  const { result, calls, core } = await execute({
    inputs: { 'slack-webhook-url': SLACK },
    play: { failOn: { put: { status: 403, body: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } } } } },
  });
  assert.equal(result.failed, true);
  assert.equal(core.errors[0], 'Google Play edits.tracks.update failed: HTTP 403 - PERMISSION_DENIED: The caller does not have permission');
  assert.equal(find(calls, 'POST', /:commit/).length, 0);
  assert.equal(find(calls, 'DELETE', /edits\/edit-1$/).length, 1);
  assert.deepEqual(core.outputs, {});
  const slack = calls.filter((call) => call.url === SLACK);
  assert.equal(slack.length, 1);
  assert.equal(slack[0].body.text, [
    ':x: *Rollout manager failed*: com.example.app (production) 1.2.3',
    'Rollout: 25%',
    'Reason: Google Play edits.tracks.update failed: HTTP 403 - PERMISSION_DENIED: The caller does not have permission',
    'Run: https://github.com/octo/app/actions/runs/42',
  ].join('\n'));
});

test('commit errors are surfaced and the edit is cleaned up', async () => {
  const { result, calls, core } = await execute({ play: { failOn: { commit: { status: 400, body: { error: { message: 'Release is in an invalid state' } } } } } });
  assert.equal(result.failed, true);
  assert.match(core.errors[0], /edits\.commit failed: HTTP 400 - Release is in an invalid state/);
  assert.equal(find(calls, 'DELETE', /edits\/edit-1$/).length, 1);
  assert.equal(find(calls, 'POST', /deployments/).length, 0);
});

test('track errors are surfaced and delete failures only warn', async () => {
  const { result, core } = await execute({
    play: { failOn: { get: { status: 404, body: { error: { message: 'Track not found' } } }, delete: { status: 500, body: {} } } },
  });
  assert.equal(result.failed, true);
  assert.match(core.errors[0], /edits\.tracks\.get failed: HTTP 404 - Track not found/);
  assert.match(core.warnings[0], /Could not delete edit edit-1/);
});

test('token exchange failures are surfaced and notified', async () => {
  const { result, calls, core } = await execute({ inputs: { 'slack-webhook-url': SLACK }, play: { tokenStatus: 400 } });
  assert.equal(result.failed, true);
  assert.equal(result.notified, true);
  assert.match(core.errors[0], /Google OAuth token exchange failed: HTTP 400 - invalid_grant: Invalid JWT Signature\./);
  assert.equal(calls.filter((call) => /androidpublisher/.test(call.url)).length, 0);
  assert.match(calls.find((call) => call.url === SLACK).body.text, /^:x: \*Rollout manager failed\*: com\.example\.app \(production\)\nReason: /);
});

test('invalid inputs fail and notify', async () => {
  const { result, calls, core } = await execute({ inputs: { command: 'rollback', 'slack-webhook-url': SLACK } });
  assert.equal(result.failed, true);
  assert.match(core.errors[0], /command must be one of/);
  assert.equal(calls.filter((call) => call.url === SLACK).length, 1);
});

test('Slack failures only warn', async () => {
  const { result, core } = await execute({ inputs: { 'slack-webhook-url': SLACK }, slackStatus: 400 });
  assert.equal(result.failed, false);
  assert.equal(result.notified, false);
  assert.match(core.warnings[0], /Slack notification failed: HTTP 400 - invalid_payload/);
  assert.doesNotMatch(core.warnings[0], /hooks\.slack/);
});

function crashRoutes({ rate, versionCode = '123', freshness = true, queryStatus = 200 }) {
  const routes = [
    {
      method: 'GET',
      url: REPORTING,
      respond: {
        body: {
          name: 'apps/com.example.app/crashRateMetricSet',
          freshnessInfo: freshness
            ? { freshnesses: [{ aggregationPeriod: 'HOURLY', latestEndTime: { year: 2026, month: 3, day: 10, hours: 3 } }, { aggregationPeriod: 'DAILY', latestEndTime: { year: 2026, month: 3, day: 1, timeZone: { id: 'America/Los_Angeles' } } }] }
            : {},
        },
      },
    },
    {
      method: 'POST',
      url: `${REPORTING}:query`,
      respond: queryStatus === 200
        ? {
            body: {
              rows: rate === undefined ? [] : [
                {
                  aggregationPeriod: 'DAILY',
                  startTime: { year: 2026, month: 2, day: 28 },
                  dimensions: [{ dimension: 'versionCode', stringValue: versionCode }],
                  metrics: [
                    { metric: 'crashRate', decimalValue: { value: String(rate) } },
                    { metric: 'distinctUsers', decimalValue: { value: '5000' } },
                  ],
                },
              ],
            },
          }
        : { status: queryStatus, body: { error: { status: 'PERMISSION_DENIED', message: 'Reporting API has not been used in project' } } },
    },
  ];
  return routes;
}

test('crash guard halts instead of advancing above the threshold', async () => {
  const { result, calls, core } = await execute({ inputs: { 'max-crash-rate': '1.5', 'slack-webhook-url': SLACK }, extraRoutes: crashRoutes({ rate: 0.021 }) });
  assert.equal(result.actionTaken, 'halted');
  assert.equal(core.outputs.status, 'halted');
  assert.equal(core.outputs.reason, 'crash guard: crash rate 2.1% for version code 123 on 2026-02-28 exceeds 1.5%');
  assert.deepEqual(find(calls, 'PUT', /tracks/)[0].body.releases[0], { name: '1.2.3', versionCodes: ['123'], status: 'halted', userFraction: 0.25 });
  assert.equal(find(calls, 'GET', /deployments/).length, 0);
  assert.equal(jwtClaims(calls).scope, `${PUBLISHER_SCOPE} ${REPORTING_SCOPE}`);
  const query = find(calls, 'POST', /crashRateMetricSet:query$/)[0];
  assert.equal(query.headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(query.body, {
    timelineSpec: {
      aggregationPeriod: 'DAILY',
      startTime: { year: 2026, month: 2, day: 28, timeZone: { id: 'America/Los_Angeles' } },
      endTime: { year: 2026, month: 3, day: 1, timeZone: { id: 'America/Los_Angeles' } },
    },
    dimensions: ['versionCode'],
    metrics: ['crashRate', 'distinctUsers'],
    filter: 'versionCode = 123',
  });
  assert.match(calls.find((call) => call.url === SLACK).body.text, /^:octagonal_sign: \*Rollout halted\*/);
});

test('crash guard advances below the threshold', async () => {
  const { result, calls } = await execute({ inputs: { 'max-crash-rate': '1.5' }, extraRoutes: crashRoutes({ rate: 0.004 }) });
  assert.equal(result.actionTaken, 'advanced');
  assert.equal(find(calls, 'PUT', /tracks/)[0].body.releases[0].userFraction, 0.5);
  assert.match(result.notes[0], /crash rate 0.4% for version code 123 on 2026-02-28 is within 1.5%/);
});

test('crash guard skips when there is no data for the release', async () => {
  const noRows = await execute({ inputs: { 'max-crash-rate': '1.5' }, extraRoutes: crashRoutes({ rate: undefined }) });
  assert.equal(noRows.result.actionTaken, 'skipped');
  assert.match(noRows.result.reason, /no crash rate data for version codes 123/);
  const otherVersion = await execute({ inputs: { 'max-crash-rate': '1.5' }, extraRoutes: crashRoutes({ rate: 0.5, versionCode: '999' }) });
  assert.equal(otherVersion.result.actionTaken, 'skipped');
  const noFreshness = await execute({ inputs: { 'max-crash-rate': '1.5' }, extraRoutes: crashRoutes({ rate: 0.001, freshness: false }) });
  assert.equal(noFreshness.result.actionTaken, 'skipped');
  assert.match(noFreshness.result.reason, /freshness is unavailable/);
});

test('crash guard API errors fail the run', async () => {
  const { result, calls, core } = await execute({ inputs: { 'max-crash-rate': '1.5' }, extraRoutes: crashRoutes({ rate: 0.001, queryStatus: 403 }) });
  assert.equal(result.failed, true);
  assert.match(core.errors[0], /crashRateMetricSet\.query failed: HTTP 403 - PERMISSION_DENIED: Reporting API has not been used in project/);
  assert.equal(find(calls, 'DELETE', /edits\/edit-1$/).length, 1);
});

test('crash guard is not consulted for halted releases or other commands', async () => {
  const halted = await execute({ inputs: { 'max-crash-rate': '1.5' }, play: { releases: [release({ status: 'halted' })] }, extraRoutes: crashRoutes({ rate: 0.5 }) });
  assert.equal(halted.result.actionTaken, 'skipped');
  assert.equal(halted.calls.some((call) => call.url.startsWith(REPORTING)), false);
  const set = await execute({ inputs: { 'max-crash-rate': '1.5', command: 'set', percentage: '40' }, extraRoutes: crashRoutes({ rate: 0.5 }) });
  assert.equal(set.result.actionTaken, 'set');
  assert.equal(set.calls.some((call) => call.url.startsWith(REPORTING)), false);
});

test('crash guard uses the worst rate across multiple version codes', async () => {
  const routes = crashRoutes({ rate: 0.001 });
  routes[1].respond.body.rows.push({
    dimensions: [{ dimension: 'versionCode', stringValue: '124' }],
    metrics: [{ metric: 'crashRate', decimalValue: { value: '0.03' } }],
  });
  const { result, calls } = await execute({
    inputs: { 'max-crash-rate': '1.5' },
    play: { releases: [release({ versionCodes: ['123', '124'] })] },
    extraRoutes: routes,
  });
  assert.equal(result.actionTaken, 'halted');
  assert.match(result.reason, /3% for version code 124/);
  assert.equal(find(calls, 'POST', /:query$/)[0].body.filter, 'versionCode = 123 OR versionCode = 124');
});

const SATURDAY = new Date('2026-03-14T16:00:00Z');

test('advance skips outside allowed-days without writing or reading history', async () => {
  const { result, calls, core } = await execute({ now: SATURDAY });
  assert.equal(result.failed, false);
  assert.equal(result.actionTaken, 'skipped');
  assert.equal(result.reason, 'today is Saturday in UTC; allowed-days is mon-fri');
  assert.equal(core.outputs['action-taken'], 'skipped');
  assert.equal(core.outputs.percentage, '25');
  assert.equal(find(calls, 'PUT', /./).length, 0);
  assert.equal(find(calls, 'POST', /:commit/).length, 0);
  assert.equal(find(calls, 'GET', /deployments/).length, 0);
  assert.equal(find(calls, 'DELETE', /edits\/edit-1$/).length, 1);
});

test('advance is allowed on a weekend day listed in allowed-days', async () => {
  const { result } = await execute({ now: SATURDAY, inputs: { 'allowed-days': 'mon-sat' } });
  assert.equal(result.actionTaken, 'advanced');
});

test('allowed-days all advances every day', async () => {
  const { result } = await execute({ now: SATURDAY, inputs: { 'allowed-days': 'all' } });
  assert.equal(result.actionTaken, 'advanced');
});

test('timezone decides which day it is', async () => {
  const fridayEveningUtc = new Date('2026-03-13T20:00:00Z');
  const utc = await execute({ now: fridayEveningUtc });
  assert.equal(utc.result.actionTaken, 'advanced');
  const kolkata = await execute({ now: fridayEveningUtc, inputs: { timezone: 'Asia/Kolkata' } });
  assert.equal(kolkata.result.actionTaken, 'skipped');
  assert.equal(kolkata.result.reason, 'today is Saturday in Asia/Kolkata; allowed-days is mon-fri');
});

test('skips outside allowed-days notify Slack only with notify-on-skip', async () => {
  const quiet = await execute({ now: SATURDAY, inputs: { 'slack-webhook-url': SLACK } });
  assert.equal(quiet.calls.some((call) => call.url === SLACK), false);
  const loud = await execute({ now: SATURDAY, inputs: { 'slack-webhook-url': SLACK, 'notify-on-skip': 'true' } });
  assert.equal(loud.calls.some((call) => call.url === SLACK), true);
});

test('manual commands work outside allowed-days', async () => {
  const halt = await execute({ now: SATURDAY, inputs: { command: 'halt' } });
  assert.equal(halt.result.actionTaken, 'halted');
  const set = await execute({ now: SATURDAY, inputs: { command: 'set', percentage: '50' } });
  assert.equal(set.result.actionTaken, 'set');
  const complete = await execute({ now: SATURDAY, inputs: { command: 'complete' } });
  assert.equal(complete.result.actionTaken, 'completed');
  const resume = await execute({ now: SATURDAY, inputs: { command: 'resume' }, play: { releases: [release({ status: 'halted' })] } });
  assert.equal(resume.result.actionTaken, 'resumed');
});

test('crash guard still halts outside allowed-days', async () => {
  const { result, calls } = await execute({ now: SATURDAY, inputs: { 'max-crash-rate': '1.5' }, extraRoutes: crashRoutes({ rate: 0.021 }) });
  assert.equal(result.actionTaken, 'halted');
  assert.equal(find(calls, 'PUT', /tracks/)[0].body.releases[0].status, 'halted');
});

test('a healthy crash guard does not override allowed-days', async () => {
  const { result, calls } = await execute({ now: SATURDAY, inputs: { 'max-crash-rate': '1.5' }, extraRoutes: crashRoutes({ rate: 0.004 }) });
  assert.equal(result.actionTaken, 'skipped');
  assert.match(result.reason, /^today is Saturday/);
  assert.equal(find(calls, 'PUT', /./).length, 0);
});
