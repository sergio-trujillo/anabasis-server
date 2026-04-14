// Scenario registry. Backed by the filesystem via content-loader — each
// interviewer-chat exercise in anabasis-content/ is a scenario.
//
// This module resolves bilingual content fields to plain strings for a
// given locale. The English-only legacy shape is still supported: fields
// declared as plain strings pass through unchanged regardless of locale.

import {
  getInterviewerScenario,
  type Locale,
  listExercises,
  pickList,
  pickText,
} from "./content-loader.js";
import type { InterviewerScenario } from "./interviewer.js";

export function getScenario(
  id: string,
  locale: Locale = "en",
): InterviewerScenario | undefined {
  const exercise = getInterviewerScenario(id);
  if (!exercise) return undefined;
  return {
    id: exercise.id,
    locale,
    topic: pickText(exercise.topic, locale),
    persona: pickText(exercise.persona, locale),
    must_explore: pickList(exercise.must_explore, locale),
    opening_message: pickText(exercise.opening_message, locale),
    max_turns: exercise.max_turns,
  };
}

export function listScenarios(locale: Locale = "en"): InterviewerScenario[] {
  return listExercises()
    .filter((ex) => ex.type === "interviewer-chat")
    .map((ex) => ({
      id: ex.id,
      locale,
      topic: pickText(ex.topic, locale),
      persona: pickText(ex.persona, locale),
      must_explore: pickList(ex.must_explore, locale),
      opening_message: pickText(ex.opening_message, locale),
      max_turns: ex.max_turns,
    }));
}
