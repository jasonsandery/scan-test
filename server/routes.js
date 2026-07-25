import path from "node:path";
import express from "express";
import { ScanController } from "../src/scanController.js";
import {
  listDatasets,
  getDataset,
  createOrUpdateDataset,
  getPhotosByDataset,
  setPhotoArchived,
  restorePhotoArchive,
  createPruneRun,
  addPruneAction,
  getPruneRunById,
  getLatestRestorablePruneRun,
  getRestorableActionsForRun,
  markActionRestored,
  listPruneRuns,
} from "../src/db.js";
import {
  normalizeRelativePath,
  normalizeArchiveRoot,
  collectImageFiles,
  processImageFile,
  loadActiveDuplicateGroups,
  moveFile,
} from "../src/scanOps.js";
import { registerJob, getJob, getActiveJobForDataset } from "./scanJobs.js";
import { renderThumbnail } from "./thumbnails.js";

function toApiPhoto(item) {
  return {
    id: item.id,
    relativePath: item.relativePath,
    size: item.size,
    width: item.width,
    height: item.height,
    mtimeMs: item.mtimeMs,
    thumbnailUrl: `/api/photos/${item.id}/thumbnail`,
  };
}

function summarizeDataset(db, dataset) {
  const photos = getPhotosByDataset(db, dataset.id);
  const activeGroups = loadActiveDuplicateGroups(db, dataset.id);
  const reclaimableBytes = activeGroups.reduce(
    (sum, group) => sum + group.duplicates.reduce((s, item) => s + (item.size || 0), 0),
    0
  );
  const activeJob = getActiveJobForDataset(dataset.id);

  return {
    name: dataset.name,
    rootPath: dataset.root_path,
    archiveRoot: dataset.archive_root,
    lastScanAt: dataset.last_scan_at,
    indexedCount: photos.length,
    archivedCount: photos.filter((p) => p.is_archived).length,
    duplicateGroupCount: activeGroups.length,
    reclaimableBytes,
    // Indexed (has a SHA256, so exact-duplicate detection still works) but
    // couldn't be perceptually hashed - commonly a corrupted/truncated file.
    noPerceptualHashCount: photos.filter((p) => p.sha256 && !p.phash).length,
    activeJobId: activeJob ? activeJob.jobId : null,
    activeJobState: activeJob ? activeJob.controller.state : null,
  };
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function createRouter(db) {
  const router = express.Router();

  router.get("/datasets", (req, res) => {
    res.json(listDatasets(db).map((dataset) => summarizeDataset(db, dataset)));
  });

  router.get("/datasets/:name", (req, res) => {
    const dataset = getDataset(db, req.params.name);
    if (!dataset) {
      return res.status(404).json({ error: `Dataset '${req.params.name}' not found.` });
    }
    res.json(summarizeDataset(db, dataset));
  });

  router.post("/datasets/:name/scan", async (req, res) => {
    const datasetName = req.params.name;
    let dataset = getDataset(db, datasetName);
    const rootPath = req.body?.rootPath || dataset?.root_path;
    if (!rootPath) {
      return res.status(400).json({ error: "rootPath is required to scan a new dataset." });
    }

    const rootAbs = path.resolve(rootPath);
    const archiveRoot =
      normalizeArchiveRoot(dataset, req.body?.archiveRoot) || path.join(rootAbs, "duplicates-archive");
    dataset = createOrUpdateDataset(db, datasetName, rootAbs, archiveRoot);

    const existingActive = getActiveJobForDataset(dataset.id);
    if (existingActive) {
      return res
        .status(409)
        .json({ error: "A scan is already active for this dataset.", jobId: existingActive.jobId });
    }

    const excludeList = [archiveRoot].filter(Boolean);
    const imageFiles = await collectImageFiles(rootAbs, excludeList);
    const existingByPath = new Map(getPhotosByDataset(db, dataset.id).map((row) => [row.relative_path, row]));
    const force = Boolean(req.body?.force);

    const controller = new ScanController({
      db,
      dataset,
      files: imageFiles,
      existingByPath,
      processFile: (absolutePath) =>
        processImageFile(absolutePath, normalizeRelativePath(rootAbs, absolutePath), existingByPath, force),
    });

    const jobId = registerJob(dataset.id, datasetName, controller);
    controller.run().catch((error) => {
      console.error(`Scan job ${jobId} for dataset '${datasetName}' failed:`, error);
    });

    res.status(202).json({ jobId, total: imageFiles.length });
  });

  router.get("/scan/:jobId/events", (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: "Unknown scan job." });
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders?.();

    sendSse(res, "status", job.controller.getStatus());

    const onProgress = (status) => sendSse(res, "progress", status);
    const onFileError = (result) =>
      sendSse(res, "fileError", { relativePath: result.relativePath, message: result.error?.message });
    const onFileWarning = (result) =>
      sendSse(res, "fileWarning", { relativePath: result.relativePath, message: result.metadataWarning });
    const onStatus = (status) => {
      sendSse(res, "status", status);
      if (status.state === "completed" || status.state === "stopped") {
        cleanup();
        res.end();
      }
    };

    function cleanup() {
      job.controller.off("progress", onProgress);
      job.controller.off("status", onStatus);
      job.controller.off("fileError", onFileError);
      job.controller.off("fileWarning", onFileWarning);
    }

    job.controller.on("progress", onProgress);
    job.controller.on("status", onStatus);
    job.controller.on("fileError", onFileError);
    job.controller.on("fileWarning", onFileWarning);
    req.on("close", cleanup);
  });

  function scanControlHandler(method) {
    return (req, res) => {
      const job = getJob(req.params.jobId);
      if (!job) {
        return res.status(404).json({ error: "Unknown scan job." });
      }
      const ok = job.controller[method]();
      res.json({ ok, status: job.controller.getStatus() });
    };
  }
  router.post("/scan/:jobId/pause", scanControlHandler("pause"));
  router.post("/scan/:jobId/resume", scanControlHandler("resume"));
  router.post("/scan/:jobId/stop", scanControlHandler("stop"));

  router.get("/datasets/:name/groups", (req, res) => {
    const dataset = getDataset(db, req.params.name);
    if (!dataset) {
      return res.status(404).json({ error: `Dataset '${req.params.name}' not found.` });
    }
    const groups = loadActiveDuplicateGroups(db, dataset.id);
    res.json(
      groups.map((group) => {
        const isExact = group.group.every((item) => item.sha256 && item.sha256 === group.keep.sha256);
        return {
          matchType: isExact ? "exact" : "near",
          keep: toApiPhoto(group.keep),
          duplicates: group.duplicates.map(toApiPhoto),
          reclaimableBytes: group.duplicates.reduce((sum, item) => sum + (item.size || 0), 0),
        };
      })
    );
  });

  router.post("/datasets/:name/prune", async (req, res) => {
    const dataset = getDataset(db, req.params.name);
    if (!dataset) {
      return res.status(404).json({ error: `Dataset '${req.params.name}' not found.` });
    }

    const dryRun = Boolean(req.body?.dryRun);
    const photoIdFilter = Array.isArray(req.body?.photoIds) ? new Set(req.body.photoIds) : null;
    const groups = loadActiveDuplicateGroups(db, dataset.id);
    const targets = groups
      .flatMap((group) => group.duplicates)
      .filter((item) => !photoIdFilter || photoIdFilter.has(item.id));

    if (targets.length === 0) {
      return res.json({ dryRun, runId: null, moved: [] });
    }

    const runId = dryRun ? null : createPruneRun(db, dataset.id, false);
    const moved = [];

    for (const duplicate of targets) {
      const destination = path.join(dataset.archive_root, duplicate.relativePath);
      if (dryRun) {
        moved.push({ id: duplicate.id, relativePath: duplicate.relativePath, destination });
        continue;
      }
      await moveFile(duplicate.absolutePath, destination);
      setPhotoArchived(db, duplicate.id, destination);
      addPruneAction(db, runId, duplicate.id, duplicate.absolutePath, destination);
      moved.push({ id: duplicate.id, relativePath: duplicate.relativePath, destination });
    }

    res.json({ dryRun, runId, moved, archiveRoot: dataset.archive_root });
  });

  router.get("/datasets/:name/runs", (req, res) => {
    const dataset = getDataset(db, req.params.name);
    if (!dataset) {
      return res.status(404).json({ error: `Dataset '${req.params.name}' not found.` });
    }
    res.json(listPruneRuns(db, dataset.id));
  });

  router.post("/datasets/:name/rollback", async (req, res) => {
    const dataset = getDataset(db, req.params.name);
    if (!dataset) {
      return res.status(404).json({ error: `Dataset '${req.params.name}' not found.` });
    }

    const dryRun = Boolean(req.body?.dryRun);
    let run;
    if (req.body?.runId) {
      run = getPruneRunById(db, Number(req.body.runId));
      if (!run || run.dataset_id !== dataset.id) {
        return res.status(404).json({ error: `Prune run '${req.body.runId}' not found.` });
      }
    } else {
      run = getLatestRestorablePruneRun(db, dataset.id);
      if (!run) {
        return res.json({ dryRun, runId: null, restored: [] });
      }
    }

    const actions = getRestorableActionsForRun(db, run.id);
    const restored = [];
    for (const action of actions) {
      if (dryRun) {
        restored.push({ relativePath: action.relative_path });
        continue;
      }
      await moveFile(action.dest_path, action.source_path);
      restorePhotoArchive(db, action.photo_id);
      markActionRestored(db, action.id);
      restored.push({ relativePath: action.relative_path });
    }

    res.json({ dryRun, runId: run.id, restored });
  });

  router.get("/photos/:id/thumbnail", async (req, res) => {
    const size = Math.min(Math.max(parseInt(req.query.size, 10) || 240, 32), 800);
    try {
      const result = await renderThumbnail(db, Number(req.params.id), size);
      if (!result) {
        return res.status(404).end();
      }
      res.set("Content-Type", result.contentType);
      res.set("Cache-Control", "public, max-age=3600");
      res.set("X-Thumbnail-Placeholder", String(result.placeholder));
      res.send(result.buffer);
    } catch (error) {
      console.error(`Thumbnail render failed for photo ${req.params.id}:`, error.message);
      res.status(500).json({ error: "Failed to render thumbnail." });
    }
  });

  return router;
}
