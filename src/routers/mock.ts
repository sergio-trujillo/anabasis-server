// mock router — builds a realistic GCA mock exam by sampling 4 code
// exercises from the content pool, weighted by difficulty (100 / 200 /
// 300 / 400 ascending, matching Capital One's CodeSignal GCA).
//
// Slot layout:
//   slot 0 (100 pts): easy         — warmup
//   slot 1 (200 pts): easy          — second easy for cadence
//   slot 2 (300 pts): medium       — the real thinking problem
//   slot 3 (400 pts): hard         — the time-sink / optimal-vs-brute-force call
//
// If a difficulty bucket is empty (e.g., no `hard` in the current pool),
// fall back to the next-easier bucket. The exam is non-deterministic by
// design — every mock run pulls a different set, so drilling doesn't let
// the user memorize answers.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  listExercises,
  type AnyExercise,
  type CodeExercise,
  type InterviewerChatExercise,
  type OpenPromptExercise,
} from "../services/content-loader.js";
import { publicProcedure, router } from "../trpc.js";

const GCA_DURATION_SECONDS = 70 * 60; // 70 minutes
const SLOT_WEIGHTS = [100, 200, 300, 400] as const;
const SLOT_DIFFICULTIES = ["easy", "easy", "medium", "hard"] as const;

type Difficulty = "easy" | "medium" | "hard";

function pickOne<T>(pool: T[]): T | undefined {
  if (pool.length === 0) return undefined;
  return pool[Math.floor(Math.random() * pool.length)];
}

function sampleByDifficulty(
  pool: CodeExercise[],
  want: Difficulty,
  used: Set<string>,
): CodeExercise | undefined {
  const fallbacks: Difficulty[] =
    want === "hard" ? ["hard", "medium", "easy"]
      : want === "medium" ? ["medium", "easy", "hard"]
      : ["easy", "medium", "hard"];
  for (const d of fallbacks) {
    const candidates = pool.filter((e) => e.difficulty === d && !used.has(e.id));
    const picked = pickOne(candidates);
    if (picked) return picked;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// Power Day — 4-round simulated virtual onsite.
//
// Round layout (Capital One's real onsite shape):
//   round 0: Coding 1              — 45 min · code exercise
//   round 1: Coding 2 / Job Fit    — 45 min · different code exercise
//   round 2: Behavioral + System Design — 45 min · behavioral open-prompt
//            OR system-design interviewer-chat (randomly picked)
//   round 3: Business Case         — 45 min · business-case interviewer-chat
//            or open-prompt
//
// Total: 3 hours wall time. The client manages per-round timers; the server
// just picks exercises and returns them. Different exercise types per round,
// so the client renders using the appropriate component.
// ─────────────────────────────────────────────────────────────────────────

const POWER_DAY_ROUND_SECONDS = 45 * 60; // 45 minutes each

type RoundKind = "coding" | "behavioral-or-sysdesign" | "business-case";

function pickBehavioralOrSysDesign(all: AnyExercise[]): AnyExercise | undefined {
  // Coin-flip between a behavioral open-prompt and a sys-design interviewer-chat.
  const flip = Math.random() < 0.5;
  if (flip) {
    const pool = all.filter(
      (e): e is OpenPromptExercise =>
        e.type === "open-prompt" && e.section.startsWith("behavioral-"),
    );
    const picked = pickOne(pool);
    if (picked) return picked;
  }
  const sdPool = all.filter(
    (e): e is InterviewerChatExercise =>
      e.type === "interviewer-chat" && e.section === "system-design-banking",
  );
  return pickOne(sdPool);
}

function pickBusinessCase(all: AnyExercise[]): AnyExercise | undefined {
  // Prefer interviewer-chat from business-case-*; fallback to open-prompt.
  const chatPool = all.filter(
    (e): e is InterviewerChatExercise =>
      e.type === "interviewer-chat" && e.section.startsWith("business-case-"),
  );
  const chatPick = pickOne(chatPool);
  if (chatPick) return chatPick;
  const opPool = all.filter(
    (e): e is OpenPromptExercise =>
      e.type === "open-prompt" && e.section.startsWith("business-case-"),
  );
  return pickOne(opPool);
}

export const mockRouter = router({
  buildPowerDay: publicProcedure
    .input(z.object({ companySlug: z.string() }))
    .query(({ input }) => {
      const all = listExercises();

      if (input.companySlug !== "capital-one") {
        return {
          examId: randomUUID(),
          companySlug: input.companySlug,
          roundDurationSeconds: POWER_DAY_ROUND_SECONDS,
          rounds: [],
          startedAt: new Date().toISOString(),
        };
      }

      const codePool = all.filter(
        (e): e is CodeExercise =>
          e.type === "code" && e.section.startsWith("gca-module-"),
      );
      const used = new Set<string>();
      const coding1 = sampleByDifficulty(codePool, "medium", used);
      if (coding1) used.add(coding1.id);
      const coding2 = sampleByDifficulty(codePool, "medium", used);
      if (coding2) used.add(coding2.id);

      const round2 = pickBehavioralOrSysDesign(all);
      const round3 = pickBusinessCase(all);

      const rounds: Array<{
        position: number;
        name: string;
        kind: RoundKind;
        exercise: AnyExercise;
      }> = [];
      if (coding1) {
        rounds.push({ position: 0, name: "Coding Round 1", kind: "coding", exercise: coding1 });
      }
      if (coding2) {
        rounds.push({ position: 1, name: "Coding Round 2 · Job Fit", kind: "coding", exercise: coding2 });
      }
      if (round2) {
        rounds.push({
          position: 2,
          name:
            round2.type === "interviewer-chat"
              ? "System Design — Banking"
              : "Behavioral Interview",
          kind: "behavioral-or-sysdesign",
          exercise: round2,
        });
      }
      if (round3) {
        rounds.push({ position: 3, name: "Business Case", kind: "business-case", exercise: round3 });
      }

      return {
        examId: randomUUID(),
        companySlug: input.companySlug,
        roundDurationSeconds: POWER_DAY_ROUND_SECONDS,
        rounds,
        startedAt: new Date().toISOString(),
      };
    }),

  buildExam: publicProcedure
    .input(z.object({ companySlug: z.string() }))
    .query(({ input }) => {
      const allCode = listExercises().filter(
        (e): e is CodeExercise => e.type === "code",
      );

      // Only pool Capital One's GCA module content for now. Companies
      // other than Capital One are `coming-soon` and have no code pool.
      if (input.companySlug !== "capital-one") {
        return {
          examId: randomUUID(),
          companySlug: input.companySlug,
          durationSeconds: GCA_DURATION_SECONDS,
          problems: [],
          startedAt: new Date().toISOString(),
        };
      }

      const gcaPool = allCode.filter((e) =>
        e.section.startsWith("gca-module-"),
      );

      const used = new Set<string>();
      const problems = SLOT_WEIGHTS.map((weight, i) => {
        const picked = sampleByDifficulty(gcaPool, SLOT_DIFFICULTIES[i], used);
        if (picked) used.add(picked.id);
        return {
          position: i,
          weight,
          targetDifficulty: SLOT_DIFFICULTIES[i],
          exercise: picked,
        };
      }).filter((slot) => slot.exercise !== undefined) as Array<{
        position: number;
        weight: number;
        targetDifficulty: Difficulty;
        exercise: CodeExercise;
      }>;

      return {
        examId: randomUUID(),
        companySlug: input.companySlug,
        durationSeconds: GCA_DURATION_SECONDS,
        problems,
        startedAt: new Date().toISOString(),
      };
    }),
});
