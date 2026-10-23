import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verify } from 'node:crypto';
import { buildJwt, fetchAccessToken, PUBLISHER_SCOPE, REPORTING_SCOPE } from '../src/auth.js';
import { parseServiceAccount } from '../src/inputs.js';
import { fakeFetch, keys, serviceAccountJson, TOKEN } from './helpers.js';

function decode(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString());
}

test('buildJwt produces an RS256 JWT with the expected header and claims', () => {
  const account = parseServiceAccount(serviceAccountJson());
  const jwt = buildJwt(account, [PUBLISHER_SCOPE], 1_700_000_000);
  const [header, claims, signature] = jwt.split('.');
  assert.deepEqual(decode(header), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(decode(claims), {
    iss: 'rollout@example-project.iam.gserviceaccount.com',
    scope: PUBLISHER_SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    iat: 1_700_000_000,
    exp: 1_700_003_600,
  });
  const valid = verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), keys().publicKey, Buffer.from(signature, 'base64url'));
  assert.equal(valid, true);
});

test('buildJwt joins multiple scopes with a space', () => {
  const account = parseServiceAccount(serviceAccountJson());
  const claims = decode(buildJwt(account, [PUBLISHER_SCOPE, REPORTING_SCOPE], 1).split('.')[1]);
  assert.equal(claims.scope, `${PUBLISHER_SCOPE} ${REPORTING_SCOPE}`);
});

test('buildJwt rejects an unusable private key without echoing it', () => {
  const account = parseServiceAccount(serviceAccountJson({ private_key: '-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----\n' }));
  assert.throws(() => buildJwt(account, [PUBLISHER_SCOPE], 1), (error) => {
    assert.match(error.message, /Could not sign/);
    assert.doesNotMatch(error.message, /not-a-key/);
    return true;
  });
});

test('fetchAccessToken exchanges a signed assertion at the token endpoint', async () => {
  const { fetchImpl, calls } = fakeFetch([
    { method: 'POST', url: 'https://oauth2.googleapis.com/token', respond: { body: { access_token: TOKEN } } },
  ]);
  const token = await fetchAccessToken(fetchImpl, {
    serviceAccount: parseServiceAccount(serviceAccountJson()),
    scopes: [PUBLISHER_SCOPE],
    tokenUrl: 'https://oauth2.googleapis.com/token',
    now: () => new Date(1_700_000_000_000),
  });
  assert.equal(token, TOKEN);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers['Content-Type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(calls[0].body);
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const claims = decode(form.get('assertion').split('.')[1]);
  assert.equal(claims.iat, 1_700_000_000);
});

test('fetchAccessToken surfaces the OAuth error description', async () => {
  const { fetchImpl } = fakeFetch([
    { method: 'POST', url: 'https://token.test/', respond: { status: 400, body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } } },
  ]);
  await assert.rejects(
    fetchAccessToken(fetchImpl, {
      serviceAccount: parseServiceAccount(serviceAccountJson()),
      scopes: [PUBLISHER_SCOPE],
      tokenUrl: 'https://token.test/',
      now: () => new Date(),
    }),
    /Google OAuth token exchange failed: HTTP 400 - invalid_grant: Invalid JWT Signature\./,
  );
});

test('fetchAccessToken fails when no access_token is returned', async () => {
  const { fetchImpl } = fakeFetch([{ method: 'POST', url: 'https://token.test/', respond: { body: {} } }]);
  await assert.rejects(
    fetchAccessToken(fetchImpl, {
      serviceAccount: parseServiceAccount(serviceAccountJson()),
      scopes: [PUBLISHER_SCOPE],
      tokenUrl: 'https://token.test/',
      now: () => new Date(),
    }),
    /returned no access_token/,
  );
});
