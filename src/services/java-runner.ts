// Java runner — ported from Praxema's praxema-server/src/services/java-runner.ts.
//
// Key differences from Praxema:
//   - Anabasis passes `studentCode` and `testCode` as raw strings (from the
//     exercise JSON or the client's editor), not file paths inside a content
//     tree keyed by pattern/slug.
//   - Paths point at anabasis-content/_lib/junit/ and anabasis-content/_helpers/.
//   - No hidden-test / submit-vs-run distinction in F1. Add later if needed.
//
// The JUnit output parser and classpath assembly are kept verbatim —
// they're battle-tested in Praxema and parsing JUnit tree output is finicky.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TIMEOUT_MS = 10_000;

// Resolve anabasis-content/ the same way content-loader.ts does, but keep
// this file dependency-free so it can be used without booting the loader.
function resolveContentDir(): string {
  if (process.env.ANABASIS_CONTENT_DIR) {
    return resolve(process.env.ANABASIS_CONTENT_DIR);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  let cur = here;
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(cur, "..", "anabasis-content");
    const absolute = resolve(candidate);
    if (fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()) {
      return absolute;
    }
    cur = resolve(cur, "..");
  }
  throw new Error("anabasis-content/ not found for java-runner");
}

const CONTENT_DIR = resolveContentDir();
const JUNIT_JAR = path.join(CONTENT_DIR, "_lib/junit/junit-platform-console-standalone.jar");
const HELPERS_DIR = path.join(CONTENT_DIR, "_helpers");

export type TestStatus = "passed" | "failed" | "error";

export type TestResult = {
  name: string;
  displayName: string;
  status: TestStatus;
  message?: string;
  expected?: string;
  actual?: string;
};

export type RunResult = {
  success: boolean;
  compilationError?: string;
  testResults: TestResult[];
  totalTests: number;
  passedTests: number;
  failedTests: number;
  timeMs: number;
};

export type RunJavaInput = {
  studentCode: string; // contents of Solution.java
  testCode: string; // contents of SolutionTest.java
  includeHelpers?: boolean; // if true, copy anabasis-content/_helpers/*.java alongside
};

