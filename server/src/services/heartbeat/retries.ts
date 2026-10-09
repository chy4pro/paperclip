import { deriveTaskKeyWithHeartbeatFallback } from "./run-state.js";
import {
  WORKSPACE_VALIDATION_FAILURE_CODE,
  isWorkspaceValidationFailedRun,
  readWorkspaceValidationPayloadFromRun,
} from "./workspaces.js";
import { admitExplicitContinuationRetry } from "../explicit-native-continuation.js";
import {
  CONVERSATION_CONTINUATION_POLICY,
  hasConversationContinuationPolicy,
} from "../conversation-continuation.js";
import { legacyExecutionNeedsReconciliationWithEvidence } from "../legacy-execution-recovery.js";
import { createRunRetry, executionFailureRetryCount, type RunRetryEffect } from "../../modules/run-retry/index.js";
import { WORKSPACE_GIT_SCAN_ERROR_CODES } from "../workspace-git-operation-scheduler.js";
import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  agentWakeupRequests,
  executionWorkspaces,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  HttpError,
  notFound,
} from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { parseObject } from "../../adapters/utils.js";
import { logActivity } from "../activity-log.js";
import { readContinuationAttempt } from "../recovery/index.js";
import { withRecoveryContext } from "../recovery/status-only-context.js";
import {
  MAX_TURN_CONTINUATION_RETRY_REASON,
  WORKSPACE_BUSY_RETRY_REASON,
  AI_CONNECTION_BUSY_RETRY_REASON,
  AI_CONNECTION_POOL_WAIT_RETRY_REASON,
  INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
  INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
  isNonAssigneeWorkspaceBusyRetry,
  isResolvedInteractionContinuationWakeContext,
} from "../../modules/run-dispatch/index.js";

import type { AppendHeartbeatRunEventInput } from "../heartbeat-run-events.js";
import type { evaluateAgentInvokabilityFromDb } from "../agent-invokability.js";
import type { createHeartbeatRunState } from "./run-state.js";
import type { createHeartbeatRunPreparation } from "./run-preparation.js";
import type { createRunDispatch, PostCommitEffect } from "../../modules/run-dispatch/index.js";

type HeartbeatRun = typeof heartbeatRuns.$inferSelect;
type HeartbeatRunState = ReturnType<typeof createHeartbeatRunState>;
type PlanApprovalResumeFailure = {
  run: HeartbeatRun;
  issueId: string | null;
  attempt: number;
  maxAttempts: number;
};

/** The retry module owns scheduling writes; the service owns lifecycle effects. */
export interface HeartbeatRetryDependencies {
  runDispatch: Pick<ReturnType<typeof createRunDispatch>,
    "evaluateScheduledRetryGate" | "promoteDueScheduledRetries" | "promoteScheduledRetry">;
  getAgent: (agentId: string) => Promise<typeof agents.$inferSelect | null | undefined>;
  getRun: (
    runId: string,
    options?: Parameters<HeartbeatRunState["getRun"]>[1],
  ) => Promise<Awaited<ReturnType<HeartbeatRunState["getRun"]>> | null | undefined>;
  resolveSessionBeforeForWakeup: HeartbeatRunState["resolveSessionBeforeForWakeup"];
  resolveResponsibleUserIdForRunContext: ReturnType<typeof createHeartbeatRunPreparation>["resolveResponsibleUserIdForRunContext"];
  getAgentInvokability: (agent: typeof agents.$inferSelect | null | undefined) => ReturnType<typeof evaluateAgentInvokabilityFromDb>;
  appendRunEvent: (run: HeartbeatRun, event: {
    eventType: string;
    stream?: "system" | "stdout" | "stderr";
    level?: "info" | "warn" | "error";
    color?: string;
    message?: string;
    payload?: Record<string, unknown>;
    retryExhaustion?: AppendHeartbeatRunEventInput["retryExhaustion"];
  }) => Promise<unknown>;
  escalatePlanApprovalResumeFailureNeedsAttention: (input: PlanApprovalResumeFailure) => Promise<string | null>;
  recordPlanApprovalResumeFailureRetry: (input: PlanApprovalResumeFailure & { retryRunId: string | null }) => Promise<string | null>;
  setRunStatusIfRunning: (runId: string, status: string, patch?: Partial<typeof heartbeatRuns.$inferInsert>) => Promise<{
    updated: boolean;
    run: HeartbeatRun | null;
  }>;
  setWakeupStatus: (wakeupRequestId: string | null | undefined, status: string, patch?: Partial<typeof agentWakeupRequests.$inferInsert>) => Promise<void>;
  releaseIssueExecutionAndPromote: (run: Pick<HeartbeatRun, "id" | "companyId">) => Promise<unknown>;
  finalizeAgentStatus: (
    agentId: string,
    outcome: "succeeded" | "interrupted" | "failed" | "cancelled" | "timed_out",
    failureReason?: string | null,
    options?: { keepIdleOnFailure?: boolean; wasFirstHeartbeat?: boolean },
  ) => Promise<void>;
  getWorktreeExecutionCutoff: () => Promise<Date | null>;
  applyRunDispatchPostCommitEffects: (effects: PostCommitEffect[]) => void;
  runRetryEffectsApplier?: (run: HeartbeatRun, effects: RunRetryEffect[]) => Promise<void>;
}

