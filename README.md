# anabasis-server

<p align="left">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" />
  <img alt="Node" src="https://img.shields.io/badge/Node-%3E%3D22-339933?logo=node.js&logoColor=white" />
  <img alt="Express" src="https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white" />
  <img alt="tRPC" src="https://img.shields.io/badge/tRPC-11-2596BE?logo=trpc&logoColor=white" />
  <img alt="Zod" src="https://img.shields.io/badge/Zod-3-3E67B1" />
  <img alt="Ollama" src="https://img.shields.io/badge/Ollama-Qwen%202.5%2014B-FF6F00" />
  <img alt="Phase" src="https://img.shields.io/badge/Phase-F3-yellow" />
  <img alt="Part of" src="https://img.shields.io/badge/Part%20of-Anabasis-black" />
  <img alt="License" src="https://img.shields.io/badge/License-Proprietary-red" />
</p>

> Backend for **Anabasis** — local-first, company-specific interview prep. Orchestrates interviewer chats, scores open-prompt answers, compiles Java submissions, and serves company catalog content.

Sibling to [`anabasis-client`](https://github.com/sergio-trujillo/anabasis-client), [`anabasis-content`](https://github.com/sergio-trujillo/anabasis-content), and [`anabasis-llm`](https://github.com/sergio-trujillo/anabasis-llm). **Not a monorepo** — each repo stands on its own, with its own `package.json` and `node_modules/`. The client consumes this server's `AppRouter` type via a TypeScript paths alias (`@server/*`), a pattern lifted from the sister project [Praxema](https://github.com/sergio-trujillo/praxema).

---

## What it does

Exposes a single tRPC router (`appRouter`) over HTTP at `:3001/trpc`:

| Router | Purpose |
|---|---|
| `healthz`    | liveness probe |
| `chat`       | multi-turn interviewer sessions — `start`, `send`, `get`. **Server owns turn counting; the LLM never closes a session or emits EVAL.** |
| `judge`      | `judgeOpenPrompt` (rubric-scored single answer) + `judgeConversation` (full-transcript coach report) |
| `runner`     | Java `javac` + JUnit 5 via `child_process` (lifted from Praxema) |
| `exercises`  | loads and serves exercises from `anabasis-content/` |
| `companies`  | company catalog |

## The two-prompt architecture (F0 lesson)

Every interviewer session uses **two separate Ollama calls** with different temperatures:

```
┌─────────────────────────────────────────────────────────────┐
│  Candidate                                                   │
│     │                                                         │
│     ▼                                                         │
│  server turnCount++                                           │
│     │                                                         │
│     ├─ if turnCount < maxTurns ──▶ interviewerReply()         │
│     │                              temp 0.7, ASK-only        │
│     │                                                         │
│     └─ if turnCount >= maxTurns ──▶ emit CLOSING_LINE (const) │
│                                     + judgeConversation()    │
│                                     temp 0, full transcript  │
└─────────────────────────────────────────────────────────────┘
```

Why: in F0 (phase 0 validation) a single prompt with two modes caused off-by-one closing, mode mixing (ASK + CLOSE in one reply), and EVAL format drift. Moving the state machine out of the LLM fixed all three defects. See [`F0_REPORT.md`](../F0_REPORT.md) in the parent workspace for the full post-mortem.

## Bilingual interviewer sessions

`chat.start` accepts an optional `locale: "en" | "es"` (default `"en"`). The scenario loader resolves each field (`topic`, `persona`, `must_explore`, `opening_message`) from either a plain `string` (legacy English-only JSON) or a `{ en, es }` object, and `services/interviewer.ts` selects the matching system prompt template. The two templates are faithful ports of each other — same allowed/forbidden patterns, same hard rules, same turn-limit discipline — so the server-owned state machine works identically regardless of locale. The Spanish template uses neutral professional tuteo and keeps industry-standard English terms intact (stateless, tradeoff, fallback, partition, latency).

---

## Quick start

```bash
# prereqs
brew install node ollama
ollama pull qwen2.5:14b-instruct-q5_K_M
brew services start ollama

# from this folder
npm install
npm run dev           # tsx watch on :3001
```

### Environment

| Variable | Default | Purpose |
|---|---|---|
| `ANABASIS_PORT`          | `3001`                          | HTTP listen port |
| `ANABASIS_CLIENT_ORIGIN` | `http://localhost:5174`          | CORS allow-origin |
| `ANABASIS_MODEL`         | `qwen2.5:14b-instruct-q5_K_M`    | Ollama model tag |
| `OLLAMA_URL`             | `http://localhost:11434`         | Ollama HTTP endpoint |
| `OLLAMA_KEEP_ALIVE`      | *(export before start)*          | `24h` — avoids 8–15 s cold reloads |

---

## Stack

- **Runtime:** Node 22+ (tested on 25), strict TypeScript, ESM, NodeNext module resolution
- **HTTP:** Express 5 + `@trpc/server` 11 express adapter
- **Validation:** Zod 3
- **LLM transport:** native `fetch` against Ollama's `/api/chat` endpoint — **zero SDK dependency** (no `ollama-js`, no Vercel AI SDK)
- **Java:** `javac` + `java` + JUnit 5 standalone JAR via `child_process` (ported from Praxema)
- **Hot reload:** `tsx watch` for TS, `chokidar` for content filesystem

## Conventions

- `type: "module"` — all imports use `.js` suffix even for `.ts` sources
- tRPC procedures in `src/routers/`, business logic in `src/services/`
- Services are framework-agnostic — routers are thin Zod-validated wrappers
- Prompts live in `services/interviewer.ts` and `services/rubric-judge.ts` — **do not modify without re-running F0**

## Not in scope (yet)

- Persistent session store — v1 is in-memory only, reload = lost chat. See `STATUS.md` O4
- Streaming token responses — F1 is request/response. F2 adds SSE
- Auth — single-user local app, forever single-user

---

## License

**Proprietary.** Single-author personal project, not open-sourced. No public `LICENSE` file. See the workspace `STATUS.md` decision D19.
