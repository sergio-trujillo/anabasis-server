// Filesystem content loader. Reads anabasis-content/ at boot and exposes
// a simple get-by-id API. No DB, no migrations — the content repo is the
// source of truth.
//
// Resolution: ANABASIS_CONTENT_DIR env var wins; otherwise walk up from
// this file until a sibling `anabasis-content/` is found. That makes the
// server work whether it's run from its own folder or from a parent.
//
// Hot reload via chokidar is deferred to F2. F1 caches on first read.

import { readdirSync, readFileSync } from "node:fs";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ─────────────────────────────────────────────────────────────────────────
// Types mirrored across the server. Client gets them via tRPC inference.
// ─────────────────────────────────────────────────────────────────────────

export type CompanyStatus = "active" | "coming-soon";

export type Company = {
  slug: string;
  name: string;
  status: CompanyStatus;
  tagline: string;
  accentColor?: string;
};

export type LoopSection = {
  id: string;
  name: string;
  kind: string;
};

export type LoopPhase = {
  id: string;
  name: string;
  description: string;
  sections: LoopSection[];
};

export type Loop = {
  companySlug: string;
  displayName: string;
  phases: LoopPhase[];
};

type Bilingual = { en: string; es: string };

export type McqOption = { id: string; label: Bilingual };

export type McqExercise = {
  id: string;
  type: "mcq";
  section: string;
  title: Bilingual;
  prompt: Bilingual;
  options: McqOption[];
  correctOptionId: string;
  explanation: Bilingual;
};

export type CodeExercise = {
  id: string;
  type: "code";
  section: string;
  title: Bilingual;
  difficulty: "easy" | "medium" | "hard";
  language: "java";
  statement: Bilingual;
  starterCode: string;
  testCode: string;
};

export type Rubric = {
  must_include: string[];
  must_avoid: string[];
  value_alignment?: string;
  min_words?: number;
};

export type OpenPromptExercise = {
  id: string;
  type: "open-prompt";
  section: string;
  title: Bilingual;
  question: Bilingual;
  rubric: Rubric;
};

export type InterviewerChatExercise = {
  id: string;
  type: "interviewer-chat";
  section: string;
  title: Bilingual;
  topic: string;
  persona: string;
  must_explore: string[];
  opening_message: string;
  max_turns: number;
};

export type AnyExercise =
  | McqExercise
  | CodeExercise
  | OpenPromptExercise
  | InterviewerChatExercise;

// ─────────────────────────────────────────────────────────────────────────
// Content root resolution (Fix #6 — lazy, not module-top-level)
//
// Resolving at module load would crash the server at import time if the
// content folder is missing. We now resolve on first access and cache the
// result for the process lifetime.
// ─────────────────────────────────────────────────────────────────────────

let cachedContentDir: string | null = null;

function resolveContentDir(): string {
  if (cachedContentDir) return cachedContentDir;

  if (process.env.ANABASIS_CONTENT_DIR) {
    cachedContentDir = resolve(process.env.ANABASIS_CONTENT_DIR);
    return cachedContentDir;
  }
  // Walk up from this source file until we find a sibling anabasis-content/
  const here = dirname(fileURLToPath(import.meta.url));
  let cur = here;
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(cur, "..", "anabasis-content");
    const absolute = resolve(candidate);
    if (existsSync(absolute) && statSync(absolute).isDirectory()) {
      cachedContentDir = absolute;
      return absolute;
    }
    cur = resolve(cur, "..");
  }
  throw new Error(
    "anabasis-content/ not found. Set ANABASIS_CONTENT_DIR or place it as a sibling of anabasis-server/.",
  );
}

// Fix #7 helper — distinguish "file doesn't exist" from "file exists but
// is malformed". A bare try/catch would silently swallow syntax errors and
// make debugging a nightmare.
type NodeError = Error & { code?: string };

function isNotFound(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as NodeError).code === "ENOENT";
}

