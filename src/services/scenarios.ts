// Scenario registry. Backed by the filesystem via content-loader — each
// interviewer-chat exercise in anabasis-content/ is a scenario.
//
// This module exists as a thin adapter so chatRouter doesn't import the
// whole content-loader surface, and so the shape returned matches
// InterviewerScenario exactly (which is what services/interviewer.ts
// expects).

import { getInterviewerScenario, listExercises } from "./content-loader.js";
import type { InterviewerScenario } from "./interviewer.js";

export function getScenario(id: string): InterviewerScenario | undefined {
  const exercise = getInterviewerScenario(id);
  if (!exercise) return undefined;
  return {
    id: exercise.id,
    topic: exercise.topic,
    persona: exercise.persona,
    must_explore: exercise.must_explore,
    opening_message: exercise.opening_message,
    max_turns: exercise.max_turns,
  };
}

export function listScenarios(): InterviewerScenario[] {
  return listExercises()
    .filter((ex) => ex.type === "interviewer-chat")
    .map((ex) => ({
      id: ex.id,
      topic: ex.topic,
      persona: ex.persona,
      must_explore: ex.must_explore,
      opening_message: ex.opening_message,
      max_turns: ex.max_turns,
    }));
}
