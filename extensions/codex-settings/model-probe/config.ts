export interface ProbeQuestion {
  id: string;
  question: string;
  answer: string;
}

export interface ProbeConfig {
  enabled: boolean;
  models: string[];
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
    models: ["gpt-6.1-sol"],
    maxAttempts: 3,
    questions: [
      {
        id: "japan-pm",
        question: "不要联网直接回复我现在的日本首相是谁？直接回答名字！",
        answer: "高市早苗",
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
      "Invalid modelProbe configuration: expected enabled:boolean, models:string[] with nonempty model IDs, maxAttempts:positive safe integer, nonempty unique questions with id/question/answer, contains + requireAll, and enabled isolation/restart safeguards",
    );
  if (!object(value) || typeof value.enabled !== "boolean") throw invalid();
  const models = value.models === undefined ? defaults.models : value.models;
  if (!Array.isArray(models) || models.some((id) => typeof id !== "string" || !id.trim()))
    throw invalid();
  const maxAttempts = value.maxAttempts === undefined ? defaults.maxAttempts : value.maxAttempts;
  if (typeof maxAttempts !== "number" || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1)
    throw invalid();
  const questions = value.questions === undefined ? defaults.questions : value.questions;
  if (!Array.isArray(questions) || questions.length === 0) throw invalid();
  const ids = new Set<string>();
  for (const q of questions) {
    if (
      !object(q) ||
      ![q.id, q.question, q.answer].every((s) => typeof s === "string" && normalize(s).length > 0)
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
    enabled: value.enabled,
    models: models.map((id) => id.trim()),
    maxAttempts,
    questions: questions.map((q) => ({ id: q.id, question: q.question, answer: q.answer })),
  };
}
