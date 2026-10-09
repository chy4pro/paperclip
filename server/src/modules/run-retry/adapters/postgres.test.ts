import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../../__tests__/helpers/embedded-postgres.js";
import { createPostgresRunRetryAdapter, type RunRetryAdapterHost } from "./postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping run-retry adapter tests: ${support.reason ?? "embedded Postgres is unavailable"}`);
}

describePostgres("run-retry postgres adapter", () => {
  let db!: ReturnType<typeof createDb>;
  let postgres: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const now = new Date("2026-04-20T12:00:00.000Z");

  function makeAdapter(recordWorkspaceQuarantineActivity: RunRetryAdapterHost["recordWorkspaceQuarantineActivity"] = async () => {}) {
    const host: RunRetryAdapterHost = {
      evaluateAgentInvokability: async (agent) => agent.status === "active"
        ? { invokable: true }
        : { invokable: false, reason: agent.status, invalidOrgChain: false, details: {} },
      admitExplicitContinuationRetry: async () => null,
      hasConversationContinuationPolicy: () => false,
      conversationContinuationPolicy: "continue_conversation_v1",
      normalizeRetryContext: (context) => context,
      readContinuationAttempt: () => 0,
      recordWorkspaceQuarantineActivity,
    };
    return createPostgresRunRetryAdapter(db, host);
  }

  beforeAll(async () => {
    postgres = await startEmbeddedPostgresTestDatabase("paperclip-run-retry-adapter-");
    db = createDb(postgres.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.execute(sql`drop trigger if exists fail_retry_issue_update on issues`);
    await db.execute(sql`drop function if exists fail_retry_issue_update()`);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await postgres?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Retry Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedSource() {
    const { companyId, agentId } = await seedCompany();
    const runId = randomUUID();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Retry fixture",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      status: "failed",
      finishedAt: now,
      scopeKind: "issue",
      issueId,
      contextSnapshot: { issueId },
    });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    if (!run) throw new Error("The source run is missing.");
    return { companyId, agentId, runId, issueId, run };
  }

  async function seedWorkspace(source: Awaited<ReturnType<typeof seedSource>>) {
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId: source.companyId, name: "Project", status: "in_progress" });
    await db.insert(executionWorkspaces).values({
      id: workspaceId, companyId: source.companyId, projectId, sourceIssueId: source.issueId,
      mode: "isolated_workspace", strategyType: "git_worktree", name: "failed-workspace",
      status: "active", cwd: "/workspace/failed-workspace", baseRef: "origin/master",
      branchName: "failed-workspace", providerType: "git_worktree", providerRef: "/workspace/failed-workspace",
      metadata: { existing: true },
    });
    await db.update(issues).set({ projectId, executionWorkspaceId: workspaceId }).where(eq(issues.id, source.issueId));
    return workspaceId;
  }

  function writerInput(source: Awaited<ReturnType<typeof seedSource>>, overrides: Record<string, unknown> = {}) {
    return {
      companyId: source.companyId,
      now,
      run: source.run,
      agentName: "Retry Agent",
      retryReason: "transient_failure",
      wakeReason: "transient_failure_retry",
      issueId: source.issueId,
      contextSnapshot: { issueId: source.issueId },
      retryContextSnapshot: { issueId: source.issueId, retryOfRunId: source.runId },
      schedule: { attempt: 1, baseDelayMs: 30_000, delayMs: 30_000, dueAt: new Date(now.getTime() + 30_000), maxAttempts: 2 },
      transientRecovery: null,
      transientRetryNotBefore: null,
      codexTransientFallbackMode: null,
      interactionContinuationPayload: {},
      workspaceValidationRetryPayload: null,
      shouldQuarantineWorkspaceForRetry: false,
      responsibleUserId: null,
      sessionBefore: null,
      continuationRetryIdempotencyKey: null,
      ...overrides,
    };
  }

  it("creates one retry run and one wake request", async () => {
    const source = await seedSource();
    const result = await makeAdapter().scheduleRetry(writerInput(source));
    expect(result.outcome).toBe("scheduled");
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, source.runId));
    expect(runs).toHaveLength(1);
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.runId, runs[0]!.id));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.status).toBe("queued");
  });

  it("copies the source run scope and issue to the retry run", async () => {
    const source = await seedSource();
    const result = await makeAdapter().scheduleRetry(writerInput(source));
    expect(result.outcome).toBe("scheduled");
    const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, source.runId));
    expect(retry).toMatchObject({ scopeKind: "issue", issueId: source.issueId });
  });

  it("checks agent invokability for the retry company", async () => {
    const source = await seedSource();
    const adapter = makeAdapter();
    const [agent] = await db.select().from(agents).where(eq(agents.id, source.agentId));
    if (!agent) throw new Error("The agent is missing.");
    expect(await adapter.checkAgentInvokability({ companyId: source.companyId, now, agent })).toMatchObject({ invokable: true });
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, source.agentId));
    const [pausedAgent] = await db.select().from(agents).where(eq(agents.id, source.agentId));
    if (!pausedAgent) throw new Error("The agent is missing.");
    expect(await adapter.checkAgentInvokability({ companyId: source.companyId, now, agent: pausedAgent }))
      .toMatchObject({ invokable: false, reason: "paused" });
  });

  it("rejects an agent from another company without changing the agent", async () => {
    const source = await seedSource();
    const other = await seedCompany();
    const [agent] = await db.select().from(agents).where(eq(agents.id, source.agentId));
    if (!agent) throw new Error("The agent is missing.");

    await expect(makeAdapter().checkAgentInvokability({ companyId: other.companyId, now, agent }))
      .rejects.toThrow("The agent company does not match the retry company.");
    expect(await db.select().from(agents).where(eq(agents.id, source.agentId))).toEqual([agent]);
  });

  it("rejects a run from another company before it creates a retry or quarantines a workspace", async () => {
    const source = await seedSource();
    const other = await seedCompany();
    const workspaceId = await seedWorkspace(source);
    const [workspaceBefore] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId));
    const [issueBefore] = await db.select().from(issues).where(eq(issues.id, source.issueId));

    await expect(makeAdapter().scheduleRetry(writerInput(source, {
      companyId: other.companyId,
      workspaceValidationRetryPayload: { executionWorkspaceId: workspaceId, reason: "invalid_branch" },
      shouldQuarantineWorkspaceForRetry: true,
    }))).rejects.toThrow("The run company does not match the retry company.");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, source.runId))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, source.agentId))).toHaveLength(0);
    expect(await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId))).toEqual([workspaceBefore]);
    expect(await db.select().from(issues).where(eq(issues.id, source.issueId))).toEqual([issueBefore]);
  });

  it("reuses a generic successor for the same company and predecessor", async () => {
    const source = await seedSource();
    const adapter = makeAdapter();
    const first = await adapter.scheduleRetry(writerInput(source));
    const second = await adapter.scheduleRetry(writerInput(source, { retryReason: "other_reason" }));
    expect(first.outcome).toBe("scheduled");
    expect(second).toMatchObject({ outcome: "scheduled", reusedExisting: true });
    if (first.outcome === "scheduled" && second.outcome === "scheduled") expect(second.run.id).toBe(first.run.id);
  });

  it("coalesces a live continuation wake request", async () => {
    const source = await seedSource();
    const adapter = makeAdapter();
    const input = writerInput(source, { retryReason: "interaction_continuation_infra_retry" });
    const first = await adapter.scheduleRetry(input);
    const second = await adapter.scheduleRetry(input);
    expect(second).toMatchObject({ outcome: "scheduled", reusedExisting: true });
    if (first.outcome !== "scheduled") throw new Error("The first retry was not scheduled.");
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, first.run.wakeupRequestId!));
    expect(wake?.coalescedCount).toBe(1);
  });

  it("does not reuse another company's successor", async () => {
    const source = await seedSource();
    const other = await seedCompany();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(), companyId: other.companyId, agentId: other.agentId,
      status: "failed", retryOfRunId: source.runId,
    });
    const result = await makeAdapter().scheduleRetry(writerInput(source));
    expect(result).toMatchObject({ outcome: "scheduled", reusedExisting: false });
  });

  it("requires admission for an explicit user continuation", async () => {
    const source = await seedSource();
    const result = await makeAdapter().scheduleRetry(writerInput(source, {
      contextSnapshot: { issueId: source.issueId, explicitUserContinuation: { previousRunId: randomUUID(), commentId: randomUUID() } },
    }));
    expect(result).toMatchObject({ outcome: "not_scheduled", errorCode: "continuation_user_authorization_missing" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, source.runId))).toHaveLength(0);
  });

  it("quarantines the failed workspace and detaches it from the issue", async () => {
    const source = await seedSource();
    const workspaceId = await seedWorkspace(source);
    const result = await makeAdapter().scheduleRetry(writerInput(source, {
      workspaceValidationRetryPayload: { executionWorkspaceId: workspaceId, reason: "invalid_branch" },
      shouldQuarantineWorkspaceForRetry: true,
    }));
    expect(result.outcome).toBe("scheduled");
    const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId));
    const [issue] = await db.select().from(issues).where(eq(issues.id, source.issueId));
    expect(workspace?.status).toBe("archived");
    expect(issue?.executionWorkspaceId).toBeNull();
  });

  it("rolls back workspace quarantine and the retry when the activity write fails", async () => {
    const source = await seedSource();
    const workspaceId = await seedWorkspace(source);
    const [workspaceBefore] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId));
    const [issueBefore] = await db.select().from(issues).where(eq(issues.id, source.issueId));
    let activityAttempted = false;
    const adapter = makeAdapter(async () => {
      activityAttempted = true;
      throw new Error("Activity write failed.");
    });

    await expect(adapter.scheduleRetry(writerInput(source, {
      workspaceValidationRetryPayload: { executionWorkspaceId: workspaceId, reason: "invalid_branch" },
      shouldQuarantineWorkspaceForRetry: true,
    }))).rejects.toThrow("Activity write failed.");
    expect(activityAttempted).toBe(true);
    expect(await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId))).toEqual([workspaceBefore]);
    expect(await db.select().from(issues).where(eq(issues.id, source.issueId))).toEqual([issueBefore]);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, source.runId))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, source.agentId))).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, source.companyId))).toHaveLength(0);
  });

  it("transfers the issue execution lock to the retry run", async () => {
    const source = await seedSource();
    const result = await makeAdapter().scheduleRetry(writerInput(source));
    if (result.outcome !== "scheduled") throw new Error("The retry was not scheduled.");
    const [issue] = await db.select().from(issues).where(eq(issues.id, source.issueId));
    expect(issue?.executionRunId).toBe(result.run.id);
  });

  it("rolls back the wake and run when a later issue update fails", async () => {
    const source = await seedSource();
    await db.execute(sql`create function fail_retry_issue_update() returns trigger language plpgsql as $$ begin raise exception 'retry update failed'; end $$`);
    await db.execute(sql`create trigger fail_retry_issue_update before update on issues for each row execute function fail_retry_issue_update()`);
    await expect(makeAdapter().scheduleRetry(writerInput(source))).rejects.toThrow("Failed query");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, source.runId))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, source.agentId))).toHaveLength(0);
  });
});
