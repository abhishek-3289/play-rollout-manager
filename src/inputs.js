export const COMMANDS = ['advance', 'set', 'halt', 'resume', 'complete', 'status'];

export class InputError extends Error {}

export function getInput(env, name) {
  const value = env[`INPUT_${name.toUpperCase()}`];
  return value === undefined ? '' : String(value).trim();
}

export function parseBoolean(value, name, fallback = false) {
  if (value === '') return fallback;
  const lower = value.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  throw new InputError(`${name} must be true or false, got '${value}'`);
}

function parseNumber(value, name) {
  if (!/^\d+(\.\d+)?$/.test(value)) throw new InputError(`${name} must be a non-negative number, got '${value}'`);
  return Number(value);
}

export function parseSteps(value) {
  const parts = value.split(',').map((part) => part.trim()).filter((part) => part !== '');
  if (parts.length === 0) throw new InputError('steps must contain at least one percentage');
  const steps = parts.map((part) => {
    if (!/^\d+(\.\d+)?$/.test(part)) throw new InputError(`steps contains an invalid percentage '${part}'`);
    const step = Number(part);
    if (step <= 0 || step > 100) throw new InputError(`steps values must be greater than 0 and at most 100, got '${part}'`);
    return step;
  });
  const sorted = [...steps].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] === sorted[i - 1]) throw new InputError(`steps contains the duplicate value ${sorted[i]}`);
  }
  return sorted;
}

export function parseServiceAccount(json) {
  if (!json) throw new InputError('service-account-json is required');
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new InputError('service-account-json is not valid JSON');
  }
  for (const field of ['client_email', 'private_key']) {
    if (typeof parsed[field] !== 'string' || parsed[field] === '') {
      throw new InputError(`service-account-json is missing '${field}'`);
    }
  }
  return {
    clientEmail: parsed.client_email,
    privateKey: parsed.private_key,
    tokenUri: parsed.token_uri || 'https://oauth2.googleapis.com/token',
  };
}

export function readInputs(env) {
  const packageName = getInput(env, 'package-name');
  if (!packageName) throw new InputError('package-name is required');
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(packageName)) {
    throw new InputError(`package-name '${packageName}' is not a valid Android package name`);
  }

  const serviceAccount = parseServiceAccount(getInput(env, 'service-account-json'));
  const track = getInput(env, 'track') || 'production';

  const command = (getInput(env, 'command') || 'advance').toLowerCase();
  if (!COMMANDS.includes(command)) {
    throw new InputError(`command must be one of ${COMMANDS.join(', ')}, got '${command}'`);
  }

  const steps = parseSteps(getInput(env, 'steps') || '10,25,50,100');

  let percentage = null;
  const rawPercentage = getInput(env, 'percentage');
  if (command === 'set') {
    if (!rawPercentage) throw new InputError('percentage is required when command is set');
    percentage = parseNumber(rawPercentage, 'percentage');
    if (percentage < 1 || percentage > 100) throw new InputError(`percentage must be between 1 and 100, got '${rawPercentage}'`);
  }

  const rawMinHours = getInput(env, 'min-hours-between-steps');
  const minHoursBetweenSteps = rawMinHours === '' ? 20 : parseNumber(rawMinHours, 'min-hours-between-steps');

  const rawCrashRate = getInput(env, 'max-crash-rate');
  let maxCrashRate = null;
  if (rawCrashRate !== '') {
    maxCrashRate = parseNumber(rawCrashRate, 'max-crash-rate');
    if (maxCrashRate <= 0 || maxCrashRate > 100) throw new InputError(`max-crash-rate must be greater than 0 and at most 100, got '${rawCrashRate}'`);
  }

  return {
    packageName,
    serviceAccount,
    track,
    command,
    steps,
    percentage,
    minHoursBetweenSteps,
    maxCrashRate,
    changesNotSentForReview: parseBoolean(getInput(env, 'changes-not-sent-for-review'), 'changes-not-sent-for-review'),
    dryRun: parseBoolean(getInput(env, 'dry-run'), 'dry-run'),
    githubToken: getInput(env, 'github-token'),
    deploymentEnvironment: getInput(env, 'deployment-environment') || `play-${track}-rollout`,
    requireHistory: parseBoolean(getInput(env, 'require-history'), 'require-history'),
    slackWebhookUrl: getInput(env, 'slack-webhook-url'),
    notifyOnSkip: parseBoolean(getInput(env, 'notify-on-skip'), 'notify-on-skip'),
    notifyOnDryRun: parseBoolean(getInput(env, 'notify-on-dry-run'), 'notify-on-dry-run'),
    playApiBaseUrl: (getInput(env, 'api-base-url') || 'https://androidpublisher.googleapis.com').replace(/\/+$/, ''),
    reportingApiBaseUrl: (getInput(env, 'api-base-url') || 'https://playdeveloperreporting.googleapis.com').replace(/\/+$/, ''),
    tokenUrl: getInput(env, 'token-url-override') || serviceAccount.tokenUri,
    githubApiUrl: (getInput(env, 'github-api-url') || env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''),
  };
}
