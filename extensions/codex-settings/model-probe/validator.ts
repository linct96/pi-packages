import { normalize, type ProbeQuestion } from "./config.ts";

export function validateAnswer(question: ProbeQuestion, actual: string) {
  const passed = normalize(actual).includes(normalize(question.answer));
  return {
    questionId: question.id,
    actual,
    passed,
    reason: passed ? undefined : actual.trim() ? "answer_mismatch" : "empty_answer",
  };
}
