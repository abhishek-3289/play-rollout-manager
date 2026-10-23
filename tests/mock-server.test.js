import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { run } from '../src/run.js';
import { createMockServer } from './mock-server.js';
import { makeCore, makeEnv, serviceAccountJson } from './helpers.js';

async function withServer(options, body) {
  const { server, requests } = createMockServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await body(base, requests);
  } finally {
    server.close();
  }
}

function env(base, inputs) {
  return makeEnv({
    'service-account-json': serviceAccountJson({ token_uri: `${base}/token` }),
    'api-base-url': base,
    'token-url-override': `${base}/token`,
    'github-api-url': base,
    'allowed-days': 'all',
    ...inputs,
  });
}

test('dry-run against the mock server reports the next step without writing', async () => {
  await withServer({}, async (base, requests) => {
    const core = makeCore();
    const result = await run({ env: env(base, { 'dry-run': 'true' }), core });
    assert.equal(result.failed, false, core.errors.join('\n'));
    assert.equal(core.outputs['action-taken'], 'advanced');
    assert.equal(core.outputs['previous-percentage'], '25');
    assert.equal(core.outputs.percentage, '50');
    assert.equal(core.outputs['version-name'], '1.2.3');
    assert.deepEqual(requests.map((request) => `${request.method} ${request.path}`), [
      'POST /token',
      'POST /androidpublisher/v3/applications/com.example.app/edits',
      'GET /androidpublisher/v3/applications/com.example.app/edits/mock-edit/tracks/production',
      'GET /repos/octo/app/deployments',
      'DELETE /androidpublisher/v3/applications/com.example.app/edits/mock-edit',
    ]);
  });
});

test('a real advance against the mock server commits and records history', async () => {
  await withServer({}, async (base, requests) => {
    const core = makeCore();
    const result = await run({ env: env(base, {}), core });
    assert.equal(result.failed, false, core.errors.join('\n'));
    assert.deepEqual(requests.map((request) => `${request.method} ${request.path}`).slice(4), [
      'PUT /androidpublisher/v3/applications/com.example.app/edits/mock-edit/tracks/production',
      'POST /androidpublisher/v3/applications/com.example.app/edits/mock-edit:commit',
      'POST /repos/octo/app/deployments',
      'POST /repos/octo/app/deployments/1/statuses',
    ]);
  });
});

test('the mock server rejects requests without the issued token', async () => {
  await withServer({}, async (base) => {
    const response = await fetch(`${base}/androidpublisher/v3/applications/com.example.app/edits`, { method: 'POST' });
    assert.equal(response.status, 401);
  });
});
