import fs from "node:fs/promises";
import path from "node:path";
import {
  computeFileHash,
  computeImageMetadata,
  buildDuplicateGroups,
  isSupportedImage,
  isCurrentHashFormat,
} from "./duplicateService.js";
import { getPhotosByDataset } from "./db.js";

// Shared, side-effect-free (beyond real filesystem I/O) operations used by
// both the CLI (src/index.js) and the HTTP server (server/), so the two
// front ends never fork this logic.

export function normalizeRelativePath(rootPath, absolutePath) {
  const relative = path.relative(rootPath, absolutePath);
  return relative.split(path.sep).join("/");
}

export function normalizeArchiveRoot(dataset, archiveRoot) {
  if (archiveRoot) {
    return path.resolve(archiveRoot);
  }
  if (dataset && dataset.archive_root) {
    return path.resolve(dataset.archive_root);
  }
  return null;
}

// Raw SQLite rows are snake_case; duplicateService and both front ends work
// with a plain camelCase shape so they don't need to know about storage.
export function toDuplicateItem(row) {
  return {
    id: row.id,
    relativePath: row.relative_path,
    absolutePath: row.absolute_path,
    size: row.size,
    mtimeMs: row.mtime_ms,
    sha256: row.sha256,
    width: row.width,
    height: row.height,
    phash: row.phash,
  };
}

export async function collectImageFiles(rootPath, excludePaths = []) {
  const files = [];
  const rootAbs = path.resolve(rootPath);
  const normalizedExcludes = excludePaths.map((exclude) => path.resolve(exclude));

  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (normalizedExcludes.some((exclude) => entryPath === exclude || entryPath.startsWith(`${exclude}${path.sep}`))) {
        continue;
      }

      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && isSupportedImage(entryPath)) {
        files.push(entryPath);
      }
    }
  }

  await walk(rootAbs);
  return files;
}

export async function processImageFile(absolutePath, relativePath, existingByPath, force) {
  let stats;
  try {
    stats = await fs.stat(absolutePath);
  } catch (error) {
    return { relativePath, absolutePath, error };
  }

  // A stale-format hash (e.g. from before a hashing-algorithm change) is
  // never treated as "unchanged" - this self-heals older datasets on their
  // next scan instead of silently comparing incompatible hash formats.
  const existing = existingByPath.get(relativePath);
  if (
    !force &&
    existing &&
    existing.size === stats.size &&
    existing.mtime_ms === stats.mtimeMs &&
    isCurrentHashFormat(existing.phash)
  ) {
    return { relativePath, absolutePath, unchanged: true, photoId: existing.id };
  }

  let sha256;
  try {
    sha256 = await computeFileHash(absolutePath);
  } catch (error) {
    return { relativePath, absolutePath, error };
  }

  // Perceptual hashing needs a full image decode, which can fail on a
  // genuinely corrupted/truncated file even though its raw bytes hash fine.
  // Don't let that discard the SHA256 - the file still gets recorded (and
  // still gets exact-duplicate detection), just without a phash.
  let width = null;
  let height = null;
  let pHash = null;
  let metadataWarning = null;
  try {
    const metadata = await computeImageMetadata(absolutePath);
    width = metadata.width;
    height = metadata.height;
    pHash = metadata.pHash;
  } catch (error) {
    metadataWarning = error.message;
  }

  return {
    relativePath,
    absolutePath,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    sha256,
    width,
    height,
    pHash,
    metadataWarning,
  };
}

export function loadActiveDuplicateGroups(db, datasetId) {
  const rows = getPhotosByDataset(db, datasetId).filter((row) => !row.is_archived);
  return buildDuplicateGroups(rows.map(toDuplicateItem));
}

export async function ensureDirectoryExists(directory) {
  await fs.mkdir(directory, { recursive: true });
}

export async function moveFile(source, destination) {
  await ensureDirectoryExists(path.dirname(destination));
  try {
    await fs.rename(source, destination);
  } catch (error) {
    if (error.code === "EXDEV") {
      await fs.copyFile(source, destination);
      await fs.unlink(source);
    } else {
      throw error;
    }
  }
}
