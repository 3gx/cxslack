# cxslack vs ccslack — Gap Analysis & Parity Plan

Date: 2026-01-28

## Executive summary
cxslack’s core Slack → Codex loop exists, but it is missing a large portion of ccslack’s collaboration UX, command surface, session tooling, and production hardening. The biggest parity gaps are:

1. **Permission/plan workflow parity** — ccslack’s mode system (plan/ask/edit/bypass), plan file workflow, and approval UX are absent in cxslack (cxslack only exposes `/policy`).
2. **Advanced Slack UX** — ccslack’s multi-block status panel, context usage display, model/mode pickers, activity log richness, and file/PNG attachments are missing or simplified in cxslack.
3. **Terminal/session sync + point‑in‑time forking** — ccslack’s `/watch`, `/ff`, `/resume`, session file parsing, and message‑ID mapping for forking are not present.
4. **File & multimodal handling** — ccslack downloads Slack files, resizes images, and builds content blocks; cxslack does not process Slack file uploads.
5. **Operational polish** — ccslack has extensive tests, setup docs, error handling, retries, and channel lifecycle cleanup; cxslack lacks most of this.

The plan below prioritizes UX parity and collaboration features first, then tooling/ops parity.

---

## Methodology (what was compared)
- File/module inventory and top‑level docs in both repos (`/Users/egx/ai/cxslack`, `/Users/egx/ai/ccslack`).
- Command surfaces (`src/commands.ts`).
- Core bot orchestration (`src/slack-bot.ts`).
- Streaming/UX blocks (`src/streaming.ts`, `src/blocks.ts`, `src/activity-thread.ts`).
- Session persistence (`src/session-manager.ts`).
- Supporting features (file handling, terminal watcher, model cache, etc.).
- Tests coverage and categories (`src/__tests__`).

---

## Feature parity matrix (high‑level)
Legend: ✅ present, ◐ partial, ❌ missing

| Area | ccslack | cxslack | Notes |
| --- | --- | --- | --- |
| Slack app events (mentions, DMs, channel lifecycle) | ✅ | ◐ | cxslack handles mentions + DMs; no channel_deleted cleanup or non‑DM message events. (`src/slack-bot.ts`) |
| Thread & channel UX | ✅ | ◐ | cxslack always replies in threads; ccslack supports richer channel/thread flows and fork‑to‑channel. |
| Command surface | ✅ | ❌ | cxslack has 7 commands; ccslack has 18+ incl. /mode, /context, /watch, /ff, /compact, /message-size, /max-thinking-tokens. (`src/commands.ts`) |
| Permission / plan modes | ✅ | ❌ | ccslack has plan/ask/edit/bypass w/ approval UX; cxslack only uses approval policy. (`src/session-manager.ts`, `src/slack-bot.ts`) |
| Plan approval UI | ✅ | ❌ | ccslack builds plan file UI & 5‑button approval. (`src/blocks.ts`, `src/slack-bot.ts`) |
| Tool approvals & reminders | ✅ | ◐ | cxslack has basic approve/deny blocks; no reminders, mode integration, or plan gating. |
| Activity log UX | ✅ | ◐ | cxslack has simplified activity blocks; ccslack has detailed live log, tool summaries, rolling window, thinking attachments. (`src/blocks.ts`, `src/activity-thread.ts`) |
| Status panel & context usage | ✅ | ❌ | ccslack shows tokens, context %, model, mode, update rate, etc. (`src/blocks.ts`, `/context` command) |
| Streaming API + markdown conversion | ✅ | ❌ | ccslack uses Slack streaming API w/ fallback + markdown conversion and truncation. (`src/streaming.ts`, `src/utils.ts`) |
| File uploads + image resizing | ✅ | ❌ | ccslack processes Slack files, resizes images, builds multimodal content. (`src/file-handler.ts`, `src/content-builder.ts`) |
| Markdown → PNG for long output | ✅ | ❌ | ccslack converts markdown to PNG, uploads when long. (`src/markdown-png.ts`) |
| Point‑in‑time forking | ✅ | ❌ | ccslack maps Slack ts → SDK msg id for fork; cxslack only forks by turn index. (`src/session-manager.ts`, `src/slack-bot.ts`) |
| Fork‑to‑channel | ✅ | ❌ | ccslack supports channel fork modal + channel creation. (`src/blocks.ts`, `src/slack-bot.ts`) |
| Terminal session watch / ff | ✅ | ❌ | ccslack syncs CLI sessions, watch/ff/resume. (`src/terminal-watcher.ts`, `src/message-sync.ts`) |
| Concurrency / busy gating | ✅ | ❌ | ccslack blocks concurrent queries, warns + abort affordances. (`src/slack-bot.ts`) |
| Model cache & deprecation warnings | ✅ | ❌ | ccslack caches models, flags deprecated. (`src/model-cache.ts`, `src/blocks.ts`) |
| Testing (unit, integration, sdk-live) | ✅ | ◐ | cxslack only has limited unit + 2 sdk-live tests. |
| Documentation (README/SETUP/ARCHITECTURE) | ✅ | ❌ | cxslack README is empty; lacks setup docs. |

