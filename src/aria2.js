import config from './config.js';

export const DEFAULT_ARIA2_RPC_URL = 'http://127.0.0.1:6800/jsonrpc';

let activeRpcUrl = null;
let lastCheckTime = 0;
let isAria2Running = false;

/**
 * Returns candidate RPC endpoints in priority order.
 */
function getCandidateUrls() {
  const custom = config.aria2RpcUrl || process.env.ARIA2_RPC_URL;
  const list = [];
  if (custom) {
    list.push(custom);
    // If user provided a URL without /jsonrpc, also try /jsonrpc
    if (!custom.endsWith('/jsonrpc')) {
      list.push(`${custom.replace(/\/$/, '')}/jsonrpc`);
    }
  }
  list.push(
    'http://127.0.0.1:6800/jsonrpc',
    'http://localhost:6800/jsonrpc',
    'http://127.0.0:6800/jsonrpc',
    'http://127.0.0/jsonrpc',
    'http://127.0.0'
  );
  return Array.from(new Set(list));
}

/**
 * Probes candidate URLs to find a live aria2c JSON-RPC daemon.
 */
export async function probeAria2RpcUrl() {
  const candidates = getCandidateUrls();
  for (const url of candidates) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 600);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'ping',
          method: 'aria2.getVersion'
        }),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (res.ok) {
        const json = await res.json().catch(() => null);
        if (json && (json.result || json.version)) {
          activeRpcUrl = url;
          isAria2Running = true;
          return url;
        }
      }
    } catch (_) {}
  }
  isAria2Running = false;
  return null;
}

/**
 * Checks whether aria2c JSON-RPC daemon is running and reachable.
 */
export async function isAria2Available() {
  if (Date.now() - lastCheckTime < 10000 && lastCheckTime > 0) {
    return isAria2Running;
  }
  lastCheckTime = Date.now();
  const found = await probeAria2RpcUrl();
  return Boolean(found);
}

/**
 * Returns the active or default aria2 JSON-RPC URL.
 */
export function getAria2RpcUrl() {
  return activeRpcUrl || config.aria2RpcUrl || process.env.ARIA2_RPC_URL || DEFAULT_ARIA2_RPC_URL;
}

/**
 * Execute an aria2 JSON-RPC call using native Node.js fetch (Node 20+).
 */
export async function aria2Rpc(method, params = []) {
  const url = getAria2RpcUrl();
  const payload = {
    jsonrpc: '2.0',
    id: `tf-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
    method,
    params
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`aria2 RPC HTTP error ${response.status}: ${errorText || response.statusText}`);
  }

  const data = await response.json();
  if (data.error) {
    const msg = data.error.message || `code ${data.error.code}`;
    const err = new Error(`aria2 RPC error: ${msg}`);
    err.code = data.error.code;
    throw err;
  }

  return data.result;
}

export default {
  DEFAULT_ARIA2_RPC_URL,
  getAria2RpcUrl,
  probeAria2RpcUrl,
  isAria2Available,
  aria2Rpc
};
