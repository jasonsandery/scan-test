# Feature test plan

Every test case here is something that was actually run against this
codebase (either as a one-off validation script during development, or
reproducible with the commands shown). None of this is automated yet -
see "Toward automation" at the bottom.

## 1. Scanning & state

### 1.1 Recursive scan of nested folders
**Test:** `scan test-set <root>` where `<root>` contains photos several
folders deep (e.g. `root/2019/vacation/photo.jpg`).
**Expected:** `status test-set` shows all nested photos indexed;
`relative_path` in the database preserves the folder structure.
**Validated with:** `local/scripts/create-test-photos.js` (creates a
`nested/vacation/`, `nested/family/` tree) and, at scale, a real
~4,900-file library four folders deep.

### 1.2 Incremental rescan (unchanged files skipped)
**Test:** `scan test-set <root>` twice in a row with no files changed.
**Expected:** Second run reports `0 hashed, N unchanged, 0 failed` and
completes near-instantly regardless of file count.
**Validated with:** synthetic 5-file set (rescan showed `0 hashed, 5
unchanged`) and confirmed the mechanism (size+mtime+hash-format check)
via code inspection of `scanOps.js`.

### 1.3 Modified file triggers a re-hash
**Test:** Scan, modify one file's content (changing size or write a new
version), rescan.
**Expected:** Only the changed file is re-hashed; its SHA256/phash update;
everything else stays `unchanged`.
**How to verify:** touch/overwrite one file, rerun `scan`, check the
`hashed` count is exactly 1.

### 1.4 Force rescan ignores the unchanged-skip
**Test:** `scan test-set <root> --force` on an already-scanned, unchanged
folder.
**Expected:** Every file is re-hashed (`hashed` count equals total file
count, `unchanged` is 0) even though nothing changed on disk.
**Validated with:** synthetic 5-file set - confirmed `--force` re-hashed
all 5 vs. a normal rescan skipping all 5.

### 1.5 Multiple independent datasets share one database
**Test:** `scan dataset-a <folder-a>` then `scan dataset-b <folder-b>`
against the same `--db` file (or the default).
**Expected:** `status dataset-a` and `status dataset-b` report
independent counts; a file byte-identical across both folders does NOT
appear as a cross-dataset duplicate in either `report`.
**Validated with:** two synthetic datasets, one containing a byte-identical
copy of a file from the other - confirmed no cross-dataset match.

### 1.6 Corrupt/unreadable file doesn't abort the whole scan
**Test:** Scan a folder containing at least one non-image or genuinely
corrupted file alongside valid photos.
**Expected:** Scan completes; the bad file is reported via a
`fileError`/"Skipping unreadable image" message and does not stop
processing of the rest.
**Validated with:** a `.jpg`-named text file mixed into a synthetic
folder, and (at scale) 831 genuinely corrupted real JPEGs in the
4,904-file real-world scan - scan completed in both cases.

