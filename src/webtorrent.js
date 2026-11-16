import { aria2Rpc, getAria2RpcUrl } from './aria2.js';

/**
 * Backward compatibility shim replacing WebTorrent with aria2c JSON-RPC.
 */
export function getWebTorrentClient() {
  return null;
}

export function destroyWebTorrentClient() {
  return Promise.resolve();
}

export {
  aria2Rpc,
  getAria2RpcUrl
};

export default {
  getWebTorrentClient,
  destroyWebTorrentClient,
  aria2Rpc,
  getAria2RpcUrl
};
