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
import { listExercises, type CodeExercise } from "../services/content-loader.js";
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

export const mockRouter = router({
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
