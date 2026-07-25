const BASE = "/api";

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) {
        message = body.error;
      }
    } catch {
      // response wasn't JSON - keep the default message
    }
    throw new Error(message);
  }
  if (res.status === 204) {
    return null;
  }
  return res.json();
}

export function listDatasets() {
  return request("/datasets");
}

export function getDataset(name) {
  return request(`/datasets/${encodeURIComponent(name)}`);
}

export function getGroups(name) {
  return request(`/datasets/${encodeURIComponent(name)}/groups`);
}

export function getRuns(name) {
  return request(`/datasets/${encodeURIComponent(name)}/runs`);
}

export function startScan(name, { rootPath, archiveRoot, force } = {}) {
  return request(`/datasets/${encodeURIComponent(name)}/scan`, {
    method: "POST",
    body: JSON.stringify({ rootPath, archiveRoot, force }),
  });
}

export function pauseScan(jobId) {
  return request(`/scan/${jobId}/pause`, { method: "POST" });
}

export function resumeScan(jobId) {
  return request(`/scan/${jobId}/resume`, { method: "POST" });
}

export function stopScan(jobId) {
  return request(`/scan/${jobId}/stop`, { method: "POST" });
}

export function prune(name, { dryRun, photoIds } = {}) {
  return request(`/datasets/${encodeURIComponent(name)}/prune`, {
    method: "POST",
    body: JSON.stringify({ dryRun, photoIds }),
  });
}

export function rollback(name, { runId, dryRun } = {}) {
  return request(`/datasets/${encodeURIComponent(name)}/rollback`, {
    method: "POST",
    body: JSON.stringify({ runId, dryRun }),
  });
}

// Returns an unsubscribe function. Handlers are optional; each SSE event name
// maps 1:1 to the ScanController events the server relays (see server/routes.js).
export function subscribeToScan(jobId, { onStatus, onProgress, onFileError, onError } = {}) {
  const source = new EventSource(`${BASE}/scan/${jobId}/events`);
  if (onStatus) source.addEventListener("status", (event) => onStatus(JSON.parse(event.data)));
  if (onProgress) source.addEventListener("progress", (event) => onProgress(JSON.parse(event.data)));
  if (onFileError) source.addEventListener("fileError", (event) => onFileError(JSON.parse(event.data)));
  if (onError) source.onerror = onError;
  return () => source.close();
}