---

## Detailed gaps (with references)

### 1) Command surface & configuration
**ccslack** supports a broad command set: `/help`, `/status`, `/context`, `/mode`, `/set-current-path`, `/cd`, `/cwd`, `/ls`, `/watch`, `/stop-watching`, `/resume`, `/model`, `/compact`, `/clear`, `/max-thinking-tokens`, `/update-rate`, `/message-size`, `/show-plan`, `/ff` (`/Users/egx/ai/ccslack/src/commands.ts`).

**cxslack** only supports: `/policy`, `/clear`, `/model`, `/reasoning`, `/status`, `/cwd`, `/update-rate`, `/help` (`/Users/egx/ai/cxslack/src/commands.ts`).

**Gap impact:** Missing user affordances for mode switching, context visibility, working directory navigation, plan display, session compaction, message size control, and terminal sync. This is a large UX parity deficit.

---

### 2) Permission modes & plan workflow
**ccslack** uses SDK permission modes (`plan`, `default`, `bypassPermissions`, `acceptEdits`) with:
- inline `/mode` parsing (mention + inline),
- plan file detection and approval UI (5‑button),
- tool approval reminders, and
- explicit “exit plan mode” handling (`/Users/egx/ai/ccslack/src/commands.ts`, `/Users/egx/ai/ccslack/src/blocks.ts`, `/Users/egx/ai/ccslack/src/slack-bot.ts`).

**cxslack** only exposes `approvalPolicy` (never/on-request/on-failure/untrusted) and basic approve/deny buttons (`/Users/egx/ai/cxslack/src/approval-handler.ts`, `/Users/egx/ai/cxslack/src/blocks.ts`).

**Gap impact:** Plan‑mode collaboration and edit‑approval workflows are not available; approval UX is less informative and less resilient (no reminders or plan gating).

---

### 3) Session state richness & metadata
**ccslack** session state tracks:
- permission mode, model, context usage, max‑thinking tokens, message size limit,
- plan file path and plan presentation counts,
- message mapping (Slack ts → SDK msg id) for point‑in‑time forking,
- fork origin metadata (channel/thread/message IDs),
- synced message UUIDs, slack‑originated UUIDs, and more (`/Users/egx/ai/ccslack/src/session-manager.ts`).

**cxslack** stores only threadId, approvalPolicy, workingDir, reasoningEffort, updateRate, fork metadata (turn index), and basic timestamps (`/Users/egx/ai/cxslack/src/session-manager.ts`).

**Gap impact:** A wide set of UX features cannot be supported without richer session state (context, plan, fork, sync, etc.).

---

### 4) Streaming & activity UX
**ccslack**
- Uses Slack native streaming API (chat.startStream) with fallback update throttling (`/Users/egx/ai/ccslack/src/streaming.ts`).
- Converts markdown to Slack‑friendly formatting and handles long responses (markdown + PNG uploads).
- Maintains a multi‑section status panel, activity log, tool details, and context metrics (`/Users/egx/ai/ccslack/src/blocks.ts`).
- Adds “attach thinking” and upload actions.