function readJson<T>(relativePath: string): T {
  const absolute = join(resolveContentDir(), relativePath);
  const raw = readFileSync(absolute, "utf-8");
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    // Re-throw with context so `loadLoop`-style callers can tell this
    // apart from ENOENT. The original stack is preserved via cause.
    throw new Error(
      `Failed to parse JSON at ${relativePath}: ${(err as Error).message}`,
      { cause: err },
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Cache — one-shot eager load on first access
// ─────────────────────────────────────────────────────────────────────────

let companiesCache: Company[] | null = null;
const loopCache = new Map<string, Loop>();
const exerciseCache = new Map<string, AnyExercise>();

function loadCompanies(): Company[] {
  if (!companiesCache) {
    companiesCache = readJson<Company[]>("companies.json");
  }
  return companiesCache;
}

function loadLoop(companySlug: string): Loop | undefined {
  if (loopCache.has(companySlug)) {
    return loopCache.get(companySlug);
  }
  try {
    const loop = readJson<Loop>(`${companySlug}/loop.json`);
    loopCache.set(companySlug, loop);
    return loop;
  } catch (err) {
    // Fix #7 — ENOENT is expected (company has no loop defined yet).
    // Anything else (JSON parse error, permission denied) is a real bug
    // and must not be silently swallowed.
    if (isNotFound(err)) {
      return undefined;
    }
    // eslint-disable-next-line no-console
    console.error(`[content-loader] failed to load loop for ${companySlug}:`, err);
    throw err;
  }
}

// F3 — recursive walk. Picks up every *.json under a company folder
// that looks like an exercise (has a `type` field in the known set).
//
// Ignored:
//   - Files/dirs starting with _ or . (_helpers, _lib, .cache, etc.)
//   - `loop.json` (company metadata, not an exercise)
//   - `companies.json` (catalog, at the root — never walked here)
//
// Malformed JSON surfaces through `readJson`'s improved error handling
// (Opus-review Fix #7). Unknown shapes are logged and skipped so one bad
// file can't tank startup.

const KNOWN_EXERCISE_TYPES = new Set([
  "mcq",
  "code",
  "open-prompt",
  "interviewer-chat",
]);

function isExerciseShape(value: unknown): value is AnyExercise {
  if (!value || typeof value !== "object") return false;
  const v = value as { id?: unknown; type?: unknown };
  return (
    typeof v.id === "string" && typeof v.type === "string" && KNOWN_EXERCISE_TYPES.has(v.type)
  );
}

function* walkExerciseJsonPaths(dir: string, relBase: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    // Skip underscores / dotfiles (system folders like _helpers, _lib, .cache)
    if (entry.startsWith("_") || entry.startsWith(".")) continue;

    const absolute = join(dir, entry);
    const rel = relBase ? `${relBase}/${entry}` : entry;
    const s = statSync(absolute);

    if (s.isDirectory()) {
      yield* walkExerciseJsonPaths(absolute, rel);
    } else if (s.isFile() && entry.endsWith(".json")) {
      // Filter out metadata files at the company root.
      if (entry === "loop.json" || entry === "companies.json") continue;
      yield rel;
    }
  }
}

function primeExerciseCache(): void {
  if (exerciseCache.size > 0) return;

  const contentDir = resolveContentDir();
  const companies = loadCompanies();

  for (const company of companies) {
    const companyDir = join(contentDir, company.slug);
    if (!existsSync(companyDir)) continue;

    for (const relPath of walkExerciseJsonPaths(companyDir, company.slug)) {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(join(contentDir, relPath), "utf-8"));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[content-loader] skipping ${relPath}: ${(err as Error).message}`);
        continue;
      }

      if (!isExerciseShape(raw)) {
        // eslint-disable-next-line no-console
        console.warn(
          `[content-loader] skipping ${relPath}: missing or unknown "type" (expected one of ${[...KNOWN_EXERCISE_TYPES].join(", ")})`,
        );
        continue;
      }

      if (exerciseCache.has(raw.id)) {
        // eslint-disable-next-line no-console
        console.warn(
          `[content-loader] duplicate exercise id "${raw.id}" at ${relPath} — keeping the first one loaded`,
        );
        continue;
      }

      exerciseCache.set(raw.id, raw);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

export function listCompanies(): Company[] {
  return loadCompanies();
}

export function getCompany(slug: string): Company | undefined {
  return loadCompanies().find((c) => c.slug === slug);
}

export function getLoop(companySlug: string): Loop | undefined {
  return loadLoop(companySlug);
}

export function listExercises(): AnyExercise[] {
  primeExerciseCache();
  return Array.from(exerciseCache.values());
}

export function getExercise(id: string): AnyExercise | undefined {
  primeExerciseCache();
  return exerciseCache.get(id);
}

export function getInterviewerScenario(id: string): InterviewerChatExercise | undefined {
  const ex = getExercise(id);
  return ex?.type === "interviewer-chat" ? ex : undefined;
}

export function contentStats() {
  const companies = loadCompanies();
  primeExerciseCache();
  return {
    contentDir: resolveContentDir(),
    activeCompanies: companies.filter((c) => c.status === "active").length,
    totalCompanies: companies.length,
    sampleExercises: exerciseCache.size,
  };
}

/** Invalidate all in-memory caches. Next API call re-reads from disk.
 *  Used by the chokidar watcher (see content-watcher.ts) when a file
 *  under anabasis-content/ changes in dev. */
export function invalidateContentCaches(): void {
  companiesCache = null;
  loopCache.clear();
  exerciseCache.clear();
}