export const BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS = [
  30_000, 30_000,
] as const;

const BOUNDED_TRANSIENT_HEARTBEAT_RETRY_JITTER_RATIO = 0;

const BOUNDED_TRANSIENT_HEARTBEAT_RETRY_REASON = "transient_failure";

const BOUNDED_TRANSIENT_HEARTBEAT_RETRY_WAKE_REASON = "transient_failure_retry";

export function isTransientWorkspaceGitScanCode(code: string | null | undefined): boolean {
  return code === WORKSPACE_GIT_SCAN_ERROR_CODES.timeout || code === WORKSPACE_GIT_SCAN_ERROR_CODES.saturated;
}

export const BOUNDED_TRANSIENT_HEARTBEAT_RETRY_MAX_ATTEMPTS =
  BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length;

const INTERACTION_CONTINUATION_INFRA_MAX_ATTEMPTS = 2;

const MAX_TURN_CONTINUATION_LIVE_RUN_STATUSES = [
  "scheduled_retry",
  "queued",
  "running",
] as const;

export const WORKSPACE_BUSY_RETRY_WAKE_REASON = "workspace_busy_retry";

export const WORKSPACE_BUSY_ERROR_CODE = "workspace_busy";

export const WORKSPACE_BUSY_RETRY_BASE_DELAY_MS = 60 * 1000;

export const WORKSPACE_BUSY_RETRY_JITTER_MS = 60 * 1000;

// Preserve the one-hour shared-workspace holder cutoff independently of the
// informational output-silence warnings. Warning sooner must not let another
// run overtake a quiet holder and mutate its shared workspace.
export const WORKSPACE_BUSY_HOLDER_STALE_AFTER_MS = 60 * 60 * 1000;

// Issue-level executionWorkspaceSettings.mode values that unambiguously opt an
// issue's runs out of the shared project workspace, and therefore out of
// shared-workspace serialization ("isolated" is the legacy alias
// parseIssueExecutionWorkspaceSettings normalizes to isolated_workspace). Any
// other value — including agent_default and an absent mode — may still resolve
// to the shared workspace and counts as a holder.
const ISOLATED_EXECUTION_WORKSPACE_MODES = [
  "isolated_workspace",
  "operator_branch",
  "isolated",
] as const;

type CodexTransientFallbackMode =
  | "same_session"
  | "safer_invocation"
  | "fresh_session"
  | "fresh_session_safer_invocation";

export interface SharedWorkspaceHolder {
  runId: string;
  agentId: string;
  issueId: string;
  issueIdentifier: string | null;
}

// Pre-dispatch gate outcome: another running run currently holds the issue's
// shared project workspace. Not a failure — the run is parked as a bounded
// scheduled retry and re-attempted once the holder finishes, so two agents
// never mutate the same working tree concurrently.
export class WorkspaceBusyDeferral extends Error {
  code = WORKSPACE_BUSY_ERROR_CODE;
  holder: SharedWorkspaceHolder;
  projectWorkspaceId: string;
  deferralAttempt: number;
  wasIssueAssignee: boolean;

  constructor(input: {
    holder: SharedWorkspaceHolder;
    projectWorkspaceId: string;
    deferralAttempt: number;
    wasIssueAssignee: boolean;
  }) {
    super(
      `Shared project workspace is busy: run ${input.holder.runId} (issue ${
        input.holder.issueIdentifier ?? input.holder.issueId
      }) is still running`,
    );
    this.name = "WorkspaceBusyDeferral";
    this.holder = input.holder;
    this.projectWorkspaceId = input.projectWorkspaceId;
    this.deferralAttempt = input.deferralAttempt;
    this.wasIssueAssignee = input.wasIssueAssignee;
  }
}

export function isWorkspaceBusyDeferral(
  error: unknown,
): error is WorkspaceBusyDeferral {
  return error instanceof WorkspaceBusyDeferral;
}

export function computeWorkspaceBusyRetryDelayMs(
  random: () => number = Math.random,
) {
  const jitter = Math.min(Math.max(random(), 0), 1);
  return (
    WORKSPACE_BUSY_RETRY_BASE_DELAY_MS +
    Math.floor(jitter * WORKSPACE_BUSY_RETRY_JITTER_MS)
  );
}

function resolveCodexTransientFallbackMode(
  attempt: number,
): CodexTransientFallbackMode {
  if (attempt <= 1) return "same_session";
  if (attempt === 2) return "safer_invocation";
  if (attempt === 3) return "fresh_session";
  return "fresh_session_safer_invocation";
}