**cxslack**
- Uses timer‑based updates to a single message with simplified activity log (`/Users/egx/ai/cxslack/src/streaming.ts`, `/Users/egx/ai/cxslack/src/blocks.ts`).
- No native streaming API usage, no markdown conversion or truncation strategy, no status panel or context usage display.

**Gap impact:** UX is materially simpler; users lose progress detail, context visibility, and markdown fidelity.

---

### 5) File uploads & multimodal support
**ccslack** downloads Slack files, resizes images, filters binary types, and builds content blocks for SDK consumption (`/Users/egx/ai/ccslack/src/file-handler.ts`, `/Users/egx/ai/ccslack/src/content-builder.ts`).

**cxslack** defines `ImageContent` in the Codex client but does not parse Slack file uploads or attach them to turns (`/Users/egx/ai/cxslack/src/codex-client.ts`, `src/slack-bot.ts`).

**Gap impact:** Multimodal and file‑based workflows are missing; users cannot send images/files with parity behavior.

---

### 6) Forking behavior (point‑in‑time + fork‑to‑channel)
**ccslack** supports:
- point‑in‑time fork from any message (via Slack↔SDK message mapping),
- fork‑to‑channel flow with modal & channel creation,
- restoration of fork buttons after session resets (`/Users/egx/ai/ccslack/src/slack-bot.ts`, `/Users/egx/ai/ccslack/src/session-manager.ts`, `/Users/egx/ai/ccslack/src/blocks.ts`).

**cxslack** only supports fork by turn index inside same channel; no message‑ID mapping or channel fork (`/Users/egx/ai/cxslack/src/slack-bot.ts`, `/Users/egx/ai/cxslack/src/session-manager.ts`).

**Gap impact:** Users cannot fork from arbitrary points or split discussions into new channels.

---

### 7) Terminal session sync (/watch, /ff, /resume)
**ccslack** integrates with CLI sessions:
- watches session JSONL files,
- fast‑forward syncs missed messages,
- resumes prior sessions, and
- posts terminal activity to Slack (`/Users/egx/ai/ccslack/src/terminal-watcher.ts`, `/Users/egx/ai/ccslack/src/message-sync.ts`, `/Users/egx/ai/ccslack/src/session-reader.ts`).

**cxslack** has no terminal watcher, message sync, or resume logic.

**Gap impact:** No cross‑surface continuity between CLI sessions and Slack.

---

### 8) Concurrency & busy‑state handling
**ccslack** prevents concurrent requests per conversation, provides a busy response, and coordinates with /watch or /ff flows (`/Users/egx/ai/ccslack/src/slack-bot.ts`).

**cxslack** has no busy‑state gating, increasing the risk of overlapping turns or conflicting UI updates.

---

### 9) Model management & context awareness
**ccslack** caches model availability, warns about deprecated models, and includes context usage in `/status` and `/context` (via `LastUsage`) (`/Users/egx/ai/ccslack/src/model-cache.ts`, `/Users/egx/ai/ccslack/src/blocks.ts`).

**cxslack** lists models ad‑hoc; no cache, no deprecated warnings, no context usage display.

---

### 10) Robustness, retries, and error UX
**ccslack** uses central retry helpers (`withSlackRetry`, `withRetry`), richer error types, and numerous edge‑case guards (`/Users/egx/ai/ccslack/src/retry.ts`, `/Users/egx/ai/ccslack/src/errors.ts`).

**cxslack** has a slimmer `slack-retry.ts` and fewer error paths handled; lacks many edge‑case tests.

---

### 11) Documentation & setup parity
**ccslack** includes README, SETUP, ARCHITECTURE, and detailed Slack app configuration (`/Users/egx/ai/ccslack/README.md`, `SETUP.md`, `ARCHITECTURE.md`).

