import { EventEmitter } from "node:events";
import { withTransaction, touchLastSeen, upsertPhotoRecord, setDatasetLastScan } from "./db.js";

const DEFAULT_WAVE_SIZE = 8;

// Drives a scan in fixed-size concurrent "waves" instead of one big loop, so
// pause/stop can take effect within a bounded number of in-flight files (at
// most `waveSize`) rather than waiting for the whole scan to finish. Each
// wave is written as a single transaction, so stopping mid-scan can never
// leave a half-written row - the worst case is re-hashing the handful of
// files that were in flight when stop was requested, on the next scan.
//
// Transport-agnostic on purpose: the CLI drives it with keypresses/SIGINT,
// and a future HTTP backend can drive the same instance from pause/resume/
// stop endpoints and stream `progress`/`status` events over SSE.
export class ScanController extends EventEmitter {
  constructor({ db, dataset, files, existingByPath, processFile, waveSize = DEFAULT_WAVE_SIZE }) {
    super();
    this.db = db;
    this.dataset = dataset;
    this.files = files;
    this.existingByPath = existingByPath;
    this.processFile = processFile;
    this.waveSize = waveSize;
    this.cursor = 0;
    this.counts = { hashed: 0, unchanged: 0, failed: 0 };
    this.state = "idle"; // idle | running | paused | stopping | stopped | completed
    this._stopRequested = false;
    this._resumeWaiter = null;
  }

  get total() {
    return this.files.length;
  }

  getStatus() {
    return {
      state: this.state,
      processed: this.cursor,
      total: this.total,
      hashed: this.counts.hashed,
      unchanged: this.counts.unchanged,
      failed: this.counts.failed,
    };
  }

  pause() {
    if (this.state !== "running") {
      return false;
    }
    this.state = "paused";
    this.emit("status", this.getStatus());
    return true;
  }

  resume() {
    if (this.state !== "paused") {
      return false;
    }
    this.state = "running";
    const waiter = this._resumeWaiter;
    this._resumeWaiter = null;
    if (waiter) {
      waiter();
    }
    this.emit("status", this.getStatus());
    return true;
  }

  // Graceful cancel: lets the in-flight wave finish and commit, then ends the
  // run. Already-committed progress is never lost - re-running scan on this
  // dataset picks up where this left off via the unchanged-file skip.
  stop() {
    if (this.state === "completed" || this.state === "stopped" || this.state === "stopping") {
      return false;
    }
    this._stopRequested = true;
    if (this.state === "paused") {
      this.resume();
    }
    this.state = "stopping";
    this.emit("status", this.getStatus());
    return true;
  }

  async _waitWhilePaused() {
    while (this.state === "paused") {
      await new Promise((resolve) => {
        this._resumeWaiter = resolve;
      });
    }
  }

  async run() {
    this.state = "running";
    this.emit("status", this.getStatus());

    while (this.cursor < this.total) {
      if (this._stopRequested) {
        break;
      }
      await this._waitWhilePaused();
      if (this._stopRequested) {
        break;
      }

      const wave = this.files.slice(this.cursor, this.cursor + this.waveSize);
      const results = await Promise.all(
        wave.map((absolutePath) => this.processFile(absolutePath, this.existingByPath))
      );

      withTransaction(this.db, () => {
        const now = new Date().toISOString();
        for (const result of results) {
          if (result.error) {
            this.counts.failed += 1;
            this.emit("fileError", result);
            continue;
          }
          if (result.unchanged) {
            touchLastSeen(this.db, result.photoId, result.absolutePath, now);
            this.counts.unchanged += 1;
            continue;
          }
          upsertPhotoRecord(this.db, this.dataset.id, { ...result, lastSeenAt: now });
          this.counts.hashed += 1;
          if (result.metadataWarning) {
            // Recorded successfully (exact-duplicate detection still works
            // via its SHA256) but couldn't be perceptually hashed - commonly
            // a genuinely corrupted/truncated image file.
            this.emit("fileWarning", result);
          }
        }
      });

      this.cursor += wave.length;
      this.emit("progress", this.getStatus());
    }

    if (this._stopRequested) {
      this.state = "stopped";
    } else {
      setDatasetLastScan(this.db, this.dataset.id);
      this.state = "completed";
    }
    this.emit("status", this.getStatus());
    return this.getStatus();
  }
}
