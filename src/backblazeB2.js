import crypto from 'crypto';
import fs from 'fs';
import https from 'https';
import path from 'path';
import config from './config.js';

const HASH_BUFFER_SIZE = 1024 * 1024;

export class BackblazeB2UploadError extends Error {
  constructor(message, { statusCode = null, code = null, retryable } = {}) {
    super(message); this.name = 'BackblazeB2UploadError'; this.statusCode = statusCode; this.code = code;
    this.retryable = retryable ?? (statusCode === 408 || statusCode === 429 || statusCode >= 500 || code === 'expired_auth_token');
  }
}
export const isRetryableBackblazeB2Error = (error) => error?.retryable === true;

export function validateFilePathWithinDownloadDir(targetPath) {
  const base = path.resolve(config.temporaryDownloadPath), resolved = path.resolve(base, targetPath || ''), relative = path.relative(base, resolved);
  if (!targetPath || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Access denied: File path escapes the configured temporary directory');
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${path.basename(resolved)}`);
  const realPath = fs.realpathSync(resolved), realRelative = path.relative(base, realPath);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new Error('Access denied: Symbolic link resolves outside the configured temporary directory');
  const stat = fs.statSync(realPath); if (!stat.isFile() || stat.size < 1) throw new Error('Path must be a non-empty regular file');
  return { resolvedPath: realPath, size: stat.size, filename: path.basename(realPath) };
}

function requestJson(url, method, headers, body) {
  return new Promise((resolve, reject) => { const u = new URL(url), raw = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers: { ...headers, ...(raw ? { 'Content-Type': 'application/json', 'Content-Length': raw.length } : {}) } }, (res) => { let text = ''; res.on('data', c => { text += c; }); res.on('end', () => { let data; try { data = JSON.parse(text); } catch { data = {}; } if (res.statusCode >= 200 && res.statusCode < 300) resolve(data); else reject(new BackblazeB2UploadError(data.message || 'Backblaze B2 request failed.', { statusCode: res.statusCode, code: data.code })); }); });
    req.on('error', e => reject(new BackblazeB2UploadError(`Backblaze B2 network error: ${e.message}`, { retryable: true }))); if (raw) req.write(raw); req.end();
  });
}
async function authorize() {
  if (!config.b2ApplicationKeyId || !config.b2ApplicationKey || !config.b2BucketId || !config.b2BucketName) throw new BackblazeB2UploadError('Backblaze B2 is not configured. Add B2_APPLICATION_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET_ID, and B2_BUCKET_NAME.', { retryable: false });
  const basic = Buffer.from(`${config.b2ApplicationKeyId}:${config.b2ApplicationKey}`).toString('base64');
  return requestJson('https://api.backblazeb2.com/b2api/v4/b2_authorize_account', 'GET', { Authorization: `Basic ${basic}` });
}
function encodeName(name) { return encodeURIComponent(name).replace(/%2F/g, '/'); }
function sha1Range(filePath, start, end) { const fd = fs.openSync(filePath, 'r'); try { const hash = crypto.createHash('sha1'), buffer = Buffer.allocUnsafe(HASH_BUFFER_SIZE); let offset = start; while (offset <= end) { const length = Math.min(buffer.length, end - offset + 1); const read = fs.readSync(fd, buffer, 0, length, offset); if (!read) break; hash.update(buffer.subarray(0, read)); offset += read; } return hash.digest('hex'); } finally { fs.closeSync(fd); } }
function publicUrl(auth, name) { return config.b2PublicUrlBase ? `${config.b2PublicUrlBase.replace(/\/$/, '')}/${encodeName(name)}` : `${auth.apiInfo.storageApi.downloadUrl}/file/${encodeName(config.b2BucketName)}/${encodeName(name)}`; }
function uploadStream(url, token, name, source, start, end, extra, onBytes) { return new Promise((resolve, reject) => { const length = end - start + 1; const req = https.request(url, { method: 'POST', headers: { Authorization: token, 'Content-Length': length, ...extra } }, res => { let raw = ''; res.on('data', c => { raw += c; }); res.on('end', () => { try { const data = JSON.parse(raw); if (res.statusCode >= 200 && res.statusCode < 300) resolve(data); else reject(new BackblazeB2UploadError(data.message || 'Backblaze B2 upload failed.', { statusCode: res.statusCode, code: data.code })); } catch { reject(new BackblazeB2UploadError('Backblaze B2 returned an invalid upload response.', { statusCode: res.statusCode })); } }); }); req.on('error', e => reject(new BackblazeB2UploadError(`Backblaze B2 network error: ${e.message}`, { retryable: true }))); const stream = fs.createReadStream(source, { start, end, highWaterMark: HASH_BUFFER_SIZE }); stream.on('data', c => onBytes?.(c.length)); stream.on('error', e => req.destroy(e)); stream.pipe(req); }); }

async function verifyRemoteFile(apiUrl, authorizationToken, fileId, expectedSize) {
  const remote = await requestJson(`${apiUrl}/b2api/v4/b2_get_file_info`, 'POST', { Authorization: authorizationToken }, { fileId });
  if (Number(remote.contentLength) !== expectedSize) throw new BackblazeB2UploadError('Backblaze B2 verification failed: remote file size does not match the local file.', { retryable: true });
  return remote;
}

export async function uploadFileToBackblazeB2(targetPath, options = {}) {
  const { resolvedPath, size, filename } = validateFilePathWithinDownloadDir(targetPath), auth = await authorize(), apiUrl = auth.apiInfo.storageApi.apiUrl, name = `torrentflow/${Date.now()}-${filename}`; let done = 0; const startedAt = Date.now();
  const progress = n => { done += n; const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000); const uploadSpeed = done / elapsedSeconds; options.onProgress?.({ uploadedBytes: done, totalBytes: size, progress: Math.min(100, Math.round(done / size * 100)), uploadSpeed, estimatedRemainingSeconds: uploadSpeed ? Math.max(0, (size - done) / uploadSpeed) : null }); };
  let file;
  const partSize = Math.max(config.backblazeB2PartSizeBytes, auth.apiInfo.storageApi.absoluteMinimumPartSize || 0);
  if (size <= partSize) { const url = await requestJson(`${apiUrl}/b2api/v4/b2_get_upload_url`, 'POST', { Authorization: auth.authorizationToken }, { bucketId: config.b2BucketId }); const sha1 = sha1Range(resolvedPath, 0, size - 1); file = await uploadStream(url.uploadUrl, url.authorizationToken, name, resolvedPath, 0, size - 1, { 'X-Bz-File-Name': encodeName(name), 'Content-Type': 'b2/x-auto', 'X-Bz-Content-Sha1': sha1 }, progress); }
  else { const started = await requestJson(`${apiUrl}/b2api/v4/b2_start_large_file`, 'POST', { Authorization: auth.authorizationToken }, { bucketId: config.b2BucketId, fileName: name, contentType: 'b2/x-auto' }); const count = Math.ceil(size / partSize), sha1s = new Array(count); let nextPart = 0; const worker = async () => { while (true) { const i = nextPart++; if (i >= count) return; const start = i * partSize, end = Math.min(size - 1, start + partSize - 1), sha1 = sha1Range(resolvedPath, start, end); const part = await requestJson(`${apiUrl}/b2api/v4/b2_get_upload_part_url`, 'POST', { Authorization: auth.authorizationToken }, { fileId: started.fileId }); await uploadStream(part.uploadUrl, part.authorizationToken, name, resolvedPath, start, end, { 'X-Bz-Part-Number': i + 1, 'X-Bz-Content-Sha1': sha1 }, progress); sha1s[i] = sha1; } }; await Promise.all(Array.from({ length: Math.min(config.backblazeB2ParallelParts, count) }, worker)); file = await requestJson(`${apiUrl}/b2api/v4/b2_finish_large_file`, 'POST', { Authorization: auth.authorizationToken }, { fileId: started.fileId, partSha1Array: sha1s }); }
  await verifyRemoteFile(apiUrl, auth.authorizationToken, file.fileId, size);
  return { success: true, id: file.fileId, objectKey: name, url: publicUrl(auth, name), filename, size, uploadedAt: new Date().toISOString() };
}

export async function downloadBackblazeB2File(fileId, rangeHeader, response) {
  if (!/^[a-zA-Z0-9_\-]+$/.test(fileId || '')) throw new BackblazeB2UploadError('Invalid Backblaze B2 file reference.', { retryable: false });
  const auth = await authorize(); const url = new URL(`${auth.apiInfo.storageApi.downloadUrl}/b2api/v4/b2_download_file_by_id`); url.searchParams.set('fileId', fileId);
  await new Promise((resolve, reject) => {
    const request = https.request(url, { headers: { Authorization: auth.authorizationToken, ...(rangeHeader ? { Range: rangeHeader } : {}) } }, (remote) => {
      if (remote.statusCode !== 200 && remote.statusCode !== 206) { remote.resume(); return reject(new BackblazeB2UploadError(remote.statusCode === 404 ? 'Movie object was not found in Backblaze B2.' : 'Backblaze B2 playback request failed.', { statusCode: remote.statusCode, retryable: remote.statusCode >= 500 })); }
      response.status(remote.statusCode);
      for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) if (remote.headers[name]) response.setHeader(name, remote.headers[name]);
      response.setHeader('Cache-Control', 'private, no-store'); remote.pipe(response); remote.on('end', resolve); remote.on('error', reject);
    }); request.on('error', reject); request.end();
  });
}
