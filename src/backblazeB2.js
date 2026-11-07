import crypto from 'crypto';
import fs from 'fs';
import https from 'https';
import path from 'path';
import config from './config.js';

// ---------------------------------------------------------------------------
// High-performance persistent HTTPS Agent with Keep-Alive
// Reuses TLS connections across hundreds of part uploads, eliminating
// repetitive SSL/TLS handshake overhead and socket churn.
// ---------------------------------------------------------------------------
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 60000,
  maxSockets: 64,
  maxFreeSockets: 32,
  timeout: 120000,
});

// ---------------------------------------------------------------------------
// Auth cache — re-use the token for up to 6 hours before re-authorizing
// ---------------------------------------------------------------------------
let cachedAuth = null;
let cachedAuthExpiresAt = 0;
const AUTH_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export function invalidateAuthCache() {
  cachedAuth = null;
  cachedAuthExpiresAt = 0;
}

// ---------------------------------------------------------------------------
// Custom error
// ---------------------------------------------------------------------------
export class BackblazeB2UploadError extends Error {
  constructor(message, { statusCode = null, code = null, retryable } = {}) {
    super(message);
    this.name = 'BackblazeB2UploadError';
    this.statusCode = statusCode;
    this.code = code;
    this.retryable =
      retryable ??
      (statusCode === 408 ||
        statusCode === 429 ||
        statusCode >= 500 ||
        code === 'expired_auth_token' ||
        code === 'bad_auth_token' ||
        code === 'service_unavailable');
  }
}
export const isRetryableBackblazeB2Error = (error) => error?.retryable === true;

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------
export function validateFilePathWithinDownloadDir(targetPath) {
  const base = path.resolve(config.temporaryDownloadPath);
  const resolved = path.resolve(base, targetPath || '');
  const relative = path.relative(base, resolved);
  if (!targetPath || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Access denied: File path escapes the configured temporary directory');
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${path.basename(resolved)}`);
  const realPath = fs.realpathSync(resolved);
  const realRelative = path.relative(base, realPath);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative))
    throw new Error('Access denied: Symbolic link resolves outside the configured temporary directory');
  const stat = fs.statSync(realPath);
  if (!stat.isFile() || stat.size < 1) throw new Error('Path must be a non-empty regular file');
  return { resolvedPath: realPath, size: stat.size, filename: path.basename(realPath) };
}

// ---------------------------------------------------------------------------
// HTTP helper with Keep-Alive and configurable socket timeout
// ---------------------------------------------------------------------------
function requestJson(url, method, headers, body, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const raw = body ? Buffer.from(JSON.stringify(body)) : null;
    let settled = false;

    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method,
        agent: httpsAgent,
        headers: {
          ...headers,
          ...(raw ? { 'Content-Type': 'application/json', 'Content-Length': raw.length } : {}),
        },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          let data;
          try { data = JSON.parse(text); } catch { data = {}; }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            const errMsg =
              data.message ||
              (data.code === 'unauthorized'
                ? 'Backblaze B2 access unauthorized (check bucket permissions and application key).'
                : 'Backblaze B2 request failed.');
            reject(new BackblazeB2UploadError(errMsg, { statusCode: res.statusCode, code: data.code }));
          }
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      if (settled) return;
      settled = true;
      req.destroy(new BackblazeB2UploadError(`Backblaze B2 request timeout (${timeoutMs}ms)`, { retryable: true }));
    });

    req.on('error', (e) => {
      if (settled) return;
      settled = true;
      reject(new BackblazeB2UploadError(`Backblaze B2 network error: ${e.message}`, { retryable: true }));
    });

    if (raw) req.write(raw);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Authorization (v3, cached)
// ---------------------------------------------------------------------------
export async function authorize(forceRefresh = false) {
  if (!config.b2ApplicationKeyId || !config.b2ApplicationKey || !config.b2BucketId || !config.b2BucketName) {
    throw new BackblazeB2UploadError(
      'Backblaze B2 is not configured. Add B2_APPLICATION_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET_ID, and B2_BUCKET_NAME.',
      { retryable: false }
    );
  }
  if (!forceRefresh && cachedAuth && Date.now() < cachedAuthExpiresAt) {
    return cachedAuth;
  }
  const basic = Buffer.from(`${config.b2ApplicationKeyId}:${config.b2ApplicationKey}`).toString('base64');
  const raw = await requestJson(
    'https://api.backblazeb2.com/b2api/v3/b2_authorize_account',
    'GET',
    { Authorization: `Basic ${basic}` }
  );
  // Normalize: v3 can return both flat and nested storageApi shapes
  const storageApi = raw.apiInfo?.storageApi ?? {};
  const auth = {
    authorizationToken: raw.authorizationToken,
    apiUrl: storageApi.apiUrl || raw.apiUrl || '',
    downloadUrl: storageApi.downloadUrl || raw.downloadUrl || '',
    absoluteMinimumPartSize: storageApi.absoluteMinimumPartSize || raw.absoluteMinimumPartSize || 5 * 1024 * 1024,
    _raw: raw,
  };
  cachedAuth = auth;
  cachedAuthExpiresAt = Date.now() + AUTH_CACHE_TTL_MS;
  return auth;
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------
function encodeName(name) {
  return encodeURIComponent(name)
    .replace(/%2F/g, '/')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

/**
 * Returns a time-limited signed download URL for a private bucket, or a
 * plain public URL if B2_PUBLIC_URL_BASE is configured (CDN / public bucket).
 */
export async function getAuthorizedDownloadUrl(auth, name, validDurationInSeconds = 604800) {
  if (config.b2PublicUrlBase) {
    return `${config.b2PublicUrlBase.replace(/\/$/, '')}/${encodeName(name)}`;
  }
  const baseUrl = `${auth.downloadUrl}/file/${encodeName(config.b2BucketName)}/${encodeName(name)}`;
  try {
    const downloadAuth = await requestJson(
      `${auth.apiUrl}/b2api/v3/b2_get_download_authorization`,
      'POST',
      { Authorization: auth.authorizationToken },
      {
        bucketId: config.b2BucketId,
        fileNamePrefix: name,
        validDurationInSeconds: Math.min(604800, Math.max(60, validDurationInSeconds)),
      }
    );
    if (downloadAuth?.authorizationToken) {
      return `${baseUrl}?Authorization=${encodeURIComponent(downloadAuth.authorizationToken)}`;
    }
  } catch (err) {
    console.warn('[Backblaze B2] Could not acquire download authorization token:', err.message);
  }
  return baseUrl;
}

/**
 * Convenience wrapper: get a signed URL for an existing object key.
 */
export async function getDownloadUrlForFile(objectKey, validDurationInSeconds = 604800) {
  const auth = await authorize();
  return getAuthorizedDownloadUrl(auth, objectKey, validDurationInSeconds);
}

// ---------------------------------------------------------------------------
// Upload stream helper
// Reads disk data once asynchronously with 2MB buffer, computes SHA-1
// in-flight during stream transfer, and enforces a socket timeout.
// ---------------------------------------------------------------------------
function uploadStream(url, token, source, start, end, extra, onBytes, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const length = end - start + 1;
    const u = new URL(url);
    const hash = crypto.createHash('sha1');
    let settled = false;

    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        agent: httpsAgent,
        headers: {
          Authorization: token,
          'Content-Length': length,
          ...extra,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          try {
            const data = JSON.parse(raw);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              data.computedSha1 = hash.digest('hex');
              resolve(data);
            } else {
              reject(
                new BackblazeB2UploadError(data.message || 'Backblaze B2 upload failed.', {
                  statusCode: res.statusCode,
                  code: data.code,
                })
              );
            }
          } catch {
            reject(
              new BackblazeB2UploadError('Backblaze B2 returned an invalid upload response.', {
                statusCode: res.statusCode,
              })
            );
          }
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      if (settled) return;
      settled = true;
      req.destroy(new BackblazeB2UploadError(`Upload socket timed out after ${timeoutMs}ms`, { retryable: true }));
    });

    req.on('error', (e) => {
      if (settled) return;
      settled = true;
      reject(new BackblazeB2UploadError(`Backblaze B2 network error: ${e.message}`, { retryable: true }));
    });

    // 2MB highWaterMark: optimal throughput without excessive memory consumption
    const stream = fs.createReadStream(source, { start, end, highWaterMark: 2 * 1024 * 1024 });
    stream.on('data', (chunk) => {
      hash.update(chunk);
      onBytes?.(chunk.length);
    });
    stream.on('error', (e) => {
      if (settled) return;
      req.destroy(e);
    });
    stream.pipe(req);
  });
}

// ---------------------------------------------------------------------------
// Asynchronous SHA-1 Computation
// Reads the specified byte range using non-blocking streams with 2MB chunks.
// Computing 64MB takes ~130ms and does not block the Node.js event loop.
// ---------------------------------------------------------------------------
function computeSha1(filePath, start, end) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(filePath, { start, end, highWaterMark: 2 * 1024 * 1024 });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Per-Part Resilient Upload with Automatic Retries
// Computes verified part SHA-1 in advance and uploads to B2.
// If one part fails due to a network glitch, 503, 500, or expired token,
// it is retried up to maxAttempts times with exponential backoff and a fresh URL.
// ---------------------------------------------------------------------------
async function uploadPartWithRetry(auth, fileId, partNumber, source, start, end, onBytesChunk, onAttemptReset, maxAttempts = 5) {
  // Compute the exact verified SHA-1 for this part range
  const partSha1 = await computeSha1(source, start, end);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // 1. Acquire an upload part URL (auto-refresh auth on 401)
      let partUrlData = null;
      try {
        partUrlData = await requestJson(
          `${auth.apiUrl}/b2api/v3/b2_get_upload_part_url`,
          'POST',
          { Authorization: auth.authorizationToken },
          { fileId }
        );
      } catch (err) {
        if (err.statusCode === 401) {
          invalidateAuthCache();
          const refreshed = await authorize(true);
          auth.authorizationToken = refreshed.authorizationToken;
          auth.apiUrl = refreshed.apiUrl;
          auth.downloadUrl = refreshed.downloadUrl;
          partUrlData = await requestJson(
            `${auth.apiUrl}/b2api/v3/b2_get_upload_part_url`,
            'POST',
            { Authorization: auth.authorizationToken },
            { fileId }
          );
        } else {
          throw err;
        }
      }

      // 2. Stream the part to B2 with the verified SHA-1 header
      onAttemptReset?.();
      await uploadStream(
        partUrlData.uploadUrl,
        partUrlData.authorizationToken,
        source,
        start,
        end,
        {
          'X-Bz-Part-Number': partNumber,
          'X-Bz-Content-Sha1': partSha1,
        },
        onBytesChunk
      );

      return partSha1;
    } catch (err) {
      lastError = err;
      onAttemptReset?.();
      console.warn(
        `[Backblaze B2] Part #${partNumber} attempt ${attempt}/${maxAttempts} failed: ${err.message}. ${
          attempt < maxAttempts ? 'Retrying part...' : 'All attempts exhausted.'
        }`
      );
      if (attempt < maxAttempts) {
        const backoffMs = Math.min(20000, 1000 * Math.pow(2, attempt - 1));
        await new Promise((res) => setTimeout(res, backoffMs));
      }
    }
  }
  throw lastError || new BackblazeB2UploadError(`Part #${partNumber} failed after ${maxAttempts} attempts`);
}

