/**
 * Jira Extension
 *
 * Fetches your assigned Jira tickets from atlassian.dpgmedia.net and shows them
 * in the statusbar. Use `/jira` to open an interactive ticket browser.
 *
 * Required env var: JIRA_TOKEN  (Jira Data Center Personal Access Token)
 */

import { exec, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Key, type SelectItem, SelectList, Text, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

const JIRA_BASE_URL = "https://atlassian.dpgmedia.net";
const JIRA_CONTEXT_PATH = "/jira";
const BOARD_ID = 2784;
const ASSIGNEE = "molhoe000";
const MAX_RESULTS = 30;
const STATUS_KEY = "jira-tickets";
const SESSION_MAP_PATH = join(homedir(), ".pi", "jira-session-map.json");

// ── Session map helpers ───────────────────────────────────────────────────────

function loadSessionMap(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(SESSION_MAP_PATH, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function saveSessionMap(map: Record<string, string>): void {
  try {
    writeFileSync(SESSION_MAP_PATH, JSON.stringify(map, null, 2));
  } catch {
    // ignore write errors
  }
}

/** Turn a branch slug like 'MDN-36715-red-dot-on-for-you-tab' into 'MDN-36715: Red dot on for you tab' */
function formatMdnSlug(cwd: string): string {
  const m = cwd.match(/(MDN-\d+)-([\w-]+)/);
  if (!m) return (cwd.match(/MDN-\d+/) ?? [""])[0];
  const title = m[2].replace(/-/g, " ");
  return `${m[1]}: ${title.charAt(0).toUpperCase()}${title.slice(1)}`;
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    status: {
      name: string;
      statusCategory: {
        colorName: string; // "blue-grey" | "yellow" | "green" etc.
        name: string; // "To Do" | "In Progress" | "Done"
      };
    };
  };
}

interface JiraSearchResult {
  issues: JiraIssue[];
  total: number;
}

// ── Jira API ───────────────────────────────────────────────────────────────────

async function jiraGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const token = process.env["JIRA_TOKEN"];
  if (!token) {
    throw new Error("JIRA_TOKEN is not set — export it before launching pi");
  }

  const url = `${JIRA_BASE_URL}${JIRA_CONTEXT_PATH}${path}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Jira API ${response.status}: ${body.slice(0, 200)}`);
  }

  return response.json() as Promise<T>;
}

interface JiraSprint {
  id: number;
  name: string;
  state: string;
}

async function fetchActiveSprintId(signal?: AbortSignal): Promise<number> {
  const data = await jiraGet<{ values: JiraSprint[] }>(
    `/rest/agile/1.0/board/${BOARD_ID}/sprint?state=active`,
    signal,
  );
  const sprint = data.values[0];
  if (!sprint) throw new Error(`No active sprint found on board ${BOARD_ID}`);
  return sprint.id;
}

interface JiraTransition {
  id: string;
  name: string;
  to: {
    name: string;
    statusCategory: { colorName: string };
  };
}

async function jiraPost(path: string, body: unknown): Promise<void> {
  const token = process.env["JIRA_TOKEN"];
  if (!token) throw new Error("JIRA_TOKEN is not set");
  const url = `${JIRA_BASE_URL}${JIRA_CONTEXT_PATH}${path}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Jira API ${response.status}: ${text.slice(0, 200)}`);
  }
}

async function fetchTransitions(issueKey: string): Promise<JiraTransition[]> {
  const data = await jiraGet<{ transitions: JiraTransition[] }>(
    `/rest/api/2/issue/${issueKey}/transitions`,
  );
  return data.transitions;
}

async function performTransition(issueKey: string, transitionId: string): Promise<void> {
  await jiraPost(`/rest/api/2/issue/${issueKey}/transitions`, {
    transition: { id: transitionId },
  });
}

