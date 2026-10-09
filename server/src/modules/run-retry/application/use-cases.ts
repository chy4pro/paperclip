import {
  applyRetryNotBeforeOverride,
  decideBoundedRetrySchedule,
  decideCodexTransientFallbackMode,
  decideHardRetryExclusion,
  isBoundedTransientRetryReason,
} from "../domain/policy.js";
import { accountingForScheduledRetry, executionFailureRetryCount, executionRetryAttemptCount } from "../domain/retry-accounting.js";
import {
  AI_CONNECTION_BUSY_RETRY_REASON,
  AI_CONNECTION_POOL_WAIT_RETRY_REASON,
  INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
  MAX_TURN_CONTINUATION_RETRY_REASON,
  WORKSPACE_BUSY_RETRY_REASON,
  type GateDecision,
} from "../../run-dispatch/index.js";
import type { RunRetryAgentInvokability, RunRetryWriter } from "./ports.js";
import type {
  RunRetryAgent,
  RunRetryRun,
  ScheduleRunRetryInput,
  ScheduleRunRetryOutcome,
} from "./types.js";

function parseObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readTransientRecovery(run: RunRetryRun) {
  const result = parseObject(run.resultJson);
  const errorFamily = readNonEmptyString(result.errorFamily) ?? (
    run.errorCode === "provider_quota" ? "provider_quota"
      : run.errorCode === "codex_transient_upstream" || run.errorCode === "claude_transient_upstream" || run.errorCode === "codex_harness_crash"
        ? "transient_upstream" : null
  );
  if (errorFamily !== "transient_upstream" && errorFamily !== "provider_quota") return null;
  const value = result.retryNotBefore ?? result.transientRetryNotBefore;
  const retryNotBefore = typeof value === "string" || typeof value === "number" || value instanceof Date
    ? new Date(value) : null;
  return {
    errorFamily,
    retryNotBefore: retryNotBefore && !Number.isNaN(retryNotBefore.getTime()) ? retryNotBefore : null,
  };
}

function taskKeyForRetry(context: Record<string, unknown>, issueId: string | null): string | null {
  return readNonEmptyString(context.taskKey) ?? readNonEmptyString(context.taskId) ??
    issueId ??
    (readNonEmptyString(context.wakeSource) === "timer" ? "__heartbeat__" : null);
}

