import crypto from "node:crypto";

// In-memory registry of active/recent ScanController instances, keyed by a
// generated job id. Deliberately not persisted: actual scan progress already
// lives in SQLite (each wave is committed as it completes), so if the server
// restarts mid-scan nothing is lost - the client just starts a fresh job for
// the same dataset and it resumes via the unchanged-file skip.
const jobs = new Map(); // jobId -> { controller, datasetId, datasetName }
const activeJobIdByDataset = new Map(); // datasetId -> jobId

export function getActiveJobForDataset(datasetId) {
  const jobId = activeJobIdByDataset.get(datasetId);
  if (!jobId) {
    return null;
  }
  const job = jobs.get(jobId);
  return job ? { jobId, ...job } : null;
}

export function registerJob(datasetId, datasetName, controller) {
  const jobId = crypto.randomUUID();
  jobs.set(jobId, { controller, datasetId, datasetName });
  activeJobIdByDataset.set(datasetId, jobId);

  controller.on("status", (status) => {
    if (status.state === "completed" || status.state === "stopped") {
      if (activeJobIdByDataset.get(datasetId) === jobId) {
        activeJobIdByDataset.delete(datasetId);
      }
    }
  });

  return jobId;
}

export function getJob(jobId) {
  const job = jobs.get(jobId);
  return job ? { jobId, ...job } : null;
}
