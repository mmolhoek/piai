# piai — Pi Extensions

Personal [pi](https://github.com/earendil-works/pi-coding-agent) extensions for day-to-day development workflow.

## Extensions

### 🎫 `jira.ts` — Jira Integration

A full Jira integration for [pi](https://github.com/earendil-works/pi-coding-agent) that keeps your sprint tickets visible at all times and lets you manage them without leaving the terminal.

#### Prerequisites

| Requirement | Notes |
|---|---|
| `JIRA_TOKEN` env var | Jira Data Center Personal Access Token |
| `JIRA_TEST_ASSIGNEE` env var | *(optional)* Email of tester for auto-assign on test-lane transitions |
| [`gh` CLI](https://cli.github.com/) | Used for PR status; gracefully skipped if absent |

```bash
export JIRA_TOKEN=your_personal_access_token
export JIRA_TEST_ASSIGNEE=susanne.niessen@dpgmedia.nl   # optional
pi
```

---

#### Status Bar

The footer shows your active sprint tickets at all times. The ticket matching your current directory or branch is shown **first and highlighted in white**, with full git and PR detail. Other tickets follow grouped by status.

```
🎫 MDN-36715 (Red dot on 'For You' tab) [↑2 · ~3 modified · PR #421 ✓ approved (2)]  ·  In Progress: MDN-36700 ✓2  ·  To Do: MDN-36710
```

| Symbol | Meaning |
|---|---|
| `↑N` / `↓N` | Commits ahead / behind upstream |
| `~N modified` | Unstaged working-tree changes |
| `↑N staged` | Staged changes |
| `?N untracked` | Untracked files |
| `⚠ no remote → /git-remote` | No upstream tracking branch |
| `⚠ tracking main → /git-remote` | Tracking the wrong remote branch |
| `PR #N ✓ approved (N)` | Open PR · checks passing · N approvals |
| `PR #N ✗ changes requested` | Reviewer requested changes |
| `PR #N ⏳ review needed` | Awaiting review |
| `✓N` *(non-active badge)* | PR fully approved with N approvals |
| `👁‍🗨N` *(non-active badge)* | Review in progress, N approvals so far |

A second status entry appears briefly during background sprint pre-loading:

```
⟳ loading sprint...    →    ✓ sprint ready    (disappears after 2 s)
```

---

#### Commands

| Command | Description |
|---|---|
| `/jira` or `/j` | Open top-level ticket browser menu |
| `/jt` | Jump straight to **My sprint tickets** |
| `/jo` | Jump straight to **Sprint overview** |
| `/js` | Jump straight to **Search** |
| `/jira-refresh` | Force-refresh the status bar |
| `/git-remote` | Fix git remote tracking for the current branch |
| `/jira-auto-resume` | Resume the saved session for the current ticket *(pre-filled on startup)* |

---

#### Ticket Browser

Type `/jira` (or `/j`) to open the top-level menu — it appears **instantly** with no loading delay.

```
🎫 My sprint tickets     12 tickets assigned to me
📊 Sprint overview       All tickets in current sprint
🔍 Search                Search by MDN nr, PR nr or title
```

---

##### 🎫 My Sprint Tickets (`/jt`)

Lists every ticket in the current sprint that is assigned to you (all statuses — open, done, closed). Press `r` inside the list to refresh without closing.

Selecting a ticket opens the **action menu**:

| Action | Description |
|---|---|
| 🌐 Open Jira in browser | Opens the Jira story in your default browser |
| 🔀 Open PR #N in browser | Opens the GitHub PR *(only shown when a PR exists)* |
| 🚀 New LLM session for this story | Fetches full story details and starts a fresh pi session with the story as context |
| ↺ Transition status | Change the Jira status (see [auto-assign](#auto-assign-on-test-lane)) |
| ← Back | Return to the ticket list |

---

##### 📊 Sprint Overview (`/jo`)

Shows **every ticket in the current sprint** in a single scrollable flat list, grouped by workflow status and sorted by MDN number within each group.

**Workflow order:** To Do → In Progress → Code Review → Test → Deploy → Done

Unknown status names are placed automatically based on their Jira status category (blue-grey = To Do tier, yellow = In Progress tier, green = Done tier). Done-tier tickets are shown at the bottom with a `✓` prefix.

The sprint data is **pre-loaded in the background** after the status bar initialises, so `/jo` opens instantly in most cases.

Selecting a ticket opens the same action menu as My Sprint Tickets, with the addition of:

| Extra action | Description |
|---|---|
| 👤 Assign to me | Assigns the ticket to `ASSIGNEE` *(only shown when not already assigned to you)* |

---

##### 🔍 Search (`/js`)

Live-filter across the full sprint as you type. Results update instantly below the cursor.

| Query type | Example | Matches |
|---|---|---|
| MDN number fragment | `36715` or `367` | All tickets whose MDN key contains the digits |
| Exact PR number | `790` | The ticket linked to PR #790 |
| Title keyword | `red dot` | Tickets whose summary contains the text |

`↑↓` navigate · `Enter` open action menu · `Esc` cancel

Sprint data is shared with the overview — once pre-loaded, search is also instant.

---

#### Auto-Assign on Test Lane

When a ticket is transitioned to any status whose name matches `test`, `qa`, `ready for test`, or `in testing` (case-insensitive), it is **automatically assigned** to the tester configured in `JIRA_TEST_ASSIGNEE`.

The tester's Jira username is resolved from their email via the Jira user search API and cached for the session. If `JIRA_TEST_ASSIGNEE` is not set, transitions work normally with no auto-assign.

---

#### New LLM Session from a Story

Available in the action menu of any ticket across all three views. Selecting **🚀 New LLM session for this story** will:

1. Fetch the full Jira story (summary, description, status, type, priority, assignee)
2. Start a fresh pi session
3. Inject the story details as the first message — the LLM reads them, summarises what needs to be done, and is ready to help immediately

---

#### Git Remote Helper (`/git-remote`)

Shows the current branch's remote tracking status and offers two fixes:

| Option | Command run |
|---|---|
| Set upstream → origin/branch | `git branch -u origin/<branch>` *(shown when remote branch exists locally)* |
| Push & create remote branch | `git push -u origin <branch>` |

After either action the status bar refreshes to clear the `⚠` warning.

---

#### Session Auto-Resume

When pi starts inside a directory or on a branch whose name contains an MDN ticket key (e.g. `feature/MDN-36715-red-dot`), the extension checks for a previously saved pi session for that ticket. If one exists, a notification appears and the editor is pre-filled:

```
↩ Previous session found for MDN-36715: Red dot on 'For You' tab — press Enter to resume
```

Press **Enter** to switch into that session. The extension command bypasses the LLM — no unwanted responses. Sessions are saved to `~/.pi/jira-session-map.json` automatically on shutdown.

---

#### Configuration

Constants at the top of `jira.ts`:

| Constant | Default | Description |
|---|---|---|
| `JIRA_BASE_URL` | `https://atlassian.dpgmedia.net` | Jira instance base URL |
| `JIRA_CONTEXT_PATH` | `/jira` | Jira context path (the `/jira` prefix in the URL) |
| `BOARD_ID` | `2784` | Agile board ID used to find the active sprint |
| `ASSIGNEE` | `molhoe000` | Your Jira username for "my tickets" and self-assign |
| `MAX_RESULTS` | `30` | Max tickets in the "my tickets" view |
| `TEST_LANE_STATUSES` | `["test","qa","ready for test","in testing"]` | Status names that trigger auto-assign to tester |

Environment variables:

| Variable | Required | Description |
|---|---|---|
| `JIRA_TOKEN` | ✅ | Jira Data Center Personal Access Token |
| `JIRA_TEST_ASSIGNEE` | ❌ | Email of the tester to auto-assign on test-lane transitions |

---

## Installation

Extensions live in `~/.pi/agent/extensions/` and are picked up automatically by pi.

```bash
git clone git@github.com:mmolhoek/piai.git ~/.pi/agent/extensions
```

Add to your shell profile (`.zshrc`, `.bashrc`, etc.):

```bash
export JIRA_TOKEN=your_personal_access_token
export JIRA_TEST_ASSIGNEE=susanne.niessen@dpgmedia.nl
```

> **Note:** No build step or `npm install` required — pi loads TypeScript extensions directly.

## License

MIT
