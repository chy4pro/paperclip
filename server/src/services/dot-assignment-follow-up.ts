import { and, eq, gt, gte, isNull, sql } from "drizzle-orm";
import { dotAgentBindings, dotMailboxItems, dotRunnerAssignments, heartbeatRuns, issueComments, type Db } from "@paperclipai/db";

/** Call inside the issue admission transaction, while its execution lock is held.
 * The caller preserves explicit fresh-session and durable actor receipt policy.
 */
export async function publishActiveDotComment(db: Db, input: {
  companyId: string; agentId: string; bindingId: string;
  runId: string; issueId: string; commentId: string;
}): Promise<boolean> {
  // Mailbox writers and cursor readers share the binding lock. An event is a
  // reference to task input; it never grants tools or steers the provider.
  const [binding] = await db.select().from(dotAgentBindings).where(and(
    eq(dotAgentBindings.id, input.bindingId), eq(dotAgentBindings.companyId, input.companyId),
    eq(dotAgentBindings.agentId, input.agentId), eq(dotAgentBindings.status, "ready"),
    isNull(dotAgentBindings.revokedAt))).for("update");
  if (!binding) return false;
  const [assignment] = await db.select({ id: dotRunnerAssignments.id }).from(dotRunnerAssignments)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, dotRunnerAssignments.runId),
      eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId),
      eq(heartbeatRuns.nativeIssueId, input.issueId), eq(heartbeatRuns.status, "running"),
      eq(heartbeatRuns.runtimeMode, "native"), sql`${heartbeatRuns.nativeSessionId}::text = ${dotRunnerAssignments.normalizedSessionId}`))
    .innerJoin(issueComments, and(eq(issueComments.id, input.commentId),
      eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
      gte(issueComments.createdAt, dotRunnerAssignments.createdAt),
      sql`(${issueComments.authorAgentId} is null or ${issueComments.authorAgentId} <> ${input.agentId})`))
    .where(and(eq(dotRunnerAssignments.companyId, input.companyId), eq(dotRunnerAssignments.agentId, input.agentId),
      eq(dotRunnerAssignments.bindingId, binding.id), eq(dotRunnerAssignments.bindingGeneration, binding.generation),
      eq(dotRunnerAssignments.runId, input.runId), eq(dotRunnerAssignments.status, "accepted"),
      gt(dotRunnerAssignments.expiresAt, new Date()))).limit(1);
  if (!assignment) return false;
  // Same key as the event scanner: either path may discover the comment first.
  await db.insert(dotMailboxItems).values({ companyId: input.companyId, bindingId: binding.id,
    bindingGeneration: binding.generation, assignmentId: assignment.id, kind: "follow_up",
    sourceEventId: `dot-follow-up:${assignment.id}:${input.commentId}`,
    references: { assignmentId: assignment.id, commentId: input.commentId } }).onConflictDoNothing();
  return true;
}
