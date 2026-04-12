// judge router — exposes the two scoring modes to the client:
//   - judgeOpenPrompt:    single question + answer + rubric → JudgeResult
//   - judgeConversation:  full interviewer transcript       → ConversationJudgeResult
//
// The conversation variant is normally called internally by chatRouter.send
// when a session closes. It's also exposed here so the client can re-judge
// an existing transcript (for debugging, or for "regenerate EVAL" actions).

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { judge, judgeConversation } from "../services/rubric-judge.js";
import { getScenario } from "../services/scenarios.js";
import { publicProcedure, router } from "../trpc.js";

const rubricSchema = z.object({
  must_include: z.array(z.string()),
  must_avoid: z.array(z.string()),
  value_alignment: z.string().optional(),
  min_words: z.number().int().positive().optional(),
});

const chatTurnSchema = z.object({
  role: z.enum(["interviewer", "candidate"]),
  content: z.string(),
});

export const judgeRouter = router({
  judgeOpenPrompt: publicProcedure
    .input(
      z.object({
        question: z.string().min(1),
        answer: z.string().min(1),
        rubric: rubricSchema,
      }),
    )
    .mutation(async ({ input }) => {
      return judge(input.question, input.answer, input.rubric);
    }),

  judgeConversation: publicProcedure
    .input(
      z.object({
        scenarioId: z.string(),
        history: z.array(chatTurnSchema).min(2),
      }),
    )
    .mutation(async ({ input }) => {
      const scenario = getScenario(input.scenarioId);
      if (!scenario) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `scenario not found: ${input.scenarioId}`,
        });
      }
      return judgeConversation(scenario, input.history);
    }),
});
