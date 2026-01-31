# Architecture

This document describes the current code architecture based strictly on the repository contents.

## High-level overview

```
Slack user
  | (app_mention in channel, or DM)
  v
@slack/bolt App (Socket Mode)
  | src/slack-bot.ts
  |-- src/commands.ts (command parsing and handlers)
  |-- src/session-manager.ts (sessions.json state)
  |-- src/file-handler.ts + src/content-builder.ts (file ingestion)
  |-- src/streaming.ts (turn streaming, status panel, activity log)
  |    |-- src/activity-thread.ts (thread posts, attachments)
  |    |-- src/approval-handler.ts (tool approvals)
  |    |-- src/dm-notifications.ts (DM reminders/notifications)
  |    |-- src/emoji-reactions.ts (status emojis)
  |-- src/codex-client.ts (spawns `codex app-server`, JSON-RPC)
  v
Codex App-Server (`codex app-server`)
  | (JSON-RPC 2.0 over stdin/stdout JSONL)
  v
Workspace filesystem + Codex session files
```

## Entry point and lifecycle
- `src/index.ts` loads environment variables via `dotenv/config`, starts the bot with `startBot()`, and installs SIGINT/SIGTERM handlers.
- Shutdown sequence: stop streaming, stop the Codex client, stop the Slack app. A 6s force-exit timer is used as a safety net. (`src/index.ts`, `src/slack-bot.ts`, `src/codex-client.ts`)

## Slack integration
- `src/slack-bot.ts` creates a Bolt `App` with `socketMode: true` and registers event and action handlers.
- Event handling:
  - `app_mention`: only allowed in channels (channel ID starts with `C`) and only in the main channel (mentions in threads are rejected). Activity and response messages are posted in the thread anchored on the mention. (`src/slack-bot.ts`)
  - `message`: only processes direct messages (channel ID starts with `D`). Activity and response messages are posted in a thread under the DM. (`src/slack-bot.ts`)
  - `channel_deleted`: removes the channel session from `sessions.json`. (`src/slack-bot.ts`, `src/session-manager.ts`)
- Interactive actions and views:
  - Approve/Deny/Abort/Fork buttons (`app.action(/^(approve|deny|abort|fork)_/)`).
  - Modals for abort confirmation and fork-to-channel.
  - Model, policy, reasoning, and sandbox pickers.
  - Attach-thinking retry button and refresh-fork button.

## Command handling
- Commands are parsed from message text that starts with `/` (`parseCommand` in `src/commands.ts`).
- The handlers implement: `/help`, `/status`, `/policy`, `/model`, `/reasoning`, `/sandbox`, `/update-rate`, `/message-size`, `/ls`, `/cd`, `/set-current-path`, `/cwd`, `/clear`, `/resume`.
- Command responses are sent as Slack Block Kit messages. The model/policy/sandbox commands open interactive pickers; selection is handled by action handlers in `src/slack-bot.ts`.

## Session and state management
- Persistent state is stored in `sessions.json` (path `./sessions.json` relative to the process working directory). (`src/session-manager.ts`)
- Access to `sessions.json` is serialized with a mutex to avoid concurrent write races. (`src/session-manager.ts`)
- Session data is tracked at two levels:
  - Channel session (`Session`) for main-channel mentions and default settings.
  - Thread session (`ThreadSession`) for specific Slack threads.
- Stored settings include: working directory, path lock, approval policy, model, reasoning effort, update rate, message size limit, last usage stats, and mappings from Slack message timestamps to Codex turn IDs. (`src/session-manager.ts`)
- `DEFAULT_WORKING_DIR` (env) or `process.cwd()` is used as a fallback working directory when no session exists. (`src/session-manager.ts`)

## Codex integration
- `src/codex-client.ts` spawns `codex app-server` and communicates using JSON-RPC 2.0 over newline-delimited JSON (`src/json-rpc.ts`).
- The client wraps lifecycle management (start/stop/restart), request tracking, and event emission for turn/item/thinking/tool events.
- Sandbox mode is passed to `codex app-server` via `-c sandbox_mode="..."` and can be changed by restarting the process. (`src/codex-client.ts`, `/sandbox` in `src/commands.ts`)
- The bot verifies authentication by calling `account/read` on startup. (`src/slack-bot.ts`, `src/codex-client.ts`)

