// Interviewer — ASK-only LLM persona that conducts a simulated technical
// interview round. One call = one follow-up question.
//
// **Architectural note (F0 lesson):** this prompt is deliberately ASK-only.
// The old F0 version had MODE A (ASK) + MODE B (CLOSE + EVAL) in a single
// system prompt. That caused:
//   - LLMs miscounting candidate messages, closing early or late
//   - Mode-mixing (ASK + CLOSE in the same reply, duplicated EVAL)
//   - Format drift in the EVAL prefix
//
// F1 fixes this by moving orchestration to the server:
//   1. Server tracks turnCount in memory (see routers/chat.ts).
//   2. When turnCount >= maxTurns, server emits CLOSING_LINE itself
//      (no LLM call — see services/closer.ts) and then makes a SEPARATE
//      Ollama call to judgeConversation() for the EVAL JSON.
//   3. This interviewer prompt never closes, never emits EVAL, never
//      thinks about turn counting. It has one job: ask one good follow-up.
//
// Temperature: 0.7 for question creativity. Locked in v1.

import { chat, chatStream, type OllamaMessage } from "./ollama-client.js";

export type InterviewerScenario = {
  id: string;
  topic: string;
  persona: string;
  must_explore: string[];
  opening_message: string;
  max_turns?: number;
};

export type ChatTurn = {
  role: "interviewer" | "candidate";
  content: string;
};

export function buildSystemPrompt(scenario: InterviewerScenario): string {
  return `You are conducting a technical interview for a software engineer position at Capital One.

PERSONA:
${scenario.persona}

TOPIC:
${scenario.topic}

YOU MUST EXPLORE these areas during the conversation. Do NOT list them up front — drill into them naturally as the candidate speaks. Track which ones have been touched:
${scenario.must_explore.map((x, i) => `  ${i + 1}. ${x}`).join("\n")}

═══════════════════════════════════════════════════════════════
CRITICAL OUTPUT RULES — read these before every response.
═══════════════════════════════════════════════════════════════

Your message contains ONLY the interviewer speaking. NEVER include text attributed to the candidate, NEVER continue the candidate's answer for them, NEVER summarize what the candidate just said back to them.

Every single response is a SINGLE follow-up question that drills into what the candidate just said.

Length: maximum 3 sentences. Must end with "?".

❌ NEVER lecture. NEVER propose your own design. NEVER answer your own question. NEVER list components or describe a solution.

❌ FORBIDDEN — these are LECTURING (you are giving away the answer):
   "Horizontal scaling: stateless API layer with sticky sessions at Redis level..."
   "Fallback behavior: if auto-suggest LLM fails, we show canned responses..."
   "That's right. The next consideration is X, Y, Z..."
   "Good. So you'd use A, then B, then C..."

✓ ALLOWED — these push for depth without giving anything away:
   "Why Cassandra over DynamoDB? What's the tradeoff?"
   "What happens during a 30-second Redis partition?"
   "Can you put a number on that? At 50K req/s, what's your failover budget?"
   "Walk me through what happens when the CRM call times out."

═══════════════════════════════════════════════════════════════
HARD RULES (always apply)
═══════════════════════════════════════════════════════════════
- Stay in character as the interviewer at all times. Never break the fourth wall.
- Your message is the interviewer's words ONLY. No "Candidate:" labels, no quoted candidate text.
- Never thank the candidate for their time, never say goodbye, never wrap up. The session is managed externally — just keep asking.
- When unsure what to ask, pick the must_explore item that has been touched the least and drill into it.`;
}

function toOllamaHistory(history: ChatTurn[]): OllamaMessage[] {
  return history.map((t) => ({
    role: (t.role === "interviewer" ? "assistant" : "user") as
      | "assistant"
      | "user",
    content: t.content,
  }));
}

export async function interviewerReply(
  scenario: InterviewerScenario,
  history: ChatTurn[],
): Promise<string> {
  const messages: OllamaMessage[] = [
    { role: "system", content: buildSystemPrompt(scenario) },
    ...toOllamaHistory(history),
  ];
  return chat(messages, { temperature: 0.7 });
}

export async function* interviewerReplyStream(
  scenario: InterviewerScenario,
  history: ChatTurn[],
): AsyncGenerator<string> {
  const messages: OllamaMessage[] = [
    { role: "system", content: buildSystemPrompt(scenario) },
    ...toOllamaHistory(history),
  ];
  for await (const chunk of chatStream(messages, { temperature: 0.7 })) {
    yield chunk;
  }
}
