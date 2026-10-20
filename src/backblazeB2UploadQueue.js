// Backblaze B2 uses the existing serialized queue implementation; its uploader
// is routed to B2 by the compatibility adapter.
import { isRetryableBackblazeB2Error, uploadFileToBackblazeB2 } from './backblazeB2.js';

export class BackblazeB2UploadQueue {
  constructor({ uploader = uploadFileToBackblazeB2, maxAttempts = 3, retryDelayMs = 15_000 } = {}) {
    this.uploader = uploader; this.maxAttempts = maxAttempts; this.retryDelayMs = retryDelayMs;
    this.pending = []; this.running = false; this.keys = new Set();
  }
  enqueue(job) { if (!job?.key || !job.targetPath || !job.onState || this.keys.has(job.key)) return false; this.keys.add(job.key); this.pending.push(job); void this.process(); return true; }
  cancel(key) { this.pending = this.pending.filter((job) => job.key !== key); this.keys.delete(key); }
  async waitForIdle() { while (this.running || this.pending.length) await new Promise((resolve) => setTimeout(resolve, 5)); }
  async process() { if (this.running) return; this.running = true; while (this.pending.length) { const job = this.pending.shift(); let attempts = job.attempts || 0; try { attempts++; job.onState({ status: 'uploading', statusMessage: 'Uploading to Backblaze B2', attempts, error: null }); const result = await this.uploader(job.targetPath, { onProgress: job.onProgress || (() => {}) }); job.onCompleted?.(result, attempts); } catch (error) { const retryable = isRetryableBackblazeB2Error(error); if (retryable && attempts < this.maxAttempts) { job.onState({ status: 'waiting', statusMessage: 'Retrying upload', attempts, error: error.message, retryable, nextRetryAt: new Date(Date.now() + this.retryDelayMs * 2 ** (attempts - 1)).toISOString() }); await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * 2 ** (attempts - 1))); job.attempts = attempts; this.pending.unshift(job); continue; } job.onFailed?.(error, { attempts, retryable }); } finally { if (!this.pending.includes(job)) this.keys.delete(job.key); } } this.running = false; }
}
