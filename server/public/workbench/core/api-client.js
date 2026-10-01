export class ApiError extends Error {
  constructor(message, { status = 0, requestId = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.requestId = requestId;
  }
}

async function request(path, options = {}) {
  const method = options.method || 'GET';
  const url = new URL(path, window.location.origin);
  if (method === 'GET') url.searchParams.set('_', Date.now());
  const response = await fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw new ApiError(body.error || `请求失败（${response.status}）`, {
      status: response.status,
      requestId: response.headers.get('x-request-id') || '',
    });
  }
  return body;
}

export const api = {
  get(path) { return request(path); },
  post(path, body) {
    return request(path, { method: 'POST', body: JSON.stringify(body) });
  },
};
