import { describe, expect, it, vi } from "vitest";
import { createScheduleRunRetry } from "./use-cases.js";
import type { RunRetryWriterInput, RunRetryWriterResult } from "./types.js";

const now = new Date("2026-01-01T00:00:00.000Z");

function fixture() {
  const calls: string[] = [];
  const run = {
    id: "run-1", companyId: "company-1", errorCode: null as string | null,
    scopeKind: "issue" as "issue" | "company", issueId: "issue-1" as string | null,
    contextSnapshot: { issueId: "issue-1" } as Record<string, unknown>,
    resultJson: null as Record<string, unknown> | null,
    scheduledRetryAttempt: null as number | null,
    scheduledRetryReason: null as string | null,
    scheduledRetryAt: null as Date | null,
  };
  const agent = { companyId: "company-1", name: "Agent", adapterType: "codex_local" };
  const retryRun = { ...run, id: "run-2", scheduledRetryAttempt: 1, scheduledRetryAt: new Date(now.getTime() + 30_000) };
  const writer = { scheduleRetry: vi.fn(async (_input: RunRetryWriterInput<typeof run>): Promise<RunRetryWriterResult<typeof run>> => {
    calls.push("writer");
    return { outcome: "scheduled" as const, run: retryRun, reusedExisting: false };
  }) };
  const invokability = { checkAgentInvokability: vi.fn(async () => {
    calls.push("invokability");
    return { invokable: true as const };
  }) };
  const evaluateScheduledRetryGate = vi.fn(async () => {
    calls.push("gate");
    return { allowed: true as const };
  });
  const resolveSessionBeforeForWakeup = vi.fn(async () => {
    calls.push("session");
    return null;
  });
  const resolveResponsibleUserIdForRunContext = vi.fn(async () => {
    calls.push("user");
    return null;
  });
  const isLegacyReconciliationBlocked = vi.fn(async () => {
    calls.push("legacy");
    return false;
  });
  const normalizeRetryContext = vi.fn((context: Record<string, unknown>) => context);
  const scheduleRunRetry = createScheduleRunRetry({
    writer, invokability, evaluateScheduledRetryGate,
    resolveSessionBeforeForWakeup, resolveResponsibleUserIdForRunContext,
    isLegacyReconciliationBlocked, normalizeRetryContext,
    hasConversationContinuationPolicy: () => false,
  });
  const input = { run, agent, now, random: () => 0.5, retryReason: "transient_failure", wakeReason: "transient_failure_retry" };
  return { calls, run, agent, retryRun, writer, invokability, evaluateScheduledRetryGate, resolveSessionBeforeForWakeup, resolveResponsibleUserIdForRunContext, isLegacyReconciliationBlocked, normalizeRetryContext, scheduleRunRetry, input };
}

