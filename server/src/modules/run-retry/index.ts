import { agents, heartbeatRuns, type Db } from "@paperclipai/db";
import type { GateDecision } from "../run-dispatch/index.js";
import { createPostgresRunRetryAdapter } from "./adapters/postgres.js";
import type { RunRetryAdapterHost } from "./adapters/postgres.js";
import { createScheduleRunRetry } from "./application/use-cases.js";
import type { RunRetryAgentInvokability, RunRetryWriter } from "./application/ports.js";

type Run = typeof heartbeatRuns.$inferSelect;
type Agent = typeof agents.$inferSelect;

export type RunRetryDeps = {
  adapterHost: RunRetryAdapterHost;
  resolveSessionBeforeForWakeup: (agent: Agent, taskKey: string | null) => Promise<string | null>;
  resolveResponsibleUserIdForRunContext: (run: Run, context: Record<string, unknown>) => Promise<string | null>;
  evaluateScheduledRetryGate: (input: { runId: string; companyId: string; retryReasonOverride: string; now: Date }) => Promise<GateDecision>;
  isLegacyReconciliationBlocked: (run: Run) => Promise<boolean>;
  normalizeRetryContext: (context: Record<string, unknown>) => Record<string, unknown>;
  adapter?: RunRetryWriter<Run> & RunRetryAgentInvokability<Agent>;
};

export function createRunRetry(db: Db, deps: RunRetryDeps) {
  const adapter = deps.adapter ?? createPostgresRunRetryAdapter(db, deps.adapterHost);
  return {
    scheduleRunRetry: createScheduleRunRetry({
      writer: adapter,
      invokability: adapter,
      evaluateScheduledRetryGate: deps.evaluateScheduledRetryGate,
      isLegacyReconciliationBlocked: deps.isLegacyReconciliationBlocked,
      hasConversationContinuationPolicy: deps.adapterHost.hasConversationContinuationPolicy,
      normalizeRetryContext: deps.normalizeRetryContext,
      resolveSessionBeforeForWakeup: deps.resolveSessionBeforeForWakeup,
      resolveResponsibleUserIdForRunContext: deps.resolveResponsibleUserIdForRunContext,
    }),
  };
}

export type { RunRetryEffect } from "./application/types.js";
export {
  accountingForScheduledRetry,
  executionFailureRetryCount,
  executionRetryAccounting,
  executionRetryAttemptCount,
} from "./domain/retry-accounting.js";
export type { ExecutionRetryAccounting } from "./domain/retry-accounting.js";

// The run-retry module's public seam. Code outside this module imports only
// from this file, never from a file inside domain/, application/, or
// adapters/ directly.
export {
  applyRetryNotBeforeOverride,
  BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS,
  BOUNDED_TRANSIENT_HEARTBEAT_RETRY_JITTER_RATIO,
  BOUNDED_TRANSIENT_HEARTBEAT_RETRY_MAX_ATTEMPTS,
  BOUNDED_TRANSIENT_HEARTBEAT_RETRY_REASON,
  BOUNDED_TRANSIENT_HEARTBEAT_RETRY_WAKE_REASON,
  computeBoundedTransientHeartbeatRetrySchedule,
  decideBoundedRetrySchedule,
  decideCodexTransientFallbackMode,
  decideHardRetryExclusion,
  isBoundedTransientRetryReason,
  resolveCodexTransientFallbackMode,
} from "./domain/policy.js";
export type {
  BoundedRetryScheduleDecision,
  BoundedRetryScheduleInput,
  CodexTransientFallbackFacts,
  CodexTransientFallbackMode,
  HardRetryExclusionDecision,
  HardRetryExclusionFacts,
  RetrySchedule,
} from "./domain/policy.js";
