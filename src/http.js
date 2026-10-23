export class HttpError extends Error {
  constructor(label, status, detail) {
    super(`${label} failed: HTTP ${status}${detail ? ` - ${detail}` : ''}`);
    this.status = status;
    this.detail = detail;
  }
}

export function extractErrorMessage(text) {
  if (!text) return '';
  try {
    const body = JSON.parse(text);
    if (body && typeof body.error === 'object' && body.error !== null) {
      return [body.error.status, body.error.message].filter(Boolean).join(': ');
    }
    if (body && typeof body.error === 'string') {
      return [body.error, body.error_description].filter(Boolean).join(': ');
    }
    if (body && typeof body.message === 'string') return body.message;
  } catch {
    return text.slice(0, 300);
  }
  return text.slice(0, 300);
}

export async function requestJson(fetchImpl, { label, method = 'GET', url, headers = {}, body, form }) {
  const init = { method, headers: { Accept: 'application/json', ...headers } };
  if (form !== undefined) {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(form).toString();
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    throw new Error(`${label} failed: ${error.message}`);
  }
  const text = await response.text();
  if (!response.ok) throw new HttpError(label, response.status, extractErrorMessage(text));
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned a response that is not JSON`);
  }
}
