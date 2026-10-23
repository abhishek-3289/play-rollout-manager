import { createSign } from 'node:crypto';
import { requestJson } from './http.js';

export const PUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
export const REPORTING_SCOPE = 'https://www.googleapis.com/auth/playdeveloperreporting';

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

export function buildJwt({ clientEmail, privateKey, tokenUri }, scopes, nowSeconds) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: clientEmail,
    scope: scopes.join(' '),
    aud: tokenUri,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  let signature;
  try {
    signature = signer.sign(privateKey).toString('base64url');
  } catch {
    throw new Error('Could not sign the token request with the service account private_key');
  }
  return `${signingInput}.${signature}`;
}

export async function fetchAccessToken(fetchImpl, { serviceAccount, scopes, tokenUrl, now }) {
  const assertion = buildJwt(serviceAccount, scopes, Math.floor(now().getTime() / 1000));
  const body = await requestJson(fetchImpl, {
    label: 'Google OAuth token exchange',
    method: 'POST',
    url: tokenUrl,
    form: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    },
  });
  if (typeof body.access_token !== 'string' || body.access_token === '') {
    throw new Error('Google OAuth token exchange returned no access_token');
  }
  return body.access_token;
}
