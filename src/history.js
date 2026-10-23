import { requestJson } from './http.js';

export const DEPLOYMENT_TASK = 'play-rollout';
export const INCREASING_ACTIONS = ['advanced', 'set', 'completed'];

function parsePayload(payload) {
  if (payload && typeof payload === 'object') return payload;
  if (typeof payload === 'string' && payload !== '') {
    try {
      return JSON.parse(payload);
    } catch {
      return {};
    }
  }
  return {};
}

export function createHistory({ fetchImpl, apiUrl, token, repository, environment }) {
  const available = Boolean(token && repository);
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const base = `${apiUrl}/repos/${repository}/deployments`;

  return {
    available,
    async lastIncrease({ packageName, track }) {
      if (!available) throw new Error('github-token or GITHUB_REPOSITORY is not set');
      const query = new URLSearchParams({ environment, task: DEPLOYMENT_TASK, per_page: '50' });
      const list = await requestJson(fetchImpl, {
        label: 'GitHub list deployments',
        url: `${base}?${query}`,
        headers,
      });
      if (!Array.isArray(list)) throw new Error('GitHub list deployments returned an unexpected response');
      const matching = list
        .map((deployment) => ({ deployment, payload: parsePayload(deployment.payload) }))
        .filter(({ payload }) => payload.packageName === packageName && payload.track === track)
        .filter(({ payload }) => payload.action === undefined || INCREASING_ACTIONS.includes(payload.action))
        .sort((a, b) => Date.parse(b.deployment.created_at) - Date.parse(a.deployment.created_at));
      if (matching.length === 0) return null;
      const { deployment, payload } = matching[0];
      return { id: deployment.id, createdAt: new Date(deployment.created_at), payload };
    },
    async record({ ref, payload, description, logUrl, productionEnvironment }) {
      if (!available) throw new Error('github-token or GITHUB_REPOSITORY is not set');
      if (!ref) throw new Error('GITHUB_SHA is not set');
      const deployment = await requestJson(fetchImpl, {
        label: 'GitHub create deployment',
        method: 'POST',
        url: base,
        headers,
        body: {
          ref,
          task: DEPLOYMENT_TASK,
          environment,
          auto_merge: false,
          required_contexts: [],
          payload,
          description,
          production_environment: productionEnvironment,
        },
      });
      if (!deployment.id) throw new Error(`GitHub create deployment returned no id${deployment.message ? `: ${deployment.message}` : ''}`);
      await requestJson(fetchImpl, {
        label: 'GitHub create deployment status',
        method: 'POST',
        url: `${base}/${deployment.id}/statuses`,
        headers,
        body: {
          state: 'success',
          description,
          environment,
          ...(logUrl ? { log_url: logUrl } : {}),
        },
      });
      return deployment.id;
    },
  };
}
