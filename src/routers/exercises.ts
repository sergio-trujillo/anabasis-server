// exercises router — list + get by id. F1 only serves the 4 sample
// exercises under capital-one/samples/. F2 walks the full tree.
//
// For non-LLM types the client evaluates locally or hits runner/judge.
// For `mcq` we also expose a server-side evaluate() so the correct
// answer never travels to the client.

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getExercise, listExercises } from "../services/content-loader.js";
import { publicProcedure, router } from "../trpc.js";

export const exercisesRouter = router({
  list: publicProcedure.query(() => {
    // Strip correctOptionId / explanation from MCQs so the client can't peek.
    return listExercises().map((ex) => {
      if (ex.type === "mcq") {
        const { correctOptionId: _c, explanation: _e, ...rest } = ex;
        return rest;
      }
      return ex;
    });
  }),

  get: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ input }) => {
      const ex = getExercise(input.id);
      if (!ex) {
        throw new TRPCError({ code: "NOT_FOUND", message: `exercise not found: ${input.id}` });
      }
      if (ex.type === "mcq") {
        const { correctOptionId: _c, explanation: _e, ...rest } = ex;
        return rest;
      }
      return ex;
    }),

  evaluateMcq: publicProcedure
    .input(z.object({ id: z.string(), optionId: z.string() }))
    .mutation(({ input }) => {
      const ex = getExercise(input.id);
      if (!ex || ex.type !== "mcq") {
        throw new TRPCError({ code: "NOT_FOUND", message: `mcq not found: ${input.id}` });
      }
      const correct = input.optionId === ex.correctOptionId;
      return {
        correct,
        correctOptionId: ex.correctOptionId,
        explanation: ex.explanation,
      };
    }),
});
