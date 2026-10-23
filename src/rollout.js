export function roundPercent(value) {
  return Math.round(value * 10000) / 10000;
}

export function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '-';
  return `${roundPercent(value)}%`;
}

export function selectRelease(trackBody, trackName) {
  const releases = Array.isArray(trackBody?.releases) ? trackBody.releases : [];
  const index = releases.findIndex((release) => release.status === 'inProgress' || release.status === 'halted');
  const chosen = index >= 0 ? index : releases.findIndex((release) => release.status === 'completed');
  if (chosen < 0) {
    const statuses = releases.map((release) => release.status).join(', ') || 'none';
    throw new Error(`Track '${trackName}' has no inProgress, halted or completed release (found: ${statuses})`);
  }
  const release = releases[chosen];
  let percent = 100;
  if (release.status !== 'completed') {
    const fraction = Number(release.userFraction);
    if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1) {
      throw new Error(`Release '${release.name ?? ''}' is ${release.status} but has no valid userFraction`);
    }
    percent = roundPercent(fraction * 100);
  }
  return {
    index: chosen,
    status: release.status,
    percent,
    versionName: release.name ?? '',
    versionCodes: (release.versionCodes ?? []).map(String),
  };
}

export function nextStep(currentPercent, steps) {
  return steps.find((step) => step > roundPercent(currentPercent) + 1e-9) ?? null;
}

function change(action, status, percent, reason) {
  return { action, toStatus: status, toPercent: percent, reason, changes: true };
}

function skip(release, reason) {
  return { action: 'skipped', toStatus: release.status, toPercent: release.percent, reason, changes: false };
}

function target(action, percent, reason) {
  if (percent >= 100) return change('completed', 'completed', 100, reason);
  return change(action, 'inProgress', percent, reason);
}

export function decide({ command, release, steps, percentage }) {
  const from = formatPercent(release.percent);
  switch (command) {
    case 'status':
      return { action: 'none', toStatus: release.status, toPercent: release.percent, reason: `release is ${release.status} at ${from}`, changes: false };
    case 'advance': {
      if (release.status === 'completed') return skip(release, 'release is already completed');
      if (release.status === 'halted') return skip(release, 'release is halted');
      const next = nextStep(release.percent, steps);
      if (next === null) return skip(release, `no configured step above ${from}`);
      return target('advanced', next, `advanced from ${from} to ${formatPercent(next)}`);
    }
    case 'set': {
      if (release.status === 'completed') return skip(release, 'release is already completed');
      if (release.status === 'halted') return skip(release, 'release is halted; run resume first');
      if (roundPercent(percentage) === release.percent) return skip(release, `release is already at ${from}`);
      if (percentage < release.percent) {
        throw new Error(`Cannot lower the rollout from ${from} to ${formatPercent(percentage)}; halt the release instead`);
      }
      return target('set', percentage, `set from ${from} to ${formatPercent(percentage)}`);
    }
    case 'halt':
      if (release.status === 'halted') return skip(release, 'release is already halted');
      if (release.status === 'completed') return skip(release, 'release is completed; this action only halts staged rollouts');
      return change('halted', 'halted', release.percent, `halted at ${from}`);
    case 'resume':
      if (release.status === 'inProgress') return skip(release, 'release is not halted');
      if (release.status === 'completed') return skip(release, 'release is already completed');
      return change('resumed', 'inProgress', release.percent, `resumed at ${from}`);
    case 'complete':
      if (release.status === 'completed') return skip(release, 'release is already completed');
      if (release.status === 'halted') return skip(release, 'release is halted; run resume first');
      return change('completed', 'completed', 100, `completed from ${from}`);
    default:
      throw new Error(`Unknown command '${command}'`);
  }
}

export function haltDecision(release, reason) {
  return change('halted', 'halted', release.percent, reason);
}

export function applyDecision(trackBody, release, decision) {
  const releases = trackBody.releases.map((item) => ({ ...item }));
  const updated = releases[release.index];
  updated.status = decision.toStatus;
  if (decision.toStatus === 'completed') {
    delete updated.userFraction;
  } else {
    updated.userFraction = roundPercent(decision.toPercent) / 100;
  }
  const kept = decision.toStatus === 'completed'
    ? releases.filter((item, index) => index === release.index || item.status !== 'completed')
    : releases;
  return { ...trackBody, releases: kept };
}
