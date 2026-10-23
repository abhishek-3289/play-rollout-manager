import { generateKeyPairSync } from 'node:crypto';

export const PACKAGE = 'com.example.app';
export const TOKEN = 'ya29.test-access-token';
export const PLAY = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.example.app';
export const REPORTING = 'https://playdeveloperreporting.googleapis.com/v1beta1/apps/com.example.app/crashRateMetricSet';
export const DEPLOYMENTS = 'https://api.github.com/repos/octo/app/deployments';
export const SLACK = 'https://hooks.slack.test/services/T000/B000/XXXX';
export const NOW = new Date('2026-03-10T16:00:00Z');

let cachedKeys;
export function keys() {
  if (!cachedKeys) {
    cachedKeys = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
  }
  return cachedKeys;
}

export function serviceAccountJson(overrides = {}) {
  return JSON.stringify({
    type: 'service_account',
    client_email: 'rollout@example-project.iam.gserviceaccount.com',
    private_key: keys().privateKey,
    token_uri: 'https://oauth2.googleapis.com/token',
    ...overrides,
  });
}

export function makeEnv(inputs = {}, extra = {}) {
  const env = {
    GITHUB_REPOSITORY: 'octo/app',
    GITHUB_SHA: 'abc123',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_RUN_ID: '42',
    GITHUB_API_URL: 'https://api.github.com',
    ...extra,
  };
  const all = {
    'package-name': PACKAGE,
    'service-account-json': serviceAccountJson(),
    'github-token': 'ghs_test',
    ...inputs,
  };
  for (const [name, value] of Object.entries(all)) {
    if (value !== undefined) env[`INPUT_${name.toUpperCase()}`] = String(value);
  }
  return env;
}

export function makeCore() {
  const core = {
    outputs: {},
    summaries: [],
    infos: [],
    warnings: [],
    errors: [],
    masked: [],
    info: (message) => core.infos.push(message),
    warning: (message) => core.warnings.push(message),
    error: (message) => core.errors.push(message),
    mask: (value) => core.masked.push(value),
    setOutput: (name, value) => {
      core.outputs[name] = String(value);
    },
    summary: (markdown) => core.summaries.push(markdown),
  };
  return core;
}

function jsonResponse(status, body) {
  const text = body === undefined || status === 204 ? null : typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text,{ status, headers: { 'Content-Type': 'application/json' } });
}

export function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    let body = init.body;
    if (typeof body === 'string' && (init.headers?.['Content-Type'] ?? '').includes('json')) body = JSON.parse(body);
    const call = { method, url: String(url), headers: init.headers ?? {}, body };
    calls.push(call);
    for (const route of routes) {
      if (route.method === method && (typeof route.url === 'string' ? route.url === call.url : route.url.test(call.url))) {
        const result = typeof route.respond === 'function' ? await route.respond(call) : route.respond;
        if (result instanceof Error) throw result;
        return jsonResponse(result.status ?? 200, result.body);
      }
    }
    return jsonResponse(599, { error: { message: `unexpected request ${method} ${call.url}` } });
  };
  return { fetchImpl, calls };
}

export function release(overrides = {}) {
  return { name: '1.2.3', versionCodes: ['123'], status: 'inProgress', userFraction: 0.25, ...overrides };
}

export function playRoutes({ releases = [release()], track = 'production', tokenStatus = 200, failOn = {} } = {}) {
  const fail = (key, fallback) => (failOn[key] ? { status: failOn[key].status, body: failOn[key].body } : fallback);
  return [
    { method: 'POST', url: 'https://oauth2.googleapis.com/token', respond: tokenStatus === 200 ? { body: { access_token: TOKEN, expires_in: 3599, token_type: 'Bearer' } } : { status: tokenStatus, body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } } },
    { method: 'POST', url: `${PLAY}/edits`, respond: fail('insert', { body: { id: 'edit-1', expiryTimeSeconds: '1773161200' } }) },
    { method: 'GET', url: `${PLAY}/edits/edit-1/tracks/${track}`, respond: fail('get', { body: { track, releases } }) },
    { method: 'PUT', url: `${PLAY}/edits/edit-1/tracks/${track}`, respond: (call) => fail('put', { body: call.body }) },
    { method: 'POST', url: new RegExp(`^${PLAY.replace(/\./g, '\\.')}/edits/edit-1:commit`), respond: fail('commit', { body: { id: 'edit-1' } }) },
    { method: 'DELETE', url: `${PLAY}/edits/edit-1`, respond: fail('delete', { status: 204 }) },
  ];
}

export function deploymentRoutes({ list = [], listStatus = 200, createStatus = 201 } = {}) {
  return [
    { method: 'GET', url: new RegExp(`^${DEPLOYMENTS}\\?`), respond: listStatus === 200 ? { body: list } : { status: listStatus, body: { message: 'Resource not accessible by integration' } } },
    { method: 'POST', url: DEPLOYMENTS, respond: createStatus === 201 ? { status: 201, body: { id: 77 } } : { status: createStatus, body: { message: 'Resource not accessible by integration' } } },
    { method: 'POST', url: `${DEPLOYMENTS}/77/statuses`, respond: { status: 201, body: { id: 1, state: 'success' } } },
  ];
}

export function slackRoutes(status = 200) {
  return [{ method: 'POST', url: SLACK, respond: { status, body: status === 200 ? 'ok' : 'invalid_payload' } }];
}

export function deployment({ hoursAgo, action = 'advanced', packageName = PACKAGE, track = 'production', id = 5 }) {
  return {
    id,
    created_at: new Date(NOW.getTime() - hoursAgo * 3600000).toISOString(),
    payload: { packageName, track, action, fromPercent: 10, toPercent: 25, command: 'advance' },
  };
}

export function sequence(calls) {
  return calls.map((call) => `${call.method} ${call.url.replace(/^https:\/\/[^/]+/, '')}`);
}
