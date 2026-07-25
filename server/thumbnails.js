import sharp from "sharp";
import { Jimp, JimpMime } from "jimp";
import { getPhotoById } from "../src/db.js";

// Small in-memory cache so scrolling a group list doesn't re-decode the same
// full-resolution photo on every render. Keyed on mtime so it self-invalidates
// if the underlying file changes (e.g. after a rescan replaces a photo).
const CACHE_LIMIT = 300;
const cache = new Map();

function rememberInCache(key, value) {
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}

async function renderWithSharp(sourcePath, size) {
  const buffer = await sharp(sourcePath).resize(size, size, { fit: "cover" }).jpeg().toBuffer();
  return { buffer, contentType: "image/jpeg" };
}

// BMP only - sharp cannot decode BMP at all (see duplicateService.js).
async function renderWithJimp(sourcePath, size) {
  const image = await Jimp.read(sourcePath);
  image.cover({ w: size, h: size });
  const buffer = await image.getBuffer(JimpMime.jpeg);
  return { buffer, contentType: JimpMime.jpeg };
}

// Returns { buffer, contentType } or null if the photo id doesn't exist.
// Never accepts a raw filesystem path from the caller - only a photo id we
// already trust from our own database.
export async function renderThumbnail(db, photoId, size) {
  const photo = getPhotoById(db, photoId);
  if (!photo) {
    return null;
  }

  const sourcePath = photo.is_archived && photo.archive_path ? photo.archive_path : photo.absolute_path;
  const key = `${photoId}:${size}:${photo.mtime_ms}`;
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }

  const result = sourcePath.toLowerCase().endsWith(".bmp")
    ? await renderWithJimp(sourcePath, size)
    : await renderWithSharp(sourcePath, size);
  rememberInCache(key, result);
  return result;
}
