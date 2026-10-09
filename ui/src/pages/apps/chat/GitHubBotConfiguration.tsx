import { copyTextToClipboard } from "@/lib/clipboard";
import { useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  GITHUB_REVIEW_EVENTS,
  type GitHubChatConfiguration,
  type GitHubReviewPolicy,
  type GitHubAllowedPerson,
} from "@paperclipai/shared";
import { accessApi } from "@/api/access";
import { chatEndpointsApi } from "@/api/chatEndpoints";
import { githubChatApi } from "@/api/githubChat";
import { Button } from "@/components/ui/button";
import { Copy, HelpCircle, MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { Label } from "@/components/ui/label";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Link } from "@/lib/router";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export const githubSelectClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
const eventLabels = {
  opened: "New pull request",
  synchronize: "Updated commits",
  reopened: "Reopened",
  ready_for_review: "Ready for review",
  mention: "Mention",
  comment: "Follow-up comment",
};
function GitHubHelp({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`About ${label}`}
          className="inline-flex shrink-0 items-center text-muted-foreground hover:text-foreground"
          onClick={() => setOpen(true)}
        >
          <HelpCircle className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{children}</TooltipContent>
    </Tooltip>
  );
}

export function GitHubToggle({
  label,
  description,
  help,
  checked,
  onChange,
  ariaLabel,
  disabled,
}: {
  label: string;
  description?: string;
  help?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="break-words text-sm font-medium">{label}</p>
          {help && <GitHubHelp label={label}>{help}</GitHubHelp>}
        </div>
        {description && (
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      <ToggleSwitch
        aria-label={ariaLabel ?? label}
        disabled={disabled}
        checked={checked}
        onCheckedChange={onChange}
      />
    </div>
  );
}
export function GitHubPolicyEditor({
  policy,
  onChange,
}: {
  policy: GitHubReviewPolicy;
  onChange: (policy: GitHubReviewPolicy) => void;
}) {
  const id = useId();
  const [prompt, setPrompt] = useState<
    (typeof GITHUB_REVIEW_EVENTS)[number] | "issue_opened"
  >("opened");
  const set = <K extends keyof GitHubReviewPolicy>(
    key: K,
    value: GitHubReviewPolicy[K],
  ) => onChange({ ...policy, [key]: value });
  return (
    <div className="space-y-8">
      <section
        className="space-y-3"
        aria-labelledby={`${id}-github-instructions-heading`}
      >
        <h2
          id={`${id}-github-instructions-heading`}
          className="text-base font-semibold"
        >
          Instructions
        </h2>
        <MarkdownEditor
          ariaLabel="Agent instructions"
          contentClassName="min-h-32"
          value={policy.instructions}
          placeholder="What should this agent do on GitHub?"
          onChange={(value) => set("instructions", value)}
        />
        <p className="text-xs text-muted-foreground">
          Included in every GitHub task. Type / to select a skill for the agent to use.
        </p>
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            Event-specific instructions
          </summary>
          <div className="grid gap-3 pt-3">
            <Label htmlFor={`${id}-github-prompt-event`} className="sr-only">
              Event
            </Label>
            <select
              id={`${id}-github-prompt-event`}
              className={githubSelectClass}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value as typeof prompt)}
            >
              {GITHUB_REVIEW_EVENTS.map((event) => (
                <option key={event} value={event}>
                  {eventLabels[event]}
                </option>
              ))}
              <option value="issue_opened">New issue</option>
            </select>
            <MarkdownEditor
              key={prompt}
              ariaLabel={`${prompt === "issue_opened" ? "New issue" : eventLabels[prompt]} instructions`}
              contentClassName="min-h-32"
              value={
                prompt === "issue_opened"
                  ? (policy.issueOpenedInstructions ?? "")
                  : policy.prompts[prompt]
              }
              onChange={(value) =>
                prompt === "issue_opened"
                  ? set("issueOpenedInstructions", value)
                  : set("prompts", {
                      ...policy.prompts,
                      [prompt]: value,
                    })
              }
            />
          </div>
        </details>
      </section>
      <section
        className="space-y-3"
        aria-labelledby={`${id}-github-triggers-heading`}
      >
        <h2
          id={`${id}-github-triggers-heading`}
          className="text-base font-semibold"
        >
          When to run
        </h2>
        <Label htmlFor={`${id}-github-invocation`} className="sr-only">
          When to run
        </Label>
        <select
          id={`${id}-github-invocation`}
          className={githubSelectClass}
          value={policy.invocation}
          onChange={(e) =>
            set(
              "invocation",
              e.target.value as GitHubReviewPolicy["invocation"],
            )
          }
        >
          <option value="mentions_only">@mentions only</option>
          <option value="linked_authors">
            @mentions + automatic events from linked members
          </option>
          <option value="allowed_authors">
            @mentions + automatic events from allowed authors
          </option>
        </select>
        <p className="text-xs text-muted-foreground">
          Authorized @mentions work in every mode. Automatic events also need
          “Run automatically” enabled for that person in Access.
        </p>
        {policy.invocation !== "mentions_only" && (
          <div
            className="grid gap-x-8 sm:grid-cols-2"
            aria-label="Automatic events"
          >
            {GITHUB_REVIEW_EVENTS.slice(0, 4).map((event) => (
              <GitHubToggle
                key={event}
                label={eventLabels[event]}
                checked={policy.events.includes(event)}
                onChange={(enabled) =>
                  set(
                    "events",
                    enabled
                      ? [...new Set([...policy.events, event])]
                      : policy.events.filter((value) => value !== event),
                  )
                }
              />
            ))}
            <GitHubToggle
              label="New issues"
              checked={policy.issueOpened === true}
              onChange={(enabled) => set("issueOpened", enabled)}
            />
          </div>
        )}
      </section>
      <section
        className="space-y-3"
        aria-labelledby={`${id}-github-results-heading`}
      >
        <h2
          id={`${id}-github-results-heading`}
          className="text-base font-semibold"
        >
          Review results
        </h2>
        <div className="grid gap-x-8 sm:grid-cols-2">
          <GitHubToggle
            label="Post a review summary"
            checked={policy.publishSummary}
            onChange={(value) => set("publishSummary", value)}
          />
          <GitHubToggle
            label="Post inline findings"
            checked={policy.publishInline}
            onChange={(value) => set("publishInline", value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${id}-github-rating`}>Passing score</Label>
          <select
            id={`${id}-github-rating`}
            className={githubSelectClass}
            value={policy.ratingThreshold ?? "report"}
            onChange={(e) =>
              set(
                "ratingThreshold",
                e.target.value === "report"
                  ? null
                  : (Number(e.target.value) as 1 | 2 | 3 | 4 | 5),
              )
            }
          >
            {[5, 4, 3, 2, 1].map((score) => (
              <option key={score} value={score}>
                Pass at {score}/5 or higher
              </option>
            ))}
            <option value="report">Report only</option>
          </select>
          <p className="text-xs text-muted-foreground">
            The Paperclip Review check applies to the exact reviewed commit. An
            incomplete review cannot pass.
          </p>
          <a
            className="text-xs text-muted-foreground underline hover:text-foreground"
            href="https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository"
            target="_blank"
            rel="noreferrer"
          >
            Require this check before merging in GitHub
          </a>
        </div>
      </section>
      <details className="text-sm">
        <summary className="cursor-pointer font-medium">
          Advanced review settings
        </summary>
        <div className="space-y-6 pt-4">
          <div>
            <GitHubToggle
              label="Include draft PRs"
              checked={policy.reviewDrafts}
              onChange={(value) => set("reviewDrafts", value)}
            />
            <GitHubToggle
              label="Include bot authors"
              description="The bot account also needs a sponsor and automatic events enabled in Access."
              checked={policy.reviewBotAuthors}
              onChange={(value) => set("reviewBotAuthors", value)}
            />
          </div>
          <div className="space-y-3">
            <h3 className="text-sm font-medium">Filters</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              {(
                [
                  [
                    "includeAuthors",
                    "Included authors",
                    "Empty includes every authorized author. One username or glob per line.",
                  ],
                  [
                    "excludeAuthors",
                    "Excluded authors",
                    "One username or glob per line.",
                  ],
                  [
                    "targetBranches",
                    "Target branches",
                    "Empty includes all branches. Supports * and **.",
                  ],
                  [
                    "excludedBranches",
                    "Excluded branches",
                    "Supports * and **.",
                  ],
                  [
                    "requiredLabels",
                    "Required labels",
                    "All listed labels must be present.",
                  ],
                  [
                    "excludedLabels",
                    "Excluded labels",
                    "Any listed label prevents automatic review.",
                  ],
                  [
                    "ignoredPaths",
                    "Ignored files",
                    "Excluded from manual and automatic analysis. Supports * and **.",
                  ],
                ] as const
              ).map(([key, label, help]) => (
                <div className="space-y-2" key={key}>
                  <Label htmlFor={`${id}-github-${key}`}>{label}</Label>
                  <Textarea
                    id={`${id}-github-${key}`}
                    value={policy[key].join("\n")}
                    onChange={(e) =>
                      set(key, e.target.value.split("\n").filter(Boolean))
                    }
                  />
                  <p className="text-xs text-muted-foreground">{help}</p>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Manual requests bypass automatic scheduling filters. Repository
              restrictions and ignored files still apply.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={`${id}-github-categories`}>
                Finding categories
              </Label>
              <Input
                id={`${id}-github-categories`}
                value={policy.findingCategories.join(", ")}
                onChange={(e) =>
                  set(
                    "findingCategories",
                    e.target.value
                      .split(",")
                      .map((v) => v.trim())
                      .filter(Boolean),
                  )
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${id}-github-severity`}>
                Minimum inline severity
              </Label>
              <select
                id={`${id}-github-severity`}
                className={githubSelectClass}
                value={policy.minimumCommentSeverity}
                onChange={(e) =>
                  set(
                    "minimumCommentSeverity",
                    e.target
                      .value as GitHubReviewPolicy["minimumCommentSeverity"],
                  )
                }
              >
                <option value="info">Info</option>
                <option value="warning">Warning</option>
                <option value="error">Error</option>
              </select>
              <p className="text-xs text-muted-foreground">
                Hidden findings still count in the assessment.
              </p>
            </div>
          </div>
          <div>
            <h3 className="text-sm font-medium">Formal review actions</h3>
            <GitHubToggle
              label="Allow approvals"
              help="Lets the agent submit an Approve review on GitHub after a complete assessment. The agent must explicitly choose it; a 5/5 score or passing check does not approve the PR. Off still allows scores, comments, and checks."
              checked={policy.allowApprove}
              onChange={(value) => set("allowApprove", value)}
            />
            <GitHubToggle
              label="Allow request changes"
              help="Lets the agent submit a Request changes review on GitHub after a complete assessment. This is a formal review decision and may prevent merging under your repository rules. Off still allows findings, comments, and a failing check."
              checked={policy.allowRequestChanges}
              onChange={(value) => set("allowRequestChanges", value)}
            />
          </div>
        </div>
      </details>
    </div>
  );
}

export function GitHubAccessEditor({
  endpointId,
  companyId,
  configuration,
  onChange,
}: {
  endpointId: string;
  companyId: string;
  configuration: GitHubChatConfiguration;
  onChange: (configuration: GitHubChatConfiguration) => void;
}) {
  const accountLink = useRef<HTMLAnchorElement>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const members = useQuery({
    queryKey: ["github-members", companyId],
    queryFn: () => accessApi.listMembers(companyId),
  });
  const links = useQuery({
    queryKey: ["github-linked-members", endpointId],
    queryFn: () => chatEndpointsApi.listPrincipals(endpointId),
  });
  const [kind, setKind] = useState<"guest" | null>(null);
  const [login, setLogin] = useState("");
  const [sponsor, setSponsor] = useState(configuration.responsibleUserId);
  const [candidate, setCandidate] = useState<{
    githubUserId: string;
    login: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const add = (person: GitHubAllowedPerson) => {
    if (
      configuration.people.some((p) => p.githubUserId === person.githubUserId)
    )
      return;
    onChange({
      ...configuration,
      ...(person.kind === "member" ? { memberAccess: "selected" } : {}),
      people: [...configuration.people, person],
    });
    setKind(null);
    setCandidate(null);
    setLogin("");
  };
  const activeMembers = (members.data?.members ?? []).filter(
    (member) =>
      member.status === "active" && member.membershipRole !== "viewer",
  );
  const linkedAccounts = (links.data ?? []).filter(
    (link) => link.status === "linked",
  );
  const unlistedAccounts = linkedAccounts.filter(
    (link) =>
      !configuration.people.some(
        (person) => person.githubUserId === link.githubUserId,
      ),
  );
  const responsible = activeMembers.find(
    (member) => member.principalId === configuration.responsibleUserId,
  );
  const unlink = async (principalId: string) => {
    setBusy(true);
    setError("");
    try {
      await chatEndpointsApi.revokeLink(endpointId, principalId);
      await links.refetch();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not unlink this account.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">People</h2>
        <div className="flex items-center gap-2">
          <Link
            ref={accountLink}
            to={`/apps/chat/connect?provider=github&resume=${endpointId}&stage=identity`}
            className="text-sm text-muted-foreground underline underline-offset-4"
          >
            Link your account
          </Link>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Copy account linking URL"
            onClick={() => {
              if (accountLink.current)
                void copyTextToClipboard(accountLink.current.href).then(
                  () => setLinkCopied(true),
                  () =>
                    setError(
                      "Could not copy the link. Open account linking and copy the address.",
                    ),
                );
            }}
          >
            <Copy className="size-4" />
            {linkCopied ? "Copied" : "Invite teammate"}
          </Button>
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="github-member-access">Who can mention the bot</Label>
        <select
          id="github-member-access"
          className={githubSelectClass}
          value={configuration.memberAccess}
          onChange={(e) =>
            onChange({
              ...configuration,
              memberAccess: e.target.value as "all_linked" | "selected",
            })
          }
        >
          <option value="all_linked">All linked company members</option>
          <option value="selected">Selected members only</option>
        </select>
        <p className="text-xs text-muted-foreground">
          Automatic events also require the person’s permission below and an
          enabled event in Settings.
        </p>
      </div>
      <div className="divide-y divide-border border-y border-border">
        {configuration.people.map((person) => {
          const identity = linkedAccounts.find(
            (link) => link.githubUserId === person.githubUserId,
          );
          const linked = person.kind === "guest" || Boolean(identity);
          return (
            <div key={person.githubUserId} className="space-y-3 py-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    @{person.login}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {person.kind === "guest"
                      ? `External contributor · sponsored by ${activeMembers.find((member) => member.principalId === person.sponsorUserId)?.user?.name ?? person.sponsorUserId}`
                      : (identity?.paperclipUserLabel ?? "Company member")}
                  </p>
                  {!linked && (
                    <p className="mt-1 text-xs text-destructive">
                      Link this member’s GitHub account to enable access.
                    </p>
                  )}
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Manage @${person.login}`}
                    >
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() =>
                        onChange({
                          ...configuration,
                          people: configuration.people.filter(
                            (p) => p.githubUserId !== person.githubUserId,
                          ),
                        })
                      }
                    >
                      {person.kind === "member" &&
                      configuration.memberAccess === "all_linked"
                        ? "Reset individual event settings"
                        : "Remove access"}
                    </DropdownMenuItem>
                    {identity && (
                      <DropdownMenuItem
                        disabled={busy}
                        onClick={() => void unlink(identity.principalId)}
                      >
                        Unlink GitHub account
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <GitHubToggle
                label={`Run automatically for @${person.login}`}
                help="Lets PRs and issues authored by this person start work without mentioning the bot. Only events enabled in Settings run. Turn this off to keep this person’s use mention-only."
                checked={person.automaticReviews}
                onChange={(value) =>
                  onChange({
                    ...configuration,
                    people: configuration.people.map((p) =>
                      p.githubUserId === person.githubUserId
                        ? { ...p, automaticReviews: value }
                        : p,
                    ),
                  })
                }
              />
              {person.kind === "guest" && (
                <p className="text-xs text-muted-foreground">
                  Restricted guest permissions; no company membership or
                  personal credentials.
                </p>
              )}
            </div>
          );
        })}
        {unlistedAccounts.map((link) => (
          <div
            key={link.id}
            className="flex items-center justify-between gap-3 py-4"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                @{link.githubLogin ?? link.externalLabel}
              </p>
              <p className="text-xs text-muted-foreground">
                {link.paperclipUserLabel ?? "Linked member"} ·{" "}
                {configuration.memberAccess === "all_linked"
                  ? "Mentions allowed"
                  : "Access not enabled"}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!link.githubUserId || !link.paperclipUserId}
                onClick={() =>
                  onChange({
                    ...configuration,
                    people: [
                      ...configuration.people,
                      {
                        kind: "member",
                        userId: link.paperclipUserId!,
                        githubUserId: link.githubUserId!,
                        login: link.githubLogin ?? link.externalLabel,
                        automaticReviews: false,
                      },
                    ],
                  })
                }
              >
                {configuration.memberAccess === "all_linked"
                  ? "Configure events"
                  : "Allow"}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Manage @${link.githubLogin ?? link.externalLabel}`}
                  >
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    disabled={busy}
                    onClick={() => void unlink(link.principalId)}
                  >
                    Unlink GitHub account
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        ))}
        {links.isPending && (
          <p role="status" className="py-4 text-sm text-muted-foreground">
            Loading linked accounts…
          </p>
        )}
        {!links.isPending &&
          !links.isError &&
          configuration.people.length === 0 &&
          unlistedAccounts.length === 0 && (
            <p className="py-4 text-sm text-muted-foreground">
              No accounts linked yet. Invite a teammate to confirm their GitHub
              identity.
            </p>
          )}
      </div>
      <Button variant="ghost" size="sm" onClick={() => setKind("guest")}>
        Add external contributor
      </Button>
      {kind === "guest" && (
        <div className="space-y-4 rounded-lg border border-border p-4">
          <p className="text-sm">
            Allow one GitHub account to mention the bot with restricted guest
            permissions. A sponsor is required.
          </p>
          <div className="space-y-2">
            <Label htmlFor="github-guest-login">GitHub username</Label>
            <div className="flex gap-2">
              <Input
                id="github-guest-login"
                value={login}
                onChange={(e) => {
                  setLogin(e.target.value);
                  setCandidate(null);
                }}
              />
              <Button
                variant="outline"
                disabled={busy || !login}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    setCandidate(await githubChatApi.lookup(endpointId, login));
                  } catch (error) {
                    setError(
                      error instanceof Error ? error.message : "Lookup failed",
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Look up
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="github-guest-sponsor">Sponsor</Label>
            <select
              id="github-guest-sponsor"
              className={githubSelectClass}
              value={sponsor}
              onChange={(e) => setSponsor(e.target.value)}
            >
              {activeMembers.map((member) => (
                <option key={member.principalId} value={member.principalId}>
                  {member.user?.name ?? member.principalId}
                </option>
              ))}
            </select>
          </div>
          {candidate && (
            <p className="text-sm">
              @{candidate.login} · GitHub ID {candidate.githubUserId}
            </p>
          )}
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setKind(null)}>
              Cancel
            </Button>
            <Button
              disabled={
                !candidate ||
                !sponsor ||
                configuration.people.some(
                  (p) => p.githubUserId === candidate.githubUserId,
                )
              }
              onClick={() =>
                candidate &&
                add({
                  ...candidate,
                  kind: "guest",
                  sponsorUserId: sponsor,
                  permissionProfile: "restricted",
                  automaticReviews: false,
                })
              }
            >
              Add contributor
            </Button>
          </div>
        </div>
      )}
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">
          Automatic task responsibility
        </summary>
        <div className="mt-4 space-y-2">
          {activeMembers.length === 1 && responsible ? (
            <p>
              <span className="inline-flex items-center gap-2">
                Responsible member{" "}
                <GitHubHelp label="Responsible member">
                  The Paperclip member accountable for automatically created
                  tasks. This does not change the GitHub author or grant the bot
                  access to the member’s personal credentials.
                </GitHubHelp>
              </span>
              :{" "}
              {responsible.user?.name ??
                responsible.user?.email ??
                responsible.principalId}
            </p>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <Label htmlFor="github-responsible">Responsible member</Label>
                <GitHubHelp label="Responsible member">
                  The Paperclip member accountable for automatically created
                  tasks. This does not change the GitHub author or grant the bot
                  access to the member’s personal credentials.
                </GitHubHelp>
              </div>
              <select
                id="github-responsible"
                className={githubSelectClass}
                value={configuration.responsibleUserId}
                onChange={(e) =>
                  onChange({
                    ...configuration,
                    responsibleUserId: e.target.value,
                  })
                }
              >
                {!responsible && (
                  <option value={configuration.responsibleUserId}>
                    {configuration.responsibleUserId || "Select a member"}
                  </option>
                )}
                {activeMembers.map((member) => (
                  <option key={member.principalId} value={member.principalId}>
                    {member.user?.name ??
                      member.user?.email ??
                      member.principalId}
                  </option>
                ))}
              </select>
            </>
          )}
          <p className="text-xs text-muted-foreground">
            Automatically created tasks are attributed to this member in
            Paperclip. The GitHub author is recorded separately.
          </p>
        </div>
      </details>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {(members.error || links.error) && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-sm text-destructive">
            Could not load members or linked accounts.
          </p>
          <Button
            variant="link"
            size="sm"
            onClick={() => {
              void members.refetch();
              void links.refetch();
            }}
          >
            Try again
          </Button>
        </div>
      )}
    </section>
  );
}
