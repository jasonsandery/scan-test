import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import {
  initializeDatabase,
  closeDatabase,
  createOrUpdateDataset,
  getDataset,
  getPhotoByRelativePath,
  upsertPhotoRecord,
  touchLastSeen,
  setDatasetLastScan,
  getPhotosByDataset,
  setPhotoArchived,
  restorePhotoArchive,
  withTransaction,
  createPruneRun,
  addPruneAction,
  getPruneRunById,
  getLatestRestorablePruneRun,
  getRestorableActionsForRun,
  markActionRestored,
  listPruneRuns,
} from "./db.js";
import {
  computeFileHash,
  computeImageMetadata,
  buildDuplicateGroups,
  isSupportedImage,
} from "./duplicateService.js";

const program = new Command();
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_BATCH_SIZE = 200;

function normalizeRelativePath(rootPath, absolutePath) {
  const relative = path.relative(rootPath, absolutePath);
  return relative.split(path.sep).join("/");
}

function normalizeArchiveRoot(dataset, archiveRoot) {
  if (archiveRoot) {
    return path.resolve(archiveRoot);
  }
  if (dataset && dataset.archive_root) {
    return path.resolve(dataset.archive_root);
  }
  return null;
}

// Raw SQLite rows are snake_case; duplicateService and the CLI's formatting
// work with a plain camelCase shape so they don't need to know about storage.
function toDuplicateItem(row) {
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

async function collectImageFiles(rootPath, excludePaths = []) {
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

// Runs `worker` over `items` with at most `limit` in flight at once, preserving
// input order in the returned array. Kept dependency-free since the concurrency
// need here is simple (no priorities, no cancellation).
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runNext() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, runNext));
  return results;
}

async function processImageFile(absolutePath, relativePath, existingByPath) {
  let stats;
  try {
    stats = await fs.stat(absolutePath);
  } catch (error) {
    return { relativePath, absolutePath, error };
  }

  const existing = existingByPath.get(relativePath);
  if (existing && existing.size === stats.size && existing.mtime_ms === stats.mtimeMs) {
    return { relativePath, absolutePath, unchanged: true, photoId: existing.id };
  }

  try {
    const sha256 = await computeFileHash(absolutePath);
    const metadata = await computeImageMetadata(absolutePath);
    return {
      relativePath,
      absolutePath,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      sha256,
      width: metadata.width,
      height: metadata.height,
      pHash: metadata.pHash,
    };
  } catch (error) {
    return { relativePath, absolutePath, error };
  }
}

async function scanDataset(datasetName, rootPath, options) {
  const dbPath = path.resolve(options.db || "duplicate_state.db");
  const rootAbs = path.resolve(rootPath);
  const archiveRoot = normalizeArchiveRoot(null, options.archive) || path.join(rootAbs, "duplicates-archive");
  const db = initializeDatabase(dbPath);
  const dataset = createOrUpdateDataset(db, datasetName, rootAbs, archiveRoot);

  const excludeList = [archiveRoot].filter(Boolean);
  const imageFiles = await collectImageFiles(rootAbs, excludeList);
  const existingByPath = new Map(getPhotosByDataset(db, dataset.id).map((row) => [row.relative_path, row]));

  let hashed = 0;
  let unchanged = 0;
  let failed = 0;

  for (let offset = 0; offset < imageFiles.length; offset += DEFAULT_BATCH_SIZE) {
    const batch = imageFiles.slice(offset, offset + DEFAULT_BATCH_SIZE);
    const results = await runWithConcurrency(batch, DEFAULT_CONCURRENCY, (absolutePath) =>
      processImageFile(absolutePath, normalizeRelativePath(rootAbs, absolutePath), existingByPath)
    );

    withTransaction(db, () => {
      const now = new Date().toISOString();
      for (const result of results) {
        if (result.error) {
          failed += 1;
          console.warn(`\nSkipping unreadable image: ${result.relativePath} (${result.error.message})`);
          continue;
        }
        if (result.unchanged) {
          touchLastSeen(db, result.photoId, result.absolutePath, now);
          unchanged += 1;
          continue;
        }
        upsertPhotoRecord(db, dataset.id, { ...result, lastSeenAt: now });
        hashed += 1;
      }
    });

    const processed = Math.min(offset + DEFAULT_BATCH_SIZE, imageFiles.length);
    process.stdout.write(
      `Processed ${processed}/${imageFiles.length} (hashed ${hashed}, unchanged ${unchanged}, failed ${failed})...\r`
    );
  }

  setDatasetLastScan(db, dataset.id);
  console.log(
    `\nScan complete. ${imageFiles.length} images found for dataset '${datasetName}': ${hashed} hashed, ${unchanged} unchanged, ${failed} failed.`
  );
  console.log(`Database file: ${dbPath}`);
  console.log(`Archive root: ${archiveRoot}`);
  closeDatabase(db);
}

