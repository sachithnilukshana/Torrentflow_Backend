import WebTorrent from 'webtorrent';
import config from './config.js';
import { aria2Rpc, getAria2RpcUrl, isAria2Available } from './aria2.js';

let clientInstance = null;

/**
 * Initializes or returns the singleton WebTorrent client.
 * WebTorrent in Node.js supports standard BitTorrent over TCP/uTP as well as WebRTC.
 */
export function getWebTorrentClient() {
  if (!clientInstance || clientInstance.destroyed) {
    const torrentPort = Number(config.torrentPort) > 0 ? Number(config.torrentPort) : 0;
    const dhtPort = (Number(config.dhtPort) > 0 && Number(config.dhtPort) !== torrentPort) ? Number(config.dhtPort) : 0;

    const clientOpts = {
      torrentPort,
      dhtPort,
      maxConns: config.maxConnections || 1000,
      dht: {
        bootstrap: [
          'router.bittorrent.com:6881',
          'dht.transmissionbt.com:6881',
          'router.utorrent.com:6881',
          'dht.aelitis.com:6881',
          'dht.libtorrent.org:25401',
          'bootstrap.jami.net:4222'
        ]
      },
      lsd: true,
      utPex: true,
      natUpnp: true,
      natPmp: true,
      webSeeds: true,
      downloadLimit: -1,
      uploadLimit: -1
    };

    clientInstance = new WebTorrent(clientOpts);

    clientInstance.on('error', (err) => {
      console.error('[WebTorrent Engine Error]:', err.message || err);
      if (err.code === 'EADDRINUSE' && clientOpts.torrentPort > 0) {
        console.warn(`[WebTorrent] Port ${clientOpts.torrentPort} in use. Rebinding engine to dynamic ports...`);
        try {
          const oldClient = clientInstance;
          clientInstance = null;
          oldClient.destroy(() => {
            getWebTorrentClient();
          });
        } catch (_) {
          clientInstance = null;
        }
      }
    });
  }
  return clientInstance;
}

/**
 * Cleanly shuts down the WebTorrent client, closing all active torrents and wires.
 */
export function destroyWebTorrentClient() {
  return new Promise((resolve) => {
    if (!clientInstance) {
      return resolve();
    }

    console.log('[WebTorrent] Shutting down client and active torrents...');
    clientInstance.destroy((err) => {
      if (err) {
        console.error('[WebTorrent] Error during destroy:', err.message);
      } else {
        console.log('[WebTorrent] Engine cleanly stopped.');
      }
      clientInstance = null;
      resolve();
    });
  });
}

export {
  aria2Rpc,
  getAria2RpcUrl,
  isAria2Available
};

export default {
  getWebTorrentClient,
  destroyWebTorrentClient,
  aria2Rpc,
  getAria2RpcUrl,
  isAria2Available
};
