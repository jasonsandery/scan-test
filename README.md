# Local Photo Duplicate Scanner

A local-first tool that scans nested folders for photos, tracks file state in
SQLite (via Node's built-in `node:sqlite`), finds exact and near-duplicate
images (same photo resized/re-encoded under a different name), and lets you
review, archive, and roll back duplicates safely. Usable as a CLI (`src/`) or
through a local GUI (`server/` + `client/`) - both drive the same scanner
and the same database file, so you can mix and match.

## CLI setup

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

- **Exact duplicates** — SHA256 content hash, any filename/location. Computed
  from raw file bytes, so this works even for a photo that can't be decoded
  as an image (see below).
- **Near duplicates** — a perceptual hash (dHash, computed via
  [sharp](https://sharp.pixelplumbing.com/)/libvips for every format except
  BMP, which sharp can't decode at all and falls back to Jimp) catches the
  same photo saved under a different name, resized, or re-encoded, even with
  a different file size, dimensions, or orientation.
- Within each group, the keeper is the copy with the highest resolution,
  then largest file size, then most recently modified.
- A file that can't be decoded at all (genuinely corrupted/truncated - this
  turned up more often than you'd expect testing against a real ~5,000-photo
  library, where a native decoder failing to read a file is a strong signal
  the file itself is damaged, not a bug) is still indexed and still gets
  exact-duplicate detection; it just can't be perceptually hashed, and a
  warning is logged when this happens.

## Performance

Validated against a real ~4,900-photo library (~13 GB, mixed iPhone/Canon
JPEGs): full scan in ~85 seconds. An earlier Jimp-only implementation (pure
JS JPEG decoding) took over an hour for the same library and silently
excluded roughly a third of the files from all duplicate detection because a
perceptual-hash failure discarded the already-computed SHA256 too - both are
fixed now (sharp's native decoder, and hashing/exact-match no longer
depend on the perceptual-hash step succeeding).

## Multiple datasets

One database file can track any number of independently-named datasets
(different root folders), so you can scan e.g. `family-photos` and
`phone-backup-2024` separately without them interfering with each other.

## GUI

A local web UI ("Light Table") for browsing datasets, reviewing duplicate
groups with real thumbnails, and running scans/prune/rollback without the
command line.

```
cd server && npm install && npm start        # API on http://127.0.0.1:4100
cd client && npm install && npm run dev       # UI on http://localhost:5173
```

Both point at the same `duplicate_state.db` the CLI uses (override with the
`DUPLICATE_DB` env var on the server). Datasets scanned from the CLI show up
in the GUI and vice versa.

Reviewing every duplicate group one at a time doesn't scale past a handful -
the **"Accept all recommended"** button archives every group's
auto-recommended duplicate in one action; use per-group "Keep this instead"
first if you want to override a specific recommendation before accepting
the rest.

The GUI binds to `127.0.0.1` only and has no auth layer - it's meant for
local use, not for exposing beyond your own machine.

## Architecture note

`src/scanOps.js` and `src/scanController.js` hold the logic shared by both
front ends - file walking, hashing, prune/rollback, and a scan engine that
runs in small concurrent "waves" (each committed as one transaction) with
`pause()`/`resume()`/`stop()` plus `progress`/`status` events. `src/index.js`
wires it to terminal keypresses and Ctrl+C; `server/routes.js` wires the same
controller to HTTP endpoints and an SSE stream for the GUI. Neither front end
duplicates the other's logic.
