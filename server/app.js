import path from "node:path";
import { pathToFileURL } from "node:url";
import express from "express";
import cors from "cors";
import { initializeDatabase, closeDatabase } from "../src/db.js";
import { createRouter } from "./routes.js";

const DEFAULT_PORT = 4100;

export function createApp(db) {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use("/api", createRouter(db));
  return app;
}

function main() {
  const dbPath = path.resolve(process.env.DUPLICATE_DB || "duplicate_state.db");
  const db = initializeDatabase(dbPath);
  const app = createApp(db);
  const port = Number(process.env.PORT || DEFAULT_PORT);

  // Local single-user tool - bind to loopback only, no auth layer.
  const server = app.listen(port, "127.0.0.1", () => {
    console.log(`Photo duplicate API listening on http://127.0.0.1:${port}`);
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
