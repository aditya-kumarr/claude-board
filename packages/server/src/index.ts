import express from "express";
import cors from "cors";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createLogger, currentLogFile, DB_PATH, getDb, REPO_ROOT } from "@automation/core";
import { requestLogging } from "./middleware/logging.ts";
import { errorHandler, notFoundHandler } from "./middleware/errors.ts";
import { boardsRouter } from "./routes/boards.ts";
import { tasksRouter } from "./routes/tasks.ts";
import { responsesRouter } from "./routes/responses.ts";
import { intakeMessagesRouter } from "./routes/intake.ts";
import { metaRouter } from "./routes/meta.ts";

const log = createLogger("server");
const PORT = Number(process.env.PORT ?? 4000);
// Loopback by default. `cloudflared` runs on this machine so it never needs more than that;
// set HOST=0.0.0.0 only to reach the board directly over the LAN without the tunnel.
const HOST = process.env.HOST ?? "127.0.0.1";

export function createApp(): express.Express {
  const app = express();
  app.disable("x-powered-by");
  // Loopback only, so `req.ip` reflects the dev proxy rather than a spoofed header.
  app.set("trust proxy", "loopback");
  app.use(cors({ origin: true, credentials: false, exposedHeaders: ["x-request-id"] }));
  app.use(express.json({ limit: "256kb" }));
  app.use(requestLogging);

  app.use("/api", metaRouter);
  app.use("/api/boards", boardsRouter);
  app.use("/api/tasks", tasksRouter);
  app.use("/api/responses", responsesRouter);
  app.use("/api/intake", intakeMessagesRouter);

  // Serve the built SPA when it exists, so `bun run build` gives a single-port app.
  const webDist = join(REPO_ROOT, "packages/web/dist");
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(join(webDist, "index.html")));
    log.info("serving built web client", { path: webDist });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

if (import.meta.main) {
  getDb(); // run migrations before accepting traffic
  const app = createApp();
  const server = app.listen(PORT, HOST, () => {
    log.info("api listening", {
      url: `http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}`,
      host: HOST,
      database: DB_PATH,
      logFile: currentLogFile(),
      pid: process.pid,
    });
  });

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      log.error("port already in use", { port: PORT, hint: "another API instance is probably still running" });
    } else {
      log.error("server error", { error });
    }
    process.exit(1);
  });

  const shutdown = (signal: string) => {
    log.info("shutting down", { signal });
    server.close(() => process.exit(0));
    // Do not hang forever on a stuck keep-alive connection.
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => log.error("unhandled rejection", { error: reason }));
  process.on("uncaughtException", (error) => {
    log.error("uncaught exception", { error });
    process.exit(1);
  });
}
