import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import config from './config.js';

const cataloguePath = config.movieCataloguePath;
let movies = [];
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try { movies = fs.existsSync(cataloguePath) ? JSON.parse(fs.readFileSync(cataloguePath, 'utf8')).movies || [] : []; } catch (error) { console.warn('[MovieCatalogue] Could not read catalogue:', error.message); movies = []; }
}
function save() { fs.writeFileSync(cataloguePath, JSON.stringify({ version: 1, movies }, null, 2), 'utf8'); }
function publicMovie(movie) {
  const { b2FileId, ...safe } = movie;
  return {
    ...safe,
    accessKey: movie.accessKey || null,
    uploadedBy: movie.uploadedBy || null
  };
}
export function listMovies() { load(); return movies.filter((movie) => movie.uploadStatus === 'completed').map(publicMovie); }
export function getMovie(id) { load(); const movie = movies.find((item) => item.id === id && item.uploadStatus === 'completed'); return movie ? publicMovie(movie) : null; }
export function getPlaybackMovie(id) { load(); return movies.find((item) => item.id === id && item.uploadStatus === 'completed') || null; }
export function findMovieByInfoHash(infoHash) { load(); const movie = movies.find((item) => item.infoHash === infoHash); return movie ? publicMovie(movie) : null; }
export function findMovieByAccessKey(key) {
  load();
  if (!key || typeof key !== 'string') return null;
  const clean = key.trim().toUpperCase();
  const movie = movies.find(
    (item) => item.uploadStatus === 'completed' && (
      (item.accessKey && item.accessKey.toUpperCase() === clean) ||
      (item.infoHash && item.infoHash.toUpperCase() === clean)
    )
  );
  return movie ? publicMovie(movie) : null;
}
export function getPlaybackMovieByAccessKey(key) {
  load();
  if (!key || typeof key !== 'string') return null;
  const clean = key.trim().toUpperCase();
  return movies.find(
    (item) => item.uploadStatus === 'completed' && (
      (item.accessKey && item.accessKey.toUpperCase() === clean) ||
      (item.infoHash && item.infoHash.toUpperCase() === clean)
    )
  ) || null;
}
export function registerUploadedMovie({ filename, size, b2FileId, objectKey, torrentName, infoHash, telegramUser, accessKey }) {
  load();
  if (!b2FileId) throw new Error('A confirmed Backblaze B2 file ID is required.');
  let movie = movies.find((item) => item.b2FileId === b2FileId || (infoHash && item.infoHash === infoHash && item.filename === filename));
  const now = new Date().toISOString();
  if (!movie) { movie = { id: crypto.randomUUID(), createdAt: now }; movies.push(movie); }
  const generatedKey = accessKey || movie.accessKey || ('TF-' + crypto.randomBytes(6).toString('hex').toUpperCase());
  Object.assign(movie, {
    title: movie.title || path.parse(filename).name,
    filename,
    size: Number(size) || 0,
    b2FileId,
    objectKey: objectKey || null,
    torrentName: torrentName || null,
    infoHash: infoHash || movie.infoHash || null,
    accessKey: generatedKey,
    uploadedBy: telegramUser || movie.uploadedBy || null,
    uploadStatus: 'completed',
    updatedAt: now
  });
  save();
  return publicMovie(movie);
}
export function updateMovieMetadata(id, input = {}) {
  load(); const movie = movies.find((item) => item.id === id && item.uploadStatus === 'completed'); if (!movie) return null;
  for (const field of ['title', 'description', 'poster', 'year', 'subtitles']) if (Object.hasOwn(input, field)) movie[field] = input[field];
  movie.updatedAt = new Date().toISOString(); save(); return publicMovie(movie);
}
export function removeMovieByB2FileId(b2FileId) {
  load();
  const initialLength = movies.length;
  movies = movies.filter((item) => item.b2FileId !== b2FileId);
  if (movies.length !== initialLength) {
    save();
    return true;
  }
  return false;
}
export function removeMovieByObjectKey(objectKey) {
  load();
  const initialLength = movies.length;
  movies = movies.filter((item) => item.objectKey !== objectKey);
  if (movies.length !== initialLength) {
    save();
    return true;
  }
  return false;
}