export function createScheduleRunRetry<Run extends RunRetryRun, Agent extends RunRetryAgent>(deps: {
  writer: RunRetryWriter<Run>;
  invokability: RunRetryAgentInvokability<Agent>;
  evaluateScheduledRetryGate: (input: { runId: string; companyId: string; retryReasonOverride: string; now: Date }) => Promise<GateDecision>;
  resolveSessionBeforeForWakeup: (agent: Agent, taskKey: string | null) => Promise<string | null>;
  resolveResponsibleUserIdForRunContext: (run: Run, context: Record<string, unknown>) => Promise<string | null>;
  isLegacyReconciliationBlocked: (run: Run) => Promise<boolean>;
  hasConversationContinuationPolicy: (result: Run["resultJson"]) => boolean;
  normalizeRetryContext: (context: Record<string, unknown>) => Record<string, unknown>;
}) {
  return async (input: ScheduleRunRetryInput<Run, Agent>): Promise<ScheduleRunRetryOutcome<Run>> => {
    const { run, agent, now, retryReason, wakeReason } = input;
    // A retry inherits the durable authorization scope of its source run. Do
    // not promote an untrusted or legacy contextSnapshot.issueId into a new
    // issue binding: that could either violate the FK or misclassify history.
    const issueId = run.scopeKind === "issue" ? run.issueId : null;
    if (parseObject(agent.adapterConfig).provider === "openai_dot" ||
      parseObject(parseObject(parseObject(run.runnerProfileJson).nativeExecutionInput).provider).kind === "openai_dot") {
      return {
        outcome: "not_scheduled",
        reason: "Dot external execution must be reconciled before a new assignment; Paperclip cannot confirm its external stop.",
        issueId,
        effects: [],
      };
    }
    const hardExclusion = decideHardRetryExclusion({
      errorCode: run.errorCode,
      hasChatCompletionDeliveryIds: Array.isArray(run.contextSnapshot?.chatCompletionDeliveryIds) &&
        run.contextSnapshot.chatCompletionDeliveryIds.some((id) => typeof id === "string"),
    });
    if (hardExclusion.excluded) {
      return {
        outcome: "not_scheduled",
        reason: hardExclusion.reason,
        ...("errorCode" in hardExclusion ? { errorCode: hardExclusion.errorCode } : {}),
        issueId,
        effects: [],
      };
    }

    const consumedAttempts = executionRetryAttemptCount(run, retryReason);
    const nextAttempt = consumedAttempts + 1;
    const { maxAttempts, schedule: baseSchedule } = decideBoundedRetrySchedule({
      consumedAttempts,
      maxAttempts: input.maxAttempts,
      delayMs: input.delayMs,
      now,
      random: input.random,
    });
    const transientRecovery = isBoundedTransientRetryReason(retryReason) ? readTransientRecovery(run) : null;
    const codexTransientFallbackMode = decideCodexTransientFallbackMode({
      isCodexLocalAdapter: agent.adapterType === "codex_local",
      isTransientUpstreamErrorFamily: transientRecovery?.errorFamily === "transient_upstream",
      attempt: nextAttempt,
    });
    const transientRetryNotBefore = transientRecovery?.retryNotBefore ?? null;
    const contextSnapshot = parseObject(run.contextSnapshot);

    if (!baseSchedule) {
      const exhaustion = { retryReason, scheduledRetryAttempt: consumedAttempts, maxAttempts };
      return {
        outcome: "retry_exhausted",
        attempt: nextAttempt,
        maxAttempts,
        event: {
          level: "warn",
          message: `Bounded retry exhausted after ${consumedAttempts} scheduled attempts; no further automatic retry will be queued`,
          payload: exhaustion,
          retryExhaustion: exhaustion,
        },
        effects: retryReason === INTERACTION_CONTINUATION_INFRA_RETRY_REASON
          ? [{ kind: "plan_approval_exhaustion_escalated", issueId, attempt: Math.min(consumedAttempts, maxAttempts), maxAttempts }]
          : [],
      };
    }

    if (await deps.isLegacyReconciliationBlocked(run)) {
      return {
        outcome: "not_scheduled",
        reason: "Reconcile the previous execution before retrying; safe provider recovery is unavailable.",
        errorCode: "legacy_execution_requires_reconciliation",
        issueId,
        effects: [],
      };
    }
    if (retryReason !== MAX_TURN_CONTINUATION_RETRY_REASON) {
      const invokability = await deps.invokability.checkAgentInvokability({ companyId: run.companyId, now, agent });
      if (!invokability.invokable) {
        const reason = "Scheduled retry suppressed because the agent is not invokable";
        return {
          outcome: "not_scheduled", reason, errorCode: "agent_not_invokable", issueId, effects: [],
          event: {
            level: "warn", message: reason,
            payload: { retryReason, scheduledRetryAttempt: nextAttempt, maxAttempts,
              reason: invokability.reason, invalidOrgChain: invokability.invalidOrgChain, ...invokability.details },
          },
        };
      }
    }

    const schedule = applyRetryNotBeforeOverride(baseSchedule, transientRetryNotBefore, now);
    const requiresIssueGate =
      run.errorCode === "workspace_git_scan_timeout" || run.errorCode === "workspace_git_scan_saturated" ||
      deps.hasConversationContinuationPolicy(run.resultJson) ||
      retryReason === AI_CONNECTION_BUSY_RETRY_REASON || retryReason === AI_CONNECTION_POOL_WAIT_RETRY_REASON ||
      retryReason === MAX_TURN_CONTINUATION_RETRY_REASON || retryReason === INTERACTION_CONTINUATION_INFRA_RETRY_REASON;
    if (requiresIssueGate) {
      const gate = await deps.evaluateScheduledRetryGate({ runId: run.id, companyId: run.companyId, retryReasonOverride: retryReason, now });
      if (!gate.allowed) {
        return {
          outcome: "not_scheduled", reason: gate.reason, errorCode: gate.errorCode, issueId: gate.issueId, effects: [],
          event: {
            level: "warn", message: gate.reason,
            payload: { retryReason, scheduledRetryAttempt: nextAttempt, maxAttempts, ...gate.details },
          },
        };
      }
    }

    const sessionBefore = await deps.resolveSessionBeforeForWakeup(agent, taskKeyForRetry(contextSnapshot, issueId));
    const interactionContinuationPayload = retryReason === INTERACTION_CONTINUATION_INFRA_RETRY_REASON
      ? {
          mutation: "interaction",
          interactionId: readNonEmptyString(contextSnapshot.interactionId),
          interactionKind: readNonEmptyString(contextSnapshot.interactionKind),
          interactionStatus: readNonEmptyString(contextSnapshot.interactionStatus),
          continuationPolicy: readNonEmptyString(contextSnapshot.continuationPolicy),
        }
      : {};
    const workspaceValidationRetryPayload = retryReason === INTERACTION_CONTINUATION_INFRA_RETRY_REASON && run.errorCode === "workspace_validation_failed"
      ? parseObject(parseObject(run.resultJson).workspaceValidation) : null;
    const shouldQuarantineWorkspaceForRetry = workspaceValidationRetryPayload !== null && Object.keys(workspaceValidationRetryPayload).length > 0;
    const failureRetries = executionFailureRetryCount(run);
    const contextWithoutIssueId = { ...contextSnapshot };
    delete contextWithoutIssueId.issueId;
    const retryContextSnapshot = deps.normalizeRetryContext({
      ...contextWithoutIssueId,
      ...(issueId ? { issueId } : {}),
      executionRetryAccounting: accountingForScheduledRetry(run, retryReason, schedule.attempt),
      retryOfRunId: run.id,
      wakeReason,
      retryReason,
      ...(retryReason === WORKSPACE_BUSY_RETRY_REASON ? { failureRetriesBeforeWorkspaceWait: failureRetries } : {}),
      ...(retryReason === AI_CONNECTION_BUSY_RETRY_REASON || retryReason === AI_CONNECTION_POOL_WAIT_RETRY_REASON
        ? { failureRetriesBeforeAiConnectionWait: failureRetries } : {}),
      ...(shouldQuarantineWorkspaceForRetry ? {
        workspaceValidationRecovery: {
          strategy: "quarantine_failed_workspace_and_retry_clean",
          sourceRunId: run.id,
          reason: readNonEmptyString(workspaceValidationRetryPayload?.reason) ?? "workspace_validation_failed",
          fingerprint: readNonEmptyString(workspaceValidationRetryPayload?.fingerprint),
          failedExecutionWorkspaceId: readNonEmptyString(workspaceValidationRetryPayload?.executionWorkspaceId),
        },
      } : {}),
      ...(transientRecovery ? { errorFamily: transientRecovery.errorFamily } : {}),
      scheduledRetryAttempt: schedule.attempt,
      scheduledRetryAt: schedule.dueAt.toISOString(),
      ...(transientRetryNotBefore ? { transientRetryNotBefore: transientRetryNotBefore.toISOString() } : {}),
      ...(transientRecovery?.errorFamily === "provider_quota" && transientRetryNotBefore
        ? { providerQuotaRetryNotBefore: transientRetryNotBefore.toISOString() } : {}),
      ...(codexTransientFallbackMode ? { codexTransientFallbackMode } : {}),
    });
    const responsibleUserId = await deps.resolveResponsibleUserIdForRunContext(run, retryContextSnapshot);
    const continuationRetryIdempotencyKey = retryReason === MAX_TURN_CONTINUATION_RETRY_REASON
      ? `max-turn-continuation:${run.companyId}:${issueId ?? "no-issue"}:${run.id}:${schedule.attempt}`
      : retryReason === INTERACTION_CONTINUATION_INFRA_RETRY_REASON
        ? `interaction-continuation:${run.companyId}:${issueId ?? "no-issue"}:${run.id}:${schedule.attempt}`
        : null;

    const scheduleResult = await deps.writer.scheduleRetry({
      companyId: run.companyId, now, run, agentName: agent.name, retryReason, wakeReason,
      issueId, contextSnapshot, retryContextSnapshot, schedule, transientRecovery,
      transientRetryNotBefore, codexTransientFallbackMode, interactionContinuationPayload,
      workspaceValidationRetryPayload, shouldQuarantineWorkspaceForRetry, responsibleUserId,
      sessionBefore, continuationRetryIdempotencyKey,
    });
    if (scheduleResult.outcome === "not_scheduled") {
      return {
        outcome: "not_scheduled", reason: scheduleResult.reason, errorCode: scheduleResult.errorCode,
        issueId: scheduleResult.issueId, effects: [],
        event: {
          level: "warn", message: scheduleResult.reason,
          payload: { retryReason, scheduledRetryAttempt: nextAttempt, maxAttempts, ...scheduleResult.details },
        },
      };
    }

    const retryRun = scheduleResult.run;
    const dueAt = retryRun.scheduledRetryAt ? new Date(retryRun.scheduledRetryAt) : schedule.dueAt;
    if (scheduleResult.reusedExisting) {
      return {
        outcome: "scheduled", run: retryRun, dueAt, attempt: retryRun.scheduledRetryAttempt,
        maxAttempts: schedule.maxAttempts, reusedExisting: true, effects: [],
        event: {
          level: "info",
          message: `Reused existing continuation retry ${retryRun.scheduledRetryAttempt}/${schedule.maxAttempts}`,
          payload: {
            retryRunId: retryRun.id, retryReason, idempotencyKey: continuationRetryIdempotencyKey,
            scheduledRetryAttempt: retryRun.scheduledRetryAttempt, scheduledRetryAt: dueAt.toISOString(),
          },
        },
      };
    }
    return {
      outcome: "scheduled", run: retryRun, dueAt, attempt: schedule.attempt, maxAttempts: schedule.maxAttempts,
      effects: retryReason === INTERACTION_CONTINUATION_INFRA_RETRY_REASON
        ? [{ kind: "plan_approval_retry_recorded", issueId, retryRunId: retryRun.id, attempt: schedule.attempt, maxAttempts: schedule.maxAttempts }]
        : [],
      event: {
        level: "warn",
        message: `Scheduled bounded retry ${schedule.attempt}/${schedule.maxAttempts} for ${schedule.dueAt.toISOString()}`,
        payload: {
          retryRunId: retryRun.id, retryReason,
          ...(transientRecovery ? { errorFamily: transientRecovery.errorFamily } : {}),
          scheduledRetryAttempt: schedule.attempt, scheduledRetryAt: schedule.dueAt.toISOString(),
          baseDelayMs: schedule.baseDelayMs, delayMs: schedule.delayMs,
          ...(transientRetryNotBefore ? { transientRetryNotBefore: transientRetryNotBefore.toISOString() } : {}),
          ...(transientRecovery?.errorFamily === "provider_quota" && transientRetryNotBefore
            ? { providerQuotaRetryNotBefore: transientRetryNotBefore.toISOString() } : {}),
          ...(codexTransientFallbackMode ? { codexTransientFallbackMode } : {}),
        },
      },
    };
  };
}
