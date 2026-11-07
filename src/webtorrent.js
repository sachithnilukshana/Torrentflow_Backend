import WebTorrent from 'webtorrent';
import config from './config.js';

let clientInstance = null;

/**
 * Initializes or returns the singleton WebTorrent client.
 * WebTorrent in Node.js supports standard BitTorrent over TCP/uTP as well as WebRTC.
 */
export function getWebTorrentClient() {
  if (!clientInstance) {
    clientInstance = new WebTorrent({
      maxConns: config.maxConnections || 500,
      dht: {
        bootstrap: [
          'router.bittorrent.com:6881',
          'dht.transmissionbt.com:6881',
          'router.utorrent.com:6881',
          'dht.aelitis.com:6881',
          'dht.libtorrent.org:25401'
        ]
      },
      webSeeds: true,
      downloadLimit: -1,
      uploadLimit: -1
    });

    clientInstance.on('error', (err) => {
      console.error('[WebTorrent Engine Error]:', err.message || err);
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

export default {
  getWebTorrentClient,
  destroyWebTorrentClient
};

