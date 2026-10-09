import type { RetrySchedule } from "../domain/policy.js";

export type RunRetryWriterInput<Run> = {
  companyId: string;
  now: Date;
  run: Run;
  agentName: string;
  retryReason: string;
  wakeReason: string;
  issueId: string | null;
  contextSnapshot: Record<string, unknown>;
  retryContextSnapshot: Record<string, unknown>;
  schedule: RetrySchedule;
  transientRecovery: { errorFamily: string } | null;
  transientRetryNotBefore: Date | null;
  codexTransientFallbackMode: string | null;
  interactionContinuationPayload: Record<string, unknown>;
  workspaceValidationRetryPayload: Record<string, unknown> | null;
  shouldQuarantineWorkspaceForRetry: boolean;
  responsibleUserId: string | null;
  sessionBefore: string | null;
  continuationRetryIdempotencyKey: string | null;
};

export type RunRetryWriterResult<Run> =
  | { outcome: "scheduled"; run: Run; reusedExisting: boolean }
  | {
      outcome: "not_scheduled";
      reason: string;
      errorCode:
        | "issue_not_found"
        | "issue_reassigned"
        | "issue_cancelled"
        | "issue_terminal_status"
        | "issue_not_in_progress"
        | "continuation_user_authorization_missing"
        | "issue_execution_lock_changed";
      issueId: string | null;
      details: Record<string, unknown>;
    };

export type RunRetryInvokabilityInput<Agent> = {
  companyId: string;
  now: Date;
  agent: Agent;
};

export type RunRetryInvokabilityResult =
  | { invokable: true }
  | {
      invokable: false;
      reason: string;
      invalidOrgChain: boolean;
      details: Record<string, unknown>;
    };

export type RunRetryEffect =
  | { kind: "plan_approval_retry_recorded"; issueId: string | null; retryRunId: string; attempt: number; maxAttempts: number }
  | { kind: "plan_approval_exhaustion_escalated"; issueId: string | null; attempt: number; maxAttempts: number };

export type RunRetryRun = {
  id: string;
  companyId: string;
  scopeKind: "company" | "issue";
  issueId: string | null;
  errorCode: string | null;
  contextSnapshot: Record<string, unknown> | null;
  resultJson: Record<string, unknown> | null;
  runnerProfileJson?: Record<string, unknown> | null;
  scheduledRetryAttempt: number | null;
  scheduledRetryReason: string | null;
  scheduledRetryAt: Date | null;
};

export type RunRetryAgent = {
  companyId: string;
  name: string;
  adapterType: string;
  adapterConfig?: Record<string, unknown> | null;
};

export type ScheduleRunRetryInput<Run, Agent> = {
  run: Run;
  agent: Agent;
  now: Date;
  random: () => number;
  retryReason: string;
  wakeReason: string;
  maxAttempts?: number;
  delayMs?: number;
};

export type RunRetryEvent = {
  level: "warn" | "info";
  message: string;
  payload: Record<string, unknown>;
  retryExhaustion?: { retryReason: string; scheduledRetryAttempt: number; maxAttempts: number };
};

export type ScheduleRunRetryOutcome<Run> =
  | { outcome: "not_scheduled"; reason: string; errorCode?: string; issueId: string | null; event?: RunRetryEvent; effects: RunRetryEffect[] }
  | { outcome: "retry_exhausted"; attempt: number; maxAttempts: number; event: RunRetryEvent; effects: RunRetryEffect[] }
  | { outcome: "scheduled"; run: Run; dueAt: Date; attempt: number | null; maxAttempts: number; reusedExisting?: true; event: RunRetryEvent; effects: RunRetryEffect[] };
