---
name: meeting-copilot-prep
description: Prepare a Meeting Copilot session ahead of time so the start form is already filled when Chris opens the app — title, a tracked agenda, attendees, private coach goals, projects, context files and a research brief — leaving only the one-click "Participants informed — Start Session". Use when Chris says "prep my meeting with X", "get the copilot ready for my 2pm", "prep tomorrow's call with Rory", "stage a session for…", or asks for Meeting Copilot to be waiting with context. Works from any repo, and with the app closed.
---

# Prep a Meeting Copilot session

The output is **one staged prep**: a file Meeting Copilot's start form fills itself
from. When Chris opens the app (panel, menu bar REC, or the next-invite row), the
form is complete and the only thing left is **"Participants informed — Start
Session"**. That button is also the per-session consent affirmation, so **never
tell him consent is handled.** He still presses it himself.

Everything goes through one command, which checks the input and prints what it
wrote:

```bash
CLI=~/Projects/meeting-copilot/scripts/stage-prep.sh
$CLI --invites [days]      # cxmail invites ahead (default 7) with their eventUid
$CLI --gather <eventUid>   # his own records on an invite: email threads, past
                           # Meeting Copilot sessions, vault meeting notes (no model)
$CLI --check <file.json>   # validate only
$CLI <file.json>           # stage it (exit 0 = staged; 1 = nothing written)
$CLI --list                # what is waiting; the first one fills the form
$CLI --remove <id>         # drop one
```

## 1. Find the meeting

Run `$CLI --invites`. If the meeting is there, **use its `eventUid`**: it is how the
form and the menu bar match the prep to the invite, and the CLI then fills in
`startsAt`, `endsAt` and attendee emails for you. If it is not on cxmail's
calendar (a call set up by text, a Zoom link in a DM), stage it by `title` +
`startsAt`/`endsAt`, and ask Chris for the time if you can't find it.

Two meetings could match? Ask which one. Don't guess.

## 2. Gather — his records first, then the web

In parallel where you can:

- **`$CLI --gather <eventUid>`**: the email threads with these people, past
  Meeting Copilot sessions with them, and vault meeting notes. It is the same
  digest the form's Prep button works from.
- **Client or project?** Read its `CLAUDE.md` and `STATUS.md`: `~/clients/<name>/`
  (acme, globex, impact) or `~/Projects/cxventures/clients/<name>/` (northwind). The deal
  shape, pricing guardrails and open decisions live there.
- **`vault` MCP** `search_vault` on the people and the company: meeting notes and
  anything filed about them.
- **`cxmail` MCP** (`search_emails`, `read_thread`) when you need more than the
  digest, e.g. a thread `--gather` cut short, or a meeting with no invite.
- **`cxtasks` MCP** `search_tasks` for open tasks about this client or person:
  promises made and things owed are agenda items.
- **Web** (WebSearch / WebFetch) for anyone new: role, company, what it does,
  anything recent. A common name must match on employer or email domain. If you
  can't confirm the person, say so rather than guessing.

Never invent facts. Anything not from his records or a page you actually read
gets "(unverified)".

## 3. Write the prep

Write JSON to your scratchpad, not the repo:

```json
{
  "eventUid": "abc123@google.com",
  "title": "Northwind weekly with Rory",
  "agenda": ["Brightline audit: what landed this week", "Academy proposal: yes/no on the $5,000 scope"],
  "goals": "Get a yes or no on the Academy proposal.\nDon't discount the retainer.",
  "projects": ["cxventures"],
  "contextPaths": ["~/Projects/cxventures/clients/northwind/STATUS.md"],
  "brief": "### Who they are\n- …",
  "sources": [{ "title": "Northwind Company", "url": "https://…" }],
  "tabs": [
    { "title": "Looker: 0 key events", "url": "https://lookerstudio.google.com/reporting/…/page/…", "path": "~/Projects/cxventures/clients/northwind/Meetings/evidence/2026-09-25/01-landing-pages.png", "note": "Brightline's own dashboard shows 0 key events" }
  ]
}
```