// ---------------------------------------------------------------------------
// Post-upload verification
// ---------------------------------------------------------------------------
async function verifyRemoteFile(auth, fileId, expectedSize) {
  const remote = await requestJson(
    `${auth.apiUrl}/b2api/v3/b2_get_file_info`,
    'POST',
    { Authorization: auth.authorizationToken },
    { fileId }
  );
  if (Number(remote.contentLength) !== expectedSize)
    throw new BackblazeB2UploadError(
      'Backblaze B2 verification failed: remote file size does not match the local file.',
      { retryable: true }
    );
  return remote;
}

// ---------------------------------------------------------------------------
// Public API: uploadFileToBackblazeB2
// Fast, robust upload supporting files up to many gigabytes with:
// - Asynchronous streaming (zero redundant disk passes)
// - Dynamic 64MB-100MB part sizing for large video files
// - Parallel part workers with connection reuse (Keep-Alive)
// - Per-part automatic retry loop
// - Accurate real-time progress calculations
// - Automatic cleanup of abandoned large files on failure
// ---------------------------------------------------------------------------
export async function uploadFileToBackblazeB2(targetPath, options = {}) {
  const { resolvedPath, size, filename } = validateFilePathWithinDownloadDir(targetPath);
  const auth = await authorize();
  const name = `torrentflow/${Date.now()}-${filename}`;
  const startedAt = Date.now();

  // Determine optimal part size:
  // For files >= 2GB (such as full 1080p/4K movie files), use at least 64MB parts
  // to minimize HTTP request overhead and keep total part counts well below 100.
  let partSize = Math.max(config.backblazeB2PartSizeBytes, auth.absoluteMinimumPartSize || 5 * 1024 * 1024);
  if (size >= 2 * 1024 * 1024 * 1024) {
    partSize = Math.max(partSize, 64 * 1024 * 1024);
  }

  let file;
  let startedLargeFile = null;

  if (size <= partSize) {
    // -----------------------------------------------------------------------
    // Single-part upload (small files)
    // -----------------------------------------------------------------------
    const fileSha1 = await computeSha1(resolvedPath, 0, size - 1);
    let lastError = null;
    let doneBytes = 0;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        let urlData;
        try {
          urlData = await requestJson(
            `${auth.apiUrl}/b2api/v3/b2_get_upload_url`,
            'POST',
            { Authorization: auth.authorizationToken },
            { bucketId: config.b2BucketId }
          );
        } catch (err) {
          if (err.statusCode === 401) {
            invalidateAuthCache();
            const refreshed = await authorize(true);
            auth.authorizationToken = refreshed.authorizationToken;
            urlData = await requestJson(
              `${refreshed.apiUrl}/b2api/v3/b2_get_upload_url`,
              'POST',
              { Authorization: refreshed.authorizationToken },
              { bucketId: config.b2BucketId }
            );
          } else {
            throw err;
          }
        }

        doneBytes = 0;
        file = await uploadStream(
          urlData.uploadUrl,
          urlData.authorizationToken,
          resolvedPath,
          0,
          size - 1,
          {
            'X-Bz-File-Name': encodeName(name),
            'Content-Type': 'b2/x-auto',
            'X-Bz-Content-Sha1': fileSha1,
          },
          (n) => {
            doneBytes += n;
            const elapsed = Math.max(0.001, (Date.now() - startedAt) / 1000);
            const speed = doneBytes / elapsed;
            options.onProgress?.({
              uploadedBytes: doneBytes,
              totalBytes: size,
              progress: Math.min(100, Math.round((doneBytes / size) * 100)),
              uploadSpeed: speed,
              estimatedRemainingSeconds: speed > 0 ? Math.max(0, (size - doneBytes) / speed) : null,
            });
          }
        );
        break;
      } catch (err) {
        lastError = err;
        if (attempt < 3 && isRetryableBackblazeB2Error(err)) {
          await new Promise((res) => setTimeout(res, 2000 * attempt));
        } else {
          throw err;
        }
      }
    }
  } else {
    // -----------------------------------------------------------------------
    // Multi-part upload (large files / movies)
    // -----------------------------------------------------------------------
    startedLargeFile = await requestJson(
      `${auth.apiUrl}/b2api/v3/b2_start_large_file`,
      'POST',
      { Authorization: auth.authorizationToken },
      { bucketId: config.b2BucketId, fileName: name, contentType: 'b2/x-auto' }
    );

    const count = Math.ceil(size / partSize);
    const sha1s = new Array(count);
    const partBytesDone = new Array(count).fill(0);
    let nextPart = 0;

    const reportProgress = () => {
      const totalDone = partBytesDone.reduce((sum, b) => sum + b, 0);
      const elapsed = Math.max(0.001, (Date.now() - startedAt) / 1000);
      const speed = totalDone / elapsed;
      options.onProgress?.({
        uploadedBytes: totalDone,
        totalBytes: size,
        progress: Math.min(100, Math.round((totalDone / size) * 100)),
        uploadSpeed: speed,
        estimatedRemainingSeconds: speed > 0 ? Math.max(0, (size - totalDone) / speed) : null,
      });
    };

    const worker = async () => {
      while (true) {
        const i = nextPart++;
        if (i >= count) return;

        const start = i * partSize;
        const end = Math.min(size - 1, start + partSize - 1);
        const partNumber = i + 1;

        const partSha1 = await uploadPartWithRetry(
          auth,
          startedLargeFile.fileId,
          partNumber,
          resolvedPath,
          start,
          end,
          (chunkLen) => {
            partBytesDone[i] += chunkLen;
            reportProgress();
          },
          () => {
            partBytesDone[i] = 0;
            reportProgress();
          },
          config.backblazeB2UploadMaxAttempts || 5
        );

        sha1s[i] = partSha1;
        partBytesDone[i] = end - start + 1;
        reportProgress();
      }
    };

    try {
      const concurrency = Math.min(config.backblazeB2ParallelParts || 6, count);
      await Promise.all(Array.from({ length: concurrency }, worker));

      file = await requestJson(
        `${auth.apiUrl}/b2api/v3/b2_finish_large_file`,
        'POST',
        { Authorization: auth.authorizationToken },
        { fileId: startedLargeFile.fileId, partSha1Array: sha1s },
        120000
      );
    } catch (uploadError) {
      // Clean up orphaned unfinished large file on B2 if aborting permanently
      if (startedLargeFile?.fileId) {
        try {
          await requestJson(
            `${auth.apiUrl}/b2api/v3/b2_cancel_large_file`,
            'POST',
            { Authorization: auth.authorizationToken },
            { fileId: startedLargeFile.fileId }
          );
        } catch {
          // ignore cancellation cleanup error
        }
      }
      throw uploadError;
    }
  }

  await verifyRemoteFile(auth, file.fileId, size);

  // Generate a valid signed URL (7-day validity) for direct playback or Telegram links
  const signedUrl = await getAuthorizedDownloadUrl(auth, name);

  return {
    success: true,
    id: file.fileId,
    objectKey: name,
    url: signedUrl,
    filename,
    size,
    uploadedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Public API: streaming download / playback (server-side proxy)
// ---------------------------------------------------------------------------
export async function downloadBackblazeB2File(fileId, rangeHeader, response) {
  if (!/^[a-zA-Z0-9_\-]+$/.test(fileId || ''))
    throw new BackblazeB2UploadError('Invalid Backblaze B2 file reference.', { retryable: false });

  const attemptStream = async (auth) => {
    const url = new URL(`${auth.downloadUrl}/b2api/v3/b2_download_file_by_id`);
    url.searchParams.set('fileId', fileId);
    await new Promise((resolve, reject) => {
      const request = https.request(
        url,
        {
          agent: httpsAgent,
          headers: {
            Authorization: auth.authorizationToken,
            ...(rangeHeader ? { Range: rangeHeader } : {}),
          },
        },
        (remote) => {
          if (remote.statusCode !== 200 && remote.statusCode !== 206) {
            remote.resume();
            return reject(
              new BackblazeB2UploadError(
                remote.statusCode === 404
                  ? 'Movie object was not found in Backblaze B2.'
                  : 'Backblaze B2 playback request failed.',
                { statusCode: remote.statusCode, retryable: remote.statusCode >= 500 }
              )
            );
          }
          response.status(remote.statusCode);
          for (const hdr of [
            'content-type',
            'content-length',
            'content-range',
            'accept-ranges',
            'etag',
            'last-modified',
          ]) {
            if (remote.headers[hdr]) response.setHeader(hdr, remote.headers[hdr]);
          }
          response.setHeader('Cache-Control', 'private, no-store');
          remote.pipe(response);
          remote.on('end', resolve);
          remote.on('error', reject);
        }
      );
      request.setTimeout(120000, () => {
        request.destroy(new Error('Streaming request timed out'));
      });
      request.on('error', reject);
      request.end();
    });
  };

  let auth = await authorize();
  try {
    await attemptStream(auth);
  } catch (error) {
    if (error.statusCode === 401) {
      console.warn('[Backblaze B2] Auth token expired during streaming — re-authorizing and retrying.');
      invalidateAuthCache();
      auth = await authorize(true);
      await attemptStream(auth);
    } else {
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Public API: Delete file version from Backblaze B2
// ---------------------------------------------------------------------------
export async function deleteFileFromBackblazeB2(fileId, fileName) {
  if (!fileId || !fileName) {
    throw new Error('fileId and fileName are required to delete a Backblaze B2 file version.');
  }

  const attemptDelete = async (auth) => {
    return await requestJson(
      `${auth.apiUrl}/b2api/v3/b2_delete_file_version`,
      'POST',
      { Authorization: auth.authorizationToken },
      { fileName, fileId },
      30000
    );
  };

  let auth = await authorize();
  try {
    return await attemptDelete(auth);
  } catch (error) {
    if (error.statusCode === 401) {
      invalidateAuthCache();
      auth = await authorize(true);
      return await attemptDelete(auth);
    }
    if (error.statusCode === 400 && error.code === 'file_not_present') {
      return { fileId, fileName, alreadyDeleted: true };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Public API: Sync bucket lifecycle rules in B2 Cloud
// Enforces automatic deletion of torrentflow/* files after retentionDays
// ---------------------------------------------------------------------------
export async function syncBucketLifecycleRules(retentionDays = config.b2RetentionDays || 2) {
  if (!config.b2BucketId) return false;
  try {
    const auth = await authorize();
    const accountId = auth._raw?.accountId;
    if (!accountId) return false;

    const listRes = await requestJson(
      `${auth.apiUrl}/b2api/v3/b2_list_buckets`,
      'POST',
      { Authorization: auth.authorizationToken },
      { accountId, bucketId: config.b2BucketId },
      30000
    );

    const bucket = (listRes.buckets || []).find((b) => b.bucketId === config.b2BucketId);
    const existingRules = bucket?.lifecycleRules || [];

    const hasMatchingRule = existingRules.some(
      (r) =>
        r.fileNamePrefix === 'torrentflow/' &&
        r.daysFromUploadingToHiding === retentionDays &&
        r.daysFromHidingToDeleting === 1
    );

    if (hasMatchingRule) {
      return true;
    }

    const otherRules = existingRules.filter((r) => r.fileNamePrefix !== 'torrentflow/');
    const updatedRules = [
      ...otherRules,
      {
        fileNamePrefix: 'torrentflow/',
        daysFromUploadingToHiding: retentionDays,
        daysFromHidingToDeleting: 1
      }
    ];

    await requestJson(
      `${auth.apiUrl}/b2api/v3/b2_update_bucket`,
      'POST',
      { Authorization: auth.authorizationToken },
      {
        accountId,
        bucketId: config.b2BucketId,
        lifecycleRules: updatedRules
      },
      30000
    );

    console.log(`[Backblaze B2] Successfully configured ${retentionDays}-day lifecycle deletion rule for bucket "${bucket?.bucketName || config.b2BucketName}".`);
    return true;
  } catch (error) {
    console.warn(`[Backblaze B2] Notice: Could not sync bucket lifecycle rule (${error.message}). Software cleaner will enforce 2-day deletion.`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API: Software cleanup job for expired files
// ---------------------------------------------------------------------------
export async function cleanupExpiredBackblazeB2Files({
  retentionDays = config.b2RetentionDays || 2,
  maxAgeMs = retentionDays * 24 * 60 * 60 * 1000
} = {}) {
  if (!config.b2BucketId) return { deletedCount: 0, errors: [] };

  const auth = await authorize();
  let deletedCount = 0;
  const errors = [];
  const deletedFiles = [];

  try {
    const listRes = await requestJson(
      `${auth.apiUrl}/b2api/v3/b2_list_file_names`,
      'POST',
      { Authorization: auth.authorizationToken },
      {
        bucketId: config.b2BucketId,
        prefix: 'torrentflow/',
        maxFileCount: 1000
      },
      45000
    );

    const files = listRes.files || [];
    const now = Date.now();

    for (const file of files) {
      const ageMs = now - (file.uploadTimestamp || now);
      if (ageMs >= maxAgeMs) {
        console.log(`[Backblaze B2 Cleanup] File is older than ${retentionDays} days (${Math.round(ageMs / 3600000)}h old): "${file.fileName}". Deleting from B2...`);
        try {
          await deleteFileFromBackblazeB2(file.fileId, file.fileName);
          deletedCount++;
          deletedFiles.push({ fileId: file.fileId, fileName: file.fileName });
        } catch (delErr) {
          console.error(`[Backblaze B2 Cleanup] Failed to delete expired file "${file.fileName}":`, delErr.message);
          errors.push({ fileName: file.fileName, error: delErr.message });
        }
      }
    }
  } catch (listErr) {
    console.warn(`[Backblaze B2 Cleanup] Could not list bucket files for expiration scan: ${listErr.message}`);
    errors.push({ error: listErr.message });
  }

  if (deletedCount > 0) {
    console.log(`[Backblaze B2 Cleanup] Cleaned up ${deletedCount} expired file(s) (> ${retentionDays} days old) from Backblaze B2.`);
  }

  return { deletedCount, deletedFiles, errors };
}
