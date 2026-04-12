// Root tRPC router. New feature routers get mounted here.
// The AppRouter type is consumed by anabasis-client via a TS paths alias
// (@server/*) — see anabasis-client/tsconfig.app.json.

import { publicProcedure, router } from "../trpc.js";
import { chatRouter } from "./chat.js";
import { companiesRouter } from "./companies.js";
import { exercisesRouter } from "./exercises.js";
import { judgeRouter } from "./judge.js";
import { mockRouter } from "./mock.js";
import { runnerRouter } from "./runner.js";

export const appRouter = router({
  healthz: publicProcedure.query(() => ({
    ok: true,
    service: "anabasis-server",
    ts: new Date().toISOString(),
  })),
  companies: companiesRouter,
  exercises: exercisesRouter,
  chat: chatRouter,
  judge: judgeRouter,
  mock: mockRouter,
  runner: runnerRouter,
});

export type AppRouter = typeof appRouter;
