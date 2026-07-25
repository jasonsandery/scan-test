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

## Roadmap (not built yet)

None of the items below are implemented. Each is flagged here as a
deliberate scope decision, not a forgotten gap - and a couple of them
share a prerequisite worth doing once rather than twice.

### Burst/similar-photo clustering

Verified (see "same filename, different content" test below): the current
near-duplicate threshold correctly does *not* flag genuinely different
photos as duplicates, even when they share a filename - real distinct
photos scored a hamming distance of 23-37+ against a threshold of 10, a
wide margin. That's deliberate: today's detector is tuned to catch "the
same photo, re-encoded/resized," and rejecting anything else is a feature,
not a gap.

Burst-mode shots (or several photos of the same moment a few seconds
apart) are a genuinely different problem - they're different captures, not
copies of the same one, so they'll always sit above that threshold and
correctly won't be touched by prune. But a user thinning out a library
often *does* want help there too: "here are 8 near-identical shots from
the same 3 seconds, pick your favorite(s)." That's a distinct feature,
not a threshold tweak, because:

- It needs a much looser similarity band, which alone would produce false
  positives against genuinely different photos - it has to be combined
  with a second, independent signal: time proximity (EXIF capture
  timestamp, which nothing here reads yet, and/or file mtime) and likely
  same source folder.
- The action on a cluster isn't "keep the best, archive the rest"
  automatically - unlike a re-encoded duplicate, there's no objective
  "better" copy (resolution/file size don't tell you which framing or
  expression is best). The right UX is presenting the cluster for the
  human to pick from, not an auto-recommendation to accept.
- It would need its own calibration and validation pass against real
  photos, the same way the current near-dup threshold was, before trusting
  it with real libraries.

### Metadata-based grouping (capture date, location)

Right now the app reads zero EXIF metadata - only filesystem size/mtime
and pixel content. File mtime is a poor stand-in for when a photo was
actually taken (it reflects when it was last copied/synced, not
captured), so grouping "photos from this trip" or "photos from this day"
needs the real EXIF `DateTimeOriginal` and GPS tags, which needs a new
EXIF-reading dependency (sharp's `.metadata()` exposes the raw EXIF
buffer today but nothing parses it yet).

This is a different *kind* of feature than everything else in this repo -
it's for browsing/organizing a library, not cleaning it up - so it likely
wants its own view rather than folding into duplicate-group cards. It's
also the same missing prerequisite (EXIF timestamp reading) that
burst-clustering's time-proximity signal needs, so it's worth building
once and using in both places rather than twice.

### Corrupted/unreadable file report

Partially there already: the scanner now tracks exactly which files
couldn't be perceptually hashed (`noPerceptualHashCount` in the dataset
API, a per-file warning during scan) - see the "GUI" section above. What's
missing is surfacing it as its own view. Today, a corrupted file only
becomes visible in the GUI if it happens to be part of a duplicate group
(via an exact SHA256 match); the common case - a corrupted file that
isn't a duplicate of anything - is counted but never listed anywhere. A
dedicated endpoint/panel listing every such file (with its decode error)
would make "831 files might be damaged, here they are" actually
actionable instead of just a number.

### Junk/low-value image detection

Different problem from corruption: technically valid, readable images
that aren't really "photos" - web thumbnails, app icons, cached preview
images, screenshots-of-screenshots that ended up synced into a photo
library. None of these are duplicates of each other, so the current
detector has no opinion on them. Plausible heuristics: very small pixel
dimensions, suspicious aspect ratios, or (once EXIF reading exists for
the metadata-grouping feature above) the *absence* of camera EXIF data,
which is itself a decent signal that something isn't a real camera photo.

### Video files

Currently completely out of scope - `supportedExtensions` is images
only, so video files are invisible to the folder walk, not skipped-with-a-
warning like an unreadable image would be. Exact-duplicate detection
would extend trivially (SHA256 is already format-agnostic). Near-duplicate
detection is a materially harder problem than for photos, though: "the
same video re-encoded" could be approximated by hashing a representative
extracted frame the same way a photo is hashed, but that needs a new
dependency (something like ffmpeg) to extract frames at all, sharp/Jimp
don't decode video containers, and it wouldn't catch trimmed/edited
variants of the same footage - a materially different, harder problem
than "the same image at a different resolution."

## Architecture note

`src/scanOps.js` and `src/scanController.js` hold the logic shared by both
front ends - file walking, hashing, prune/rollback, and a scan engine that
runs in small concurrent "waves" (each committed as one transaction) with
`pause()`/`resume()`/`stop()` plus `progress`/`status` events. `src/index.js`
wires it to terminal keypresses and Ctrl+C; `server/routes.js` wires the same
controller to HTTP endpoints and an SSE stream for the GUI. Neither front end
duplicates the other's logic.