function formatGroup(group, index) {
  const lines = [];
  lines.push(`Group ${index + 1}: keep ${group.keep.relativePath}`);
  lines.push(`  duplicates:`);
  group.duplicates.forEach((item) => {
    lines.push(`    - ${item.relativePath} (${item.size} bytes, ${item.width}x${item.height}, modified ${new Date(item.mtimeMs).toISOString()})`);
  });
  return lines.join("\n");
}

function loadActiveDuplicateGroups(db, datasetId) {
  const rows = getPhotosByDataset(db, datasetId).filter((row) => !row.is_archived);
  return buildDuplicateGroups(rows.map(toDuplicateItem));
}

function requireDataset(db, datasetName, dbPath) {
  const dataset = getDataset(db, datasetName);
  if (!dataset) {
    console.error(`Dataset '${datasetName}' not found in ${dbPath}.`);
    closeDatabase(db);
    process.exit(1);
  }
  return dataset;
}

async function showReport(datasetName, options) {
  const dbPath = path.resolve(options.db || "duplicate_state.db");
  const db = initializeDatabase(dbPath);
  const dataset = requireDataset(db, datasetName, dbPath);

  const totalPhotos = getPhotosByDataset(db, dataset.id).length;
  const groups = loadActiveDuplicateGroups(db, dataset.id);

  console.log(`Dataset: ${datasetName}`);
  console.log(`Root path: ${dataset.root_path}`);
  console.log(`Archive root: ${dataset.archive_root}`);
  console.log(`Total images indexed: ${totalPhotos}`);
  console.log(`Duplicate groups: ${groups.length}`);

  groups.forEach((group, index) => {
    console.log(formatGroup(group, index));
    console.log("");
  });
  closeDatabase(db);
}

async function ensureDirectoryExists(directory) {
  await fs.mkdir(directory, { recursive: true });
}

