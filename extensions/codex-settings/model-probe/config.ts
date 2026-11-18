export interface ProbeQuestion {
  id: string;
  question: string;
  answer: string;
  models: string[];
}

export interface ProbeConfig {
  enabled: boolean;
  maxAttempts: number;
  questions: ProbeQuestion[];
  validation: { mode: "contains"; requireAll: true };
  isolation: { disableTools: true; clearSystemPrompt: true };
  onFailure: { confirmRestart: true };
}

export function normalize(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, "").trim();
}

export function parseProbeConfig(value: unknown): ProbeConfig {
  const defaults: ProbeConfig = {
    enabled: false,
    maxAttempts: 3,
    questions: [
      {
        id: "fable5-release-date",
        question: "不要联网直接回复我fable5是什么时候出的，直接回复我日期，使用yyyy-mm-dd格式",
        answer: "2026-06-09",
        models: ["gpt-6.2-sol"],
      },
    ],
    validation: { mode: "contains", requireAll: true },
    isolation: { disableTools: true, clearSystemPrompt: true },
    onFailure: { confirmRestart: true },
  };
  if (value === undefined) return defaults;
  const object = (input: unknown): input is Record<string, unknown> =>
    !!input && typeof input === "object" && !Array.isArray(input);
  const invalid = () =>
    new Error(
      "Invalid modelProbe configuration: expected enabled:boolean, maxAttempts:positive safe integer, optional questions array with unique IDs, nonempty id/question/answer and a nonempty models:string[] on each question, contains + requireAll, and enabled isolation/restart safeguards",
    );
  if (!object(value) || typeof value.enabled !== "boolean") throw invalid();
  if ("models" in value)
    throw new Error(
      "Invalid modelProbe configuration: move the top-level models list to each question.",
    );
  const maxAttempts = value.maxAttempts === undefined ? defaults.maxAttempts : value.maxAttempts;
  if (typeof maxAttempts !== "number" || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1)
    throw invalid();
  const questions = value.questions === undefined ? defaults.questions : value.questions;
  if (!Array.isArray(questions)) throw invalid();
  const ids = new Set<string>();
  for (const q of questions) {
    if (
      !object(q) ||
      ![q.id, q.question, q.answer].every(
        (s) => typeof s === "string" && normalize(s).length > 0,
      ) ||
      !Array.isArray(q.models) ||
      q.models.length === 0 ||
      q.models.some((id) => typeof id !== "string" || !id.trim())
    )
      throw invalid();
    if (ids.has(q.id as string)) throw invalid();
    ids.add(q.id as string);
  }
  for (const [key, expected] of Object.entries({
    validation: defaults.validation,
    isolation: defaults.isolation,
    onFailure: defaults.onFailure,
  })) {
    const actual = value[key];
    if (actual === undefined) continue;
    if (!object(actual) || Object.entries(expected).some(([k, v]) => actual[k] !== v))
      throw invalid();
  }
  return {
    ...defaults,
    enabled: value.enabled && questions.length > 0,
    maxAttempts,
    questions: questions.map((q) => ({
      id: q.id,
      question: q.question,
      answer: q.answer,
      models: q.models.map((id: string) => id.trim()),
    })),
  };
}
