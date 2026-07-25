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
  return { buffer, contentType: "image/jpeg", placeholder: false };
}

// BMP only - sharp cannot decode BMP at all (see duplicateService.js).
async function renderWithJimp(sourcePath, size) {
  const image = await Jimp.read(sourcePath);
  image.cover({ w: size, h: size });
  const buffer = await image.getBuffer(JimpMime.jpeg);
  return { buffer, contentType: JimpMime.jpeg, placeholder: false };
}

// Same "couldn't be decoded" files that fail perceptual hashing during a
// scan (see duplicateService.js/scanOps.js) will also fail here - without
// this, the <img> tag gets a bare 500 and shows the browser's broken-image
// icon with no explanation. A placeholder keeps every request returning a
// valid, cacheable image; the client separately flags these visually using
// the width/height-is-null signal already present in the groups API.
async function renderPlaceholder(size) {
  const fontSize = Math.round(size * 0.15);
  const lineHeight = Math.round(fontSize * 1.25);
  const svg = Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#EFE7D2"/>
      <text x="50%" y="50%" font-family="monospace" font-size="${fontSize}" font-weight="700"
        fill="#8A6A22" text-anchor="middle" dominant-baseline="middle">
        <tspan x="50%" dy="-${lineHeight / 2}">no</tspan>
        <tspan x="50%" dy="${lineHeight}">preview</tspan>
      </text>
    </svg>`
  );
  const buffer = await sharp(svg).jpeg().toBuffer();
  return { buffer, contentType: "image/jpeg", placeholder: true };
}

// Returns { buffer, contentType, placeholder } or null if the photo id
// doesn't exist. Never accepts a raw filesystem path from the caller - only
// a photo id we already trust from our own database. Never throws for a
// file that can't be decoded - falls back to a placeholder instead.
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

  let result;
  try {
    result = sourcePath.toLowerCase().endsWith(".bmp")
      ? await renderWithJimp(sourcePath, size)
      : await renderWithSharp(sourcePath, size);
  } catch (error) {
    result = await renderPlaceholder(size);
  }

  rememberInCache(key, result);
  return result;
}