export function readHeartbeatRunErrorFamily(
  run: Pick<typeof heartbeatRuns.$inferSelect, "errorCode" | "resultJson">,
) {
  const resultJson = parseObject(run.resultJson);
  const persistedFamily = readNonEmptyString(resultJson.errorFamily);
  if (persistedFamily) return persistedFamily;

  if (run.errorCode === "provider_quota") {
    return "provider_quota";
  }
  if (
    run.errorCode === "codex_transient_upstream" ||
    run.errorCode === "claude_transient_upstream" ||
    run.errorCode === "codex_harness_crash"
  ) {
    return "transient_upstream";
  }
  return null;
}

function readTransientRetryNotBeforeFromRun(
  run: Pick<typeof heartbeatRuns.$inferSelect, "resultJson">,
) {
  const resultJson = parseObject(run.resultJson);
  const value = resultJson.retryNotBefore ?? resultJson.transientRetryNotBefore;
  if (!(
    typeof value === "string" ||
    typeof value === "number" ||
    value instanceof Date
  )) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function readTransientRecoveryContractFromRun(
  run: Pick<typeof heartbeatRuns.$inferSelect, "errorCode" | "resultJson">,
) {
  const errorFamily = readHeartbeatRunErrorFamily(run);
  return errorFamily === "transient_upstream" ||
    errorFamily === "provider_quota"
    ? {
        errorFamily,
        retryNotBefore: readTransientRetryNotBeforeFromRun(run),
      }
    : null;
}

function isSpawnLikeFailureMessage(value: unknown) {
  if (typeof value !== "string") return false;
  return /failed to start command|spawn\b|\bENOENT\b/i.test(value);
}

// A sandbox provider plugin's worker can be briefly down during its own
// restart window (e.g. a rolling deploy of the plugin worker process). Lease
// acquisition fails immediately in that window, but the condition is
// transient and self-healing, so it must be treated as retryable
// infrastructure rather than a terminal setup failure. See
// resolveSandboxProviderPlugin's "worker_unavailable" message in
// environment-runtime.ts (":808"), e.g. 'Sandbox provider "kubernetes" is
// installed via plugin "acme.kubernetes-sandbox-provider", but its worker is
// not running.'
//
// This is anchored on both "is installed via plugin" and "but its worker is
// not running" so it does not also match plugin-environment-driver.ts's
// unrelated, permanent "provider not installed" message ('Sandbox provider
// "X" is not installed or its plugin worker is not running.'), which
// coincidentally contains the same "worker is not running" substring but
// describes a terminal condition that must not be retried.
function isSandboxProviderWorkerUnavailableFailureMessage(value: unknown) {
  if (typeof value !== "string") return false;
  return /sandbox provider .* is installed via plugin .* but its worker is not running/i.test(
    value,
  );
}

function isRetryableInteractionContinuationInfrastructureFailure(
  run: Pick<
    typeof heartbeatRuns.$inferSelect,
    "error" | "errorCode" | "resultJson"
  >,
) {
  if (
    run.errorCode === WORKSPACE_VALIDATION_FAILURE_CODE ||
    run.errorCode === "process_lost"
  ) {
    return true;
  }

  if (run.errorCode !== "adapter_failed" && run.errorCode !== "setup_failed")
    return false;

  const resultJson = parseObject(run.resultJson);
  return (
    isSpawnLikeFailureMessage(run.error) ||
    isSpawnLikeFailureMessage(resultJson.errorMessage) ||
    isSpawnLikeFailureMessage(resultJson.message) ||
    isSandboxProviderWorkerUnavailableFailureMessage(run.error) ||
    isSandboxProviderWorkerUnavailableFailureMessage(resultJson.errorMessage) ||
    isSandboxProviderWorkerUnavailableFailureMessage(resultJson.message)
  );
}

export function computeBoundedTransientHeartbeatRetrySchedule(
  attempt: number,
  now = new Date(),
  random: () => number = Math.random,
) {
  if (!Number.isInteger(attempt) || attempt <= 0) return null;
  const baseDelayMs = BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS[attempt - 1];
  if (typeof baseDelayMs !== "number") return null;
  const sample = Math.min(1, Math.max(0, random()));
  const jitterMultiplier =
    1 + (sample * 2 - 1) * BOUNDED_TRANSIENT_HEARTBEAT_RETRY_JITTER_RATIO;
  const delayMs = Math.max(1_000, Math.round(baseDelayMs * jitterMultiplier));
  return {
    attempt,
    baseDelayMs,
    delayMs,
    dueAt: new Date(now.getTime() + delayMs),
    maxAttempts: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_MAX_ATTEMPTS,
  };
}

export function normalizeAgentNameKey(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Retry persistence uses the service database and explicit lifecycle callbacks. */
export function createHeartbeatRetries(db: Db, dependencies: HeartbeatRetryDependencies) {
  const {
    appendRunEvent,
    escalatePlanApprovalResumeFailureNeedsAttention,
    getAgentInvokability,
    runDispatch,
    resolveSessionBeforeForWakeup,
    resolveResponsibleUserIdForRunContext,
    recordPlanApprovalResumeFailureRetry,
    setRunStatusIfRunning,
    setWakeupStatus,
    getRun,
    getAgent,
    releaseIssueExecutionAndPromote,
    finalizeAgentStatus,
    getWorktreeExecutionCutoff,
    applyRunDispatchPostCommitEffects,
  } = dependencies;

  const normalizeRetryContext = (context: Record<string, unknown>) =>
    withRecoveryContext(context, "normal_model");
  const runRetry = createRunRetry(db, {
    adapterHost: {
      evaluateAgentInvokability: async (agent) => getAgentInvokability(agent),
      admitExplicitContinuationRetry,
      hasConversationContinuationPolicy,
      conversationContinuationPolicy: CONVERSATION_CONTINUATION_POLICY,
      normalizeRetryContext,
      readContinuationAttempt,
      recordWorkspaceQuarantineActivity: async (tx, input) => {
        await logActivity(tx, {
          companyId: input.companyId,
          actorType: "system",
          actorId: "heartbeat",
          agentId: input.agentId,
          runId: input.runId,
          action: "execution_workspace.workspace_validation_quarantined",
          entityType: "execution_workspace",
          entityId: input.workspaceId,
          details: input.details,
        });
      },
    },
    resolveSessionBeforeForWakeup,
    resolveResponsibleUserIdForRunContext,
    evaluateScheduledRetryGate: (input) => runDispatch.evaluateScheduledRetryGate(input),
    isLegacyReconciliationBlocked: (run) => legacyExecutionNeedsReconciliationWithEvidence(db, run),
    normalizeRetryContext,
  });

  async function applyRunRetryEffects(
    run: typeof heartbeatRuns.$inferSelect,
    effects: RunRetryEffect[],
  ) {
    for (const effect of effects) {
      if (effect.kind === "plan_approval_exhaustion_escalated") {
        await escalatePlanApprovalResumeFailureNeedsAttention({
          run,
          issueId: effect.issueId,
          attempt: effect.attempt,
          maxAttempts: effect.maxAttempts,
        }).catch((error) => {
          logger.warn(
            { err: error, runId: run.id, issueId: effect.issueId },
            "failed to escalate exhausted plan-approval resume failure",
          );
        });
      } else {
        await recordPlanApprovalResumeFailureRetry({
          run,
          issueId: effect.issueId,
          retryRunId: effect.retryRunId,
          attempt: effect.attempt,
          maxAttempts: effect.maxAttempts,
        }).catch((error) => {
          logger.warn(
            { err: error, runId: run.id, issueId: effect.issueId, retryRunId: effect.retryRunId },
            "failed to record plan-approval resume retry failure",
          );
        });
      }
    }
  }

  async function scheduleBoundedRetryForRun(
    run: typeof heartbeatRuns.$inferSelect,
    agent: typeof agents.$inferSelect,
    opts?: {
      now?: Date;
      random?: () => number;
      retryReason?: string;
      wakeReason?: string;
      maxAttempts?: number;
      delayMs?: number;
    },
  ) {
    const now = opts?.now ?? new Date();
    const retryReason = opts?.retryReason ?? BOUNDED_TRANSIENT_HEARTBEAT_RETRY_REASON;
    const wakeReason = opts?.wakeReason ?? BOUNDED_TRANSIENT_HEARTBEAT_RETRY_WAKE_REASON;
    const result = await runRetry.scheduleRunRetry({
      run,
      agent,
      now,
      random: opts?.random ?? Math.random,
      retryReason,
      wakeReason,
      maxAttempts: opts?.maxAttempts,
      delayMs: opts?.delayMs,
    });
    if (result.event) {
      await appendRunEvent(run, {
        eventType: "lifecycle",
        stream: "system",
        level: result.event.level,
        message: result.event.message,
        payload: result.event.payload,
        ...(result.event.retryExhaustion
          ? { retryExhaustion: result.event.retryExhaustion }
          : {}),
      });
    }
    await (dependencies.runRetryEffectsApplier ?? applyRunRetryEffects)(run, result.effects);
    if (result.outcome === "not_scheduled") {
      return {
        outcome: "not_scheduled" as const,
        reason: result.reason,
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        issueId: result.issueId,
      };
    }
    if (result.outcome === "retry_exhausted") {
      return {
        outcome: "retry_exhausted" as const,
        attempt: result.attempt,
        maxAttempts: result.maxAttempts,
      };
    }
    return {
      outcome: "scheduled" as const,
      run: result.run,
      dueAt: result.dueAt,
      attempt: result.attempt,
      maxAttempts: result.maxAttempts,
      ...(result.reusedExisting ? { reusedExisting: true as const } : {}),
    };
  }

  // Finds a running heartbeat run (other than the caller's) whose context
  // issue shares the same project workspace, i.e. the run that currently
  // "holds" the shared working tree. Runs that have been silent past
  // WORKSPACE_BUSY_HOLDER_STALE_AFTER_MS do not count — a zombie holder must
  // not park other work forever. This cutoff is independent of informational
  // silence warnings. When isolated workspaces are enabled, holders whose
  // issue explicitly opted into an isolated workspace never touch the shared
  // tree, so they are excluded; a NULL/agent_default mode may resolve to the
  // shared tree and counts as a holder (over-serializing is the safe
  // direction). When the isolated-workspaces experiment is off, every run
  // resolves to the shared tree, so no holder is excluded.
  async function findSharedWorkspaceHolder(input: {
    companyId: string;
    projectWorkspaceId: string;
    excludeIssueId: string;
    excludeRunId: string;
    honorIsolatedWorkspaceModes: boolean;
    now?: Date;
  }): Promise<SharedWorkspaceHolder | null> {
    const staleCutoff = new Date(
      (input.now ?? new Date()).getTime() -
        WORKSPACE_BUSY_HOLDER_STALE_AFTER_MS,
    );
    return await db
      .select({
        runId: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        issueId: sql<string>`${issues.id}::text`,
        issueIdentifier: issues.identifier,
      })
      .from(heartbeatRuns)
      .innerJoin(
        issues,
        and(
          eq(issues.companyId, heartbeatRuns.companyId),
          sql`${issues.id}::text = ${heartbeatRuns.contextSnapshot} ->> 'issueId'`,
        ),
      )
      .where(
        and(
          eq(heartbeatRuns.companyId, input.companyId),
          eq(heartbeatRuns.status, "running"),
          ne(heartbeatRuns.id, input.excludeRunId),
          // Last observed activity: output beats start beats creation. A run
          // that started recently but has not written output yet is live.
          sql`coalesce(${heartbeatRuns.lastOutputAt}, ${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) >= ${staleCutoff.toISOString()}::timestamptz`,
          eq(issues.projectWorkspaceId, input.projectWorkspaceId),
          ne(sql`${issues.id}::text`, input.excludeIssueId),
          ...(input.honorIsolatedWorkspaceModes
            ? [
                or(
                  // Covers both a NULL settings blob and a blob without a mode
                  // key; either may still resolve to the shared workspace.
                  sql`${issues.executionWorkspaceSettings} ->> 'mode' is null`,
                  notInArray(
                    sql`${issues.executionWorkspaceSettings} ->> 'mode'`,
                    [...ISOLATED_EXECUTION_WORKSPACE_MODES],
                  ),
                ),
              ]
            : []),
        ),
      )
      .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  // Credential rotation can briefly contend with a fresh runtime read. Keep
  // the task on its automatic pre-provider retry path while the lock clears.
  async function finalizeAiConnectionBusyDeferral(
    run: typeof heartbeatRuns.$inferSelect,
    error: HttpError,
    wasIssueAssignee: boolean,
  ) {
    const now = new Date();
    const cancelled = await setRunStatusIfRunning(run.id, "cancelled", {
      error: error.message, errorCode: AI_CONNECTION_BUSY_RETRY_REASON, finishedAt: now,
      resultJson: {
        executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false },
        cancellation: {
          source: "control_plane",
          expected: true,
          initiator: { type: "system" },
          reason: "Waiting for shared AI credentials",
          recordedAt: now.toISOString(),
        },
      },
      contextSnapshot: {
        ...parseObject(run.contextSnapshot),
        aiConnectionBusyDeferredWhileAssignee: wasIssueAssignee,
      },
    });
    if (!cancelled.updated) return;
    await setWakeupStatus(run.wakeupRequestId, "cancelled", { finishedAt: now, error: error.message }).catch(() => undefined);
    const cancelledRun = cancelled.run ?? await getRun(run.id);
    const agent = await getAgent(run.agentId);
    let scheduled = false;
    try {
      if (cancelledRun && agent) {
        const retry = await scheduleBoundedRetryForRun(cancelledRun, agent, {
          now, retryReason: AI_CONNECTION_BUSY_RETRY_REASON, wakeReason: "ai_connection_busy_retry",
          maxAttempts: (cancelledRun.scheduledRetryAttempt ?? 0) + 1,
          delayMs: computeWorkspaceBusyRetryDelayMs(),
        });
        scheduled = retry.outcome === "scheduled";
        await appendRunEvent(cancelledRun, {
          eventType: "lifecycle", stream: "system", level: "info",
          message: scheduled ? "Waiting for the shared AI subscription. This task will retry automatically." : "The AI subscription is busy; this task can no longer retry automatically.",
          payload: { retryScheduled: scheduled },
        });
      }
    } finally {
      try {
        if (cancelledRun && !scheduled) await releaseIssueExecutionAndPromote(cancelledRun);
      } finally {
        await finalizeAgentStatus(run.agentId, "cancelled", null, { wasFirstHeartbeat: timerClaimWasFirstHeartbeat(run) });
      }
    }
  }

  // Terminal handling for a WorkspaceBusyDeferral thrown by the pre-dispatch
  // gate: cancel the run (contention is not a failure), schedule a
  // workspace_busy retry, and leave the agent idle. The issue execution lock
  // transfers to the scheduled retry run inside scheduleBoundedRetryForRun, so
  // the issue keeps an active execution path and recovery leaves it alone.
  // Deferral has no attempt ceiling — the retry keeps rescheduling while a
  // live holder exists, and holder staleness (not a counter) is what prevents
  // waiting on a zombie. If no retry could be scheduled (agent no longer
  // invokable), the lock is released so the issue does not strand on a
  // cancelled run.
  async function finalizeWorkspaceBusyDeferral(
    run: typeof heartbeatRuns.$inferSelect,
    deferral: WorkspaceBusyDeferral,
  ) {
    const now = new Date();
    const cancelWrite = await setRunStatusIfRunning(run.id, "cancelled", {
      error: deferral.message,
      errorCode: WORKSPACE_BUSY_ERROR_CODE,
      finishedAt: now,
      resultJson: {
        executionRecovery: {
          kind: "workspace_wait",
          providerWorkStarted: false,
        },
        cancellation: {
          source: "control_plane",
          expected: true,
          initiator: { type: "system" },
          reason: "Waiting for the shared project workspace",
          recordedAt: now.toISOString(),
        },
        workspaceBusy: {
          projectWorkspaceId: deferral.projectWorkspaceId,
          holderRunId: deferral.holder.runId,
          holderIssueId: deferral.holder.issueId,
          deferralAttempt: deferral.deferralAttempt,
        },
      },
      // Recorded on the run (and inherited by the scheduled retry's context)
      // so the retry promotion gate can tell a non-assignee wake — where an
      // assignee mismatch is the expected state — from a reassignment race.
      contextSnapshot: {
        ...parseObject(run.contextSnapshot),
        workspaceBusyDeferredWhileAssignee: deferral.wasIssueAssignee,
      },
    });
    if (!cancelWrite.updated) {
      logger.info(
        { runId: run.id, currentStatus: cancelWrite.run?.status ?? null },
        "skipping workspace-busy deferral finalization because the run already left running state",
      );
      return;
    }
    await setWakeupStatus(run.wakeupRequestId, "cancelled", {
      finishedAt: now,
      error: deferral.message,
    }).catch(() => undefined);

    const cancelledRun =
      cancelWrite.run ?? (await getRun(run.id).catch(() => null));
    const agentRow = await getAgent(run.agentId).catch(() => null);
    let scheduleOutcome: string | null = null;
    if (cancelledRun && agentRow) {
      const scheduleResult = await scheduleBoundedRetryForRun(
        cancelledRun,
        agentRow,
        {
          now,
          retryReason: WORKSPACE_BUSY_RETRY_REASON,
          wakeReason: WORKSPACE_BUSY_RETRY_WAKE_REASON,
          // Always admit the next attempt: workspace-busy deferral is bounded by
          // holder liveness, not by an attempt counter.
          maxAttempts: (cancelledRun.scheduledRetryAttempt ?? 0) + 1,
          delayMs: computeWorkspaceBusyRetryDelayMs(),
        },
      ).catch((scheduleErr) => {
        logger.error(
          { err: scheduleErr, runId: run.id },
          "failed to schedule workspace-busy retry after deferral",
        );
        return null;
      });
      scheduleOutcome = scheduleResult?.outcome ?? null;
    }

    if (cancelledRun) {
      await appendRunEvent(cancelledRun, {
        eventType: "lifecycle",
        stream: "system",
        level: "info",
        message:
          scheduleOutcome === "scheduled"
            ? `Deferred: ${deferral.message}. Retry ${deferral.deferralAttempt + 1} scheduled; the run waits for the workspace to free.`
            : `Deferred: ${deferral.message}. No retry could be scheduled; releasing the issue for other runs.`,
        payload: {
          projectWorkspaceId: deferral.projectWorkspaceId,
          holderRunId: deferral.holder.runId,
          holderIssueId: deferral.holder.issueId,
          deferralAttempt: deferral.deferralAttempt,
          retryScheduled: scheduleOutcome === "scheduled",
        },
      }).catch(() => undefined);
    }

    if (cancelledRun && scheduleOutcome !== "scheduled") {
      await releaseIssueExecutionAndPromote(cancelledRun).catch(
        (releaseErr) => {
          logger.error(
            { err: releaseErr, runId: run.id },
            "failed to release issue execution after workspace-busy deferral",
          );
        },
      );
    }

    await finalizeAgentStatus(run.agentId, "cancelled", null, {
      wasFirstHeartbeat: timerClaimWasFirstHeartbeat(run),
    }).catch(() => undefined);
  }

  async function scheduleInteractionContinuationInfrastructureRetryIfEligible(
    run: typeof heartbeatRuns.$inferSelect,
    agent: typeof agents.$inferSelect,
  ) {
    if (!run.wakeupRequestId) return null;
    if (!isResolvedInteractionContinuationWakeContext(run.contextSnapshot))
      return null;
    if (!isRetryableInteractionContinuationInfrastructureFailure(run)) {
      const context = parseObject(run.contextSnapshot);
      const issueId = readNonEmptyString(context.issueId);
      await escalatePlanApprovalResumeFailureNeedsAttention({
        run,
        issueId,
        attempt: Math.min(
          run.scheduledRetryAttempt ??
            INTERACTION_CONTINUATION_INFRA_MAX_ATTEMPTS,
          INTERACTION_CONTINUATION_INFRA_MAX_ATTEMPTS,
        ),
        maxAttempts: INTERACTION_CONTINUATION_INFRA_MAX_ATTEMPTS,
      }).catch((error) => {
        logger.warn(
          { err: error, runId: run.id, issueId },
          "failed to escalate non-retryable plan-approval resume failure",
        );
      });
      return null;
    }

    return scheduleBoundedRetryForRun(run, agent, {
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      maxAttempts: INTERACTION_CONTINUATION_INFRA_MAX_ATTEMPTS,
    });
  }

  async function promoteDueScheduledRetries(now = new Date()) {
    const cutoff = await getWorktreeExecutionCutoff();
    const result = await runDispatch.promoteDueScheduledRetries({
      now,
      cutoff,
    });
    applyRunDispatchPostCommitEffects(result.postCommitEffects);
    return { promoted: result.promoted, runIds: result.runIds };
  }

  async function getIssueRetryRun(
    companyId: string,
    issueId: string,
    statuses: Array<"scheduled_retry" | "queued" | "running" | "cancelled">,
  ) {
    if (statuses.length === 0) return null;
    return db
      .select({
        run: heartbeatRuns,
        agentName: agents.name,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, statuses),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
          sql`${heartbeatRuns.retryOfRunId} is not null`,
        ),
      )
      .orderBy(
        desc(heartbeatRuns.updatedAt),
        desc(heartbeatRuns.createdAt),
        desc(heartbeatRuns.id),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  function summarizeIssueScheduledRetryRun(row: {
    run: typeof heartbeatRuns.$inferSelect;
    agentName: string | null;
  }) {
    return {
      runId: row.run.id,
      status: row.run.status as
        "scheduled_retry" | "queued" | "running" | "cancelled",
      agentId: row.run.agentId,
      agentName: row.agentName,
      retryOfRunId: row.run.retryOfRunId,
      scheduledRetryAt: row.run.scheduledRetryAt,
      scheduledRetryAttempt: row.run.scheduledRetryAttempt,
      scheduledRetryReason: row.run.scheduledRetryReason,
      error: row.run.error,
      errorCode: row.run.errorCode,
    };
  }

  async function retryScheduledRetryNow(input: {
    issueId: string;
    actor?: {
      actorType?: "user" | "agent" | "system";
      actorId?: string | null;
    };
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const issue = await db
      .select({ id: issues.id, companyId: issues.companyId })
      .from(issues)
      .where(eq(issues.id, input.issueId))
      .then((rows) => rows[0] ?? null);
    if (!issue) throw notFound("Issue not found");

    const scheduled = await getIssueRetryRun(issue.companyId, issue.id, [
      "scheduled_retry",
    ]);
    if (!scheduled) {
      const alreadyPromoted = await getIssueRetryRun(
        issue.companyId,
        issue.id,
        ["queued", "running"],
      );
      if (alreadyPromoted) {
        return {
          outcome: "already_promoted" as const,
          message: "Scheduled retry was already promoted",
          scheduledRetry: summarizeIssueScheduledRetryRun(alreadyPromoted),
        };
      }
      return {
        outcome: "no_scheduled_retry" as const,
        message: "No live scheduled retry exists for this issue",
        scheduledRetry: null,
      };
    }

    const contextSnapshot = {
      ...parseObject(scheduled.run.contextSnapshot),
      scheduledRetryAt: now.toISOString(),
      retryNowRequestedAt: now.toISOString(),
      retryNowRequestedByActorType: input.actor?.actorType ?? null,
      retryNowRequestedByActorId: input.actor?.actorId ?? null,
    };

    const updated = await db.transaction(async (tx) => {
      const row = await tx
        .update(heartbeatRuns)
        .set({
          scheduledRetryAt: now,
          contextSnapshot,
          updatedAt: now,
        })
        .where(
          and(
            eq(heartbeatRuns.id, scheduled.run.id),
            eq(heartbeatRuns.status, "scheduled_retry"),
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!row) return null;

      if (row.wakeupRequestId) {
        const wakeupPayload = {
          ...parseObject(
            await tx
              .select({ payload: agentWakeupRequests.payload })
              .from(agentWakeupRequests)
              .where(eq(agentWakeupRequests.id, row.wakeupRequestId))
              .then((rows) => rows[0]?.payload ?? null),
          ),
          scheduledRetryAt: now.toISOString(),
          retryNowRequestedAt: now.toISOString(),
        };
        await tx
          .update(agentWakeupRequests)
          .set({
            payload: wakeupPayload,
            updatedAt: now,
          })
          .where(eq(agentWakeupRequests.id, row.wakeupRequestId));
      }

      return row;
    });

    if (!updated) {
      const alreadyPromoted = await getIssueRetryRun(
        issue.companyId,
        issue.id,
        ["queued", "running"],
      );
      if (alreadyPromoted) {
        return {
          outcome: "already_promoted" as const,
          message: "Scheduled retry was already promoted",
          scheduledRetry: summarizeIssueScheduledRetryRun(alreadyPromoted),
        };
      }
      return {
        outcome: "no_scheduled_retry" as const,
        message: "No live scheduled retry exists for this issue",
        scheduledRetry: null,
      };
    }

    await appendRunEvent(updated, {
      eventType: "lifecycle",
      stream: "system",
      level: "info",
      message: "Scheduled retry was requested to run now",
      payload: {
        issueId: issue.id,
        scheduledRetryAttempt: updated.scheduledRetryAttempt,
        scheduledRetryAt: updated.scheduledRetryAt
          ? new Date(updated.scheduledRetryAt).toISOString()
          : null,
        scheduledRetryReason: updated.scheduledRetryReason,
        requestedByActorType: input.actor?.actorType ?? null,
        requestedByActorId: input.actor?.actorId ?? null,
      },
    });

    const promotion = await runDispatch.promoteScheduledRetry({
      runId: updated.id,
      companyId: updated.companyId,
      now,
    });
    if (promotion.outcome === "promoted") {
      applyRunDispatchPostCommitEffects(promotion.postCommitEffects);
    }
    // Promotion can preserve this row as a cleanup wait. Read that exact run,
    // not an older cancelled retry or the pre-promotion schedule.
    const currentRun = await getRun(updated.id);
    const scheduledRetry = currentRun
      ? summarizeIssueScheduledRetryRun({
          run: currentRun,
          agentName: scheduled.agentName,
        })
      : null;

    if (currentRun?.status === "scheduled_retry") {
      return {
        outcome: "waiting" as const,
        message: parseObject(currentRun.resultJson?.executionWait).cause === "execution_owner_active"
          ? "Waiting for execution cleanup. Paperclip will retry automatically once cleanup finishes."
          : "The retry remains scheduled. Paperclip will check again at the scheduled time.",
        scheduledRetry,
      };
    }

    if (promotion.outcome === "promoted") {
      return {
        outcome: "promoted" as const,
        message: "Scheduled retry was promoted to the queued run pool",
        scheduledRetry,
      };
    }
    if (promotion.outcome === "gate_suppressed") {
      return {
        outcome: "gate_suppressed" as const,
        message: promotion.reason,
        scheduledRetry,
      };
    }
    if (currentRun && ["queued", "running"].includes(currentRun.status)) {
      return {
        outcome: "already_promoted" as const,
        message: "Scheduled retry was already promoted",
        scheduledRetry,
      };
    }
    return {
      outcome: "no_scheduled_retry" as const,
      message: "No live scheduled retry exists for this issue",
      scheduledRetry: null,
    };
  }

  function timerClaimWasFirstHeartbeat(
    run: Pick<typeof heartbeatRuns.$inferSelect, "contextSnapshot">,
  ): true | undefined {
    return parseObject(run.contextSnapshot).timerClaimWasFirstHeartbeat === true
      ? true
      : undefined;
  }

  return {
    scheduleBoundedRetryForRun,
    timerClaimWasFirstHeartbeat,
    scheduleInteractionContinuationInfrastructureRetryIfEligible,
    findSharedWorkspaceHolder,
    finalizeAiConnectionBusyDeferral,
    finalizeWorkspaceBusyDeferral,
    promoteDueScheduledRetries,
    retryScheduledRetryNow,

    scheduleBoundedRetry: async (
      runId: string,
      opts?: {
        now?: Date;
        random?: () => number;
        retryReason?: string;
        wakeReason?: string;
        maxAttempts?: number;
        delayMs?: number;
      },
    ) => {
      const run = await getRun(runId, { unsafeFullResultJson: true });
      if (!run) return { outcome: "missing_run" as const };
      const agent = await getAgent(run.agentId);
      if (!agent) return { outcome: "missing_agent" as const };
      return scheduleBoundedRetryForRun(run, agent, opts);
    },
  };
}
