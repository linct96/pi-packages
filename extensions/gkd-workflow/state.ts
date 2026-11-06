import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const enumOf = <T extends string>(values: T[]) => Type.Unsafe<T>({ type: "string", enum: values });
const phaseSchema = enumOf([
  "ROUTING",
  "PLANNING",
  "AWAITING_APPROVAL",
  "IMPLEMENTING",
  "VERIFYING",
  "COMPLETED",
  "PAUSED",
  "BLOCKED",
  "CANCELLED",
]);
export type Phase = Static<typeof phaseSchema>;
export const reportTextSchema = Type.String({ minLength: 1, maxLength: 16000, pattern: "\\S" });
const stateSchema = Type.Object(
  {
    version: Type.Literal(2),
    taskId: Type.String({ pattern: "^[a-f0-9-]{36}$" }),
    sessionId: Type.String({ minLength: 1 }),
    task: reportTextSchema,
    cwd: Type.String(),
    tools: Type.Array(Type.String(), { maxItems: 256 }),
    route: Type.Union([enumOf(["FAST", "STANDARD"]), Type.Null()]),
    phase: phaseSchema,
    plan: Type.Union([reportTextSchema, Type.Null()]),
    planVersion: Type.Integer({ minimum: 0 }),
    approval: Type.Union([
      Type.Object({ taskId: Type.String(), planVersion: Type.Integer({ minimum: 1 }) }),
      Type.Null(),
    ]),
    retries: Type.Integer({ minimum: 0, maximum: 2 }),
    implementation: Type.String({ maxLength: 16000 }),
    validation: Type.Union([
      Type.Object(
        { passed: Type.Boolean(), summary: reportTextSchema },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    resumePhase: Type.Union([phaseSchema, Type.Null()]),
    reason: Type.String(),
    updatedAt: Type.String(),
  },
  { additionalProperties: false },
);
export type TaskState = Static<typeof stateSchema>;

export const terminal = (phase: Phase) => phase === "COMPLETED" || phase === "CANCELLED";
const transitions: Record<Phase, Phase[]> = {
  ROUTING: ["PLANNING", "IMPLEMENTING", "PAUSED", "BLOCKED", "CANCELLED"],
  PLANNING: ["AWAITING_APPROVAL", "PAUSED", "BLOCKED", "CANCELLED"],
  AWAITING_APPROVAL: ["PLANNING", "IMPLEMENTING", "PAUSED", "BLOCKED", "CANCELLED"],
  IMPLEMENTING: ["PLANNING", "VERIFYING", "PAUSED", "BLOCKED", "CANCELLED"],
  VERIFYING: ["PLANNING", "IMPLEMENTING", "COMPLETED", "PAUSED", "BLOCKED", "CANCELLED"],
  PAUSED: ["ROUTING", "PLANNING", "IMPLEMENTING", "BLOCKED", "CANCELLED"],
  BLOCKED: ["ROUTING", "PLANNING", "IMPLEMENTING", "PAUSED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};
export function transition(
  state: TaskState,
  phase: Phase,
  patch: Partial<TaskState> = {},
): TaskState {
  if (!transitions[state.phase].includes(phase))
    throw new Error(`Illegal GKD transition: ${state.phase} → ${phase}`);
  const next = { ...state, ...patch, phase, updatedAt: new Date().toISOString() };
  validateState(next);
  return next;
}
export function validateState(state: unknown): asserts state is TaskState {
  if (!Value.Check(stateSchema, state)) throw new Error("Invalid GKD state");
  const s = state as TaskState;
  if (s.plan && s.planVersion < 1) throw new Error("Invalid GKD plan version");
  if (
    s.approval &&
    (s.route !== "STANDARD" ||
      !s.plan ||
      s.approval.taskId !== s.taskId ||
      s.approval.planVersion !== s.planVersion)
  )
    throw new Error("Stale GKD approval");
  if (
    ["PLANNING", "AWAITING_APPROVAL", "IMPLEMENTING", "VERIFYING", "COMPLETED"].includes(s.phase) &&
    !s.route
  )
    throw new Error("Missing GKD route");
  if (s.phase === "AWAITING_APPROVAL" && !s.plan) throw new Error("Missing GKD plan");
  if (
    s.route === "STANDARD" &&
    ["IMPLEMENTING", "VERIFYING", "COMPLETED"].includes(s.phase) &&
    !s.approval
  )
    throw new Error("STANDARD plan is not approved");
  if (s.phase === "COMPLETED" && !s.validation?.passed)
    throw new Error("Missing GKD verification report");
}

export function statePath(sessionId: string, taskId: string) {
  if (!/^[a-f0-9-]{36}$/.test(taskId)) throw new Error("Invalid GKD task id");
  return join(
    getAgentDir(),
    "gkd-workflow",
    createHash("sha256").update(sessionId).digest("hex"),
    `${taskId}.json`,
  );
}
export function saveState(state: TaskState) {
  validateState(state);
  const path = statePath(state.sessionId, state.taskId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(state, null, 2) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}
export function loadState(sessionId: string, taskId: string): TaskState {
  const fd = openSync(statePath(sessionId, taskId), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("Invalid GKD state file");
    const raw: unknown = JSON.parse(readFileSync(fd, "utf8"));
    validateState(raw);
    if (raw.sessionId !== sessionId || raw.taskId !== taskId)
      throw new Error("GKD session/task mismatch");
    return raw;
  } finally {
    closeSync(fd);
  }
}
