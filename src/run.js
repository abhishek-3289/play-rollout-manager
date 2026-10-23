import { createCore } from './core.js';
import { getInput, readInputs } from './inputs.js';
import { fetchAccessToken, PUBLISHER_SCOPE, REPORTING_SCOPE } from './auth.js';
import { createPlayClient } from './play.js';
import { createHistory } from './history.js';
import { checkCrashRate } from './crash.js';
import { applyDecision, decide, formatPercent, haltDecision, roundPercent, selectRelease } from './rollout.js';
import { formatSlackMessage, postSlack, shouldNotify } from './slack.js';
import { renderSummary } from './summary.js';

function runUrl(env) {
  if (!env.GITHUB_SERVER_URL || !env.GITHUB_REPOSITORY || !env.GITHUB_RUN_ID) return '';
  return `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
}

function looseBoolean(value) {
  return value.toLowerCase() === 'true';
}

async function guardAdvance({ inputs, release, decision, fetchImpl, token, history, now, core, notes }) {
  if (inputs.maxCrashRate !== null) {
    const crash = await checkCrashRate({
      fetchImpl,
      baseUrl: inputs.reportingApiBaseUrl,
      token,
      packageName: inputs.packageName,
      versionCodes: release.versionCodes,
      maxCrashRate: inputs.maxCrashRate,
    });
    core.info(`Crash guard: ${crash.reason}`);
    if (!crash.ok && !crash.unavailable) return haltDecision(release, `crash guard: ${crash.reason}`);
    if (!crash.ok) {
      return { action: 'skipped', toStatus: release.status, toPercent: release.percent, reason: `crash guard: ${crash.reason}; not advancing`, changes: false };
    }
    notes.push(`Crash guard: ${crash.reason}`);
  }

  if (inputs.minHoursBetweenSteps > 0) {
    let last = null;
    try {
      last = await history.lastIncrease({ packageName: inputs.packageName, track: inputs.track });
    } catch (error) {
      if (inputs.requireHistory) throw new Error(`Rollout history is unavailable and require-history is true: ${error.message}`);
      core.warning(`Could not read rollout history, skipping the min-hours-between-steps check: ${error.message}`);
      notes.push('Rollout history was unavailable, so min-hours-between-steps was not checked');
    }
    if (last) {
      const hours = (now().getTime() - last.createdAt.getTime()) / 3600000;
      if (hours < inputs.minHoursBetweenSteps) {
        return {
          action: 'skipped',
          toStatus: release.status,
          toPercent: release.percent,
          reason: `last rollout increase was ${hours.toFixed(1)} hours ago; min-hours-between-steps is ${inputs.minHoursBetweenSteps}`,
          changes: false,
        };
      }
    }
  }
  return decision;
}

async function execute({ env, fetchImpl, now, core, context }) {
  const inputs = readInputs(env);
  context.inputs = inputs;

  const scopes = inputs.maxCrashRate === null ? [PUBLISHER_SCOPE] : [PUBLISHER_SCOPE, REPORTING_SCOPE];
  const token = await fetchAccessToken(fetchImpl, { serviceAccount: inputs.serviceAccount, scopes, tokenUrl: inputs.tokenUrl, now });
  core.mask(token);

  const play = createPlayClient({ fetchImpl, baseUrl: inputs.playApiBaseUrl, token, packageName: inputs.packageName });
  const history = createHistory({
    fetchImpl,
    apiUrl: inputs.githubApiUrl,
    token: inputs.githubToken,
    repository: env.GITHUB_REPOSITORY,
    environment: inputs.deploymentEnvironment,
  });
  const notes = [];

  const editId = await play.insertEdit();
  let editOpen = true;
  const discardEdit = async () => {
    editOpen = false;
    try {
      await play.deleteEdit(editId);
    } catch (error) {
      core.warning(`Could not delete edit ${editId}: ${error.message}`);
    }
  };

  let release;
  let decision;
  try {
    const trackBody = await play.getTrack(editId, inputs.track);
    release = selectRelease(trackBody, inputs.track);
    context.versionName = release.versionName;
    context.fromPercent = release.percent;
    core.info(`Current release ${release.versionName || '(unnamed)'} [${release.versionCodes.join(', ')}] is ${release.status} at ${formatPercent(release.percent)}`);

    decision = decide({ command: inputs.command, release, steps: inputs.steps, percentage: inputs.percentage });
    if (inputs.command === 'advance' && decision.changes) {
      decision = await guardAdvance({ inputs, release, decision, fetchImpl, token, history, now, core, notes });
    }
    core.info(`Decision: ${decision.action} (${decision.reason})`);

    if (decision.changes && !inputs.dryRun) {
      await play.updateTrack(editId, inputs.track, applyDecision(trackBody, release, decision));
      await play.commitEdit(editId, inputs.changesNotSentForReview);
      editOpen = false;
    } else {
      await discardEdit();
    }
  } finally {
    if (editOpen) await discardEdit();
  }

  const applied = decision.changes && !inputs.dryRun;
  if (applied) {
    const description = `${release.versionName} ${formatPercent(release.percent)} → ${formatPercent(decision.toPercent)}`.trim().slice(0, 140);
    try {
      await history.record({
        ref: env.GITHUB_SHA,
        description,
        logUrl: runUrl(env),
        productionEnvironment: inputs.track === 'production',
        payload: {
          packageName: inputs.packageName,
          track: inputs.track,
          versionName: release.versionName,
          versionCodes: release.versionCodes,
          fromPercent: release.percent,
          toPercent: decision.toPercent,
          command: inputs.command,
          action: decision.action,
        },
      });
    } catch (error) {
      if (inputs.requireHistory) {
        throw new Error(`The change was applied in Google Play, but recording rollout history failed and require-history is true: ${error.message}`);
      }
      core.warning(`The change was applied, but recording rollout history failed: ${error.message}`);
      notes.push('Rollout history could not be recorded for this change');
    }
  }

  return {
    packageName: inputs.packageName,
    track: inputs.track,
    command: inputs.command,
    dryRun: inputs.dryRun,
    versionName: release.versionName,
    versionCodes: release.versionCodes,
    previousStatus: release.status,
    previousPercent: release.percent,
    status: decision.toStatus,
    percent: decision.toPercent,
    actionTaken: decision.action,
    changes: decision.changes,
    reason: inputs.dryRun && decision.changes ? `dry run, not applied: ${decision.reason}` : decision.reason,
    notes,
    failed: false,
  };
}

async function notify({ fetchImpl, core, webhookUrl, flags, message }) {
  if (!webhookUrl || !shouldNotify({ event: message.event, ...flags })) return false;
  try {
    await postSlack(fetchImpl, webhookUrl, formatSlackMessage(message));
    return true;
  } catch (error) {
    core.warning(error.message);
    return false;
  }
}

export async function run({ env = process.env, fetchImpl = globalThis.fetch, now = () => new Date(), core = createCore(env) } = {}) {
  const context = { versionName: '', fromPercent: null, inputs: null };
  const url = runUrl(env);
  try {
    const result = await execute({ env, fetchImpl, now, core, context });
    core.setOutput('version-name', result.versionName);
    core.setOutput('version-codes', result.versionCodes.join(','));
    core.setOutput('status', result.status);
    core.setOutput('previous-percentage', roundPercent(result.previousPercent));
    core.setOutput('percentage', roundPercent(result.percent));
    core.setOutput('action-taken', result.actionTaken);
    core.setOutput('reason', result.reason);
    core.summary(renderSummary(result));
    const { inputs } = context;
    result.notified = await notify({
      fetchImpl,
      core,
      webhookUrl: inputs.slackWebhookUrl,
      flags: { dryRun: inputs.dryRun, notifyOnSkip: inputs.notifyOnSkip, notifyOnDryRun: inputs.notifyOnDryRun },
      message: {
        event: result.actionTaken,
        dryRun: inputs.dryRun,
        packageName: inputs.packageName,
        track: inputs.track,
        versionName: result.versionName,
        fromPercent: result.previousPercent,
        toPercent: result.percent,
        reason: result.reason,
        runUrl: url,
      },
    });
    return result;
  } catch (error) {
    core.error(error.message);
    const dryRun = looseBoolean(getInput(env, 'dry-run'));
    const notified = await notify({
      fetchImpl,
      core,
      webhookUrl: getInput(env, 'slack-webhook-url'),
      flags: { dryRun, notifyOnSkip: false, notifyOnDryRun: looseBoolean(getInput(env, 'notify-on-dry-run')) },
      message: {
        event: 'failed',
        dryRun,
        packageName: getInput(env, 'package-name') || '(unknown package)',
        track: getInput(env, 'track') || 'production',
        versionName: context.versionName,
        fromPercent: context.fromPercent,
        toPercent: null,
        reason: error.message,
        runUrl: url,
      },
    });
    return { failed: true, error: error.message, notified };
  }
}
