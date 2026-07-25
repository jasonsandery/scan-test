import crypto from "node:crypto";
import fs from "node:fs";
import sharp from "sharp";
import { Jimp } from "jimp";

export const supportedExtensions = [
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".bmp",
  ".tiff",
  ".tif"
];

export function isSupportedImage(filePath) {
  const lower = filePath.toLowerCase();
  return supportedExtensions.some((ext) => lower.endsWith(ext));
}

export async function computeFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

// --- Perceptual hash (dHash) --------------------------------------------
//
// sharp (native libjpeg-turbo/libvips) decodes everything except BMP, which
// it doesn't support at all - Jimp (pure JS) covers that one format. Both
// paths reduce down to the same small grayscale pixel grid and run through
// the SAME hash function below, so hashes stay comparable across formats -
// a BMP and a JPEG of the same photo still land in the same duplicate group.
//
// Versioned (HASH_VERSION prefix) so a change to this algorithm can't
// silently compare old- and new-format hashes against each other: a stale
// hash just never matches (see isCurrentHashFormat / hammingDistance).
export const HASH_VERSION = "dh1";
const HASH_GRID_WIDTH = 9;
const HASH_GRID_HEIGHT = 8;

const NIBBLE_POPCOUNT = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

function dHashFromGrayscale(buffer, width, height) {
  const bits = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      bits.push(buffer[y * width + x] < buffer[y * width + x + 1] ? 1 : 0);
    }
  }
  const bytes = Buffer.alloc(Math.ceil(bits.length / 8));
  bits.forEach((bit, index) => {
    if (bit) {
      bytes[index >> 3] |= 1 << (7 - (index % 8));
    }
  });
  return bytes.toString("hex");
}

async function computeHashViaSharp(filePath) {
  const image = sharp(filePath);
  const metadata = await image.metadata();
  const gray = await image
    .clone()
    .resize(HASH_GRID_WIDTH, HASH_GRID_HEIGHT, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer();
  return {
    width: metadata.width,
    height: metadata.height,
    pHash: `${HASH_VERSION}:${dHashFromGrayscale(gray, HASH_GRID_WIDTH, HASH_GRID_HEIGHT)}`,
  };
}

// BMP only - sharp cannot decode BMP at all.
async function computeHashViaJimp(filePath) {
  const image = await Jimp.read(filePath);
  const width = image.bitmap.width;
  const height = image.bitmap.height;
  const resized = image.clone().resize({ w: HASH_GRID_WIDTH, h: HASH_GRID_HEIGHT }).greyscale();

  const gray = Buffer.alloc(HASH_GRID_WIDTH * HASH_GRID_HEIGHT);
  for (let i = 0; i < gray.length; i += 1) {
    gray[i] = resized.bitmap.data[i * 4]; // RGBA -> R (R=G=B post-greyscale)
  }

  return {
    width,
    height,
    pHash: `${HASH_VERSION}:${dHashFromGrayscale(gray, HASH_GRID_WIDTH, HASH_GRID_HEIGHT)}`,
  };
}

export async function computeImageMetadata(filePath) {
  if (filePath.toLowerCase().endsWith(".bmp")) {
    return computeHashViaJimp(filePath);
  }
  return computeHashViaSharp(filePath);
}

export function isCurrentHashFormat(phash) {
  return typeof phash === "string" && phash.startsWith(`${HASH_VERSION}:`);
}

// Hamming distance in bits (0-64). Returns Infinity for missing/stale-format
// hashes so they simply never match anything, rather than being compared
// against a different algorithm's output.
export function hammingDistance(phashA, phashB) {
  if (!isCurrentHashFormat(phashA) || !isCurrentHashFormat(phashB)) {
    return Infinity;
  }
  const hexA = phashA.slice(HASH_VERSION.length + 1);
  const hexB = phashB.slice(HASH_VERSION.length + 1);
  if (hexA.length !== hexB.length) {
    return Infinity;
  }
  let distance = 0;
  for (let i = 0; i < hexA.length; i += 1) {
    distance += NIBBLE_POPCOUNT[parseInt(hexA[i], 16) ^ parseInt(hexB[i], 16)];
  }
  return distance;
}

// --- Duplicate grouping ---------------------------------------------------

// Hamming distance is an integer 0-64 for a 64-bit dHash; empirically
// calibrated (see local smoke tests) against both synthetic and real photos.
const DEFAULT_NEAR_DUP_THRESHOLD = 10;
const DEFAULT_COMPARISON_WINDOW = 8;

export function compareCandidates(a, b) {
  const pixelsA = (a.width || 0) * (a.height || 0);
  const pixelsB = (b.width || 0) * (b.height || 0);

  if (pixelsA !== pixelsB) {
    return pixelsB - pixelsA;
  }

  if (a.size !== b.size) {
    return b.size - a.size;
  }

  return (b.mtimeMs || 0) - (a.mtimeMs || 0);
}

export function selectBestCandidate(candidates) {
  return [...candidates].sort(compareCandidates)[0];
}

// Single union-find pass combining both duplicate signals, so a near-duplicate
// (e.g. a resized copy) of an already-exact-matched pair joins the same group
// instead of being compared only against other leftover items. Sorting by hash
// string clusters visually-similar images next to each other, so comparing each
// item against a small trailing window (instead of every other item) keeps the
// near-duplicate pass roughly O(n log n) at 20k+ photos.
export function buildDuplicateGroups(items, options = {}) {
  const threshold = options.threshold ?? DEFAULT_NEAR_DUP_THRESHOLD;
  const window = options.window ?? DEFAULT_COMPARISON_WINDOW;

  const parent = new Map(items.map((item) => [item.id, item.id]));
  function find(id) {
    let root = id;
    while (parent.get(root) !== root) {
      root = parent.get(root);
    }
    while (parent.get(id) !== root) {
      const next = parent.get(id);
      parent.set(id, root);
      id = next;
    }
    return root;
  }
  function union(a, b) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) {
      parent.set(rootA, rootB);
    }
  }

  const bySha = new Map();
  items.forEach((item) => {
    if (!item.sha256) {
      return;
    }
    const existingId = bySha.get(item.sha256);
    if (existingId !== undefined) {
      union(existingId, item.id);
    } else {
      bySha.set(item.sha256, item.id);
    }
  });

  const withHash = items.filter((item) => isCurrentHashFormat(item.phash));
  const sorted = [...withHash].sort((a, b) => (a.phash < b.phash ? -1 : a.phash > b.phash ? 1 : 0));
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < Math.min(sorted.length, i + 1 + window); j += 1) {
      const distance = hammingDistance(sorted[i].phash, sorted[j].phash);
      if (distance <= threshold) {
        union(sorted[i].id, sorted[j].id);
      }
    }
  }

  const clusters = new Map();
  items.forEach((item) => {
    const root = find(item.id);
    const bucket = clusters.get(root) || [];
    bucket.push(item);
    clusters.set(root, bucket);
  });

  return [...clusters.values()]
    .filter((group) => group.length > 1)
    .map((group) => {
      const keep = selectBestCandidate(group);
      const duplicates = group.filter((item) => item.id !== keep.id);
      return { group, keep, duplicates };
    });
}
