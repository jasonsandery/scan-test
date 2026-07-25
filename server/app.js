import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import cors from "cors";
import { initializeDatabase, closeDatabase } from "../src/db.js";
import { createRouter } from "./routes.js";

const DEFAULT_PORT = 4100;

// Resolved relative to this file's own location (local/server/), not the
// process's current working directory - so the GUI and the CLI agree on
// where the database lives by default, regardless of which directory you
// happened to launch `node` from.
const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, "duplicate_state.db");
const CLIENT_DIST = path.join(PROJECT_ROOT, "client", "dist");

export function createApp(db) {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use("/api", createRouter(db));
  // Serves the built React app (npm run build in client/) so the whole GUI
  // is reachable from this one process/port - no separate Vite dev server
  // needed for normal use. If client/dist doesn't exist yet (no build run),
  // this simply falls through to a 404 rather than erroring.
  app.use(express.static(CLIENT_DIST));
  return app;
}

function main() {
  const dbPath = path.resolve(process.env.DUPLICATE_DB || DEFAULT_DB_PATH);
  const db = initializeDatabase(dbPath);
  const app = createApp(db);
  const port = Number(process.env.PORT || DEFAULT_PORT);

  // Local single-user tool - bind to loopback only, no auth layer.
  const server = app.listen(port, "127.0.0.1", () => {
    console.log(`Light Table listening on http://127.0.0.1:${port}`);
    console.log(`Database file: ${dbPath}`);
  });

  const shutdown = () => {
    server.close(() => {
      closeDatabase(db);
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
