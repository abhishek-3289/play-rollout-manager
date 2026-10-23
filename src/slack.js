import { formatPercent } from './rollout.js';

const TITLES = {
  advanced: 'Rollout advanced',
  completed: 'Rollout completed',
  halted: 'Rollout halted',
  resumed: 'Rollout resumed',
  set: 'Rollout percentage set',
  skipped: 'Rollout step skipped',
  failed: 'Rollout manager failed',
};

const ICONS = {
  advanced: ':arrow_up:',
  completed: ':white_check_mark:',
  halted: ':octagonal_sign:',
  resumed: ':arrow_forward:',
  set: ':level_slider:',
  skipped: ':fast_forward:',
  failed: ':x:',
};

export function shouldNotify({ event, dryRun, notifyOnSkip, notifyOnDryRun }) {
  if (!TITLES[event]) return false;
  if (event === 'skipped' && !notifyOnSkip) return false;
  if (dryRun && !notifyOnDryRun) return false;
  return true;
}

export function formatSlackMessage({ event, dryRun, packageName, track, versionName, fromPercent, toPercent, reason, runUrl }) {
  const prefix = dryRun ? '[dry run] ' : '';
  const version = versionName ? ` ${versionName}` : '';
  const lines = [`${ICONS[event]} ${prefix}*${TITLES[event]}*: ${packageName} (${track})${version}`];
  if (fromPercent !== null && fromPercent !== undefined) {
    const to = toPercent === null || toPercent === undefined ? '' : ` → ${formatPercent(toPercent)}`;
    lines.push(`Rollout: ${formatPercent(fromPercent)}${to}`);
  }
  if (reason) lines.push(`Reason: ${reason}`);
  if (runUrl) lines.push(`Run: ${runUrl}`);
  return { text: lines.join('\n') };
}

export async function postSlack(fetchImpl, webhookUrl, payload) {
  let response;
  try {
    response = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw new Error(`Slack notification failed: ${error.message}`);
  }
  if (!response.ok) {
    const text = (await response.text()).slice(0, 200);
    throw new Error(`Slack notification failed: HTTP ${response.status}${text ? ` - ${text}` : ''}`);
  }
}
