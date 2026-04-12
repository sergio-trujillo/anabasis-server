// tRPC initialization. Context is empty in v1 — single-user local app,
// no auth, no request-scoped state beyond what routers build themselves.

import { initTRPC } from "@trpc/server";

const t = initTRPC.create();

export const router = t.router;
export const publicProcedure = t.procedure;
