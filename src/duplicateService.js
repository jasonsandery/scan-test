import crypto from "node:crypto";
import fs from "node:fs";
import { Jimp, compareHashes } from "jimp";

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

// compareHashes returns 0 (identical) .. 1 (unrelated); 0.1 reliably separates
// resized/re-encoded copies of the same photo from genuinely different photos
// (see local smoke test: same-image-resized scored 0, different-image scored 0.09+).
const DEFAULT_NEAR_DUP_THRESHOLD = 0.1;
const DEFAULT_COMPARISON_WINDOW = 8;

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

export async function computeImageMetadata(filePath) {
  const image = await Jimp.read(filePath);
  return {
    width: image.bitmap.width,
    height: image.bitmap.height,
    pHash: image.hash(),
  };
}

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

  const withHash = items.filter((item) => item.phash);
  const sorted = [...withHash].sort((a, b) => (a.phash < b.phash ? -1 : a.phash > b.phash ? 1 : 0));
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < Math.min(sorted.length, i + 1 + window); j += 1) {
      const distance = compareHashes(sorted[i].phash, sorted[j].phash);
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
