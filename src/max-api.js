export class MaxApiError extends Error {
  constructor(message, { status, data } = {}) {
    super(message);
    this.name = 'MaxApiError';
    this.status = status;
    this.data = data;
  }
}

export function createMaxApi({ token, baseUrl }) {
  if (!token) {
    throw new Error('MAX bot token is required');
  }

  async function request(method, path, { query, body } = {}) {
    const url = new URL(path.replace(/^\//, ''), ensureTrailingSlash(baseUrl));
    appendQuery(url, query);

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: token,
        ...(body == null ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body == null ? undefined : JSON.stringify(body),
    });

    const data = await readResponseBody(response);
    if (!response.ok) {
      throw new MaxApiError(`MAX API request failed: ${method} ${path}`, {
        status: response.status,
        data,
      });
    }

    if (data && data.success === false) {
      throw new MaxApiError(`MAX API returned success=false: ${method} ${path}`, {
        status: response.status,
        data,
      });
    }

    return data;
  }

  return {
    request,
    getMe: () => request('GET', '/me'),
    getUpdates: ({ limit, timeout, marker, types } = {}) =>
      request('GET', '/updates', {
        query: {
          limit,
          timeout,
          marker,
          types: Array.isArray(types) ? types.join(',') : types,
        },
      }),
    deleteMessage: (messageId) =>
      request('DELETE', '/messages', {
        query: { message_id: messageId },
      }),
    sendMessageToChat: (chatId, text, extra = {}) =>
      request('POST', '/messages', {
        query: { chat_id: chatId },
        body: { text, ...extra },
      }),
    createSubscription: ({ url, updateTypes, secret }) =>
      request('POST', '/subscriptions', {
        body: {
          url,
          update_types: updateTypes,
          ...(secret ? { secret } : {}),
        },
      }),
  };
}

function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

function appendQuery(url, query = {}) {
  for (const [key, value] of Object.entries(query)) {
    if (value == null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
}

async function readResponseBody(response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
