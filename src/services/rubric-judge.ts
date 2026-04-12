// Rubric judge — given a question, an answer, and a rubric,
// asks the LLM to score the answer 0-100 with reasoning.
//
// **Ported verbatim from anabasis-f0-eval/src/judge.ts.**
// F0 validation: 9/9 perfect match. DO NOT modify the system prompt
// without re-running F0 and updating F0_REPORT.md.
//
// Also hosts `judgeConversation`, which is the server-side replacement
// for the old MODE B template in the F0 interviewer prompt. Runs as a
// separate Ollama call after the session closes (see services/interviewer.ts
// for why — the short version: LLMs can't reliably count turns or switch
// modes mid-session).

import { chat, type OllamaMessage } from "./ollama-client.js";
import type { InterviewerScenario, ChatTurn } from "./interviewer.js";

export type Rubric = {
  must_include: string[];
  must_avoid: string[];
  value_alignment?: string;
  min_words?: number;
};

export type JudgeResult = {
  score: number;
  passed: boolean;
  reasoning: string;
  hits: string[];
  misses: string[];
  warnings: string[];
};

export type ConversationJudgeResult = {
  score: number;
  covered: string[];
  missed: string[];
  feedback: string;
};

// ─────────────────────────────────────────────────────────────────────────
// Open-prompt / rubric judge (F0-calibrated, verbatim)
// ─────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a strict but fair interview coach evaluating a candidate's answer to a behavioral or open-ended question.

Your job:
1. Read the rubric carefully.
2. Read the candidate's answer.
3. Decide which "must_include" items appear (use SEMANTIC match, not literal — "I led the migration" satisfies "personal_ownership" even without that exact phrase).
4. Decide which "must_avoid" items appear.
5. Score 0–100 based on rubric coverage AND clarity AND specificity.

Calibration:
- 90–100: Strong specifics, clear personal ownership, measurable outcome, all must_include items covered, no warnings.
- 70–89:  Most must_include covered, some specifics, reasonable result. Minor warnings allowed.
- 50–69:  Vague but on-topic. Misses 1-2 key items. Lacks specifics or numbers.
- 30–49:  Generic, no personal action, no clear outcome.
- 0–29:   Off-topic, incoherent, or triggers serious warnings (blaming, dishonest).

Output STRICT JSON only — no markdown, no prose around it:
{
  "score": <integer 0-100>,
  "passed": <true if score >= 70>,
  "reasoning": "<2-4 sentences explaining the score>",
  "hits": ["<must_include items the answer covered>"],
  "misses": ["<must_include items the answer missed>"],
  "warnings": ["<must_avoid items the answer triggered>"]
}`;

export async function judge(
  question: string,
  answer: string,
  rubric: Rubric,
): Promise<JudgeResult> {
  const userPrompt = `## Question
${question}

## Rubric

must_include:
${rubric.must_include.map((x) => `  - ${x}`).join("\n")}

must_avoid:
${rubric.must_avoid.map((x) => `  - ${x}`).join("\n")}
${rubric.value_alignment ? `\nvalue_alignment: ${rubric.value_alignment}` : ""}${rubric.min_words ? `\nmin_words: ${rubric.min_words}` : ""}

## Candidate Answer
${answer}

## Output JSON:`;

  const messages: OllamaMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  const raw = await chat(messages, { temperature: 0 });
  const json = extractJson(raw);
  return JSON.parse(json) as JudgeResult;
}

// ─────────────────────────────────────────────────────────────────────────
// Conversation judge — replaces the old MODE B EVAL template from F0.
// Runs after the server closes an interviewer session, receives the full
// transcript, and emits a score + coverage report. Temperature 0 for
// reproducibility. Same shape as the F0 EVAL JSON.
// ─────────────────────────────────────────────────────────────────────────

const CONVERSATION_JUDGE_PROMPT = `You are a strict but fair interview coach evaluating a full multi-turn interview conversation.

Your job:
1. Read the interview topic and the areas the interviewer was supposed to explore.
2. Read the entire conversation transcript.
3. Decide which must_explore items the candidate actually addressed (SEMANTIC match — a candidate who described CDN caching satisfies "cache strategy" even without using that exact phrase).
4. Score 0–100 based on coverage breadth + specificity + reasoning quality.

Calibration:
- 90–100: Addressed nearly all must_explore items with specifics, numbers, and clear trade-off reasoning.
- 70–89:  Most items covered, mostly specific, some reasoning gaps.
- 50–69:  On-topic but vague. Missed 2+ key items or gave surface-level answers.
- 30–49:  Rambling, off-topic, or repeated hand-wavy claims without depth.
- 0–29:   Refused, incoherent, or fundamentally misunderstood the problem.

Output STRICT JSON only — no markdown, no prose around it:
{
  "score": <integer 0-100>,
  "covered": ["<must_explore items the candidate addressed, as strings>"],
  "missed":  ["<must_explore items not addressed, as strings>"],
  "feedback": "<2-3 sentences of constructive feedback>"
}`;

export async function judgeConversation(
  scenario: InterviewerScenario,
  history: ChatTurn[],
): Promise<ConversationJudgeResult> {
  const transcript = history
    .map((t) => `${t.role === "interviewer" ? "INTERVIEWER" : "CANDIDATE"}: ${t.content}`)
    .join("\n\n");

  const userPrompt = `## Topic
${scenario.topic}

## Persona
${scenario.persona}

## must_explore
${scenario.must_explore.map((x, i) => `  ${i + 1}. ${x}`).join("\n")}

## Transcript
${transcript}

## Output JSON:`;

  const messages: OllamaMessage[] = [
    { role: "system", content: CONVERSATION_JUDGE_PROMPT },
    { role: "user", content: userPrompt },
  ];

  const raw = await chat(messages, { temperature: 0 });
  const json = extractJson(raw);
  return JSON.parse(json) as ConversationJudgeResult;
}

function extractJson(s: string): string {
  // Models occasionally wrap JSON in markdown fences despite instructions
  const fenced = s.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenced) return fenced[1] ?? "";
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error(`No JSON object found in response:\n${s}`);
  }
  return s.slice(start, end + 1);
}
