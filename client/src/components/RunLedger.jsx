export default function RunLedger({ runs, onRollback, busy }) {
  return (
    <div className="pane rail">
      <div className="rail-title">Run ledger</div>
      {runs.length === 0 && <div className="section-note">No prune runs recorded.</div>}
      {runs.map((run) => {
        const isPending = run.pending_actions > 0;
        const pillClass = run.dry_run ? "pill-preview" : isPending ? "pill-archived" : "pill-restored";
        const pillLabel = run.dry_run ? "Preview only" : isPending ? "Archived" : "Restored";
        return (
          <div className="ledger-entry" key={run.id}>
            <div className="ledger-top">
              <span className="ledger-run">Run #{run.id}</span>
              <div className="ledger-spacer" />
              <span className={`pill ${pillClass}`}>{pillLabel}</span>
            </div>
            <div className="ledger-meta">
              <div>{run.dry_run ? "dry-run" : "live"}</div>
              <div>{new Date(run.started_at).toLocaleString()}</div>
              <div>
                {run.total_actions} file{run.total_actions === 1 ? "" : "s"}
              </div>
            </div>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              style={{ width: "100%" }}
              disabled={busy || run.dry_run || !isPending}
              onClick={() => onRollback(run.id)}
            >
              {run.dry_run ? "Nothing to undo" : isPending ? "Roll back" : "Already restored"}
            </button>
          </div>
        );
      })}
    </div>
  );
}
