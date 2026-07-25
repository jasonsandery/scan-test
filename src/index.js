#!/usr/bin/env node
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { ScanController } from "./scanController.js";
import {
  initializeDatabase,
  closeDatabase,
  createOrUpdateDataset,
  getDataset,
  setPhotoArchived,
  restorePhotoArchive,
  getPhotosByDataset,
  createPruneRun,
  addPruneAction,
  getPruneRunById,
  getLatestRestorablePruneRun,
  getRestorableActionsForRun,
  markActionRestored,
  listPruneRuns,
} from "./db.js";
import {
  normalizeRelativePath,
  normalizeArchiveRoot,
  collectImageFiles,
  processImageFile,
  loadActiveDuplicateGroups,
  moveFile,
} from "./scanOps.js";

const program = new Command();

// Resolved relative to this file's own location (local/src/), not the
// process's current working directory - so `scan` from any directory (or
// the GUI server, started from server/) always finds the same database by
// default, instead of silently creating a new one wherever you happened to
// launch the process from.
const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, "duplicate_state.db");

function formatDuration(totalSeconds) {
  if (totalSeconds == null || !Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return null;
  }
  if (totalSeconds < 1) {
    return "<1s";
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.round(totalSeconds % 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

// Wires the scan up to whatever control surface the current process
// (interactive terminal vs. piped/CI) supports. Kept separate from
// ScanController so a future HTTP backend can drive the same controller from
// pause/resume/stop endpoints instead of keypresses.
function registerScanControls(controller) {
  const isInteractive = Boolean(process.stdin.isTTY);

  const onStatus = (status) => {
    if (status.state === "completed" || status.state === "stopped") {
      finish();
    }
  };

  const onSigint = () => {
    if (controller.state === "running" || controller.state === "paused") {
      console.log("\nStopping after the current batch... (progress so far is saved; Ctrl+C again to force quit)");
      controller.stop();
    } else {
      process.exit(1);
    }
  };

  const onKeypress = (str, key) => {
    if (key && key.ctrl && key.name === "c") {
      onSigint();
      return;
    }
    if (str === "p") {
      controller.state === "paused" ? controller.resume() : controller.pause();
    } else if (str === "s") {
      controller.stop();
    }
  };

  function finish() {
    if (isInteractive) {
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
    process.off("SIGINT", onSigint);
    controller.off("status", onStatus);
  }

  controller.on("status", onStatus);
  process.on("SIGINT", onSigint);

  if (isInteractive) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", onKeypress);
    console.log("Press [p] to pause/resume, [s] to stop - progress is saved as you go.");
  } else {
    console.log("Press Ctrl+C to stop - progress is saved as you go.");
  }
}

async function scanDataset(datasetName, rootPath, options) {
  const dbPath = path.resolve(options.db);
  const rootAbs = path.resolve(rootPath);
  const archiveRoot = normalizeArchiveRoot(null, options.archive) || path.join(rootAbs, "duplicates-archive");
  const db = initializeDatabase(dbPath);
  const dataset = createOrUpdateDataset(db, datasetName, rootAbs, archiveRoot);

  const excludeList = [archiveRoot].filter(Boolean);
  const imageFiles = await collectImageFiles(rootAbs, excludeList);
  const existingByPath = new Map(getPhotosByDataset(db, dataset.id).map((row) => [row.relative_path, row]));

  const controller = new ScanController({
    db,
    dataset,
    files: imageFiles,
    existingByPath,
    processFile: (absolutePath) =>
      processImageFile(absolutePath, normalizeRelativePath(rootAbs, absolutePath), existingByPath, options.force),
  });

  controller.on("fileError", (result) => {
    process.stdout.write("\n");
    console.warn(`Skipping unreadable image: ${result.relativePath} (${result.error.message})`);
  });

  controller.on("fileWarning", (result) => {
    process.stdout.write("\n");
    console.warn(`Indexed but couldn't perceptually hash (likely corrupted): ${result.relativePath} (${result.metadataWarning})`);
  });

  controller.on("progress", (status) => {
    const suffix = status.state === "paused" ? " [paused - press p to resume]" : "...";
    const eta = formatDuration(status.etaSeconds);
    const etaText = eta ? ` - ~${eta} remaining` : "";
    const line = `Processed ${status.processed}/${status.total} (hashed ${status.hashed}, unchanged ${status.unchanged}, warned ${status.warned}, failed ${status.failed})${etaText}${suffix}`;
    // Padded so a shorter line (e.g. once the ETA disappears) fully overwrites
    // a longer previous one instead of leaving stray trailing characters.
    process.stdout.write(`${line.padEnd(110)}\r`);
  });

  registerScanControls(controller);
  const finalStatus = await controller.run();
  const elapsed = formatDuration(finalStatus.elapsedMs / 1000);
  const elapsedText = elapsed ? ` in ${elapsed}` : "";

  console.log("");
  if (finalStatus.state === "stopped") {
    console.log(
      `Scan stopped at ${finalStatus.processed}/${finalStatus.total} (${finalStatus.hashed} hashed, ${finalStatus.unchanged} unchanged, ${finalStatus.warned} warned, ${finalStatus.failed} failed)${elapsedText}.`
    );
    console.log(`Re-run scan for '${datasetName}' to continue - already-processed files are skipped automatically.`);
  } else {
    console.log(
      `Scan complete. ${finalStatus.total} images found for dataset '${datasetName}': ${finalStatus.hashed} hashed, ${finalStatus.unchanged} unchanged, ${finalStatus.warned} warned (indexed but not perceptually hashed), ${finalStatus.failed} failed${elapsedText}.`
    );
  }
  console.log(`Database file: ${dbPath}`);
  console.log(`Archive root: ${archiveRoot}`);
  closeDatabase(db);
}

function formatGroup(group, index) {
  const lines = [];
  lines.push(`Group ${index + 1}: keep ${group.keep.relativePath}`);
  lines.push(`  duplicates:`);
  group.duplicates.forEach((item) => {
    const dimensions = item.width && item.height ? `${item.width}x${item.height}` : "dimensions unknown";
    lines.push(`    - ${item.relativePath} (${item.size} bytes, ${dimensions}, modified ${new Date(item.mtimeMs).toISOString()})`);
  });
  return lines.join("\n");
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
  const dbPath = path.resolve(options.db);
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

async function pruneDataset(datasetName, options) {
  const dbPath = path.resolve(options.db);
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
  const dbPath = path.resolve(options.db);
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
  const dbPath = path.resolve(options.db);
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
  const dbPath = path.resolve(options.db);
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
  .option("--db <dbPath>", "SQLite database path", DEFAULT_DB_PATH)
  .option("--archive <archiveRoot>", "Local archive folder for duplicates")
  .option("--force", "Re-hash every file, ignoring the unchanged-file skip (a true restart, not a resume)", false)
  .action(async (dataset, rootPath, options) => {
    await scanDataset(dataset, rootPath, options);
  });

program
  .command("report <dataset>")
  .description("Show duplicate groups for a dataset")
  .option("--db <dbPath>", "SQLite database path", DEFAULT_DB_PATH)
  .action(async (dataset, options) => {
    await showReport(dataset, options);
  });

program
  .command("prune <dataset>")
  .description("Move duplicate files into the archive folder")
  .option("--db <dbPath>", "SQLite database path", DEFAULT_DB_PATH)
  .option("--archive <archiveRoot>", "Local archive folder for duplicate files")
  .option("--dry-run", "Show what would be moved without changing files", false)
  .action(async (dataset, options) => {
    await pruneDataset(dataset, options);
  });

program
  .command("rollback <dataset>")
  .description("Restore files moved by a previous prune run")
  .option("--db <dbPath>", "SQLite database path", DEFAULT_DB_PATH)
  .option("--run <runId>", "Prune run id to roll back (defaults to the most recent restorable run)")
  .option("--dry-run", "Show what would be restored without changing files", false)
  .action(async (dataset, options) => {
    await rollbackDataset(dataset, options);
  });

program
  .command("runs <dataset>")
  .description("List prune runs for a dataset")
  .option("--db <dbPath>", "SQLite database path", DEFAULT_DB_PATH)
  .action(async (dataset, options) => {
    await showPruneRuns(dataset, options);
  });

program
  .command("status <dataset>")
  .description("Show dataset indexing and archive status")
  .option("--db <dbPath>", "SQLite database path", DEFAULT_DB_PATH)
  .action(async (dataset, options) => {
    await showStatus(dataset, options);
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error);
  process.exit(1);
});
