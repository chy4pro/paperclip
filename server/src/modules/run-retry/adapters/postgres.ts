import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  type Db,
} from "@paperclipai/db";
import { parseObject } from "../../../adapters/utils.js";
import {
  AI_CONNECTION_BUSY_RETRY_REASON,
  AI_CONNECTION_POOL_WAIT_RETRY_REASON,
  INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
  MAX_TURN_CONTINUATION_RETRY_REASON,
  isNonAssigneeWorkspaceBusyRetry,
} from "../../run-dispatch/index.js";
import type { RunRetryAgentInvokability, RunRetryWriter } from "../application/ports.js";
import type { RunRetryInvokabilityResult, RunRetryWriterResult } from "../application/types.js";

type Run = typeof heartbeatRuns.$inferSelect;
type Agent = typeof agents.$inferSelect;
export type RunRetryAdapterHost = {
  evaluateAgentInvokability: (agent: Agent) => Promise<RunRetryInvokabilityResult>;
  admitExplicitContinuationRetry: (input: {
    db: Db; companyId: string; issueId: string; agentId: string;
    parentRunId: string; successorRunId: string; now: Date;
  }) => Promise<{ previousRunId: string; commentId: string } | null>;
  hasConversationContinuationPolicy: (result: Run["resultJson"]) => boolean;
  conversationContinuationPolicy: string;
  normalizeRetryContext: (context: Record<string, unknown>) => Record<string, unknown>;
  readContinuationAttempt: (value: unknown) => number;
  recordWorkspaceQuarantineActivity: (db: Db, input: {
    companyId: string; agentId: string; runId: string; workspaceId: string;
    details: Record<string, unknown>;
  }) => Promise<void>;
};
const MAX_TURN_CONTINUATION_LIVE_RUN_STATUSES = ["scheduled_retry", "queued", "running"] as const;
const WORKSPACE_VALIDATION_FAILURE_CODE = "workspace_validation_failed";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizeAgentNameKey(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function createPostgresRunRetryAdapter(db: Db, host: RunRetryAdapterHost): RunRetryWriter<Run> & RunRetryAgentInvokability<Agent> {
  return {
    async checkAgentInvokability(input) {
      if (input.companyId !== input.agent.companyId) {
        throw new Error("The agent company does not match the retry company.");
      }
      return host.evaluateAgentInvokability(input.agent);
    },
    async scheduleRetry(input) {
      const {
        companyId, now, run, agentName, retryReason, wakeReason, issueId,
        contextSnapshot, retryContextSnapshot, schedule, transientRecovery,
        transientRetryNotBefore, codexTransientFallbackMode,
        interactionContinuationPayload, workspaceValidationRetryPayload,
        shouldQuarantineWorkspaceForRetry, responsibleUserId, sessionBefore,
        continuationRetryIdempotencyKey,
      } = input;
      if (companyId !== run.companyId) {
        throw new Error("The run company does not match the retry company.");
      }
      return db.transaction(
        async (tx): Promise<RunRetryWriterResult<Run>> => {
          // All automatic failures use the same predecessor claim.
          // A second request uses the existing successor.
          if (
            retryReason !== MAX_TURN_CONTINUATION_RETRY_REASON &&
            retryReason !== INTERACTION_CONTINUATION_INFRA_RETRY_REASON
          ) {
            if (issueId)
              await tx.execute(
                sql`select id from issues where company_id = ${companyId} and id = ${issueId} for update`,
              );
            await tx.execute(
              sql`select id from heartbeat_runs where company_id = ${companyId} and id = ${run.id} for update`,
            );
            const [existing] = await tx
              .select()
              .from(heartbeatRuns)
              .where(
                and(
                  eq(heartbeatRuns.companyId, companyId),
                  eq(heartbeatRuns.retryOfRunId, run.id),
                ),
              )
              .limit(1);
            if (existing)
              return {
                outcome: "scheduled",
                run: existing,
                reusedExisting: true,
              };
          }
          if (retryReason === INTERACTION_CONTINUATION_INFRA_RETRY_REASON) {
            if (issueId) {
              await tx.execute(
                sql`select id from issues where company_id = ${companyId} and id = ${issueId} for update`,
              );
            } else {
              await tx.execute(
                sql`select id from heartbeat_runs where company_id = ${companyId} and id = ${run.id} for update`,
              );
            }

            const existingContinuation = await tx
              .select()
              .from(heartbeatRuns)
              .where(
                and(
                  eq(heartbeatRuns.companyId, companyId),
                  eq(heartbeatRuns.retryOfRunId, run.id),
                  eq(heartbeatRuns.scheduledRetryReason, retryReason),
                  eq(heartbeatRuns.scheduledRetryAttempt, schedule.attempt),
                  inArray(heartbeatRuns.status, [
                    ...MAX_TURN_CONTINUATION_LIVE_RUN_STATUSES,
                  ]),
                  issueId
                    ? sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`
                    : sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' is null`,
                ),
              )
              .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
              .limit(1)
              .then((rows) => rows[0] ?? null);

            if (existingContinuation) {
              if (existingContinuation.wakeupRequestId) {
                const existingWakeup = await tx
                  .select({ coalescedCount: agentWakeupRequests.coalescedCount })
                  .from(agentWakeupRequests)
                  .where(
                    eq(
                      agentWakeupRequests.id,
                      existingContinuation.wakeupRequestId,
                    ),
                  )
                  .then((rows) => rows[0] ?? null);

                await tx
                  .update(agentWakeupRequests)
                  .set({
                    coalescedCount: (existingWakeup?.coalescedCount ?? 0) + 1,
                    updatedAt: now,
                  })
                  .where(
                    eq(
                      agentWakeupRequests.id,
                      existingContinuation.wakeupRequestId,
                    ),
                  );
              }

              return {
                outcome: "scheduled",
                run: existingContinuation,
                reusedExisting: true,
              };
            }
          }

          if (retryReason === MAX_TURN_CONTINUATION_RETRY_REASON) {
            if (issueId) {
              await tx.execute(
                sql`select id from issues where company_id = ${companyId} and id = ${issueId} for update`,
              );
            } else {
              await tx.execute(
                sql`select id from heartbeat_runs where company_id = ${companyId} and id = ${run.id} for update`,
              );
            }

            const existingContinuation = await tx
              .select()
              .from(heartbeatRuns)
              .where(
                and(
                  eq(heartbeatRuns.companyId, companyId),
                  eq(heartbeatRuns.retryOfRunId, run.id),
                  eq(heartbeatRuns.scheduledRetryReason, retryReason),
                  eq(heartbeatRuns.scheduledRetryAttempt, schedule.attempt),
                  inArray(heartbeatRuns.status, [
                    ...MAX_TURN_CONTINUATION_LIVE_RUN_STATUSES,
                  ]),
                  issueId
                    ? sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`
                    : sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' is null`,
                ),
              )
              .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
              .limit(1)
              .then((rows) => rows[0] ?? null);

            if (existingContinuation) {
              if (existingContinuation.wakeupRequestId) {
                const existingWakeup = await tx
                  .select({ coalescedCount: agentWakeupRequests.coalescedCount })
                  .from(agentWakeupRequests)
                  .where(
                    eq(
                      agentWakeupRequests.id,
                      existingContinuation.wakeupRequestId,
                    ),
                  )
                  .then((rows) => rows[0] ?? null);

                await tx
                  .update(agentWakeupRequests)
                  .set({
                    coalescedCount: (existingWakeup?.coalescedCount ?? 0) + 1,
                    updatedAt: now,
                  })
                  .where(
                    eq(
                      agentWakeupRequests.id,
                      existingContinuation.wakeupRequestId,
                    ),
                  );
              }

              return {
                outcome: "scheduled",
                run: existingContinuation,
                reusedExisting: true,
              };
            }

            if (issueId) {
              const lockedIssue = await tx
                .select({
                  id: issues.id,
                  status: issues.status,
                  assigneeAgentId: issues.assigneeAgentId,
                  executionRunId: issues.executionRunId,
                })
                .from(issues)
                .where(
                  and(
                    eq(issues.id, issueId),
                    eq(issues.companyId, companyId),
                  ),
                )
                .then((rows) => rows[0] ?? null);

              if (!lockedIssue) {
                return {
                  outcome: "not_scheduled",
                  reason:
                    "Scheduled max-turn continuation suppressed because the target issue no longer exists",
                  errorCode: "issue_not_found",
                  issueId,
                  details: { issueId },
                };
              }

              if (lockedIssue.assigneeAgentId !== run.agentId) {
                return {
                  outcome: "not_scheduled",
                  reason:
                    "Scheduled max-turn continuation suppressed because issue ownership changed",
                  errorCode: "issue_reassigned",
                  issueId,
                  details: {
                    issueId,
                    previousAssigneeAgentId: run.agentId,
                    currentAssigneeAgentId: lockedIssue.assigneeAgentId,
                  },
                };
              }

              if (
                lockedIssue.status === "cancelled" ||
                lockedIssue.status === "done"
              ) {
                return {
                  outcome: "not_scheduled",
                  reason: `Scheduled max-turn continuation suppressed because issue reached terminal status (${lockedIssue.status})`,
                  errorCode:
                    lockedIssue.status === "cancelled"
                      ? "issue_cancelled"
                      : "issue_terminal_status",
                  issueId,
                  details: { issueId, currentStatus: lockedIssue.status },
                };
              }

              if (lockedIssue.status !== "in_progress") {
                return {
                  outcome: "not_scheduled",
                  reason: `Scheduled max-turn continuation suppressed because issue is no longer in_progress (current status: ${lockedIssue.status})`,
                  errorCode: "issue_not_in_progress",
                  issueId,
                  details: {
                    issueId,
                    currentStatus: lockedIssue.status,
                    requiredStatus: "in_progress",
                  },
                };
              }

              if (lockedIssue.executionRunId !== run.id) {
                return {
                  outcome: "not_scheduled",
                  reason:
                    "Scheduled max-turn continuation suppressed because the issue execution lock belongs to a different run",
                  errorCode: "issue_execution_lock_changed",
                  issueId,
                  details: {
                    issueId,
                    expectedExecutionRunId: run.id,
                    currentExecutionRunId: lockedIssue.executionRunId,
                  },
                };
              }
            }
          }

          if (
            (retryReason === AI_CONNECTION_BUSY_RETRY_REASON || retryReason === AI_CONNECTION_POOL_WAIT_RETRY_REASON) && issueId &&
            !isNonAssigneeWorkspaceBusyRetry(retryReason, contextSnapshot)
          ) {
            // Check the issue lock again after the preflight gate.
            // This check keeps the successor with its issue lock.
            const [lockedIssue] = await tx.select({ executionRunId: issues.executionRunId })
              .from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
            if (lockedIssue?.executionRunId !== run.id) {
              return {
                outcome: "not_scheduled", issueId, errorCode: "issue_execution_lock_changed",
                reason: "Subscription retry suppressed because the task execution lock changed",
                details: { issueId, expectedExecutionRunId: run.id, currentExecutionRunId: lockedIssue?.executionRunId ?? null },
              };
            }
          }

          const scheduledRunId = randomUUID();
          if (contextSnapshot.explicitUserContinuation) {
            const continuation = issueId && retryReason === "transient_failure" ? await host.admitExplicitContinuationRetry({
              db: tx as unknown as Db, companyId: companyId, issueId, agentId: run.agentId,
              parentRunId: run.id, successorRunId: scheduledRunId, now,
            }) : null;
            if (!continuation) return {
              outcome: "not_scheduled", issueId,
              errorCode: "continuation_user_authorization_missing",
              reason: "The automatic retry could not revalidate the original user continuation.",
              details: {},
            };
            retryContextSnapshot.explicitUserContinuation = continuation;
            retryContextSnapshot.previousRunId = continuation.previousRunId;
          }

          const wakeupRequest = await tx
            .insert(agentWakeupRequests)
            .values({
              companyId: companyId,
              agentId: run.agentId,
              source: "automation",
              triggerDetail: "system",
              reason: wakeReason,
              payload: host.normalizeRetryContext(
                {
                  ...(issueId ? { issueId } : {}),
                  retryOfRunId: run.id,
                  ...interactionContinuationPayload,
                  retryReason,
                  ...(transientRecovery
                    ? { errorFamily: transientRecovery.errorFamily }
                    : {}),
                  scheduledRetryAttempt: schedule.attempt,
                  scheduledRetryAt: schedule.dueAt.toISOString(),
                  ...(transientRetryNotBefore
                    ? {
                        transientRetryNotBefore:
                          transientRetryNotBefore.toISOString(),
                      }
                    : {}),
                  ...(transientRecovery?.errorFamily === "provider_quota" &&
                  transientRetryNotBefore
                    ? {
                        providerQuotaRetryNotBefore:
                          transientRetryNotBefore.toISOString(),
                      }
                    : {}),
                  ...(codexTransientFallbackMode
                    ? { codexTransientFallbackMode }
                    : {}),
                },
              ),
              status: "queued",
              requestedByActorType: "system",
              requestedByActorId: null,
              idempotencyKey: continuationRetryIdempotencyKey,
              updatedAt: now,
            })
            .returning()
            .then((rows) => rows[0]);

          const scheduledRun = await tx
            .insert(heartbeatRuns)
            .values({
              id: scheduledRunId,
              companyId: companyId,
              agentId: run.agentId,
              scopeKind: run.scopeKind,
              issueId,
              invocationSource: "automation",
              triggerDetail: "system",
              status: "scheduled_retry",
              wakeupRequestId: wakeupRequest.id,
              contextSnapshot: retryContextSnapshot,
              ...(host.hasConversationContinuationPolicy(run.resultJson)
                ? { resultJson: { conversationContinuation: host.conversationContinuationPolicy } } : {}),
              responsibleUserId,
              sessionIdBefore: sessionBefore,
              retryOfRunId: run.id,
              scheduledRetryAt: schedule.dueAt,
              scheduledRetryAttempt: schedule.attempt,
              scheduledRetryReason: retryReason,
              continuationAttempt: host.readContinuationAttempt(
                retryContextSnapshot.livenessContinuationAttempt,
              ),
              updatedAt: now,
            })
            .returning()
            .then((rows) => rows[0]);

          await tx
            .update(agentWakeupRequests)
            .set({
              runId: scheduledRun.id,
              updatedAt: now,
            })
            .where(eq(agentWakeupRequests.id, wakeupRequest.id));

          let detachWorkspaceFromIssue = false;
          if (issueId && shouldQuarantineWorkspaceForRetry) {
            const issueWorkspace = await tx
              .select({
                id: issues.id,
                companyId: issues.companyId,
                executionWorkspaceId: issues.executionWorkspaceId,
              })
              .from(issues)
              .where(
                and(eq(issues.id, issueId), eq(issues.companyId, companyId)),
              )
              .for("update")
              .then((rows) => rows[0] ?? null);
            const failedExecutionWorkspaceId =
              readNonEmptyString(
                workspaceValidationRetryPayload?.executionWorkspaceId,
              ) ?? readNonEmptyString(issueWorkspace?.executionWorkspaceId);

            if (issueWorkspace && failedExecutionWorkspaceId) {
              const failedWorkspace = await tx
                .select({
                  id: executionWorkspaces.id,
                  companyId: executionWorkspaces.companyId,
                  sourceIssueId: executionWorkspaces.sourceIssueId,
                  status: executionWorkspaces.status,
                  metadata: executionWorkspaces.metadata,
                })
                .from(executionWorkspaces)
                .where(
                  and(
                    eq(executionWorkspaces.id, failedExecutionWorkspaceId),
                    eq(executionWorkspaces.companyId, companyId),
                  ),
                )
                .for("update")
                .then((rows) => rows[0] ?? null);

              const workspaceBelongsToIssue = failedWorkspace
                ? failedWorkspace.sourceIssueId === issueId
                : false;

              if (
                failedWorkspace &&
                workspaceBelongsToIssue &&
                issueWorkspace.executionWorkspaceId === failedExecutionWorkspaceId
              ) {
                const existingMetadata = parseObject(failedWorkspace.metadata);
                const quarantine = {
                  reason: WORKSPACE_VALIDATION_FAILURE_CODE,
                  retryReason,
                  sourceRunId: run.id,
                  retryRunId: scheduledRun.id,
                  issueId,
                  sourceIssueId: failedWorkspace.sourceIssueId ?? null,
                  quarantinedAt: now.toISOString(),
                  workspaceValidation: workspaceValidationRetryPayload ?? {},
                };
                await tx
                  .update(executionWorkspaces)
                  .set({
                    status: "archived",
                    closedAt: now,
                    cleanupEligibleAt: null,
                    cleanupReason: WORKSPACE_VALIDATION_FAILURE_CODE,
                    metadata: {
                      ...existingMetadata,
                      workspaceValidationQuarantine: quarantine,
                    },
                    updatedAt: now,
                  })
                  .where(
                    and(
                      eq(executionWorkspaces.id, failedWorkspace.id),
                      eq(executionWorkspaces.companyId, companyId),
                    ),
                  );

                await host.recordWorkspaceQuarantineActivity(tx as unknown as Db, {
                  companyId, agentId: run.agentId, runId: run.id,
                  workspaceId: failedWorkspace.id, details: quarantine,
                });
                detachWorkspaceFromIssue =
                  issueWorkspace.executionWorkspaceId ===
                  failedExecutionWorkspaceId;
              }
            }
          }

          if (issueId) {
            await tx
              .update(issues)
              .set({
                executionRunId: scheduledRun.id,
                checkoutRunId: sql`case when ${issues.checkoutRunId} = ${run.id} then null else ${issues.checkoutRunId} end`,
                executionAgentNameKey: normalizeAgentNameKey(agentName),
                executionLockedAt: now,
                ...(detachWorkspaceFromIssue
                  ? {
                      executionWorkspaceId: null,
                      executionWorkspacePreference: null,
                    }
                  : {}),
                updatedAt: now,
              })
              .where(
                and(
                  eq(issues.id, issueId),
                  eq(issues.companyId, companyId),
                  eq(issues.executionRunId, run.id),
                ),
              );
          }

          return {
            outcome: "scheduled",
            run: scheduledRun,
            reusedExisting: false,
          };
        },
      );
    },
  };
}
