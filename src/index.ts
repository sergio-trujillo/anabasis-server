// anabasis-server entry point.
// Express + tRPC at /trpc, listening on :3001. CORS allows the Vite dev
// client at :5174 (offset +1 from Praxema so both apps can run together).

import { createExpressMiddleware } from "@trpc/server/adapters/express";
import cors from "cors";
import express from "express";
import { appRouter } from "./routers/_app.js";
import { contentStats } from "./services/content-loader.js";
import { modelInfo } from "./services/ollama-client.js";

const PORT = Number(process.env.ANABASIS_PORT ?? 3001);
const CLIENT_ORIGIN = process.env.ANABASIS_CLIENT_ORIGIN ?? "http://localhost:5174";

const app = express();

app.use(cors({ origin: CLIENT_ORIGIN, credentials: false }));
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, service: "anabasis-server" });
});

app.use(
  "/trpc",
  createExpressMiddleware({
    router: appRouter,
    createContext: () => ({}),
  }),
);

app.listen(PORT, () => {
  const stats = contentStats();
  const { url, model } = modelInfo();
  // eslint-disable-next-line no-console
  console.log(`anabasis-server ready → http://localhost:${PORT}`);
  console.log(`  CORS origin        → ${CLIENT_ORIGIN}`);
  console.log(`  Ollama             → ${url} (${model})`);
  console.log(
    `  content loaded     → ${stats.activeCompanies} active / ${stats.totalCompanies} companies, ${stats.sampleExercises} sample exercises`,
  );
  console.log(`  content dir        → ${stats.contentDir}`);
});
