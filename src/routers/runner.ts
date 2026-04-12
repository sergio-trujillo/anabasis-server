// runner router — exposes the Java runner to the client.
// Client sends student code + test code as strings; server compiles and
// executes in a tmpdir via javac + JUnit 5 console launcher.

import { z } from "zod";
import { runJava } from "../services/java-runner.js";
import { publicProcedure, router } from "../trpc.js";

export const runnerRouter = router({
  runJava: publicProcedure
    .input(
      z.object({
        studentCode: z.string().min(1),
        testCode: z.string().min(1),
        includeHelpers: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      return runJava(input);
    }),
});
