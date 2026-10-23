import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export const MOCK_TOKEN = 'mock-access-token';

export function defaultTrack(track) {
  return {
    track,
    releases: [
      { name: '1.2.3', versionCodes: ['123'], status: 'inProgress', userFraction: 0.25 },
      { name: '1.2.2', versionCodes: ['122'], status: 'completed' },
    ],
  };
}

function send(res, status, body) {
  if (status === 204) {
    res.writeHead(204);
    res.end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function validAssertion(assertion) {
  const parts = (assertion ?? '').split('.');
  if (parts.length !== 3) return false;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    return header.alg === 'RS256' && typeof claims.iss === 'string' && claims.exp - claims.iat === 3600;
  } catch {
    return false;
  }
}

export function createMockServer({ trackFor = defaultTrack, deployments = [] } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      const url = new URL(req.url, 'http://mock');
      const path = url.pathname;
      if (req.method === 'GET' && path === '/__requests') {
        send(res, 200, requests);
        return;
      }
      requests.push({ method: req.method, path, query: url.search });

      if (req.method === 'POST' && path === '/token') {
        const form = new URLSearchParams(raw);
        if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer' || !validAssertion(form.get('assertion'))) {
          send(res, 400, { error: 'invalid_grant', error_description: 'Invalid JWT.' });
          return;
        }
        send(res, 200, { access_token: MOCK_TOKEN, expires_in: 3599, token_type: 'Bearer' });
        return;
      }

      if (req.headers.authorization !== `Bearer ${MOCK_TOKEN}` && !path.startsWith('/repos/')) {
        send(res, 401, { error: { code: 401, status: 'UNAUTHENTICATED', message: 'Missing or invalid token' } });
        return;
      }

      const edits = path.match(/^\/androidpublisher\/v3\/applications\/([^/]+)\/edits(?:\/([^/:]+))?(?::commit)?(?:\/tracks\/([^/]+))?$/);
      if (edits) {
        const [, , editId, track] = edits;
        if (req.method === 'POST' && !editId) return send(res, 200, { id: 'mock-edit' });
        if (req.method === 'GET' && track) return send(res, 200, trackFor(decodeURIComponent(track)));
        if (req.method === 'PUT' && track) return send(res, 200, JSON.parse(raw || '{}'));
        if (req.method === 'POST' && path.endsWith(':commit')) return send(res, 200, { id: editId });
        if (req.method === 'DELETE' && editId) return send(res, 204);
      }

      if (/^\/repos\/[^/]+\/[^/]+\/deployments$/.test(path)) {
        if (req.method === 'GET') return send(res, 200, deployments);
        if (req.method === 'POST') return send(res, 201, { id: 1 });
      }
      if (req.method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/deployments\/\d+\/statuses$/.test(path)) {
        return send(res, 201, { id: 1, state: 'success' });
      }

      send(res, 404, { error: { code: 404, status: 'NOT_FOUND', message: `No mock for ${req.method} ${path}` } });
    });
  });
  return { server, requests };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.MOCK_PORT || 8787);
  const { server } = createMockServer();
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`mock server listening on http://127.0.0.1:${port}\n`);
  });
}
