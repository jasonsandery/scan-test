# Local Photo Duplicate Scanner

A local-first CLI that scans nested folders for photos, tracks file state in
SQLite (via Node's built-in `node:sqlite`), finds exact and near-duplicate
images (same photo resized/re-encoded under a different name), and lets you
review, archive, and roll back duplicates safely.

## Setup

```
npm install
```

## Commands

- `npm run scan -- <dataset-name> <root-folder> [--db <database-file>] [--archive <archive-folder>] [--force]`

  Recursively scans `<root-folder>` and records/updates state for the named
  dataset. Re-scans are incremental: files whose size and modified time
  haven't changed are skipped, not re-hashed. Pass `--force` to re-hash
  every file instead (a true restart, not a resume).

  **While scanning:** press `p` to pause/resume, `s` or Ctrl+C to stop.
  Each small batch of files is committed to the database as it's processed,
  so a stopped or interrupted scan never corrupts state — just re-run `scan`
  on the same dataset and it picks up where it left off automatically.

- `npm run report -- <dataset-name> [--db <database-file>]`

  Shows duplicate groups for a dataset without touching any files.

- `npm run prune -- <dataset-name> [--db <database-file>] [--archive <archive-folder>] [--dry-run]`

  Moves duplicate files (everything in a group except the highest-quality
  keeper) into an archive folder. `--dry-run` previews the moves without
  touching the filesystem. Every live prune is recorded as a numbered run.

- `npm run rollback -- <dataset-name> [--db <database-file>] [--run <run-id>] [--dry-run]`

  Restores files moved by a previous prune run back to their original
  location (defaults to the most recent run with pending restores).

- `npm run runs -- <dataset-name> [--db <database-file>]`

  Lists prune run history for a dataset with pending/restored counts.

- `npm run status -- <dataset-name> [--db <database-file>]`

  Quick summary: indexed photo count, archived count, last scan time.

## How duplicates are detected

- **Exact duplicates** — SHA256 content hash, any filename/location.
- **Near duplicates** — a perceptual hash (Jimp) catches the same photo
  saved under a different name, resized, or re-encoded, even with a
  different file size or dimensions.
- Within each group, the keeper is the copy with the highest resolution,
  then largest file size, then most recently modified.

## Multiple datasets

One database file can track any number of independently-named datasets
(different root folders), so you can scan e.g. `family-photos` and
`phone-backup-2024` separately without them interfering with each other.

## Architecture note

`src/scanController.js` drives scans in small concurrent "waves" and exposes
`pause()` / `resume()` / `stop()` plus `progress`/`status` events, decoupled
from the CLI. `src/index.js` wires it to terminal keypresses and Ctrl+C, but
the same controller is meant to be driven by a future HTTP backend (for a
GUI) without changes.
