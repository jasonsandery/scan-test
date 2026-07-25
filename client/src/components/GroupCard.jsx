import { formatBytes, formatDimensions } from "../format.js";

function Mount({ item, isKeep, onKeepInstead, busy }) {
  const hasNoPreview = !item.width || !item.height;
  return (
    <div className="mount">
      <div className={`swatch${hasNoPreview ? " swatch-no-preview" : ""}`}>
        <img src={item.thumbnailUrl} alt="" loading="lazy" />
        <span className={`mark ${isKeep ? "mark-keep" : "mark-reject"}`}>{isKeep ? "✓" : "✕"}</span>
      </div>
      <div className="mount-name">{item.relativePath}</div>
      <div className="mount-meta">
        {formatDimensions(item)} · {formatBytes(item.size)}
      </div>
      {hasNoPreview && (
        <span className="mount-tag mount-tag-warning">couldn't be hashed - likely corrupted</span>
      )}
      {isKeep ? (
        <span className="mount-tag">keeping</span>
      ) : (
        <button type="button" className="mount-swap" disabled={busy} onClick={() => onKeepInstead(item.id)}>
          Keep this instead
        </button>
      )}
    </div>
  );
}

export default function GroupCard({ group, overrideKeepId, onSetKeep, onArchive, onSkip, busy }) {
  const allItems = [group.keep, ...group.duplicates];
  const effectiveKeepId = overrideKeepId ?? group.keep.id;
  const effectiveKeep = allItems.find((item) => item.id === effectiveKeepId) ?? group.keep;
  const effectiveDuplicates = allItems.filter((item) => item.id !== effectiveKeepId);

  return (
    <div className="group">
      <div className="group-head">
        <span className="group-title">{effectiveKeep.relativePath.split("/").pop()}</span>
        <span className={`badge ${group.matchType === "exact" ? "badge-exact" : "badge-near"}`}>
          {group.matchType === "exact" ? "Exact match" : "Near match"}
        </span>
        <div className="group-spacer" />
        <span className="group-reclaim">reclaims {formatBytes(group.reclaimableBytes)}</span>
      </div>

      <div className="filmstrip">
        <Mount item={effectiveKeep} isKeep busy={busy} onKeepInstead={onSetKeep} />
        {effectiveDuplicates.map((item) => (
          <Mount key={item.id} item={item} isKeep={false} busy={busy} onKeepInstead={onSetKeep} />
        ))}
      </div>

      <div className="group-foot">
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy}
          onClick={() => onArchive(effectiveDuplicates.map((item) => item.id), true)}
        >
          Dry run
        </button>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={busy}
          onClick={() => onArchive(effectiveDuplicates.map((item) => item.id), false)}
        >
          Archive {effectiveDuplicates.length > 1 ? "duplicates" : "duplicate"}
        </button>
        <div className="group-foot-spacer" />
        <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={onSkip}>
          Skip group
        </button>
      </div>
    </div>
  );
}
