import os from 'os';
import fs from 'fs';
import path from 'path';
import config from './config.js';

let previousCpus = os.cpus();
let currentCpuPercent = 0;

/**
 * Periodically samples CPU core ticks to compute real-time CPU utilization.
 */
function updateCpuUsage() {
  const cpus = os.cpus();
  let idleDiff = 0;
  let totalDiff = 0;

  for (let i = 0; i < cpus.length; i++) {
    const prev = previousCpus[i] ? previousCpus[i].times : { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 };
    const curr = cpus[i].times;
    const prevTotal = prev.user + prev.nice + prev.sys + prev.idle + prev.irq;
    const currTotal = curr.user + curr.nice + curr.sys + curr.idle + curr.irq;
    idleDiff += (curr.idle - prev.idle);
    totalDiff += (currTotal - prevTotal);
  }

  if (totalDiff > 0) {
    const usage = ((totalDiff - idleDiff) / totalDiff) * 100;
    currentCpuPercent = Math.max(0, Math.min(100, Math.round(usage * 10) / 10));
  }
  previousCpus = cpus;
}

// Initial sample and 2-second background sampler
updateCpuUsage();
const cpuTimer = setInterval(updateCpuUsage, 2000);
if (cpuTimer.unref) cpuTimer.unref();

/**
 * Returns disk usage statistics for the storage path (Oracle Cloud / Linux / Windows).
 */
export function getDiskUsage(targetDir = null) {
  const dir = targetDir || config.temporaryDownloadPath || config.downloadPath || process.cwd();
  try {
    if (typeof fs.statfsSync === 'function') {
      const stats = fs.statfsSync(dir);
      const total = stats.bsize * stats.blocks;
      const free = stats.bsize * stats.bavail; // bavail is unprivileged available blocks
      const used = Math.max(0, total - free);
      const percent = total > 0 ? Math.round((used / total) * 1000) / 10 : 0;
      return {
        path: dir,
        total,
        used,
        free,
        percent
      };
    }
  } catch (err) {
    // Fallback if statfsSync encounters restricted container permissions
  }

  return {
    path: dir,
    total: 0,
    used: 0,
    free: 0,
    percent: 0
  };
}

/**
 * Returns comprehensive system hardware metrics: CPU, RAM, Disk, Network throughput.
 */
export function getSystemMetrics(networkStats = {}) {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = Math.max(0, totalMem - freeMem);
  const memPercent = totalMem > 0 ? Math.round((usedMem / totalMem) * 1000) / 10 : 0;

  const disk = getDiskUsage();
  const loadAvg = os.loadavg(); // [1m, 5m, 15m] load average
  const processMem = process.memoryUsage();

  return {
    cpu: {
      percent: currentCpuPercent,
      cores: os.cpus().length,
      model: os.cpus()[0]?.model || 'Generic CPU',
      speedMhz: os.cpus()[0]?.speed || 0,
      loadAvg: [
        Math.round(loadAvg[0] * 100) / 100,
        Math.round(loadAvg[1] * 100) / 100,
        Math.round(loadAvg[2] * 100) / 100
      ]
    },
    memory: {
      total: totalMem,
      used: usedMem,
      free: freeMem,
      percent: memPercent,
      processRss: processMem.rss,
      processHeapUsed: processMem.heapUsed
    },
    disk,
    network: {
      downloadSpeed: networkStats.downloadSpeed || 0,
      uploadSpeed: networkStats.uploadSpeed || 0,
      totalDownloaded: networkStats.totalDownloaded || 0,
      totalUploaded: networkStats.totalUploaded || 0
    },
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      uptimeSeconds: Math.round(os.uptime()),
      processUptimeSeconds: Math.round(process.uptime()),
      nodeVersion: process.version
    }
  };
}

export default {
  getSystemMetrics,
  getDiskUsage
};