| Field | Rules |
|---|---|
| `title` | Required, ≤ 200 chars. The invite's title unless it is useless ("Meeting"). |
| `eventUid` / `startsAt` / `endsAt` | The uid when there is an invite; otherwise ISO times. Without `endsAt` the copilot's wrap-up check doesn't know when the meeting ends. |
| `attendees` | Omit for an invite (the CLI takes them from it). Otherwise names, or `{name, email}`. |
| `agenda` | **Required, 1–10 items, each ≤ 150 chars.** The live tracker checks these off as they come up, so write 5–8 items under 70 characters each, phrased as a topic or a question Chris raises. Make them specific to these people ("How does Juniper decide build vs buy for AI?"), never generic ("Discuss AI"). Order them the way the conversation should flow: rapport and context → their world → overlap → a concrete next step. Open decisions and things owed (from email, tasks, STATUS.md) come first. |
| `goals` | **Private: only the coach reads them.** ≤ 1,000 chars. Chris's positions, asks and red lines, one per line, in his voice ("Get a yes on…", "Don't discount…"). Take them from the client's `CLAUDE.md` guardrails and the open decisions. Leave it out rather than invent a negotiating position. |
| `projects` | Names from the start form's picker (`~/Projects`, `~/Projects/xcode`, `~/clients` folders that have a `CLAUDE.md`). Unknown names are dropped with a warning. |
| `contextPaths` | Absolute or `~/` paths to `.md`/`.txt`/`.json`/`.yaml` files or folders. The copilot reads them during the meeting. Two to four focused files beat a whole repo. |
| `brief` | Markdown, **≤ 3,000 chars**. It is pinned into every live suggestion's context, so write only what helps mid-meeting: `### Who they are`, `### Their company`, `### How you're connected`, `### Overlap & openings`, and `### Watch-outs` only when something real exists. Bullets, no filler. |
| `sources` | `{title, url}` for the pages the brief relies on (≤ 10). |
| `tabs` | Optional **evidence tabs** (≤ 8): what Chris may want to show or paste mid-meeting. Each is `{title, url?, path?, note?}` and needs a `url` (http/https), a `path` (an absolute or `~/` **png/jpg/gif/webp/pdf/html** snapshot that exists), or both. Title ≤ 80 chars, note ≤ 200, one line. They appear in the dashboard's Evidence panel once the session starts, each with Copy link (the url) and Copy image (image snapshots). **Every `url` opens in his default browser on Start**, where his logins are, so only list pages he'd want open. For an authenticated page (Looker Studio, Search Console, HubSpot) pair the url with a cropped screenshot at `path`, since those pages don't load inside the app and a snapshot is what he can paste into the chat. Only add tabs when the meeting has evidence to show; most don't. |

## 4. Stage it, and read what comes back

```bash
$CLI /path/to/prep.json
```

- **`✗` errors** mean nothing was written. Fix them (usually a brief or an agenda
  item that is too long) and run it again. Don't truncate blindly: tighten the
  words.
- **`⚠` warnings** name what was dropped (an unknown project, a missing or
  unreadable context path, an unknown field, a tab's missing snapshot).
  Fix any that matter and re-stage.
  Staging the same invite again replaces its prep, and an open form shows the
  update.
- **`• notes`** say what was taken from the invite.

## 5. Tell Chris

Three or four lines: which meeting and when, how many agenda items, what the
brief leans on, and anything you couldn't confirm. Say plainly that when he opens
Meeting Copilot the form will be filled, and that **he presses "Participants
informed — Start Session" himself** once he has told the room. That click is his
consent, never yours.

## How it works (for debugging)

- Preps live in `~/.meeting-copilot/staged/<id>.json`, one per meeting (the id is
  keyed on the invite uid, so re-staging replaces it). A prep is offered until
  the meeting ends (else start + 2h, else 24h), and deleted a day after that.
- The form fills itself from the soonest one while untouched: on open, on focus,
  and every 30 s. **Clear** on the banner empties the form and leaves the prep as
  a chip.
- On Start the server moves the file into the session's folder as `prep.json`
  and hands the brief to the copilot as a pinned context doc.
- Source: `server/src/prep/staged.ts` (format, checks), `prep/stage-cli.ts` (this
  CLI), `present/index.ts` ("Staged preps"). Tests:
  `server/src/__tests__/staged-prep.test.ts` (run under `/usr/local/bin/node`).