async function jiraPut(path: string, body: unknown): Promise<void> {
  const token = process.env["JIRA_TOKEN"];
  if (!token) throw new Error("JIRA_TOKEN is not set");
  const url = `${JIRA_BASE_URL}${JIRA_CONTEXT_PATH}${path}`;
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Jira API ${response.status}: ${text.slice(0, 200)}`);
  }
}

interface JiraIssueWithAssignee {
  key: string;
  fields: {
    summary: string;
    status: { name: string; statusCategory: { colorName: string; name: string } };
    assignee: { displayName: string; name: string } | null;
  };
}

async function fetchSprintIssues(signal?: AbortSignal): Promise<JiraIssueWithAssignee[]> {
  const sprintId = await fetchActiveSprintId(signal);
  const jql = `sprint = ${sprintId} ORDER BY key ASC`;
  const path =
    `/rest/agile/1.0/sprint/${sprintId}/issue` +
    `?jql=${encodeURIComponent(jql)}` +
    `&fields=summary,status,assignee` +
    `&maxResults=100`;
  const data = await jiraGet<{ issues: JiraIssueWithAssignee[] }>(path, signal);

  const mdnNum = (key: string) => parseInt(key.match(/\d+/)?.[0] ?? "0", 10);
  return data.issues.sort((a, b) => mdnNum(a.key) - mdnNum(b.key));
}

async function assignIssue(issueKey: string): Promise<void> {
  await jiraPut(`/rest/api/2/issue/${issueKey}`, {
    fields: { assignee: { name: ASSIGNEE } },
  });
}

async function fetchMyIssues(signal?: AbortSignal): Promise<JiraIssue[]> {
  const sprintId = await fetchActiveSprintId(signal);

  const jql = `assignee = ${ASSIGNEE} AND sprint = ${sprintId} ORDER BY updated DESC`;

  const path =
    `/rest/agile/1.0/sprint/${sprintId}/issue` +
    `?jql=${encodeURIComponent(jql)}` +
    `&fields=summary,status` +
    `&maxResults=${MAX_RESULTS}`;

  const data = await jiraGet<JiraSearchResult>(path, signal);
  return data.issues;
}

function searchIssues(
  query: string,
  issues: JiraIssueWithAssignee[],
  prMap: PrStatusMap,
): JiraIssueWithAssignee[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const isNum = /^\d+$/.test(q);
  return issues.filter((issue) => {
    if (isNum) {
      const mdnNum = issue.key.match(/\d+/)?.[0] ?? "";
      if (mdnNum.includes(q)) return true;
      const pr = prMap.get(issue.key);
      if (pr && String(pr.number) === q) return true;
    }
    return issue.fields.summary.toLowerCase().includes(q);
  });
}

// ── Statusbar helpers ──────────────────────────────────────────────────────────

/** Map Jira status-category colorName → a theme fg color key */
function categoryColor(
  colorName: string,
): "accent" | "warning" | "success" | "muted" | "dim" {
  switch (colorName) {
    case "blue-grey":
      return "muted"; // To Do / Backlog
    case "yellow":
      return "warning"; // In Progress
    case "green":
      return "success"; // Done
    default:
      return "dim";
  }
}

// ── GitHub PR helpers ───────────────────────────────────────────────────────────

const execAsync = promisify(exec);

interface PrStatus {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  checksState: "passing" | "failing" | "pending" | "none";
  approvalCount: number;
  url: string;
}

type PrStatusMap = Map<string, PrStatus>;

function parsePrRaw(raw: {
  number: number;
  state: string;
  isDraft: boolean;
  reviewDecision: string | null;
  statusCheckRollup: Array<{ conclusion: string | null; status: string }> | null;
  latestReviews: Array<{ state: string }> | null;
  url: string;
}): PrStatus {
  const failing = ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE"];
  const pending = ["IN_PROGRESS", "QUEUED", "PENDING", "WAITING", "REQUESTED"];
  let checksState: PrStatus["checksState"] = "none";
  if (raw.statusCheckRollup && raw.statusCheckRollup.length > 0) {
    if (raw.statusCheckRollup.some((c) => failing.includes(c.conclusion ?? ""))) checksState = "failing";
    else if (raw.statusCheckRollup.some((c) => pending.includes(c.status))) checksState = "pending";
    else checksState = "passing";
  }
  const approvalCount = raw.latestReviews
    ? raw.latestReviews.filter((r) => r.state === "APPROVED").length
    : 0;
  return {
    number: raw.number,
    state: raw.state as PrStatus["state"],
    isDraft: raw.isDraft,
    reviewDecision: raw.reviewDecision as PrStatus["reviewDecision"],
    checksState,
    approvalCount,
    url: raw.url,
  };
}

async function fetchAllPrStatuses(cwd: string): Promise<PrStatusMap> {
  try {
    const { stdout } = await execAsync(
      "gh pr list --limit 50 --json number,state,isDraft,reviewDecision,statusCheckRollup,latestReviews,headRefName,url",
      { cwd, timeout: 15_000 },
    );
    const prs = JSON.parse(stdout) as Array<{
      number: number; state: string; isDraft: boolean;
      reviewDecision: string | null;
      statusCheckRollup: Array<{ conclusion: string | null; status: string }> | null;
      latestReviews: Array<{ state: string }> | null;
      headRefName: string;
      url: string;
    }>;
    const map: PrStatusMap = new Map();
    for (const pr of prs) {
      const m = pr.headRefName.match(/MDN-\d+/);
      if (m) map.set(m[0], parsePrRaw(pr));
    }
    return map;
  } catch {
    return new Map();
  }
}

function formatPrStatus(
  pr: PrStatus,
  fg: (color: string, text: string) => string,
): string {
  if (pr.state === "MERGED") return fg("success", `PR #${pr.number} merged`);
  if (pr.state === "CLOSED") return fg("muted", `PR #${pr.number} closed`);
  if (pr.isDraft) return fg("muted", `PR #${pr.number} draft`);

  const parts: string[] = [fg("dim", `PR #${pr.number}`)];
  if (pr.checksState === "passing") parts.push(fg("success", "✓"));
  else if (pr.checksState === "failing") parts.push(fg("error", "✗"));
  else if (pr.checksState === "pending") parts.push(fg("warning", "⏳"));

  if (pr.reviewDecision === "APPROVED") parts.push(fg("success", `approved (${pr.approvalCount})`));
  else if (pr.reviewDecision === "CHANGES_REQUESTED") parts.push(fg("error", "changes requested"));
  else if (pr.reviewDecision === "REVIEW_REQUIRED") {
    const label = pr.approvalCount > 0 ? `${pr.approvalCount} approved` : "review needed";
    parts.push(fg(pr.approvalCount > 0 ? "warning" : "muted", label));
  }
  return parts.join(" ");
}

/** Compact single badge for non-active tickets, e.g. "👁⃣1" or "✓" or "✗" */
function formatPrBadge(
  pr: PrStatus,
  fg: (color: string, text: string) => string,
): string {
  if (pr.isDraft || pr.state !== "OPEN") return "";
  if (pr.reviewDecision === "APPROVED") return fg("success", `✓${pr.approvalCount}`);
  if (pr.reviewDecision === "CHANGES_REQUESTED") return fg("error", "✗");
  if (pr.reviewDecision === "REVIEW_REQUIRED") {
    return fg(pr.approvalCount > 0 ? "warning" : "muted",
      `👁‍🗨${pr.approvalCount > 0 ? pr.approvalCount : ""}`);
  }
  return "";
}

// ── Git helpers ───────────────────────────────────────────────────────────────

interface GitInfo {
  changes: string;         // e.g. "↑1 staged · ~3 modified"
  branch: string;          // current local branch name
  upstream: string | null; // full ref, e.g. "origin/feature/MDN-36715-..."
  upstreamBranch: string | null; // branch part only, e.g. "feature/MDN-36715-..."
  ahead: number;           // commits ahead of upstream
  behind: number;          // commits behind upstream
}

function gitRun(cmd: string, cwd: string): string | null {
  try {
    return execSync(cmd, { cwd, encoding: "utf8", timeout: 2_000 }).trim();
  } catch {
    return null;
  }
}

function getGitInfo(cwd: string): GitInfo {
  // ── Changes ──
  const porcelain = gitRun("git status --porcelain", cwd) ?? "";
  const lines = porcelain.split("\n").filter(Boolean);
  let staged = 0, modified = 0, untracked = 0;
  for (const line of lines) {
    const x = line[0], y = line[1];
    if (x === "?" && y === "?") untracked++;
    else {
      if (x !== " " && x !== "?") staged++;
      if (y !== " " && y !== "?") modified++;
    }
  }
  const changeParts: string[] = [];
  if (staged > 0) changeParts.push(`↑${staged} staged`);
  if (modified > 0) changeParts.push(`~${modified} modified`);
  if (untracked > 0) changeParts.push(`?${untracked} untracked`);
  const changes = changeParts.join(" · ") || "clean";

  // ── Branch & upstream ──
  const branch = gitRun("git branch --show-current", cwd) ?? "";
  const upstream = gitRun(
    "git rev-parse --abbrev-ref --symbolic-full-name @{u}",
    cwd,
  );
  const upstreamBranch = upstream
    ? upstream.slice(upstream.indexOf("/") + 1)
    : null;

  // ── Ahead / behind ──
  let ahead = 0, behind = 0;
  if (upstream) {
    const counts = gitRun("git rev-list --left-right --count HEAD...@{u}", cwd);
    if (counts) {
      const [a, b] = counts.split("\t").map(Number);
      ahead = a ?? 0;
      behind = b ?? 0;
    }
  }

  return { changes, branch, upstream, upstreamBranch, ahead, behind };
}