async function moveFile(source, destination) {
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

async function pruneDataset(datasetName, options) {
  const dbPath = path.resolve(options.db || "duplicate_state.db");
  const db = initializeDatabase(dbPath);
  const dataset = requireDataset(db, datasetName, dbPath);

  const archiveRoot = normalizeArchiveRoot(dataset, options.archive) || path.join(dataset.root_path, "duplicates-archive");
  const groups = loadActiveDuplicateGroups(db, dataset.id);

  if (groups.length === 0) {
    console.log("No duplicate groups found.");
    closeDatabase(db);
    return;
  }

  const runId = options.dryRun ? null : createPruneRun(db, dataset.id, false);
  let moved = 0;

  for (const group of groups) {
    for (const duplicate of group.duplicates) {
      const source = duplicate.absolutePath;
      const destination = path.join(archiveRoot, duplicate.relativePath);
      if (options.dryRun) {
        console.log(`[dry-run] move ${source} -> ${destination}`);
        continue;
      }
      await moveFile(source, destination);
      setPhotoArchived(db, duplicate.id, destination);
      addPruneAction(db, runId, duplicate.id, source, destination);
      moved += 1;
      console.log(`Moved duplicate: ${duplicate.relativePath}`);
    }
  }

  if (options.dryRun) {
    console.log(`Prune complete (dry-run). Archive root: ${archiveRoot}`);
  } else {
    console.log(`Prune complete. Moved ${moved} duplicate file(s) as run #${runId}. Archive root: ${archiveRoot}`);
    console.log(`Undo with: npm run rollback -- ${datasetName} --run ${runId}`);
  }
  closeDatabase(db);
}

async function rollbackDataset(datasetName, options) {
  const dbPath = path.resolve(options.db || "duplicate_state.db");
  const db = initializeDatabase(dbPath);
  const dataset = requireDataset(db, datasetName, dbPath);

  let run;
  if (options.run) {
    run = getPruneRunById(db, Number(options.run));
    if (!run || run.dataset_id !== dataset.id) {
      console.error(`Prune run '${options.run}' not found for dataset '${datasetName}'.`);
      closeDatabase(db);
      process.exit(1);
    }
  } else {
    run = getLatestRestorablePruneRun(db, dataset.id);
    if (!run) {
      console.log("No prune run available to roll back.");
      closeDatabase(db);
      return;
    }
  }

  const actions = getRestorableActionsForRun(db, run.id);
  if (actions.length === 0) {
    console.log(`Prune run #${run.id} has no pending actions to restore.`);
    closeDatabase(db);
    return;
  }

  let restored = 0;
  for (const action of actions) {
    if (options.dryRun) {
      console.log(`[dry-run] restore ${action.dest_path} -> ${action.source_path}`);
      continue;
    }
    await moveFile(action.dest_path, action.source_path);
    restorePhotoArchive(db, action.photo_id);
    markActionRestored(db, action.id);
    restored += 1;
    console.log(`Restored: ${action.relative_path}`);
  }

  if (options.dryRun) {
    console.log(`Rollback complete (dry-run). ${actions.length} file(s) would be restored from run #${run.id}.`);
  } else {
    console.log(`Rollback complete. Restored ${restored} file(s) from run #${run.id}.`);
  }
  closeDatabase(db);
}

async function showPruneRuns(datasetName, options) {
  const dbPath = path.resolve(options.db || "duplicate_state.db");
  const db = initializeDatabase(dbPath);
  const dataset = requireDataset(db, datasetName, dbPath);

  const runs = listPruneRuns(db, dataset.id);
  if (runs.length === 0) {
    console.log("No prune runs recorded.");
  } else {
    runs.forEach((run) => {
      const mode = run.dry_run ? "dry-run" : "live";
      console.log(`Run #${run.id} | ${run.started_at} | ${mode} | ${run.pending_actions}/${run.total_actions} pending restore`);
    });
  }
  closeDatabase(db);
}

async function showStatus(datasetName, options) {
  const dbPath = path.resolve(options.db || "duplicate_state.db");
  const db = initializeDatabase(dbPath);
  const dataset = requireDataset(db, datasetName, dbPath);

  const photos = getPhotosByDataset(db, dataset.id);
  const archived = photos.filter((photo) => photo.is_archived).length;
  console.log(`Dataset: ${datasetName}`);
  console.log(`Root path: ${dataset.root_path}`);
  console.log(`Archive root: ${dataset.archive_root}`);
  console.log(`Indexed photos: ${photos.length}`);
  console.log(`Archived duplicates: ${archived}`);
  console.log(`Last scan: ${dataset.last_scan_at || "never"}`);
  closeDatabase(db);
}

program
  .name("photo-duplicate-local")
  .description("Local photo duplicate scanner with SQLite state tracking");

program
  .command("scan <dataset> <rootPath>")
  .description("Scan a local folder tree and update state for a named dataset")
  .option("--db <dbPath>", "SQLite database path", "duplicate_state.db")
  .option("--archive <archiveRoot>", "Local archive folder for duplicates")
  .action(async (dataset, rootPath, options) => {
    await scanDataset(dataset, rootPath, options);
  });

program
  .command("report <dataset>")
  .description("Show duplicate groups for a dataset")
  .option("--db <dbPath>", "SQLite database path", "duplicate_state.db")
  .action(async (dataset, options) => {
    await showReport(dataset, options);
  });

program
  .command("prune <dataset>")
  .description("Move duplicate files into the archive folder")
  .option("--db <dbPath>", "SQLite database path", "duplicate_state.db")
  .option("--archive <archiveRoot>", "Local archive folder for duplicate files")
  .option("--dry-run", "Show what would be moved without changing files", false)
  .action(async (dataset, options) => {
    await pruneDataset(dataset, options);
  });

program
  .command("rollback <dataset>")
  .description("Restore files moved by a previous prune run")
  .option("--db <dbPath>", "SQLite database path", "duplicate_state.db")
  .option("--run <runId>", "Prune run id to roll back (defaults to the most recent restorable run)")
  .option("--dry-run", "Show what would be restored without changing files", false)
  .action(async (dataset, options) => {
    await rollbackDataset(dataset, options);
  });

program
  .command("runs <dataset>")
  .description("List prune runs for a dataset")
  .option("--db <dbPath>", "SQLite database path", "duplicate_state.db")
  .action(async (dataset, options) => {
    await showPruneRuns(dataset, options);
  });

program
  .command("status <dataset>")
  .description("Show dataset indexing and archive status")
  .option("--db <dbPath>", "SQLite database path", "duplicate_state.db")
  .action(async (dataset, options) => {
    await showStatus(dataset, options);
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error);
  process.exit(1);
});
