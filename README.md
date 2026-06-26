# piai — Pi Extensions

Personal [pi](https://github.com/earendil-works/pi-coding-agent) extensions for day-to-day development workflow.

## Extensions

### 🎫 `jira.ts` — Jira Integration

A full Jira integration for [pi](https://github.com/earendil-works/pi-coding-agent) that keeps your sprint tickets visible at all times and lets you manage them without leaving the terminal.

#### Features

- **Status bar** — live ticker in the pi footer showing your assigned sprint tickets with status colours, git sync state, and PR review status at a glance
- **Interactive ticket browser** — keyboard-driven TUI for browsing, searching, and acting on tickets
- **GitHub PR overlay** — fetches open PRs via the `gh` CLI and overlays check status, review decisions, and approval counts onto every ticket
- **Git context** — detects the active MDN ticket from your working directory or current branch and shows `↑ahead / ↓behind`, staged/modified/untracked counts, and upstream tracking health
- **Session persistence** — automatically maps each MDN ticket to a pi session file; on startup pi offers to resume the previous session for that ticket
- **Status transitions** — transition any ticket to a new status directly from the TUI
- **Assign to self** — claim unassigned sprint tickets from the sprint overview or search results

#### Prerequisites

| Requirement | Notes |
|---|---|
| `JIRA_TOKEN` env var | Jira Data Center Personal Access Token — export before launching pi |
| [`gh` CLI](https://cli.github.com/) | Used for PR status; gracefully omitted if not available |

```bash
export JIRA_TOKEN=your_personal_access_token
pi
```

#### Commands

| Command | Alias | Description |
|---|---|---|
| `/jira` | `/j` | Open the top-level ticket browser menu |
| `/jt` | — | Jump straight to **My sprint tickets** |
| `/jo` | — | Jump straight to the **Sprint overview** (all tickets) |
| `/js` | — | Jump straight to **Search** |
| `/jira-refresh` | — | Force-refresh the status bar |
| `/git-remote` | — | Fix git remote tracking for the current branch |

#### Status Bar Legend

The footer shows a compact summary of your sprint tickets.  The active ticket (matched from the current directory or branch name) is shown first, expanded:

```
🎫 MDN-36715 (Red dot on for you tab) [↑2 · ~3 modified · PR #421 ✓ approved (2)]  ·  In Progress: MDN-36700 ✓2
```

| Symbol | Meaning |
|---|---|
| `↑N` | N commits ahead of upstream |
| `↓N` | N commits behind upstream |
| `~N modified` | N unstaged changes |
| `↑N staged` | N staged changes |
| `?N untracked` | N untracked files |
| `⚠ no remote` | No upstream tracking branch — use `/git-remote` |
| `PR #N ✓ approved (N)` | Open PR with passing checks and N approvals |
| `PR #N ✗` | Changes requested |
| `PR #N ⏳` | Checks pending |
| `👁‍🗨N` | Review required, N approvals so far |

#### Ticket Browser

Open with `/jira` (or `/j`).  The top-level menu offers three views:

**My sprint tickets** (`/jt`)  
Lists all tickets currently assigned to you in the active sprint.  Select a ticket to open in the browser, jump to its PR, or transition its status.  Press `r` to refresh without closing.

**Sprint overview** (`/jo`)  
Shows every ticket in the sprint grouped by workflow status (To Do → In Progress → Code Review → Test → Deploy → Done).  You can assign unassigned tickets to yourself, open them in the browser, view their PR, or transition their status.

**Search** (`/js`)  
Fuzzy-search across the full sprint by MDN number, PR number, or summary text.  Results update as you type; use `↑↓` to navigate and `Enter` to open the action menu for a ticket.

#### Session Auto-Resume

When you start pi inside a directory or on a branch whose name contains an MDN ticket key (e.g. `feature/MDN-36715-red-dot`), the extension checks whether a previous pi session was saved for that ticket.  If one exists you'll see:

```
↩ Previous session found for MDN-36715: Red dot on for you tab — press Enter to resume
```

The editor is pre-filled with `/jira-auto-resume`; just press `Enter` to switch back into that session.  Sessions are saved automatically on shutdown.

#### Configuration

The following constants at the top of `jira.ts` can be adjusted:

| Constant | Default | Description |
|---|---|---|
| `JIRA_BASE_URL` | `https://atlassian.dpgmedia.net` | Jira instance base URL |
| `BOARD_ID` | `2784` | Agile board ID used to find the active sprint |
| `ASSIGNEE` | `molhoe000` | Username used for "assigned to me" queries and self-assign |
| `MAX_RESULTS` | `30` | Maximum tickets fetched for the "my tickets" view |

---

## Installation

Extensions live in `~/.pi/agent/extensions/` and are picked up automatically by pi — no extra steps needed.

```
~/.pi/agent/extensions/
└── jira.ts
```

To install on a new machine:

```bash
git clone git@github.com:mmolhoek/piai.git ~/.pi/agent/extensions
```

> **Note:** pi loads extensions from this directory on startup.  After cloning, simply start pi — no build step or `npm install` is required.

## License

MIT