## Message flow for a normal request
1. A message arrives via `app_mention` or DM.
2. `handleUserMessage` checks for a command. If present, it executes the command handler. (`src/slack-bot.ts`, `src/commands.ts`)
3. If not a command, the bot enforces a path lock (must be set with `/set-current-path` or `/cwd`). (`src/slack-bot.ts`)
4. Only one active Codex turn is allowed at a time; concurrent requests are rejected. (`src/slack-bot.ts`, `src/streaming.ts`)
5. A Codex thread is created or resumed:
   - New thread via `thread/start`.
   - Existing thread via `thread/resume` or `/resume`.
   - Forked thread for Slack thread replies when configured. (`src/slack-bot.ts`, `src/codex-client.ts`, `src/session-manager.ts`)
6. An activity/status panel message is posted in the Slack thread and streaming begins. (`src/streaming.ts`, `src/blocks.ts`)
7. Slack file uploads (if present) are downloaded and converted to `TurnContent` for Codex. (`src/file-handler.ts`, `src/content-builder.ts`)
8. The turn starts with `thread/startTurn` and streaming updates begin. (`src/codex-client.ts`, `src/streaming.ts`)

## Streaming and activity UI
- `StreamingManager` listens to Codex events and updates the activity panel on a timer (default 3s; adjustable by `/update-rate`). (`src/streaming.ts`)
- Activity entries are batched and posted to the conversation thread via `ActivityThreadManager`. Long activity messages are uploaded as markdown attachments when they exceed 2900 characters. (`src/activity-thread.ts`)
- The activity panel shows status, policy, model, reasoning, sandbox, session ID, and token/context metrics when available. (`src/blocks.ts`, `src/streaming.ts`)
- Emoji reactions are used to show processing, approval wait, errors, and aborts. (`src/emoji-reactions.ts`)
- Final responses are posted as thread replies. If a response exceeds the per-session `message-size` limit, it is uploaded as `.md` (and optional `.png`) using `markdownToPng`. (`src/activity-thread.ts`, `src/markdown-png.ts`)

## Approvals
- Codex approval requests (`item/commandExecution/requestApproval` and `item/fileChange/requestApproval`) are routed to `ApprovalHandler`. (`src/approval-handler.ts`, `src/codex-client.ts`)
- The bot posts approval buttons in Slack and responds to Codex on Approve/Deny.
- Reminders are sent every 4 hours and auto-decline after 7 days if no response. (`src/approval-handler.ts`)
- DM notifications are sent for approvals (debounced per conversation). (`src/dm-notifications.ts`)

## Forking to a new Slack channel
- After a turn completes, the activity panel can display a Fork button. (`src/blocks.ts`, `src/streaming.ts`)
- The fork flow:
  1. A modal collects the new channel name.
  2. A new public channel is created and the requesting user is invited.
  3. The Codex thread is forked at the selected turn.
  4. A new session is saved for the new channel, inheriting the locked working directory.
  5. The original activity message is updated with a link to the forked channel. (`src/slack-bot.ts`, `src/codex-client.ts`, `src/session-manager.ts`)

## File handling
- Slack files are downloaded using the bot token and private URLs. (`src/file-handler.ts`)
- Limits:
  - Max files per message: 20
  - Max file size: 25MB
  - Download timeout: 30s
- Image files (`jpeg`, `png`, `gif`, `webp`) may be resized and inlined as base64 when under ~3.75MB, with a temp file fallback. (`src/file-handler.ts`)
- Text files are added inline to the Codex turn input; binary types (PDF, ZIP, audio/video, office formats) are skipped with warnings. (`src/file-handler.ts`, `src/content-builder.ts`)

## Defaults and limits
- Default model: `gpt-5.2-codex` (`DEFAULT_MODEL` in `src/commands.ts`).
- Default reasoning: `xhigh` (`DEFAULT_REASONING` in `src/commands.ts`).
- Update rate: 3s (default when not set; `/update-rate` can set 1-10). (`src/commands.ts`, `src/streaming.ts`)
- Message size limit: default 500 chars, min 100, max 36000 (`/message-size`). (`src/commands.ts`)
- Activity rolling window: when entries exceed 300, the activity panel displays only the last 20. (`src/streaming.ts`)
- Activity batch max text before attachment: 2900 chars. (`src/activity-thread.ts`)
- Thinking display limit: 3000 chars for the activity panel; longer thinking can be attached as files. (`src/commands.ts`, `src/streaming.ts`, `src/activity-thread.ts`)

## Testing
- Tests use Vitest. (`package.json`)
- `src/__tests__/sdk-live/` contains live SDK tests; they can be skipped by setting `SKIP_SDK_TESTS=true`.