### 1.7 Pause / Resume / Stop mid-scan
**Test (CLI):** start `scan` on a large-enough folder, press `p` to pause,
confirm the progress line stops advancing, press `p` again to resume,
press `s` to stop early.
**Test (API):** `POST /datasets/:name/scan`, then `POST
/scan/:jobId/pause`, `/resume`, `/stop` while it's running; watch `GET
/scan/:jobId/events` (SSE).
**Expected:** pause halts progress within at most one "wave" (~8 files);
resume continues from exactly there; stop ends the job early with partial
progress *committed*, not lost - rerunning `scan` on the same dataset
finishes the rest via the unchanged-file skip.
**Validated with:** a 300-file synthetic set with artificial per-file
delay (pause held within one wave's slack, stop halted at 40/300, a
follow-up run completed the remaining 260/260); repeated live over HTTP
against a 120-file set (paused at 16/120, resumed, stopped at 24/120);
and for real via `Get-NetTCPConnection`/`Stop-Process` mid-scan on the
real 4,904-file library, confirming 609 photos were safely committed.

### 1.8 Killed process doesn't corrupt state
**Test:** hard-kill the `node` process mid-scan (not a graceful stop).
**Expected:** the database is left in a consistent state - photos from
completed "waves" are present, the in-flight wave's photos simply aren't
(no partial/corrupt rows), and a subsequent scan continues normally.
**Validated with:** killing a real scan of the 4,904-file library mid-run
(process ID killed directly) - `status` afterward showed exactly 609
cleanly-committed photos, no errors on reopening the database.

## 2. Duplicate detection

### 2.1 Exact duplicates (byte-identical, any name/location)
**Test:** place two byte-identical files at different paths/names, scan.
**Expected:** `report` groups them together, `matchType: exact`.
**Validated with:** synthetic `photo-a.png` copied to a nested folder
under a different name.

### 2.2 Near duplicates (resized copy of the same photo)
**Test:** take a photo, save a resized copy under a different name, scan
both.
**Expected:** grouped together (`matchType: near` unless mixed with an
exact match in the same group), hamming distance well under the
threshold (10 of 64 bits).
**Validated with:** synthetic noise image resized to half size (distance
0-2); a real photo from the test library resized to 400px wide (distance
8).

### 2.3 Near duplicates (re-encoded/recompressed copy)
**Test:** re-save the same photo at a different JPEG quality, scan both.
**Expected:** grouped as near-duplicates.
**Validated with:** synthetic image re-encoded at quality 60 (distance 6
on noise images); real photo re-encoded at quality 50 (distance 6).

### 2.4 Genuinely different photos are NOT flagged, even with high visual
similarity in file metadata
**Test:** two distinct photos (different content), scan.
**Expected:** never grouped; hamming distance stays far above threshold.
**Validated with:** distinct real photos scored 23-37 bits apart (vs.
threshold 10) across 19 comparisons in the real library - wide, consistent
margin.

### 2.5 Same filename, different content is NOT flagged as a duplicate
**Test:** two genuinely different photos given the identical filename in
different folders, scan.
**Expected:** not grouped - matching is content-based (SHA256 + phash),
never filename-based.
**Validated with:** two different synthetic noise images both named
`photo.jpg` in `folder-a/` and `folder-b/` - `report` found 0 duplicate
groups. (Also checked the real 4,904-file library for naturally-occurring
filename collisions to cross-check against real data - none existed in
that particular library, since its filenames are long
device+timestamp-encoded strings; the synthetic test is the one carrying
this case.)

### 2.6 Cross-format matching (BMP vs. JPEG/PNG of the same photo)
**Test:** save the same image as both a JPEG/PNG (decoded via sharp) and
a BMP (decoded via the Jimp fallback), scan both.
**Expected:** grouped together, since both decode paths feed the same
hash function.
**Validated with:** a synthetic image and its BMP re-save. First pass:
Jimp did its own resize before hashing, and its resize algorithm differs
slightly from sharp's - measured distance 14, *above* the threshold of
10 (a real gap, documented as such). Fixed by having Jimp handle only the
BMP file decode, then piping its raw pixels through the *same* sharp
resize/grayscale pipeline every other format uses - re-measured distance:
**0** (identical hash). Re-confirmed distinct photos via the BMP path
still score far apart (34), so the fix didn't loosen anything.

### 2.7 Corrupted file still gets exact-duplicate detection
**Test:** two byte-identical copies of a file that can't be perceptually
decoded (e.g. a genuinely corrupted JPEG), scan.
**Expected:** both copies are indexed (not skipped), a warning is logged
for each, and `report` still groups them as an exact duplicate via
SHA256 despite neither having a perceptual hash.
**Validated with:** two copies of a real corrupted file from the test
library - both indexed, `report` showed `Group 1: keep copy-a.jpg /
duplicates: copy-b.jpg`.

### 2.8 Keeper selection (highest quality wins)
**Test:** a duplicate group with members of different resolution/size,
scan.
**Expected:** the highest-resolution copy is marked as the keeper; ties
broken by larger file size, then most recent modification time.
**Validated with:** synthetic exact-duplicate + resized-duplicate group -
the largest/highest-resolution file was consistently selected as `keep`
across repeated test runs.

## 3. Review & action (dry-run / prune / rollback)

### 3.1 `report` never touches files
**Test:** run `report` on a dataset with duplicates, check file
mtimes/existence before and after.
**Expected:** no files moved, created, or modified.

### 3.2 `prune --dry-run` never touches files
**Test:** run `prune --dry-run`, check the archive folder is not created
and no source files moved.
**Expected:** console shows `[dry-run] move ...` lines; filesystem
unchanged.
**Validated with:** synthetic and real datasets - confirmed no
`duplicates-archive` folder appears on disk after a dry run.

### 3.3 Live `prune` moves (not deletes) duplicates
**Test:** run `prune` for real, inspect the filesystem.
**Expected:** duplicate files (not the keeper) move into
`<root>/duplicates-archive/<relative-path>`; the keeper stays in place;
the move is recorded as a numbered run.
**Validated with:** synthetic dataset via `Get-ChildItem` before/after;
then for real against the full ~4,900-file real library (a copy, safe to
mutate) - dry-run first (124 files targeted, filesystem confirmed
untouched: still 4,904 files afterward), then a real live prune. Verified
exhaustively: total file count across main tree + archive stayed exactly
4,904 (nothing lost), archive held exactly 124 files, main tree held
exactly 4,780, total size unchanged at 13.8 GB, and spot-checked one
specific keeper/duplicate pair from an earlier screenshot - the keeper
stayed put, the duplicate moved to the correctly mirrored archive path.
`report` correctly dropped to 0 duplicate groups afterward (everything
left is a keeper).

### 3.4 Rollback restores files to their exact original location
**Test:** `prune`, then `rollback --run <id>`, check filesystem and `status`.
**Expected:** files return to their original paths; `status` shows 0
archived; the run's `pending_actions` drops to 0.
**Validated with:** synthetic dataset; then for real - rolled back the
124-file live prune above via the CLI, confirmed the main tree returned
to exactly 4,904 files, archive folder emptied to 0, the same
keeper/duplicate spot-check pair was back in its original location, and
`report` returned to 106 duplicate groups. Also validated the archive
side-effect: rollback left 6 empty leftover directories in the
now-file-less archive tree (harmless, cosmetic - not cleaned up
automatically, worth a minor polish item but not a correctness bug).
Separately validated through the actual GUI via Playwright, twice: once
against a small seeded synthetic group (archived 2 files as run #1,
rolled back, screenshots confirmed full restoration), and once against
the real 106-group/124-file dataset via the real "Accept all recommended"
and "Roll back" buttons - filesystem ground truth matched exactly (4,904
main tree / 0 archive) both times. This second real pass also caught and
fixed a genuine timing bug: the success/restore notice banner was firing
*before* the group list had actually refetched, so there was a real
(if brief, ~1.5s) window where the banner said "Restored" while the
visible group list hadn't updated yet. Fixed in `App.jsx` by awaiting the
refetch before setting the notice; re-verified by checking the group
count at the exact instant the banner appears (0 right when "Archived"
appears, 106 right when "Restored" appears - no more stale window).

### 3.5 Selective (scoped) prune archives only specified files
**Test (API/GUI only - CLI always prunes every group):** `POST
/datasets/:name/prune` with `photoIds` limited to one file in a
multi-duplicate group.
**Expected:** only that file moves; other duplicates in other groups are
untouched.
**Validated with:** `prune` via curl with `photoIds: [13]` against a
120-file real-ish set - only that one photo moved, run recorded 1 file.

### 3.6 "Accept all recommended" (GUI) archives every group's default
duplicate in one action
**Test:** in the GUI, click "Accept all recommended" with multiple
groups present, without touching any per-group controls.
**Expected:** every group's non-keeper photo(s) get archived in one
prune call; stats and group list update to reflect 0 remaining groups.
**Validated with:** Playwright-driven browser session against the live
app - button click archived both duplicates in the one seeded group,
banner confirmed "Archived 2 file(s) as run #1."

### 3.7 "Keep this instead" changes which file is treated as the keeper
**Test:** in the GUI, click "Keep this instead" on a non-keeper photo in
a group, then archive.
**Expected:** the previously-marked keeper is now included in the
archived set instead of the newly-selected one.
**How to verify:** click-driven; not yet exercised by an automated
script (the Playwright pass validated the button exists and is
clickable, not the resulting archive selection - worth a follow-up test).

### 3.8 Run ledger lists history with accurate pending/restored counts
**Test:** perform a live prune, a dry-run prune, and a rollback; check
`runs`.
**Expected:** three distinct entries with correct `dry_run` flags and
`pending_actions` (0 for the dry run and the rolled-back run, >0 for an
un-rolled-back live run).
**Validated with:** CLI `runs` command and the GUI's run ledger panel,
both cross-checked against the same underlying data.

## 4. GUI / API

### 4.1 Real thumbnails render for real photos
**Test:** load a dataset in the GUI, inspect the duplicate group photos.
**Expected:** actual JPEG thumbnails render (not broken-image icons).
**Validated with:** Playwright - checked `naturalWidth`/`complete` on
each `<img>` element (all 240px, all complete) and visually via
screenshot.

### 4.2 Live scan progress via SSE
**Test:** start a scan via `POST /datasets/:name/scan`, connect to `GET
/scan/:jobId/events`.
**Expected:** an initial `status` event, a stream of `progress` events as
files process, a final `status` event with `state: completed` (or
`stopped`), then the connection closes.
**Validated with:** `curl` against a live scan - captured the full event
sequence from `running` through to `completed`.

### 4.3 API rejects a second concurrent scan for the same dataset
**Test:** start a scan, immediately `POST /datasets/:name/scan` again for
the same dataset.
**Expected:** `409` with the existing `jobId`, not a second concurrent
job.
**Not yet validated** - implemented (see `server/routes.js`) but not
exercised by a test. Worth adding.

### 4.4 Thumbnail endpoint never trusts a raw filesystem path
**Test:** request `/api/photos/:id/thumbnail` for a valid id and for a
made-up/nonexistent id.
**Expected:** valid id returns image bytes; nonexistent id returns 404;
there's no endpoint that accepts an arbitrary filesystem path.
**Validated with:** curl against a real photo id (200, JPEG bytes) and id
`9999` (404).

### 4.5 A file that can't be perceptually hashed still gets a valid thumbnail
**Test:** request `/api/photos/:id/thumbnail` for a photo with no phash
(a genuinely corrupted file); load it in the GUI.
**Expected:** the endpoint returns a 200 with a placeholder JPEG (never a
500), tagged with an `X-Thumbnail-Placeholder: true` header; in the
browser, the `<img>` loads successfully (not a broken-image icon) and
the swatch gets a distinct dashed-border treatment plus a "couldn't be
hashed" tag.
**Validated with:** curl against a real corrupted file's photo id (200,
valid JPEG, header present, viewed the actual placeholder image); then
end-to-end via Playwright against a seeded duplicate group of two
corrupted files - screenshot confirmed the dashed border, warning tag,
and dataset-level callout ("2 file(s) in this dataset couldn't be
perceptually hashed...") all render correctly, and the placeholder
`<img>` loads successfully (`naturalWidth: 240, complete: true`).

### 4.6 GUI renders correctly at real scale
**Test:** load the real ~4,900-photo / 106-group dataset in the browser.
**Expected:** all groups render, all thumbnails load (none broken),
"Accept all recommended" shows the correct total count, scrolling stays
responsive, no console errors or failed requests.
**Validated with:** Playwright against the actual real-world dataset -
106/106 groups rendered, 230 `<img>` elements in the DOM with 0 broken
(`complete && naturalWidth === 0`), "Accept all recommended (124)"
matched the real duplicate count, full scroll-through took ~3s with no
errors. (Note: none of these 106 real groups happened to contain a
no-preview/corrupted file - that path is validated separately in 4.5,
since a real corrupted file being duplicated is inherently rarer than a
real corrupted file existing at all.)

## 5. Safety boundaries (things the app deliberately does NOT do)

- **Never deletes** - `prune` always moves to a recoverable archive
  folder; verified across every prune test above.
- **`scan`/`report` never write to the photo library** - verified
  repeatedly, including against the real, unmodified `F:\photo test`
  drive (confirmed no `duplicates-archive` folder was ever created there
  since only `scan`/`report` were run against it, never `prune`).
- **GUI binds to `127.0.0.1` only, no auth** - by design for a local
  single-user tool; not yet tested that it actually refuses non-loopback
  connections (worth a quick check if this ever runs on a shared machine).

## Toward automation

None of the above runs as `npm test` today - each was a one-off script
written, run, and deleted during development (or a manual CLI/GUI pass).
The next step discussed but not yet started: turn the ones with clear
pass/fail conditions (most of section 1 and 2, several of section 3) into
a real, checked-in test suite so they run automatically instead of
depending on someone re-deriving these scripts by hand.
