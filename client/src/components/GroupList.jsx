import { useMemo, useState } from "react";
import { formatBytes, formatRelativeTime } from "../format.js";
import GroupCard from "./GroupCard.jsx";

export default function GroupList({ dataset, groups, onArchive, busy }) {
  const [overrides, setOverrides] = useState({}); // original keep id -> chosen keep id
  const [skipped, setSkipped] = useState(new Set());

  const visibleGroups = groups.filter((group) => !skipped.has(group.keep.id));

  const allRecommendedIds = useMemo(() => {
    const ids = [];
    visibleGroups.forEach((group) => {
      const allItems = [group.keep, ...group.duplicates];
      const effectiveKeepId = overrides[group.keep.id] ?? group.keep.id;
      allItems.forEach((item) => {
        if (item.id !== effectiveKeepId) {
          ids.push(item.id);
        }
      });
    });
    return ids;
  }, [visibleGroups, overrides]);

  if (!dataset) {
    return (
      <div className="pane main">
        <div className="section-note">Select or add a dataset to get started.</div>
      </div>
    );
  }

  return (
    <div className="pane main">
      <div className="stat-row">
        <div className="stat-tile">
          <div className="stat-num">{dataset.indexedCount.toLocaleString()}</div>
          <div className="stat-label">Indexed photos</div>
        </div>
        <div className="stat-tile">
          <div className="stat-num">{groups.length}</div>
          <div className="stat-label">Duplicate groups</div>
        </div>
        <div className="stat-tile">
          <div className="stat-num">{formatBytes(dataset.reclaimableBytes)}</div>
          <div className="stat-label">Reclaimable space</div>
        </div>
        <div className="stat-tile">
          <div className="stat-num">{formatRelativeTime(dataset.lastScanAt)}</div>
          <div className="stat-label">Last full scan</div>
        </div>
      </div>

      {dataset.noPerceptualHashCount > 0 && (
        <div className="dataset-callout">
          {dataset.noPerceptualHashCount.toLocaleString()} file(s) in this dataset couldn't be perceptually
          hashed (commonly a corrupted/truncated file) - they're still indexed and checked for exact
          duplicates, just not near-duplicates, and show a "no preview" thumbnail below.
        </div>
      )}

      <div className="section-head">
        <h2>Duplicate groups · {dataset.name}</h2>
        {visibleGroups.length > 0 && (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy || allRecommendedIds.length === 0}
            onClick={() => onArchive(allRecommendedIds, false)}
            title="Archives every group's recommended duplicate in one go - review individual groups first if you want to change a recommendation."
          >
            Accept all recommended ({allRecommendedIds.length})
          </button>
        )}
      </div>

      {visibleGroups.length === 0 && (
        <div className="section-note">
          {groups.length > 0 ? "No duplicate groups left to review." : "No duplicate groups found - scan looks clean."}
        </div>
      )}

      {visibleGroups.map((group) => (
        <GroupCard
          key={group.keep.id}
          group={group}
          overrideKeepId={overrides[group.keep.id]}
          busy={busy}
          onSetKeep={(photoId) => setOverrides((prev) => ({ ...prev, [group.keep.id]: photoId }))}
          onArchive={onArchive}
          onSkip={() => setSkipped((prev) => new Set(prev).add(group.keep.id))}
        />
      ))}
    </div>
  );
}
