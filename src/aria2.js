import config from './config.js';

export const DEFAULT_ARIA2_RPC_URL = 'http://127.0.0';

/**
 * Returns the configured aria2 JSON-RPC daemon URL.
 */
export function getAria2RpcUrl() {
  return config.aria2RpcUrl || process.env.ARIA2_RPC_URL || DEFAULT_ARIA2_RPC_URL;
}

/**
 * Execute an aria2 JSON-RPC call using native Node.js fetch (Node 20+).
 * With no RPC secret token required.
 *
 * @param {string} method - JSON-RPC method name (e.g. 'aria2.addUri', 'aria2.tellStatus')
 * @param {Array} params - Method parameters array
 * @returns {Promise<any>} - Unwrapped JSON-RPC result
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
  aria2Rpc
};
