# Thread Activity UX gaps — ccslack vs cxslack

This doc lists the thread/activity behaviors ccslack implements that are missing or simplified in cxslack. Source refs are from `ccslack` (e.g., `src/slack-bot.ts`, `src/activity-thread.ts`, `src/blocks.ts`, `src/message-sync.ts`) versus cxslack (`src/streaming.ts`, `src/blocks.ts`).

Status: Living spec. Update this file as gaps are closed or if implementation is partial/blocked (record what's missing and why).
Last updated: 2026-01-29 — after implementing fork-to-channel modal flow.

---

## Completed Items ✓

### Activity Thread Formatting (DONE)
- **Result metrics extraction**: Edit/Write show lines added/removed, Bash shows output preview
- **Tool formatting**: Input summaries, bullet-point details, result summaries per tool type
- **Emoji standardization**: `:bulb:` for thinking, `:speech_balloon:` for generating (ccslack parity)
- **In-place thinking updates**: Thinking messages update in place with streaming content
- **Bash output capture**: `command:output` events captured and stored for preview

### Fork Button UX (DONE)
- **Fork button timing**: Only appears AFTER query completes (not during running)
- **Fork button placement**: Only on activity/status message, not per-entry
- **Fork button style**: `:twisted_rightwards_arrows: Fork here` with `emoji: true` (ccslack parity)
- **Replaces Abort**: Fork button appears in same position where Abort was during running

### Fork-to-Channel Flow (DONE)
Full fork flow implemented (ccslack parity):
1. ✓ Modal with channel name input (pre-filled: `{channelName}-fork`)
2. ✓ Channel name validation (lowercase, numbers, hyphens)
3. ✓ New Slack channel creation via `conversations.create`
4. ✓ User invitation to new channel
5. ✓ Codex session fork at specific turn via `thread/fork` RPC
6. ✓ Initial message in new channel with link to source
7. ✓ Source message updated with link to forked channel

**Implementation files:**
- `src/blocks.ts`: `buildForkToChannelModalView()`
- `src/slack-bot.ts`: Modal handler, `createForkChannel()`
- `src/session-manager.ts`: Added `forkedFrom`/`forkedAtTurnIndex` to Session

### SDK Live Testing (DONE)
- **Token accumulation test**: `src/__tests__/sdk-live/token-accumulation.test.ts` — verifies Codex sends cumulative totals
- **Thread fork test**: `src/__tests__/sdk-live/thread-fork.test.ts` — verifies `thread/fork` RPC:
  - Basic fork (creates new thread from existing)
  - Fork-at-turn-index (point-in-time fork)
  - Fork metadata (`forkedFrom`, `forkedAtTurnIndex`)
  - Error handling for invalid thread ID

---

## In Progress / Partial

### Attach Thinking (PARTIAL)
- Button renders on thinking entries
- File upload to thread NOT implemented

---

## Not Implemented

### Live activity stream
- **Separate activity thread replies**: ccslack posts per-segment activity replies. cxslack only updates single status message.
- **Interleaved segments**: ccslack supports multiple activity→text segments per turn. cxslack assumes one contiguous stream.
- **Activity batching window**: ccslack batches entries with rolling window. cxslack shows latest rolling text in one message.

### Rich entry types
- **Todo extraction**: ccslack parses `- [ ]` bullets and pins todo list. cxslack does not extract todos.
- **Rate-limit + retry markers**: ccslack annotates activity with rate-limit hits. cxslack lacks these.
- **Context events**: ccslack adds `context_cleared`, `session_changed`, `mode_changed` entries. cxslack omits.
- **Exit codes/warnings**: ccslack shows exit codes and warning badges per tool. cxslack does not.

### Status panel enrichment
- **Cost display**: ccslack includes per-turn cost. cxslack drops cost.
- **Auto-compaction preview**: ccslack shows compact thresholds. cxslack hides.
- **Rate-limit display**: ccslack shows rate-limit hits in status. cxslack omits.

### Message mapping & dedup
- **UUID-based mapping**: ccslack maps Slack ts ↔ SDK message UUIDs. cxslack lacks message mapping.
- **Update vs post fallback**: ccslack updates existing activity messages. cxslack cannot update past activity.

### Error and edge handling
- **Trailing activity & no-text turns**: ccslack handles turns with only activity. cxslack assumes text response.
- **Inline mode changes**: ccslack logs mode transitions. cxslack has no mode system.
- **Live file/multimodal activity**: ccslack posts image/file-handling steps. cxslack ignores Slack files.

---

## Priority Order for Remaining Work

1. **Attach thinking file upload** — Button exists, need file upload logic
2. **Per-entry activity replies** — Major architectural change for activity threading
3. **Message mapping (UUID ↔ Slack ts)** — Enables update-in-place and point-in-time actions

---

## SDK Live Tests Inventory

| Test File | Purpose | Run With |
|-----------|---------|----------|
| `token-accumulation.test.ts` | Verify token events are cumulative totals | `make sdk-test` |
| `thread-fork.test.ts` | Verify `thread/fork` RPC and fork-at-point | `make sdk-test` |

These tests ensure Codex SDK behavior is validated when upgrading SDK versions.
