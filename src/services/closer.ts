// Deterministic closing line. The server emits this string directly when
// an interviewer session hits max_turns — no LLM call needed for closing.
//
// This replaces the old MODE B "CLOSE" template from the F0 interviewer
// prompt. See services/interviewer.ts header for the architectural reason.

export const CLOSING_LINE = "Thank you, that's all the time we have for today.";
