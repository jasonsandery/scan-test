import { useState } from "react";
import { formatBytes } from "../format.js";

export default function DatasetRail({ datasets, selectedName, onSelect, onScan, scanBusy }) {
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");

  const selected = datasets.find((d) => d.name === selectedName) || null;

  function submitNewDataset(event) {
    event.preventDefault();
    if (!name.trim() || !rootPath.trim()) {
      return;
    }
    onScan(name.trim(), rootPath.trim());
    setName("");
    setRootPath("");
    setShowForm(false);
  }

  return (
    <div className="pane rail">
      <div className="rail-title">Datasets</div>

      {datasets.length === 0 && <div className="section-note" style={{ marginBottom: 10 }}>No datasets yet.</div>}

      {datasets.map((dataset) => (
        <button
          key={dataset.name}
          type="button"
          className="dataset"
          aria-current={dataset.name === selectedName}
          onClick={() => onSelect(dataset.name)}
        >
          <span className="dataset-name">{dataset.name}</span>
          <span className={`dataset-meta${dataset.activeJobState ? " dataset-scanning" : ""}`}>
            {dataset.activeJobState
              ? `● ${dataset.activeJobState}...`
              : `${dataset.indexedCount.toLocaleString()} indexed · ${dataset.duplicateGroupCount} groups`}
          </span>
        </button>
      ))}

      {!showForm && (
        <button type="button" className="dataset-add" onClick={() => setShowForm(true)}>
          + Add dataset…
        </button>
      )}

      {showForm && (
        <form onSubmit={submitNewDataset} style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          <input
            className="text-input"
            placeholder="Dataset name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <input
            className="text-input"
            placeholder="Folder path, e.g. C:\Users\you\Pictures"
            value={rootPath}
            onChange={(e) => setRootPath(e.target.value)}
          />
          <div style={{ display: "flex", gap: 6 }}>
            <button type="submit" className="btn btn-sm btn-primary" disabled={scanBusy}>
              Scan
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowForm(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {selected && (
        <>
          <hr />
          <div className="rail-title">{selected.name}</div>
          <div className="setting-block">
            <span className="field-label">Root folder</span>
            <span className="field-value">{selected.rootPath}</span>
          </div>
          <div className="setting-block">
            <span className="field-label">Archive folder</span>
            <span className="field-value">{selected.archiveRoot}</span>
          </div>
          <div className="setting-block">
            <span className="field-label">Reclaimable</span>
            <span className="field-value">{formatBytes(selected.reclaimableBytes)}</span>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            style={{ width: "100%" }}
            disabled={scanBusy || Boolean(selected.activeJobId)}
            onClick={() => onScan(selected.name, null)}
          >
            {selected.activeJobId ? "Scan in progress…" : "Rescan"}
          </button>
        </>
      )}
    </div>
  );
}
