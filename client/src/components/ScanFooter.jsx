export default function ScanFooter({ job, onPause, onResume, onStop }) {
  if (!job) {
    return null;
  }

  const { status, datasetName } = job;
  const pct = status.total > 0 ? Math.round((status.processed / status.total) * 100) : 0;
  const isPaused = status.state === "paused";
  const isStopping = status.state === "stopping";

  return (
    <div className="scan-footer">
      <span className="scan-footer-label">
        <span className="dot" />
        {isPaused ? "Paused" : isStopping ? "Stopping" : "Scanning"} {datasetName}
      </span>
      <div className="scan-track">
        <div className="scan-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="scan-counts">
        {status.processed.toLocaleString()} / {status.total.toLocaleString()} · {status.hashed} hashed ·{" "}
        {status.unchanged} unchanged · {status.failed} failed
      </span>
      <div style={{ display: "flex", gap: 6 }}>
        {isPaused ? (
          <button type="button" className="btn btn-sm" onClick={onResume}>
            Resume
          </button>
        ) : (
          <button type="button" className="btn btn-sm" disabled={isStopping} onClick={onPause}>
            Pause
          </button>
        )}
        <button type="button" className="btn btn-sm btn-ghost" disabled={isStopping} onClick={onStop}>
          Stop
        </button>
      </div>
    </div>
  );
}
