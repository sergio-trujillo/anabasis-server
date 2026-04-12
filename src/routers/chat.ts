// chat router — server-orchestrated interviewer sessions.
//
// **Architectural contract (F0 lesson):**
//   - The server owns turn counting, not the LLM.
//   - Two prompts, one call each:
//       1. interviewerReply()   → single ASK follow-up, temp 0.7
//       2. judgeConversation()  → separate EVAL call on close, temp 0
//   - The closing line is a deterministic string from services/closer.ts.
//     No LLM call is made to produce it.
//
// Sessions live in memory (Map). v1 is single-user; reload = lost session.
// See STATUS.md open decision O4.

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { CLOSING_LINE } from "../services/closer.js";
import {
  type ChatTurn,
  type InterviewerScenario,
  interviewerReply,
} from "../services/interviewer.js";
import {
  type ConversationJudgeResult,
  judgeConversation,
} from "../services/rubric-judge.js";
import { getScenario } from "../services/scenarios.js";
import { publicProcedure, router } from "../trpc.js";

type ChatSession = {
  id: string;
  scenario: InterviewerScenario;
  history: ChatTurn[];
  turnCount: number; // number of candidate messages received
  maxTurns: number;
  closed: boolean;
  eval: ConversationJudgeResult | null;
};

const sessions = new Map<string, ChatSession>();

function serialize(session: ChatSession) {
  return {
    id: session.id,
    scenarioId: session.scenario.id,
    history: session.history,
    turnCount: session.turnCount,
    maxTurns: session.maxTurns,
    closed: session.closed,
    eval: session.eval,
  };
}

export const chatRouter = router({
  // ── start: open a session for a scenario, seed with opening_message ──
  start: publicProcedure
    .input(z.object({ scenarioId: z.string() }))
    .mutation(({ input }) => {
      const scenario = getScenario(input.scenarioId);
      if (!scenario) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `scenario not found: ${input.scenarioId}`,
        });
      }

      const session: ChatSession = {
        id: crypto.randomUUID(),
        scenario,
        history: [{ role: "interviewer", content: scenario.opening_message }],
        turnCount: 0,
        maxTurns: scenario.max_turns ?? 6,
        closed: false,
        eval: null,
      };
      sessions.set(session.id, session);

      return {
        sessionId: session.id,
        openingMessage: scenario.opening_message,
        maxTurns: session.maxTurns,
      };
    }),

  // ── send: candidate message in, interviewer message (or close+eval) out ──
  send: publicProcedure
    .input(
      z.object({
        sessionId: z.string(),
        candidateMessage: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const session = sessions.get(input.sessionId);
      if (!session) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `session not found: ${input.sessionId}`,
        });
      }
      if (session.closed) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "session is already closed",
        });
      }

      // 1. Append candidate turn, increment counter.
      session.history.push({
        role: "candidate",
        content: input.candidateMessage,
      });
      session.turnCount += 1;

      // 2. If the cap is hit, server closes + judges. No interviewer LLM call.
      if (session.turnCount >= session.maxTurns) {
        session.history.push({ role: "interviewer", content: CLOSING_LINE });
        const evalResult = await judgeConversation(session.scenario, session.history);
        session.eval = evalResult;
        session.closed = true;
        return {
          closed: true as const,
          closingLine: CLOSING_LINE,
          eval: evalResult,
        };
      }

      // 3. Otherwise ask the interviewer for one more follow-up.
      const reply = await interviewerReply(session.scenario, session.history);
      session.history.push({ role: "interviewer", content: reply });
      return {
        closed: false as const,
        reply,
        turnCount: session.turnCount,
        maxTurns: session.maxTurns,
      };
    }),

  // ── get: full session state for client hydration / debugging ──
  get: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(({ input }) => {
      const session = sessions.get(input.sessionId);
      if (!session) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `session not found: ${input.sessionId}`,
        });
      }
      return serialize(session);
    }),
});
