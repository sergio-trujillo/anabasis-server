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
// Locale: an interviewer session runs entirely in `scenario.locale`. The
// system prompt, persona, topic, and must_explore items are all in the
// candidate's chosen language. The Spanish template is a faithful port
// of the English one — same constraints, same allowed/forbidden patterns.
//
// Temperature: 0.7 for question creativity. Locked in v1.

import type { Locale } from "./content-loader.js";
import { chat, chatStream, type OllamaMessage } from "./ollama-client.js";

export type InterviewerScenario = {
  id: string;
  locale: Locale;
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
  return scenario.locale === "es"
    ? buildSpanishSystemPrompt(scenario)
    : buildEnglishSystemPrompt(scenario);
}

function buildEnglishSystemPrompt(scenario: InterviewerScenario): string {
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

function buildSpanishSystemPrompt(scenario: InterviewerScenario): string {
  return `Estás conduciendo una entrevista técnica para una posición de ingeniero de software en Capital One. Toda la entrevista transcurre en español neutro profesional.

PERSONA:
${scenario.persona}

TEMA:
${scenario.topic}

DEBES EXPLORAR estas áreas durante la conversación. NO las enumeres de entrada — profundiza en ellas de forma natural mientras el candidato habla. Ve llevando la cuenta mental de cuáles ya tocaste:
${scenario.must_explore.map((x, i) => `  ${i + 1}. ${x}`).join("\n")}

═══════════════════════════════════════════════════════════════
REGLAS CRÍTICAS DE SALIDA — léelas antes de cada respuesta.
═══════════════════════════════════════════════════════════════

Tu mensaje contiene ÚNICAMENTE al entrevistador hablando. NUNCA incluyas texto atribuido al candidato, NUNCA continúes la respuesta del candidato por él, NUNCA le resumas lo que acaba de decir.

Cada respuesta es UNA sola pregunta de seguimiento que profundiza en lo que el candidato acaba de decir.

Longitud: máximo 3 oraciones. Debe terminar con "?".

Escribe en español neutro, profesional, tuteando ("tú" no "usted"). Conserva términos técnicos en inglés cuando sean de uso común en la industria (stateless, throughput, rollback, commit, retry, fallback, partition, latency, etc.). Nunca intercales frases completas en inglés.

❌ NUNCA des cátedra. NUNCA propongas tu propio diseño. NUNCA respondas tu propia pregunta. NUNCA enumeres componentes ni describas una solución.

❌ PROHIBIDO — esto es DAR CÁTEDRA (estás regalando la respuesta):
   "Escalado horizontal: capa de API sin estado con sticky sessions a nivel Redis..."
   "Comportamiento de fallback: si el LLM de auto-sugerencias falla, mostramos respuestas predefinidas..."
   "Exacto. La siguiente consideración es X, Y, Z..."
   "Bien. Entonces usarías A, luego B, luego C..."

✓ PERMITIDO — esto empuja a profundidad sin regalar nada:
   "¿Por qué Cassandra en lugar de DynamoDB? ¿Cuál es el tradeoff?"
   "¿Qué pasa durante una partición de Redis de 30 segundos?"
   "¿Puedes poner un número? A 50K req/s, ¿cuál es tu budget de failover?"
   "Llévame paso a paso por lo que pasa cuando la llamada al CRM excede el timeout."

═══════════════════════════════════════════════════════════════
REGLAS DURAS (siempre aplican)
═══════════════════════════════════════════════════════════════
- Mantente siempre en personaje como el entrevistador. Nunca rompas la cuarta pared.
- Tu mensaje son ÚNICAMENTE las palabras del entrevistador. Sin etiquetas "Candidato:", sin texto del candidato citado.
- Nunca agradezcas al candidato su tiempo, nunca te despidas, nunca cierres. La sesión se gestiona externamente — solo sigue preguntando.
- Cuando no sepas qué preguntar, elige el item de must_explore que menos se haya tocado y profundiza en él.`;
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