describe("createScheduleRunRetry", () => {
  it("stops a retry when the provider uses external Dot execution", async () => {
    const test = fixture();
    Object.assign(test.agent, { adapterConfig: { provider: "openai_dot" } });
    const result = await test.scheduleRunRetry(test.input);
    expect(result).toMatchObject({ outcome: "not_scheduled", issueId: "issue-1" });
    expect(test.writer.scheduleRetry).not.toHaveBeenCalled();
  });

  it("uses the source run issue scope when context names a different issue", async () => {
    const test = fixture();
    test.run.contextSnapshot.issueId = "issue-from-context";
    const result = await test.scheduleRunRetry(test.input);
    expect(result.outcome).toBe("scheduled");
    expect(test.writer.scheduleRetry).toHaveBeenCalledWith(expect.objectContaining({
      issueId: "issue-1",
      retryContextSnapshot: expect.objectContaining({ issueId: "issue-1" }),
    }));
  });

  it("does not bind a company retry to an issue from context", async () => {
    const test = fixture();
    test.run.scopeKind = "company";
    test.run.issueId = null;
    const result = await test.scheduleRunRetry(test.input);
    expect(result.outcome).toBe("scheduled");
    expect(test.writer.scheduleRetry).toHaveBeenCalledWith(expect.objectContaining({ issueId: null }));
    const retryContext = test.writer.scheduleRetry.mock.calls[0]?.[0].retryContextSnapshot;
    expect(retryContext).not.toHaveProperty("issueId");
  });

  it("keeps the completion outbox outside the retry ports", async () => {
    const test = fixture();
    test.run.contextSnapshot.chatCompletionDeliveryIds = ["delivery-1"];
    const result = await test.scheduleRunRetry(test.input);
    expect(result).toMatchObject({ outcome: "not_scheduled", errorCode: "chat_completion_outbox_owns_retry", effects: [] });
    expect(test.calls).toEqual([]);
  });
  it("stops at exhaustion before it calls a retry port", async () => {
    const test = fixture();
    test.run.scheduledRetryReason = "interaction_continuation_infra_retry";
    test.run.scheduledRetryAttempt = 2;
    const result = await test.scheduleRunRetry({ ...test.input, retryReason: "interaction_continuation_infra_retry", maxAttempts: 2 });
    expect(result).toMatchObject({ outcome: "retry_exhausted", attempt: 3, maxAttempts: 2,
      effects: [{ kind: "plan_approval_exhaustion_escalated", issueId: "issue-1", attempt: 2, maxAttempts: 2 }] });
    expect(test.calls).toEqual([]);
  });

  it("does not check legacy reconciliation after retry exhaustion", async () => {
    const test = fixture();
    test.run.scheduledRetryReason = "transient_failure";
    test.run.scheduledRetryAttempt = 2;
    const result = await test.scheduleRunRetry({ ...test.input, maxAttempts: 2 });
    expect(result.outcome).toBe("retry_exhausted");
    expect(test.isLegacyReconciliationBlocked).not.toHaveBeenCalled();
  });

  it("stops before invokability when legacy reconciliation is blocked", async () => {
    const test = fixture();
    test.isLegacyReconciliationBlocked.mockImplementationOnce(async () => {
      test.calls.push("legacy");
      return true;
    });
    const result = await test.scheduleRunRetry(test.input);
    expect(result).toMatchObject({ outcome: "not_scheduled", errorCode: "legacy_execution_requires_reconciliation", issueId: "issue-1", effects: [] });
    expect(test.calls).toEqual(["legacy"]);
    expect(test.invokability.checkAgentInvokability).not.toHaveBeenCalled();
    expect(test.writer.scheduleRetry).not.toHaveBeenCalled();
  });

  it("does not call retry ports when legacy reconciliation is blocked", async () => {
    const test = fixture();
    test.isLegacyReconciliationBlocked.mockResolvedValueOnce(true);
    const result = await test.scheduleRunRetry(test.input);
    expect(result.outcome).toBe("not_scheduled");
    expect(test.invokability.checkAgentInvokability).not.toHaveBeenCalled();
    expect(test.writer.scheduleRetry).not.toHaveBeenCalled();
  });

  it("stops when the invokability port denies the agent", async () => {
    const test = fixture();
    test.invokability.checkAgentInvokability.mockImplementationOnce(async () => {
      test.calls.push("invokability");
      return { invokable: false, reason: "paused", invalidOrgChain: false, details: { state: "paused" } } as never;
    });
    const result = await test.scheduleRunRetry(test.input);
    expect(result).toMatchObject({ outcome: "not_scheduled", errorCode: "agent_not_invokable", issueId: "issue-1", effects: [] });
    expect(result.event?.payload).toMatchObject({ reason: "paused", state: "paused" });
    expect(test.calls).toEqual(["legacy", "invokability"]);
  });

  it("stops when the scheduled retry gate denies the run", async () => {
    const test = fixture();
    test.run.errorCode = "workspace_git_scan_timeout";
    test.evaluateScheduledRetryGate.mockImplementationOnce(async () => {
      test.calls.push("gate");
      return { allowed: false, reason: "issue blocked", errorCode: "issue_blocked", issueId: "issue-1", details: { blockers: 1 } } as never;
    });
    const result = await test.scheduleRunRetry(test.input);
    expect(result).toMatchObject({ outcome: "not_scheduled", reason: "issue blocked", errorCode: "issue_blocked", effects: [] });
    expect(result.event?.payload).toMatchObject({ blockers: 1 });
    expect(test.calls).toEqual(["legacy", "invokability", "gate"]);
  });

  it("calls the ports in order and returns the scheduled run", async () => {
    const test = fixture();
    test.run.errorCode = "workspace_git_scan_timeout";
    const result = await test.scheduleRunRetry(test.input);
    expect(test.calls).toEqual(["legacy", "invokability", "gate", "session", "user", "writer"]);
    expect(result).toMatchObject({ outcome: "scheduled", run: test.retryRun, dueAt: test.retryRun.scheduledRetryAt, attempt: 1, maxAttempts: 2, effects: [] });
    expect(test.writer.scheduleRetry).toHaveBeenCalledWith(expect.objectContaining({ run: test.run, agentName: "Agent", issueId: "issue-1", sessionBefore: null,
      retryContextSnapshot: expect.objectContaining({ retryOfRunId: "run-1", scheduledRetryAttempt: 1 }) }));
  });

  it("returns one reporter effect after a plan approval retry", async () => {
    const test = fixture();
    const result = await test.scheduleRunRetry({ ...test.input, retryReason: "interaction_continuation_infra_retry" });
    expect(test.calls).toEqual(["legacy", "invokability", "gate", "session", "user", "writer"]);
    expect(result).toMatchObject({ outcome: "scheduled", effects: [{ kind: "plan_approval_retry_recorded", issueId: "issue-1", retryRunId: "run-2", attempt: 1, maxAttempts: 2 }] });
  });

  it("returns a reused run without a reporter effect", async () => {
    const test = fixture();
    test.writer.scheduleRetry.mockResolvedValueOnce({ outcome: "scheduled", run: test.retryRun, reusedExisting: true });
    const result = await test.scheduleRunRetry({ ...test.input, retryReason: "interaction_continuation_infra_retry" });
    expect(result).toMatchObject({ outcome: "scheduled", reusedExisting: true, effects: [] });
  });
});
