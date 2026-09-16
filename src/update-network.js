const clampNumber = (value, min, max, fallback) => {
  const n = Number(value);
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : fallback));
};

const clampInteger = (value, min, max, fallback) =>
  Math.round(clampNumber(value, min, max, fallback));

export const DEFAULT_UPDATE_NETWORK = Object.freeze({
  networkRetries: 4,
  retryBaseMs: 1500,
  retryMaxMs: 15000,
  connectivityTimeoutSeconds: 20,
  fetchTimeoutSeconds: 300,
  forceHttp11: true,
  disableOnFailure: true
});

export function normalizeUpdateNetworkSettings(autoUpdate = {}) {
  const raw = autoUpdate && typeof autoUpdate === 'object' ? autoUpdate : {};
  const retryBaseMs = clampInteger(
    raw.retryBaseMs,
    100,
    30000,
    DEFAULT_UPDATE_NETWORK.retryBaseMs
  );
  return {
    networkRetries: clampInteger(
      raw.networkRetries,
      0,
      10,
      DEFAULT_UPDATE_NETWORK.networkRetries
    ),
    retryBaseMs,
    retryMaxMs: Math.max(
      retryBaseMs,
      clampInteger(
        raw.retryMaxMs,
        500,
        120000,
        DEFAULT_UPDATE_NETWORK.retryMaxMs
      )
    ),
    connectivityTimeoutSeconds: clampInteger(
      raw.connectivityTimeoutSeconds,
      3,
      120,
      DEFAULT_UPDATE_NETWORK.connectivityTimeoutSeconds
    ),
    fetchTimeoutSeconds: clampInteger(
      raw.fetchTimeoutSeconds,
      30,
      1800,
      DEFAULT_UPDATE_NETWORK.fetchTimeoutSeconds
    ),
    forceHttp11: raw.forceHttp11 !== false,
    disableOnFailure: raw.disableOnFailure !== false
  };
}

export function updateRetryDelayMs(failureIndex, settings = DEFAULT_UPDATE_NETWORK) {
  const normalized = normalizeUpdateNetworkSettings(settings);
  const index = Math.max(0, Math.round(Number(failureIndex) || 0));
  return Math.min(
    normalized.retryMaxMs,
    normalized.retryBaseMs * (2 ** index)
  );
}

export function isRetryableUpdateNetworkError(error) {
  if (error?.retryable === false) return false;
  if (error?.retryable === true) return true;
  const text = String(
    error?.stderr
    || error?.message
    || error
    || ''
  ).toLowerCase();
  if (!text) return true;
  if (
    /repository not found|authentication failed|permission denied|couldn't find remote ref|could not find remote ref|branch .* not found|invalid refspec|not an approved github/.test(text)
  ) {
    return false;
  }
  return /gnutls|tls|ssl|http\/2|http 429|http 5\d\d|timed? ?out|timeout|connection|network|could not resolve|temporary failure|early eof|rpc failed|remote end hung up|connection reset|connection closed|recv error|send error|broken pipe|failed to connect|unreachable/.test(text)
    || error?.code === 'ETIMEDOUT'
    || error?.code === 'ECONNRESET'
    || error?.code === 'EAI_AGAIN';
}

export async function retryUpdateOperation(operation, {
  retries = DEFAULT_UPDATE_NETWORK.networkRetries,
  baseDelayMs = DEFAULT_UPDATE_NETWORK.retryBaseMs,
  maxDelayMs = DEFAULT_UPDATE_NETWORK.retryMaxMs,
  isRetryable = isRetryableUpdateNetworkError,
  onRetry = null,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  const settings = normalizeUpdateNetworkSettings({
    networkRetries: retries,
    retryBaseMs: baseDelayMs,
    retryMaxMs: maxDelayMs
  });
  const total = settings.networkRetries + 1;
  let lastError = null;
  for (let attempt = 1; attempt <= total; attempt += 1) {
    try {
      return {
        value: await operation(attempt),
        attempts: attempt
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      lastError.attempts = attempt;
      if (attempt >= total || !isRetryable(lastError)) throw lastError;
      const delayMs = Math.min(
        settings.retryMaxMs,
        settings.retryBaseMs * (2 ** (attempt - 1))
      );
      onRetry?.({ attempt, nextAttempt: attempt + 1, delayMs, error: lastError });
      await sleep(delayMs);
    }
  }
  throw lastError || new Error('update operation failed');
}

export function gitTransportPrefix(autoUpdate = {}) {
  const settings = normalizeUpdateNetworkSettings(autoUpdate);
  if (!settings.forceHttp11) return [];
  return [
    '-c', 'http.version=HTTP/1.1',
    '-c', 'http.lowSpeedLimit=1',
    '-c', `http.lowSpeedTime=${Math.max(30, settings.connectivityTimeoutSeconds)}`
  ];
}