function exec(
  cmd: string,
  args: string[],
  options: { cwd: string; timeout: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((r) => {
    execFile(
      cmd,
      args,
      { cwd: options.cwd, timeout: options.timeout, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const exitCode = error ? ((error as unknown as { status?: number }).status ?? 1) : 0;
        r({
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? "",
          exitCode,
        });
      },
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────
// JUnit tree-output parser — ported verbatim from Praxema. The output
// shape is load-bearing; do not "clean up" the regexes without re-running
// against a real JUnit 5 console-launcher execution.
// ─────────────────────────────────────────────────────────────────────────

const CONTAINER_NAMES = new Set(["JUnit Jupiter", "JUnit Vintage", "JUnit Platform Suite"]);

function parseJUnitOutput(stdout: string, stderr: string): TestResult[] {
  const results: TestResult[] = [];
  const lines = stdout.split("\n");

  for (const line of lines) {
    const passMatch = line.match(/─\s+(.+?)\s+✔\s*$/);
    const failMatch = line.match(/─\s+(.+?)\s+✘\s*(.*)$/);

    if (passMatch) {
      const display = passMatch[1]?.trim() ?? "";
      if (CONTAINER_NAMES.has(display)) continue;
      if (/^\w+$/.test(display) && /^[A-Z]/.test(display)) continue;
      const name = display.match(/(\w+)\(\)/)?.[1] ?? display.replace(/\s+/g, "_");
      results.push({
        name,
        displayName: display.replace(/\(\)\s*$/, ""),
        status: "passed",
      });
    } else if (failMatch) {
      const display = failMatch[1]?.trim() ?? "";
      if (CONTAINER_NAMES.has(display)) continue;
      if (/^\w+$/.test(display) && /^[A-Z]/.test(display)) continue;
      const name = display.match(/(\w+)\(\)/)?.[1] ?? display.replace(/\s+/g, "_");
      const errorMsg = failMatch[2]?.trim() ?? "";
      const assertMatch = errorMsg.match(/expected:\s*<(.+?)>\s*but was:\s*<(.+?)>/);
      results.push({
        name,
        displayName: display.replace(/\(\)\s*$/, ""),
        status: "failed",
        message: errorMsg || undefined,
        expected: assertMatch?.[1],
        actual: assertMatch?.[2],
      });
    }
  }

  // Fallback: summary-line parse if tree-details gave us nothing.
  if (results.length === 0) {
    const summaryMatch = stdout.match(/\[\s*(\d+) tests successful\s*\]/);
    const failedMatch = stdout.match(/\[\s*(\d+) tests failed\s*\]/);
    const passed = summaryMatch ? Number.parseInt(summaryMatch[1] ?? "0") : 0;
    const failed = failedMatch ? Number.parseInt(failedMatch[1] ?? "0") : 0;

    for (let i = 0; i < passed; i += 1) {
      results.push({ name: `test${i + 1}`, displayName: `Test ${i + 1}`, status: "passed" });
    }
    for (let i = 0; i < failed; i += 1) {
      results.push({
        name: `failedTest${i + 1}`,
        displayName: `Failed Test ${i + 1}`,
        status: "failed",
      });
    }
  }

  // If still nothing and stderr has content, surface as runtime error.
  if (results.length === 0 && stderr) {
    results.push({
      name: "error",
      displayName: "Execution Error",
      status: "error",
      message: stderr.slice(0, 2000),
    });
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────
// Main entry — write files, compile, run JUnit, parse.
// ─────────────────────────────────────────────────────────────────────────

export async function runJava(input: RunJavaInput): Promise<RunResult> {
  const startTime = Date.now();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "anabasis-java-"));

  try {
    fs.writeFileSync(path.join(tmpDir, "Solution.java"), input.studentCode);
    fs.writeFileSync(path.join(tmpDir, "SolutionTest.java"), input.testCode);

    if (input.includeHelpers && fs.existsSync(HELPERS_DIR)) {
      for (const file of fs.readdirSync(HELPERS_DIR)) {
        if (file.endsWith(".java")) {
          fs.copyFileSync(path.join(HELPERS_DIR, file), path.join(tmpDir, file));
        }
      }
    }

    // 1. Compile with JUnit JAR on the classpath.
    const javaFiles = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".java"));
    const compile = await exec("javac", ["-cp", JUNIT_JAR, ...javaFiles], {
      cwd: tmpDir,
      timeout: TIMEOUT_MS,
    });

    if (compile.exitCode !== 0) {
      return {
        success: false,
        compilationError: (compile.stderr || compile.stdout).trim(),
        testResults: [],
        totalTests: 0,
        passedTests: 0,
        failedTests: 0,
        timeMs: Date.now() - startTime,
      };
    }

    // 2. Run via JUnit console launcher.
    const classpath = [tmpDir, JUNIT_JAR].join(path.delimiter);
    const run = await exec(
      "java",
      [
        "-jar",
        JUNIT_JAR,
        "execute",
        "--class-path",
        classpath,
        "--exclude-engine",
        "junit-platform-suite",
        "--exclude-engine",
        "junit-vintage",
        "--disable-ansi-colors",
        "--details",
        "tree",
        "--details-theme",
        "unicode",
        "--select-class",
        "SolutionTest",
      ],
      { cwd: tmpDir, timeout: TIMEOUT_MS },
    );

    const testResults = parseJUnitOutput(run.stdout, run.stderr);

    if (testResults.length === 0 && run.exitCode !== 0) {
      const errorOutput = (run.stderr || run.stdout).trim();
      const isException = errorOutput.includes("Exception");
      return {
        success: false,
        compilationError: isException ? undefined : errorOutput,
        testResults: isException
          ? [
              {
                name: "error",
                displayName: "Runtime Error",
                status: "error",
                message: errorOutput.slice(0, 2000),
              },
            ]
          : [],
        totalTests: 0,
        passedTests: 0,
        failedTests: isException ? 1 : 0,
        timeMs: Date.now() - startTime,
      };
    }

    const passedTests = testResults.filter((r) => r.status === "passed").length;
    const failedTests = testResults.filter((r) => r.status !== "passed").length;

    return {
      success: failedTests === 0 && testResults.length > 0,
      testResults,
      totalTests: testResults.length,
      passedTests,
      failedTests,
      timeMs: Date.now() - startTime,
    };
  } catch (err) {
    return {
      success: false,
      testResults: [
        {
          name: "error",
          displayName: "Internal Error",
          status: "error",
          message: String(err),
        },
      ],
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      timeMs: Date.now() - startTime,
    };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}
