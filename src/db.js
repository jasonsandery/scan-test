import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS datasets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  root_path TEXT NOT NULL,
  archive_root TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_scan_at TEXT
);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id INTEGER NOT NULL REFERENCES datasets(id),
  relative_path TEXT NOT NULL,
  absolute_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  sha256 TEXT,
  width INTEGER,
  height INTEGER,
  phash TEXT,
  is_archived INTEGER NOT NULL DEFAULT 0,
  archive_path TEXT,
  last_seen_at TEXT NOT NULL,
  UNIQUE(dataset_id, relative_path)
);
CREATE INDEX IF NOT EXISTS idx_photos_dataset ON photos(dataset_id);
CREATE INDEX IF NOT EXISTS idx_photos_sha256 ON photos(dataset_id, sha256);

CREATE TABLE IF NOT EXISTS prune_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id INTEGER NOT NULL REFERENCES datasets(id),
  started_at TEXT NOT NULL,
  dry_run INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS prune_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES prune_runs(id),
  photo_id INTEGER NOT NULL REFERENCES photos(id),
  source_path TEXT NOT NULL,
  dest_path TEXT NOT NULL,
  restored_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_actions_run ON prune_actions(run_id);
`;

export function initializeDatabase(dbFilePath) {
  const absolutePath = path.resolve(dbFilePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const conn = new DatabaseSync(absolutePath);
  conn.exec("PRAGMA journal_mode = WAL");
  conn.exec("PRAGMA foreign_keys = ON");
  conn.exec(SCHEMA);
  return { conn, path: absolutePath };
}

export function closeDatabase(db) {
  db.conn.close();
}

export function getDataset(db, datasetName) {
  return db.conn.prepare("SELECT * FROM datasets WHERE name = ?").get(datasetName) ?? null;
}

export function createOrUpdateDataset(db, datasetName, rootPath, archiveRoot) {
  const existing = getDataset(db, datasetName);
  const now = new Date().toISOString();

  if (existing) {
    db.conn
      .prepare("UPDATE datasets SET root_path = ?, archive_root = ? WHERE id = ?")
      .run(rootPath, archiveRoot, existing.id);
    return getDataset(db, datasetName);
  }

  db.conn
    .prepare(
      "INSERT INTO datasets (name, root_path, archive_root, created_at, last_scan_at) VALUES (?, ?, ?, ?, NULL)"
    )
    .run(datasetName, rootPath, archiveRoot, now);
  return getDataset(db, datasetName);
}

export function setDatasetLastScan(db, datasetId) {
  db.conn.prepare("UPDATE datasets SET last_scan_at = ? WHERE id = ?").run(new Date().toISOString(), datasetId);
}

export function getPhotoByRelativePath(db, datasetId, relativePath) {
  return (
    db.conn
      .prepare("SELECT * FROM photos WHERE dataset_id = ? AND relative_path = ?")
      .get(datasetId, relativePath) ?? null
  );
}

// Returns { id, isNew } and resets archive state, since a changed/new file
// can no longer be assumed to be the same content that was previously archived.
export function upsertPhotoRecord(db, datasetId, photo) {
  const existing = getPhotoByRelativePath(db, datasetId, photo.relativePath);

  if (existing) {
    db.conn
      .prepare(
        `UPDATE photos SET absolute_path = ?, size = ?, mtime_ms = ?, sha256 = ?, width = ?, height = ?, phash = ?,
         is_archived = 0, archive_path = NULL, last_seen_at = ? WHERE id = ?`
      )
      .run(
        photo.absolutePath,
        photo.size,
        photo.mtimeMs,
        photo.sha256,
        photo.width,
        photo.height,
        photo.pHash,
        photo.lastSeenAt,
        existing.id
      );
    return { id: existing.id, isNew: false };
  }

  const result = db.conn
    .prepare(
      `INSERT INTO photos (dataset_id, relative_path, absolute_path, size, mtime_ms, sha256, width, height, phash, is_archived, archive_path, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`
    )
    .run(
      datasetId,
      photo.relativePath,
      photo.absolutePath,
      photo.size,
      photo.mtimeMs,
      photo.sha256,
      photo.width,
      photo.height,
      photo.pHash,
      photo.lastSeenAt
    );
  return { id: result.lastInsertRowid, isNew: true };
}

export function touchLastSeen(db, photoId, absolutePath, lastSeenAt) {
  db.conn
    .prepare("UPDATE photos SET absolute_path = ?, last_seen_at = ? WHERE id = ?")
    .run(absolutePath, lastSeenAt, photoId);
}

export function getPhotosByDataset(db, datasetId) {
  return db.conn.prepare("SELECT * FROM photos WHERE dataset_id = ? ORDER BY relative_path").all(datasetId);
}

export function setPhotoArchived(db, photoId, archivePath) {
  db.conn.prepare("UPDATE photos SET is_archived = 1, archive_path = ? WHERE id = ?").run(archivePath, photoId);
}

export function restorePhotoArchive(db, photoId) {
  db.conn.prepare("UPDATE photos SET is_archived = 0, archive_path = NULL WHERE id = ?").run(photoId);
}

export function withTransaction(db, fn) {
  db.conn.exec("BEGIN");
  try {
    const result = fn();
    db.conn.exec("COMMIT");
    return result;
  } catch (error) {
    db.conn.exec("ROLLBACK");
    throw error;
  }
}

export function createPruneRun(db, datasetId, dryRun) {
  const result = db.conn
    .prepare("INSERT INTO prune_runs (dataset_id, started_at, dry_run) VALUES (?, ?, ?)")
    .run(datasetId, new Date().toISOString(), dryRun ? 1 : 0);
  return result.lastInsertRowid;
}

export function addPruneAction(db, runId, photoId, sourcePath, destPath) {
  db.conn
    .prepare("INSERT INTO prune_actions (run_id, photo_id, source_path, dest_path) VALUES (?, ?, ?, ?)")
    .run(runId, photoId, sourcePath, destPath);
}

export function getLatestRestorablePruneRun(db, datasetId) {
  return (
    db.conn
      .prepare(
        `SELECT pr.* FROM prune_runs pr
         WHERE pr.dataset_id = ? AND pr.dry_run = 0
           AND EXISTS (SELECT 1 FROM prune_actions pa WHERE pa.run_id = pr.id AND pa.restored_at IS NULL)
         ORDER BY pr.id DESC LIMIT 1`
      )
      .get(datasetId) ?? null
  );
}

export function getPruneRunById(db, runId) {
  return db.conn.prepare("SELECT * FROM prune_runs WHERE id = ?").get(runId) ?? null;
}

export function getRestorableActionsForRun(db, runId) {
  return db.conn
    .prepare(
      `SELECT pa.*, p.relative_path FROM prune_actions pa
       JOIN photos p ON p.id = pa.photo_id
       WHERE pa.run_id = ? AND pa.restored_at IS NULL
       ORDER BY pa.id`
    )
    .all(runId);
}

export function markActionRestored(db, actionId) {
  db.conn.prepare("UPDATE prune_actions SET restored_at = ? WHERE id = ?").run(new Date().toISOString(), actionId);
}

export function listPruneRuns(db, datasetId) {
  return db.conn
    .prepare(
      `SELECT pr.id, pr.started_at, pr.dry_run,
         (SELECT COUNT(*) FROM prune_actions pa WHERE pa.run_id = pr.id) AS total_actions,
         (SELECT COUNT(*) FROM prune_actions pa WHERE pa.run_id = pr.id AND pa.restored_at IS NULL) AS pending_actions
       FROM prune_runs pr WHERE pr.dataset_id = ? ORDER BY pr.id DESC`
    )
    .all(datasetId);
}