**cxslack** has an empty README and no setup guide.

---

### 12) Tests & quality gates
**ccslack** has extensive unit, integration, and SDK‑live tests covering forking, approvals, streaming, watchers, activity log, and edge cases (`/Users/egx/ai/ccslack/src/__tests__`).

**cxslack** only has a small unit suite and two sdk‑live tests (`/Users/egx/ai/cxslack/src/__tests__`).

---

## Parity plan (phased, dependency‑aware)

### Phase 0 — Alignment decisions (fast)
1. **Backend capability mapping**: confirm which ccslack features map to Codex App‑Server APIs (plan mode, tool approvals, file upload content, message IDs, session metadata). Document any non‑portable items.
2. **UX target spec**: define the exact Slack UX parity target (blocks layout, status panel contents, emojis, attachments) using ccslack as the reference.

### Phase 1 — Core UX parity (highest impact)
1. **Expand commands** to match ccslack surface (add `/mode`, `/context`, `/message-size`, `/max-thinking-tokens` or Codex equivalent, `/compact`, `/show-plan`, `/ls`, `/cd`, `/set-current-path`).
2. **Build status panel + context display**: port ccslack’s block builders for status, context usage, model + mode display, update rate, token usage.
3. **Improve streaming UX**: add markdown conversion and size handling; implement Slack native streaming API with fallback; add structured activity log + rolling window UI.
4. **Busy‑state gating**: add per‑conversation busy checks to avoid overlapping turns and to align user feedback.

### Phase 2 — Permission / approval parity
1. **Mode system**: map ccslack’s plan/ask/edit/bypass to Codex’s approval policies or extend Codex client to emulate those semantics.
2. **Plan workflow**: add plan file detection (if supported by Codex), plan UI, and approval/revise buttons.
3. **Tool approvals**: add reminders and richer tool context; ensure approvals tie into mode logic.

### Phase 3 — Collaboration features
1. **Point‑in‑time forking**: add Slack ts ↔ Codex message ID mapping and fork at message boundaries.
2. **Fork‑to‑channel**: implement modal flow and channel creation with context handoff.
3. **DM notifications**: expand beyond approvals to match ccslack’s question/plan/completion notifications and debouncing strategy.

### Phase 4 — Multimodal & file handling
1. **Slack file ingestion**: download files, filter binary, resize images; build Codex content blocks.
2. **Markdown → PNG** for long answers, plus file attachments for long activity/thinking content.

### Phase 5 — Terminal/session sync (if Codex supports it)
1. **Session file reader**: implement session JSONL parsing and event stream.
2. **/watch + /ff + /resume**: replicate ccslack’s terminal watcher and message sync behaviors.

### Phase 6 — Hardening & tests
1. **Port tests**: prioritize integration tests for commands, approvals, streaming, forking, and context UX.
2. **Retry & error normalization**: align with ccslack’s error handling patterns.
3. **Docs**: add README, SETUP, ARCHITECTURE (codex‑specific) to match ccslack’s onboarding quality.

---

## Unknowns / decisions to resolve
- **Plan mode parity**: Codex App‑Server must support a plan‑write‑approval loop for true parity; if not, a surrogate workflow is needed.
^^^ [N/A] Plan mode is not uspported by Codex, so we DO NOT SUPPORT IT

- **Session message IDs**: Point‑in‑time forking depends on stable message IDs from Codex; validate availability.
^^^ Creat sdk-test live testing to verify point-in-time

- **Terminal sync feasibility**: ccslack relies on local CLI session files; Codex CLI behavior may differ.
^^^ DEFERRED TO LATER

- **Streaming API support**: ccslack uses Slack’s `chat.startStream`; confirm compatibility for cxslack’s token and Slack app scopes.
^^^ adjust to whatever codex app-server supports

---

## Suggested next step
Pick Phase 1 scope (commands + status panel + streaming UX) as the MVP parity target, then confirm which Phase 2/3 items Codex supports so effort isn’t wasted on non‑portable features.
