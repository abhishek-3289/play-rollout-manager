import { formatPercent } from './rollout.js';

function cell(value) {
  return String(value ?? '-').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function renderSummary(result) {
  const title = result.dryRun ? '### Play rollout (dry run)' : '### Play rollout';
  const lines = [
    title,
    '',
    `**${cell(result.packageName)}** on track **${cell(result.track)}**, command \`${cell(result.command)}\``,
    '',
    '| | Before | After |',
    '|:--|:--|:--|',
    `| Version | ${cell(result.versionName)} | ${cell(result.versionName)} |`,
    `| Version codes | ${cell(result.versionCodes.join(', '))} | ${cell(result.versionCodes.join(', '))} |`,
    `| Status | ${cell(result.previousStatus)} | ${cell(result.status)} |`,
    `| Rollout | ${formatPercent(result.previousPercent)} | ${formatPercent(result.percent)} |`,
    '',
    `**Action:** ${cell(result.actionTaken)}${result.dryRun && result.changes ? ' (not applied)' : ''}`,
    '',
    `**Reason:** ${cell(result.reason)}`,
  ];
  for (const note of result.notes ?? []) {
    lines.push('', `- ${cell(note)}`);
  }
  return `${lines.join('\n')}\n`;
}
