// companies router — reads from anabasis-content/companies.json via
// the content-loader. v1 has 6 entries; only Capital One is `active`.

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getCompany, getLoop, listCompanies } from "../services/content-loader.js";
import { publicProcedure, router } from "../trpc.js";

export const companiesRouter = router({
  list: publicProcedure.query(() => listCompanies()),

  get: publicProcedure
    .input(z.object({ slug: z.string() }))
    .query(({ input }) => {
      const company = getCompany(input.slug);
      if (!company) {
        throw new TRPCError({ code: "NOT_FOUND", message: `company not found: ${input.slug}` });
      }
      const loop = getLoop(input.slug);
      return { company, loop: loop ?? null };
    }),
});
