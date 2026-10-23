import { requestJson } from './http.js';

function previousDay({ year, month, day }) {
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - 1);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

export function buildCrashRateQuery(latestEndTime, versionCodes) {
  const timeZone = latestEndTime.timeZone ?? { id: 'America/Los_Angeles' };
  const end = { year: latestEndTime.year, month: latestEndTime.month, day: latestEndTime.day };
  return {
    timelineSpec: {
      aggregationPeriod: 'DAILY',
      startTime: { ...previousDay(end), timeZone },
      endTime: { ...end, timeZone },
    },
    dimensions: ['versionCode'],
    metrics: ['crashRate', 'distinctUsers'],
    filter: versionCodes.map((code) => `versionCode = ${code}`).join(' OR '),
  };
}

function metricValue(row, name) {
  const metric = (row.metrics ?? []).find((item) => item.metric === name);
  const raw = metric?.decimalValue?.value;
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(value) ? value : null;
}

function dimensionValue(row, name) {
  const dimension = (row.dimensions ?? []).find((item) => item.dimension === name);
  if (!dimension) return null;
  return String(dimension.stringValue ?? dimension.int64Value ?? '');
}

export function evaluateCrashRows(rows, versionCodes) {
  const wanted = new Set(versionCodes.map(String));
  const perVersion = [];
  for (const row of rows ?? []) {
    const code = dimensionValue(row, 'versionCode');
    if (code === null || !wanted.has(code)) continue;
    const rate = metricValue(row, 'crashRate');
    if (rate === null) continue;
    perVersion.push({ versionCode: code, crashRatePercent: rate * 100, distinctUsers: metricValue(row, 'distinctUsers') });
  }
  if (perVersion.length === 0) return null;
  return perVersion.reduce((worst, item) => (item.crashRatePercent > worst.crashRatePercent ? item : worst));
}

export async function checkCrashRate({ fetchImpl, baseUrl, token, packageName, versionCodes, maxCrashRate }) {
  const root = `${baseUrl}/v1beta1/apps/${encodeURIComponent(packageName)}/crashRateMetricSet`;
  const headers = { Authorization: `Bearer ${token}` };
  const metricSet = await requestJson(fetchImpl, { label: 'Play Developer Reporting crashRateMetricSet.get', url: root, headers });
  const daily = (metricSet.freshnessInfo?.freshnesses ?? []).find((item) => item.aggregationPeriod === 'DAILY');
  if (!daily?.latestEndTime) {
    return { ok: false, unavailable: true, reason: 'crash rate data freshness is unavailable' };
  }
  const query = buildCrashRateQuery(daily.latestEndTime, versionCodes);
  const result = await requestJson(fetchImpl, {
    label: 'Play Developer Reporting crashRateMetricSet.query',
    method: 'POST',
    url: `${root}:query`,
    headers,
    body: query,
  });
  const worst = evaluateCrashRows(result.rows, versionCodes);
  const day = `${query.timelineSpec.startTime.year}-${String(query.timelineSpec.startTime.month).padStart(2, '0')}-${String(query.timelineSpec.startTime.day).padStart(2, '0')}`;
  if (!worst) {
    return { ok: false, unavailable: true, reason: `no crash rate data for version codes ${versionCodes.join(', ')} on ${day}` };
  }
  const rate = Math.round(worst.crashRatePercent * 1000) / 1000;
  if (worst.crashRatePercent > maxCrashRate) {
    return { ok: false, unavailable: false, rate, reason: `crash rate ${rate}% for version code ${worst.versionCode} on ${day} exceeds ${maxCrashRate}%` };
  }
  return { ok: true, rate, reason: `crash rate ${rate}% for version code ${worst.versionCode} on ${day} is within ${maxCrashRate}%` };
}