/** Check local remote-tracking refs (no network needed). */
function remoteTrackingExists(cwd: string, branch: string): boolean {
  return (
    gitRun(`git show-ref --verify refs/remotes/origin/${branch}`, cwd) !== null
  );
}


/** Replace 'Investigation:' prefix with a looking-glass icon. */
function formatSummary(summary: string): string {
  return summary.replace(/^.*Investigation:\s*/i, "🔍 ");
}


/**
 * e.g.  🎫 In Progress: MDN-36715, MDN-36700  ·  To Do: MDN-36710
 */
function buildStatusText(
  issues: JiraIssue[],
  fg: (color: string, text: string) => string,
  activeKey: string | null,
  git: GitInfo | null,
  prMap: PrStatusMap,
): string {
  if (issues.length === 0) {
    return fg("dim", "🎫 no open tickets");
  }

  const icon = "🎫 ";
  const segments: string[] = [];

  // ── Active ticket first ──
  const activeIssue = activeKey ? issues.find((i) => i.key === activeKey) : null;
  if (activeIssue && git) {
    const label = `${activeKey} (${formatSummary(activeIssue.fields.summary)})`;
    const syncParts: string[] = [];
    if (git.ahead > 0) syncParts.push(fg("accent", `↑${git.ahead}`));
    if (git.behind > 0) syncParts.push(fg("warning", `↓${git.behind}`));
    const syncStr = syncParts.join(" ");
    const remoteParts: string[] = [];
    if (!git.upstream) {
      remoteParts.push(fg("warning", "⚠ no remote → /git-remote"));
    } else if (git.upstreamBranch !== git.branch) {
      remoteParts.push(fg("warning", `⚠ tracking ${git.upstreamBranch} → /git-remote`));
    }
    const activePr = activeKey ? prMap.get(activeKey) : undefined;
    const prStr = activePr ? formatPrStatus(activePr, fg) : fg("dim", "no PR");
    const allParts = [syncStr, git.changes, ...remoteParts, prStr].filter(Boolean);
    const gitStr = allParts.length
      ? ` ${fg("dim", "[")}${allParts.join(fg("dim", " · "))}${fg("dim", "]")}` : "";
    segments.push(`\x1b[97m${label}\x1b[0m${gitStr}`);
  }

  // ── Remaining tickets grouped by status ──
  const rest = issues.filter((i) => i.key !== activeKey);
  const groups = new Map<string, { colorName: string; keys: string[] }>();
  for (const issue of rest) {
    const name = issue.fields.status.name;
    const colorName = issue.fields.status.statusCategory.colorName;
    if (!groups.has(name)) groups.set(name, { colorName, keys: [] });
    groups.get(name)!.keys.push(issue.key);
  }

  const order = ["yellow", "blue-grey", "green"];
  const sorted = [...groups.entries()].sort(([, a], [, b]) => {
    const ai = order.indexOf(a.colorName);
    const bi = order.indexOf(b.colorName);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  for (const [name, { colorName, keys }] of sorted) {
    const color = categoryColor(colorName);
    const statusLabel = fg(color, name + ":");
    const ticketParts = keys.map((k) => {
      const issue = issues.find((i) => i.key === k);
      const pr = prMap.get(k);
      const badge = pr ? formatPrBadge(pr, fg) : "";
      const title = issue ? `${k} (${formatSummary(issue.fields.summary)})` : k;
      return fg(color, title) + (badge ? ` ${badge}` : "");
    }).join(fg("dim", "  ·  "));
    segments.push(`${statusLabel} ${ticketParts}`);
  }

  return icon + segments.join(fg("dim", "  ·  "));
}

// ── Extension entry point ──────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let cachedIssues: JiraIssue[] = [];
  let cachedPrMap: PrStatusMap = new Map();
  let cachedSprintIssues: JiraIssueWithAssignee[] = [];
  let sprintLoadPromise: Promise<void> | null = null;
  let lastError: string | null = null;

  // ── Fetch & update status ──────────────────────────────────────────────────

  async function refresh(
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<void> {
    const theme = ctx.ui.theme;
    ctx.ui.setStatus(STATUS_KEY, theme.fg("dim", "🎫 loading…"));

    try {
      const cwdKey = (ctx.cwd.match(/MDN-\d+/) ?? [])[0] ?? null;
      const branch = gitRun("git branch --show-current", ctx.cwd) ?? "";
      const branchKey = (branch.match(/MDN-\d+/) ?? [])[0] ?? null;
      const activeKey = cwdKey ?? branchKey ?? null;
      const [issues, prMap] = await Promise.all([
        fetchMyIssues(signal),
        fetchAllPrStatuses(ctx.cwd),
      ]);
      cachedIssues = issues;
      cachedPrMap = prMap;
      lastError = null;
      const git = activeKey ? getGitInfo(ctx.cwd) : null;
      const text = buildStatusText(cachedIssues, (c, t) =>
        theme.fg(c as Parameters<typeof theme.fg>[0], t),
        activeKey,
        git,
        cachedPrMap,
      );
      ctx.ui.setStatus(STATUS_KEY, text);
      // Pre-fetch sprint issues in the background so /jira is instant
      if (cachedSprintIssues.length === 0 && !sprintLoadPromise) {
        ctx.ui.setStatus("jira-sprint", theme.fg("dim", "⟳ loading sprint..."));
        sprintLoadPromise = fetchSprintIssues()
          .then((issues) => {
            cachedSprintIssues = issues;
            sprintLoadPromise = null;
            ctx.ui.setStatus("jira-sprint", theme.fg("success", "✓ sprint ready"));
            setTimeout(() => ctx.ui.setStatus("jira-sprint", undefined), 2_000);
          })
          .catch(() => {
            sprintLoadPromise = null;
            ctx.ui.setStatus("jira-sprint", undefined);
          });
      }
    } catch (err: unknown) {
      lastError =
        err instanceof Error ? err.message : "Unknown error fetching Jira issues";
      ctx.ui.setStatus(STATUS_KEY, theme.fg("error", "🎫 error — /jira to retry"));
    }
  }

  // ── session_start: initial fetch + auto-resume ───────────────────────────

  pi.on("session_start", async (event, ctx) => {
    if (!process.env["JIRA_TOKEN"]) return;

    // On fresh startup, check if there is a saved session for this MDN ticket
    if (event.reason === "startup") {
      const branch = gitRun("git branch --show-current", ctx.cwd) ?? "";
      const mdnKey = (ctx.cwd.match(/MDN-\d+/) ?? [])[0] ?? (branch.match(/MDN-\d+/) ?? [])[0];
      if (mdnKey) {
        const map = loadSessionMap();
        const target = map[mdnKey];
        if (target && existsSync(target) && target !== ctx.sessionManager.getSessionFile()) {
          const label = formatMdnSlug(ctx.cwd);
          ctx.ui.notify(`↩ Previous session found for ${label} — press Enter to resume`, "info");
          ctx.ui.setEditorText(`/jira-auto-resume ${target}`);
          return; // refresh happens after the switch via session_start reason:"resume"
        }
      }
    }

    await refresh(ctx);
  });

  // ── session_shutdown: persist session → MDN mapping ───────────────────────

  pi.on("session_shutdown", async (_event, ctx) => {
    const branch = gitRun("git branch --show-current", ctx.cwd) ?? "";
    const mdnKey = (ctx.cwd.match(/MDN-\d+/) ?? [])[0] ?? (branch.match(/MDN-\d+/) ?? [])[0];
    if (!mdnKey) return;
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return;
    const map = loadSessionMap();
    map[mdnKey] = sessionFile;
    saveSessionMap(map);
  });

  // ── Extension maintenance reminder ────────────────────────────────────────────

  pi.on("before_agent_start", (event, _ctx) => {
    return {
      systemPrompt:
        event.systemPrompt +
        "\n\n> **Pi extension maintenance:** When you make any change to" +
        " `~/.pi/agent/extensions/jira.ts` or `~/.pi/agent/extensions/README.md`," +
        " also commit and push to GitHub (`git -C ~/.pi/agent/extensions add -A &&" +
        " git -C ~/.pi/agent/extensions commit -m '...' &&" +
        " git -C ~/.pi/agent/extensions push origin main`)." +
        " Update README.md first if the change affects features, commands, or configuration.",
    };
  });

  // ── /jira-auto-resume command (internal, triggered by session_start) ────────

  pi.registerCommand("jira-auto-resume", {
    description: "Internal: resume the saved session for the current Jira ticket",
    handler: async (args, ctx) => {
      const sessionPath = args?.trim() ?? "";
      if (!sessionPath || !existsSync(sessionPath)) {
        await refresh(ctx);
        return;
      }
      const label = formatMdnSlug(ctx.cwd);
      ctx.ui.notify(`↩ Resuming session for ${label}`, "info");
      await ctx.switchSession(sessionPath);
    },
  });

  // ── /jira-refresh command ──────────────────────────────────────────────────

  pi.registerCommand("jira-refresh", {
    description: "Refresh Jira tickets in the statusbar",
    handler: async (_args, ctx) => {
      await refresh(ctx);
    },
  });

  // ── /git-remote command — fix remote tracking ──────────────────────────────

  pi.registerCommand("git-remote", {
    description: "Fix git remote tracking for the current branch",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;

      const git = getGitInfo(ctx.cwd);
      if (!git.branch) {
        ctx.ui.notify("Not inside a git repository", "error");
        return;
      }

      const localExists = remoteTrackingExists(ctx.cwd, git.branch);

      const upstreamLabel = git.upstream
        ? `currently tracking: ${git.upstream}`
        : "no remote tracking branch set";

      type Action = "set-upstream" | "push-create" | "cancel";
      const items: SelectItem[] = [];

      if (localExists) {
        items.push({
          value: "set-upstream" satisfies Action,
          label: `Set upstream → origin/${git.branch}`,
          description: `git branch -u origin/${git.branch}`,
        });
      }

      items.push({
        value: "push-create" satisfies Action,
        label: `Push & create remote branch`,
        description: `git push -u origin ${git.branch}`,
      });

      items.push({
        value: "cancel" satisfies Action,
        label: "Cancel",
        description: "",
      });

      const chosen = await ctx.ui.custom<Action | null>(
        (tui, theme, _kb, done) => {
          const container = new Container();
          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
          container.addChild(
            new Text(
              theme.fg("accent", theme.bold("  ⎇ Git remote")) +
              theme.fg("dim", `  ${git.branch}`),
              1, 0,
            ),
          );
          container.addChild(
            new Text(theme.fg("muted", `  ${upstreamLabel}`), 1, 0),
          );
          const list = new SelectList(items, items.length, {
            selectedPrefix: (t: string) => theme.fg("accent", t),
            selectedText: (t: string) => theme.fg("accent", t),
            description: (t: string) => theme.fg("dim", t),
            scrollInfo: (t: string) => theme.fg("dim", t),
            noMatch: (t: string) => theme.fg("warning", t),
          });
          list.onSelect = (item) => done(item.value as Action);
          list.onCancel = () => done(null);
          container.addChild(list);
          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
          return {
            render: (w: number) => container.render(w),
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => { list.handleInput(data); tui.requestRender(); },
          };
        },
      );

      if (!chosen || chosen === "cancel") return;

      try {
        if (chosen === "set-upstream") {
          execSync(`git branch -u origin/${git.branch}`, { cwd: ctx.cwd, encoding: "utf8" });
          ctx.ui.notify(`Upstream set to origin/${git.branch}`, "info");
        } else {
          execSync(`git push -u origin ${git.branch}`, { cwd: ctx.cwd, encoding: "utf8", timeout: 30_000 });
          ctx.ui.notify(`Pushed and tracking origin/${git.branch}`, "info");
        }
        await refresh(ctx);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Git error: ${msg.split("\n")[0]}`, "error");
      }
    },
  });

  // ── /jira command — interactive ticket browser ─────────────────────────────

  type JiraView = "my-tickets" | "sprint-overview" | "search";

  const makeJiraHandler = (forceView?: JiraView): Parameters<typeof pi.registerCommand>[1]["handler"] =>
    async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Jira browser requires interactive mode", "error");
        return;
      }
      if (!process.env["JIRA_TOKEN"]) {
        ctx.ui.notify("JIRA_TOKEN is not set", "error");
        return;
      }

      // ── Top-level menu — shown immediately, data loaded lazily per choice ──
      let view: JiraView | null;
      if (forceView) {
        view = forceView;
      } else {
        const viewItems: SelectItem[] = [
          { value: "my-tickets",      label: "🎫 My sprint tickets",  description: cachedIssues.length > 0 ? `${cachedIssues.length} tickets assigned to me` : "my sprint tickets" },
          { value: "sprint-overview", label: "📊 Sprint overview",     description: "All tickets in current sprint" },
          { value: "search",          label: "🔍 Search",              description: "Search by MDN nr, PR nr or title" },
        ];
        view = await ctx.ui.custom<JiraView | null>((tui, theme, _kb, done) => {
          const container = new Container();
          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
          container.addChild(new Text(theme.fg("accent", theme.bold("  🎫 Jira")), 1, 0));
          const list = new SelectList(viewItems, viewItems.length, {
            selectedPrefix: (t: string) => theme.fg("accent", t),
            selectedText:   (t: string) => theme.fg("accent", t),
            description:    (t: string) => theme.fg("muted", t),
            scrollInfo:     (t: string) => theme.fg("dim", t),
            noMatch:        (t: string) => theme.fg("warning", t),
          });
          list.onSelect = (item) => done(item.value as JiraView);
          list.onCancel = () => done(null);
          container.addChild(list);
          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
          return {
            render: (w: number) => container.render(w),
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => { list.handleInput(data); tui.requestRender(); },
          };
        });
      }
      if (!view) return;

      // ── My tickets: load now if not cached ──
      if (view === "my-tickets") {
        if (cachedIssues.length === 0 && !lastError) await refresh(ctx);
        if (lastError) {
          const retry = await ctx.ui.confirm("Jira fetch failed", `${lastError}\n\nRetry?`);
          if (retry) {
            await refresh(ctx);
            if (lastError) { ctx.ui.notify(`Still failing: ${lastError}`, "error"); return; }
          } else { return; }
        }
        if (cachedIssues.length === 0) { ctx.ui.notify("No tickets found 🎉", "info"); return; }
      }

      if (view === "search") {
        // ── Search flow ──
        if (cachedSprintIssues.length === 0) {
          try {
            if (sprintLoadPromise) {
              ctx.ui.setStatus("jira-sprint", ctx.ui.theme.fg("dim", "⟳ loading sprint..."));
              await sprintLoadPromise;
            } else {
              ctx.ui.setStatus("jira-sprint", ctx.ui.theme.fg("dim", "⟳ loading sprint..."));
              cachedSprintIssues = await fetchSprintIssues();
              ctx.ui.setStatus("jira-sprint", undefined);
            }
          } catch (err: unknown) {
            ctx.ui.notify(`Failed to load sprint: ${err instanceof Error ? err.message : String(err)}`, "error");
            return;
          }
        }

        const searchKey = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
          let query = "";
          let selIdx = 0;
          let results: JiraIssueWithAssignee[] = [];

          return {
            render(width: number): string[] {
              const lines: string[] = [];
              lines.push(theme.fg("accent", "─".repeat(width)));
              lines.push(truncateToWidth(
                theme.fg("accent", theme.bold("  🔍 Search  ")) +
                theme.fg("dim", "│ ") + query + theme.fg("accent", "▌"),
                width,
              ));
              lines.push(theme.fg("accent", "─".repeat(width)));
              if (query.trim().length === 0) {
                lines.push(theme.fg("dim", "  type MDN nr, PR nr or title keyword"));
              } else if (results.length === 0) {
                lines.push(theme.fg("warning", "  no results"));
              } else {
                results.slice(0, 12).forEach((issue, i) => {
                  const pr = cachedPrMap.get(issue.key);
                  const prStr = pr ? theme.fg("dim", ` PR#${pr.number}`) : "";
                  const sel = i === selIdx;
                  const prefix = sel ? theme.fg("accent", "> ") : "  ";
                  const key = sel ? theme.fg("accent", issue.key) : theme.fg("muted", issue.key);
                  const title = theme.fg("dim", ` ${formatSummary(issue.fields.summary)}`);
                  const assignee = theme.fg("dim", issue.fields.assignee ? ` — ${issue.fields.assignee.displayName}` : " — unassigned");
                  lines.push(truncateToWidth(`${prefix}${key}${title}${prStr}${assignee}`, width));
                });
                if (results.length > 12) lines.push(theme.fg("dim", `  … ${results.length - 12} more`));
              }
              lines.push(theme.fg("dim", "  ↑↓ navigate  •  enter select  •  esc cancel"));
              lines.push(theme.fg("accent", "─".repeat(width)));
              return lines;
            },
            invalidate() {},
            handleInput(data: string) {
              if (matchesKey(data, Key.enter)) {
                if (results.length > 0) done(results[selIdx]!.key);
                return;
              }
              if (matchesKey(data, Key.escape)) { done(null); return; }
              if (matchesKey(data, Key.up))   { if (selIdx > 0) { selIdx--; tui.requestRender(); } return; }
              if (matchesKey(data, Key.down)) { if (selIdx < results.length - 1) { selIdx++; tui.requestRender(); } return; }
              if (matchesKey(data, Key.backspace)) { query = query.slice(0, -1); }
              else if (data.length === 1 && data.charCodeAt(0) >= 32) { query += data; }
              results = searchIssues(query, cachedSprintIssues, cachedPrMap);
              selIdx = 0;
              tui.requestRender();
            },
          };
        });

        if (!searchKey) return;

        // reuse sprint overview action submenu
        const sprintIssue = cachedSprintIssues.find((i) => i.key === searchKey);
        const sprintPr = cachedPrMap.get(searchKey);
        const isAssignedToMe = sprintIssue?.fields.assignee?.name === ASSIGNEE;
        type SearchAction = "assign" | "browser" | "pr" | "transition" | "back";
        const searchActionItems: SelectItem[] = [
          ...(!isAssignedToMe ? [{ value: "assign" as SearchAction, label: "👤 Assign to me", description: `Assign ${searchKey} to ${ASSIGNEE}` }] : []),
          { value: "browser",    label: "🌐 Open Jira in browser", description: `${JIRA_BASE_URL}${JIRA_CONTEXT_PATH}/browse/${searchKey}` },
          ...(sprintPr ? [{ value: "pr" as SearchAction, label: `🔀 Open PR #${sprintPr.number} in browser`, description: sprintPr.url }] : []),
          { value: "transition", label: "↺ Transition status", description: `Change the status of ${searchKey}` },
          { value: "back",       label: "← Back", description: "" },
        ];
        const searchAction = await ctx.ui.custom<SearchAction | null>((tui, theme, _kb, done) => {
          const container = new Container();
          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
          container.addChild(new Text(theme.fg("accent", theme.bold(`  🎫 ${searchKey}`)), 1, 0));
          if (sprintIssue) container.addChild(new Text(
            theme.fg("muted", `  [${sprintIssue.fields.status.name}]  ${formatSummary(sprintIssue.fields.summary)}`),
            1, 0,
          ));
          const list = new SelectList(searchActionItems, searchActionItems.length, {
            selectedPrefix: (t: string) => theme.fg("accent", t),
            selectedText:   (t: string) => theme.fg("accent", t),
            description:    (t: string) => theme.fg("dim", t),
            scrollInfo:     (t: string) => theme.fg("dim", t),
            noMatch:        (t: string) => theme.fg("warning", t),
          });
          list.onSelect = (item) => done(item.value as SearchAction);
          list.onCancel = () => done(null);
          container.addChild(list);
          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
          return {
            render: (w: number) => container.render(w),
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => { list.handleInput(data); tui.requestRender(); },
          };
        });
        if (!searchAction || searchAction === "back") return;
        if (searchAction === "assign") {
          try { await assignIssue(searchKey); ctx.ui.notify(`${searchKey} assigned to ${ASSIGNEE}`, "info"); await refresh(ctx); }
          catch (err: unknown) { ctx.ui.notify(`Assign failed: ${err instanceof Error ? err.message : String(err)}`, "error"); }
          return;
        }
        if (searchAction === "browser" || searchAction === "pr") {
          const url = searchAction === "pr" && sprintPr ? sprintPr.url : `${JIRA_BASE_URL}${JIRA_CONTEXT_PATH}/browse/${searchKey}`;
          try { execSync(process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`); ctx.ui.notify("Opened in browser", "info"); }
          catch { ctx.ui.setEditorText(url); }
          return;
        }
        if (searchAction === "transition") {
          let transitions: JiraTransition[];
          try { transitions = await fetchTransitions(searchKey); }
          catch (err: unknown) { ctx.ui.notify(`Failed: ${err instanceof Error ? err.message : String(err)}`, "error"); return; }
          const tItems: SelectItem[] = transitions.map((t) => ({ value: t.id, label: t.name, description: `→ ${t.to.name}` }));
          const tid = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
            const c = new Container();
            c.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
            c.addChild(new Text(theme.fg("accent", theme.bold(`  ↺ Transition ${searchKey}`)), 1, 0));
            const l = new SelectList(tItems, Math.min(tItems.length, 10), {
              selectedPrefix: (t: string) => theme.fg("accent", t), selectedText: (t: string) => theme.fg("accent", t),
              description: (t: string) => theme.fg("dim", t), scrollInfo: (t: string) => theme.fg("dim", t), noMatch: (t: string) => theme.fg("warning", t),
            });
            l.onSelect = (item) => done(item.value); l.onCancel = () => done(null);
            c.addChild(l); c.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
            return { render: (w: number) => c.render(w), invalidate: () => c.invalidate(), handleInput: (d: string) => { l.handleInput(d); tui.requestRender(); } };
          });
          if (!tid) return;
          try {
            await performTransition(searchKey, tid);
            ctx.ui.notify(`${searchKey} → ${transitions.find((t) => t.id === tid)?.to.name ?? "transitioned"}`, "info");
            await refresh(ctx);
          } catch (err: unknown) { ctx.ui.notify(`Transition failed: ${err instanceof Error ? err.message : String(err)}`, "error"); }
        }
        return;
      }

      if (view === "sprint-overview") {
        // ── Sprint overview: all sprint tickets ──
        let sprintIssues: JiraIssueWithAssignee[];
        if (cachedSprintIssues.length > 0) {
          sprintIssues = cachedSprintIssues;
        } else {
          try {
            if (sprintLoadPromise) {
              ctx.ui.setStatus("jira-sprint", ctx.ui.theme.fg("dim", "⟳ loading sprint..."));
              await sprintLoadPromise;
            } else {
              ctx.ui.setStatus("jira-sprint", ctx.ui.theme.fg("dim", "⟳ loading sprint..."));
              cachedSprintIssues = await fetchSprintIssues();
              ctx.ui.setStatus("jira-sprint", undefined);
            }
          } catch (err: unknown) {
            ctx.ui.notify(`Failed to load sprint: ${err instanceof Error ? err.message : String(err)}`, "error");
            await refresh(ctx);
            return;
          }
          sprintIssues = cachedSprintIssues;
        }

        // Group by status name, sorted by workflow
        // Map exact Jira status names → sort order; statusCategory used as fallback
        const WORKFLOW_ORDER: Record<string, number> = {
          // To Do
          "To Do": 0, "Open": 0, "Backlog": 0, "Reopened": 0,
          // In Progress
          "In Progress": 1, "In Development": 1, "Development": 1,
          // Code Review / Ready for Review
          "Code Review": 2, "Ready for Review": 2, "In Review": 2, "Review": 2, "Peer Review": 2,
          // Test
          "Test": 3, "Testing": 3, "QA": 3, "In Testing": 3, "Ready for Testing": 3,
          // Deploy
          "Deploy": 4, "Deployment": 4, "Ready to Deploy": 4, "In Deployment": 4,
          // Done
          "Done": 5, "Resolved": 5, "Closed": 5, "Merged": 5, "Released": 5, "Won't Fix": 5, "Cancelled": 5,
        };
        const groupOrder = (name: string, colorName: string): number => {
          if (name in WORKFLOW_ORDER) return WORKFLOW_ORDER[name]!;
          if (colorName === "blue-grey") return 0;  // unknown todo-like
          if (colorName === "yellow")    return 1;  // unknown in-progress-like
          if (colorName === "green")     return 5;  // unknown done-like
          return 4;
        };
        const groups = new Map<string, JiraIssueWithAssignee[]>();
        for (const issue of sprintIssues) {
          const name = issue.fields.status.name;
          if (!groups.has(name)) groups.set(name, []);
          groups.get(name)!.push(issue);
        }
        const sortedGroups = [...groups.entries()].sort(([a, ai], [b, bi]) => {
          const aOrd = groupOrder(a, ai[0]?.fields.status.statusCategory.colorName ?? "");
          const bOrd = groupOrder(b, bi[0]?.fields.status.statusCategory.colorName ?? "");
          return aOrd - bOrd;
        });

        // ── Single flat list: headers + tickets ──
        const HEADER_PREFIX = "__group__";
        const flatItems: SelectItem[] = [];
        for (const [name, issues] of sortedGroups) {
          const isDoneGroup = groupOrder(name, issues[0]?.fields.status.statusCategory.colorName ?? "") >= 5;
          flatItems.push({
            value: `${HEADER_PREFIX}${name}`,
            label: `── ${name.toUpperCase()} (${issues.length}) ──`,
            description: "",
          });
          for (const issue of issues) {
            flatItems.push({
              value: issue.key,
              label: issue.key,
              description:
                (isDoneGroup ? "✓ " : "") +
                formatSummary(issue.fields.summary) +
                (issue.fields.assignee ? `  — ${issue.fields.assignee.displayName}` : "  — unassigned"),
            });
          }
        }

        const visibleRows = Math.min(flatItems.length, 20);
        const sprintKey = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
          const container = new Container();
          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
          container.addChild(
            new Text(
              theme.fg("accent", theme.bold("  📊 Sprint overview")) +
              theme.fg("dim", `  (${sprintIssues.length} tickets)`),
              1, 0,
            ),
          );
          const list = new SelectList(flatItems, visibleRows, {
            selectedPrefix: (t: string) => {
              // Don't show prefix on headers
              return t.startsWith("── ") ? "  " : theme.fg("accent", t);
            },
            selectedText: (t: string) =>
              t.startsWith("── ") ? theme.fg("dim", t) : theme.fg("accent", t),
            description: (t: string) => theme.fg("muted", t),
            scrollInfo:  (t: string) => theme.fg("dim", t),
            noMatch:     (t: string) => theme.fg("warning", t),
          });
          list.onSelect = (item) => {
            if (item.value.startsWith(HEADER_PREFIX)) return; // skip group headers
            done(item.value);
          };
          list.onCancel = () => done(null);
          container.addChild(list);
          container.addChild(new Text(theme.fg("dim", "  ↑↓ navigate  •  enter select  •  esc back"), 1, 0));
          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
          return {
            render: (w: number) => container.render(w),
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => { list.handleInput(data); tui.requestRender(); },
          };
        });

        if (!sprintKey) return;

        const sprintIssue = sprintIssues.find((i) => i.key === sprintKey);
        const sprintPr = cachedPrMap.get(sprintKey);
        const isAssignedToMe = sprintIssue?.fields.assignee?.name === ASSIGNEE;

        type SprintAction = "assign" | "browser" | "pr" | "transition" | "back";
        const sprintActionItems: SelectItem[] = [
          ...(!isAssignedToMe ? [{ value: "assign" as SprintAction, label: "👤 Assign to me", description: `Assign ${sprintKey} to ${ASSIGNEE}` }] : []),
          { value: "browser",    label: "🌐 Open Jira in browser", description: `${JIRA_BASE_URL}${JIRA_CONTEXT_PATH}/browse/${sprintKey}` },
          ...(sprintPr ? [{ value: "pr" as SprintAction, label: `🔀 Open PR #${sprintPr.number} in browser`, description: sprintPr.url }] : []),
          { value: "transition", label: "↺ Transition status",  description: `Change the status of ${sprintKey}` },
          { value: "back",       label: "← Back",              description: "" },
        ];

        const sprintAction = await ctx.ui.custom<SprintAction | null>((tui, theme, _kb, done) => {
          const container = new Container();
          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
          container.addChild(new Text(theme.fg("accent", theme.bold(`  🎫 ${sprintKey}`)), 1, 0));
          if (sprintIssue) {
            container.addChild(new Text(
              theme.fg("muted", `  [${sprintIssue.fields.status.name}]  ${formatSummary(sprintIssue.fields.summary)}`) +
              theme.fg("dim", sprintIssue.fields.assignee ? `  — ${sprintIssue.fields.assignee.displayName}` : "  — unassigned"),
              1, 0,
            ));
          }
          const list = new SelectList(sprintActionItems, sprintActionItems.length, {
            selectedPrefix: (t: string) => theme.fg("accent", t),
            selectedText:   (t: string) => theme.fg("accent", t),
            description:    (t: string) => theme.fg("dim", t),
            scrollInfo:     (t: string) => theme.fg("dim", t),
            noMatch:        (t: string) => theme.fg("warning", t),
          });
          list.onSelect = (item) => done(item.value as SprintAction);
          list.onCancel = () => done(null);
          container.addChild(list);
          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
          return {
            render: (w: number) => container.render(w),
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => { list.handleInput(data); tui.requestRender(); },
          };
        });

        if (!sprintAction || sprintAction === "back") return;

        if (sprintAction === "assign") {
          try {
            await assignIssue(sprintKey);
            ctx.ui.notify(`${sprintKey} assigned to ${ASSIGNEE}`, "info");
            await refresh(ctx);
          } catch (err: unknown) {
            ctx.ui.notify(`Assign failed: ${err instanceof Error ? err.message : String(err)}`, "error");
          }
          return;
        }

        if (sprintAction === "browser" || sprintAction === "pr") {
          const url = sprintAction === "pr" && sprintPr ? sprintPr.url : `${JIRA_BASE_URL}${JIRA_CONTEXT_PATH}/browse/${sprintKey}`;
          try {
            const cmd = process.platform === "darwin" ? `open "${url}"` : process.platform === "win32" ? `start "" "${url}"` : `xdg-open "${url}"`;
            execSync(cmd);
            ctx.ui.notify(`Opened in browser`, "info");
          } catch { ctx.ui.setEditorText(url); }
          return;
        }

        if (sprintAction === "transition") {
          let transitions: JiraTransition[];
          try { transitions = await fetchTransitions(sprintKey); }
          catch (err: unknown) { ctx.ui.notify(`Failed to fetch transitions: ${err instanceof Error ? err.message : String(err)}`, "error"); return; }
          if (transitions.length === 0) { ctx.ui.notify("No available transitions", "info"); return; }

          const transitionItems: SelectItem[] = transitions.map((t) => ({ value: t.id, label: t.name, description: `→ ${t.to.name}` }));
          const transitionId = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
            const container = new Container();
            container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
            container.addChild(new Text(
              theme.fg("accent", theme.bold(`  ↺ Transition ${sprintKey}`)) +
              (sprintIssue ? theme.fg("dim", `  currently: ${sprintIssue.fields.status.name}`) : ""),
              1, 0,
            ));
            const list = new SelectList(transitionItems, Math.min(transitionItems.length, 10), {
              selectedPrefix: (t: string) => theme.fg("accent", t),
              selectedText:   (t: string) => theme.fg("accent", t),
              description:    (t: string) => theme.fg("dim", t),
              scrollInfo:     (t: string) => theme.fg("dim", t),
              noMatch:        (t: string) => theme.fg("warning", t),
            });
            list.onSelect = (item) => done(item.value);
            list.onCancel = () => done(null);
            container.addChild(list);
            container.addChild(new Text(theme.fg("dim", "  ↑↓ navigate  •  enter apply  •  esc cancel"), 1, 0));
            container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
            return {
              render: (w: number) => container.render(w),
              invalidate: () => container.invalidate(),
              handleInput: (data: string) => { list.handleInput(data); tui.requestRender(); },
            };
          });
          if (!transitionId) return;
          try {
            await performTransition(sprintKey, transitionId);
            const applied = transitions.find((t) => t.id === transitionId);
            ctx.ui.notify(`${sprintKey} → ${applied?.to.name ?? "transitioned"}`, "info");
            await refresh(ctx);
          } catch (err: unknown) {
            ctx.ui.notify(`Transition failed: ${err instanceof Error ? err.message : String(err)}`, "error");
          }
        }
        return;
      }

      // ── Step 1: my ticket list ──
      const listTheme = {
        selectedPrefix: (t: string) => ctx.ui.theme.fg("accent", t),
        selectedText: (t: string) => ctx.ui.theme.fg("accent", t),
        description: (t: string) => ctx.ui.theme.fg("muted", t),
        scrollInfo: (t: string) => ctx.ui.theme.fg("dim", t),
        noMatch: (t: string) => ctx.ui.theme.fg("warning", t),
      };

      const ticketItems: SelectItem[] = cachedIssues.map((issue) => ({
        value: issue.key,
        label: issue.key,
        description: `[${issue.fields.status.name}]  ${formatSummary(issue.fields.summary)}`,
      }));

      const chosenKey = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        container.addChild(
          new Text(
            theme.fg("accent", theme.bold("  🎫 Jira — my open tickets")) +
            theme.fg("dim", `  (${cachedIssues.length} found)`),
            1, 0,
          ),
        );
        const list = new SelectList(ticketItems, Math.min(ticketItems.length, 12), listTheme);
        list.onSelect = (item) => done(item.value);
        list.onCancel = () => done(null);
        container.addChild(list);
        container.addChild(
          new Text(
            theme.fg("dim", "  ↑↓ navigate  •  enter select  •  esc cancel  •  r refresh"),
            1, 0,
          ),
        );
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        return {
          render: (w: number) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            if (data === "r" || data === "R") {
              done(null);
              void refresh(ctx).then(() => ctx.ui.notify("Jira tickets refreshed", "info"));
              return;
            }
            list.handleInput(data);
            tui.requestRender();
          },
        };
      });

      if (!chosenKey) return;

      const chosenIssue = cachedIssues.find((i) => i.key === chosenKey);

      // ── Step 2: action submenu ──
      const chosenPr = cachedPrMap.get(chosenKey);
      type TicketAction = "browser" | "pr" | "transition" | "back";
      const actionItems: SelectItem[] = [
        { value: "browser",    label: "🌐 Open Jira in browser", description: `${JIRA_BASE_URL}${JIRA_CONTEXT_PATH}/browse/${chosenKey}` },
        ...(chosenPr ? [{ value: "pr" as TicketAction, label: `🔀 Open PR #${chosenPr.number} in browser`, description: chosenPr.url }] : []),
        { value: "transition", label: "↺ Transition status",  description: `Change the status of ${chosenKey}` },
        { value: "back",       label: "← Back",              description: "" },
      ];

      const action = await ctx.ui.custom<TicketAction | null>((tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        container.addChild(
          new Text(theme.fg("accent", theme.bold(`  🎫 ${chosenKey}`)), 1, 0),
        );
        if (chosenIssue) {
          container.addChild(
            new Text(
              theme.fg("muted", `  [${chosenIssue.fields.status.name}]  ${formatSummary(chosenIssue.fields.summary)}`),
              1, 0,
            ),
          );
        }
        const list = new SelectList(actionItems, actionItems.length, listTheme);
        list.onSelect = (item) => done(item.value as TicketAction);
        list.onCancel = () => done(null);
        container.addChild(list);
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        return {
          render: (w: number) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => { list.handleInput(data); tui.requestRender(); },
        };
      });

      if (!action || action === "back") return;

      // ── Step 3a: open Jira in browser ──
      if (action === "browser" || action === "pr") {
        const url = action === "pr" && chosenPr ? chosenPr.url : `${JIRA_BASE_URL}${JIRA_CONTEXT_PATH}/browse/${chosenKey}`;
        try {
          const cmd = process.platform === "darwin" ? `open "${url}"`
            : process.platform === "win32" ? `start "" "${url}"`
            : `xdg-open "${url}"`;
          execSync(cmd);
          ctx.ui.notify(`Opened ${action === "pr" ? `PR #${chosenPr!.number}` : chosenKey} in browser`, "info");
        } catch {
          ctx.ui.setEditorText(url);
          ctx.ui.notify(`URL copied to editor`, "info");
        }
        return;
      }

      // ── Step 3b: transition flow ──
      let transitions: JiraTransition[];
      try {
        transitions = await fetchTransitions(chosenKey);
      } catch (err: unknown) {
        ctx.ui.notify(`Failed to fetch transitions: ${err instanceof Error ? err.message : String(err)}`, "error");
        return;
      }

      if (transitions.length === 0) {
        ctx.ui.notify("No available transitions for this ticket", "info");
        return;
      }

      const transitionItems: SelectItem[] = transitions.map((t) => ({
        value: t.id,
        label: t.name,
        description: `→ ${t.to.name}`,
      }));

      const transitionId = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        container.addChild(
          new Text(
            theme.fg("accent", theme.bold(`  ↺ Transition ${chosenKey}`)) +
            (chosenIssue ? theme.fg("dim", `  currently: ${chosenIssue.fields.status.name}`) : ""),
            1, 0,
          ),
        );
        const list = new SelectList(transitionItems, Math.min(transitionItems.length, 10), listTheme);
        list.onSelect = (item) => done(item.value);
        list.onCancel = () => done(null);
        container.addChild(list);
        container.addChild(
          new Text(theme.fg("dim", "  ↑↓ navigate  •  enter apply  •  esc cancel"), 1, 0),
        );
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        return {
          render: (w: number) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => { list.handleInput(data); tui.requestRender(); },
        };
      });

      if (!transitionId) return;

      try {
        await performTransition(chosenKey, transitionId);
        const applied = transitions.find((t) => t.id === transitionId);
        ctx.ui.notify(`${chosenKey} → ${applied?.to.name ?? "transitioned"}`, "info");
        await refresh(ctx);
      } catch (err: unknown) {
        ctx.ui.notify(`Transition failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
  };

  pi.registerCommand("jira", { description: "Browse your Jira tickets",          handler: makeJiraHandler() });
  pi.registerCommand("j",    { description: "Alias for /jira",                   handler: makeJiraHandler() });
  pi.registerCommand("jt",   { description: "Jira: my sprint tickets",            handler: makeJiraHandler("my-tickets") });
  pi.registerCommand("jo",   { description: "Jira: sprint overview",              handler: makeJiraHandler("sprint-overview") });
  pi.registerCommand("js",   { description: "Jira: search tickets",               handler: makeJiraHandler("search") });
}
