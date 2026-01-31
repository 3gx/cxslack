# cxslack

OpenAI Codex Slack Bot. This repo runs a Slack bot built on `@slack/bolt` (Socket Mode) that connects to the Codex app-server (`codex` CLI) over JSON-RPC, streams activity into Slack threads, and persists per-channel/thread settings in `sessions.json`.

## Setup
See `SETUP.md` for Slack app configuration, required tokens, and native dependency setup.

## Runtime requirements (from this repo)
- Node.js 18+ (listed in `SETUP.md`)
- Codex CLI in PATH (the bot spawns `codex app-server` in `src/codex-client.ts`)
- Slack tokens are required at startup: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET` (validated in `src/slack-bot.ts`)

## Behavior notes
- The bot responds to `app_mention` events in channels and to direct messages. App mentions in threads are rejected. (`src/slack-bot.ts`)
- Activity and response messages are posted in threads; some errors/notifications are sent as ephemeral messages or DMs. (`src/slack-bot.ts`, `src/dm-notifications.ts`)
- Commands are parsed from message text that starts with `/` in an app mention or DM. (`src/commands.ts`)
- A working directory must be locked before running requests; use `/ls`, `/cd`, `/set-current-path`, or `/cwd`. (`src/commands.ts`, `src/slack-bot.ts`)
- Only one Codex turn can run at a time across the bot process. (`src/streaming.ts`, `src/slack-bot.ts`)

## Command reference
Commands are handled in `src/commands.ts` and surfaced by `/help`.

| Command | Purpose |
| --- | --- |
| `/help` | Show help text with the full command list. |
| `/status` | Show session status, model, directory, approval policy, sandbox, and token/rate info (if available). |
| `/policy [never|on-request|on-failure|untrusted]` | View or set approval policy. |
| `/model` | Open the model picker (uses the fallback list in `src/commands.ts`). |
| `/reasoning [minimal|low|medium|high|xhigh]` | View or set reasoning effort. |
| `/sandbox [read-only|workspace-write|danger-full-access]` | View or set sandbox mode (restarts the app-server). |
| `/update-rate [1-10]` | Set activity update rate in seconds. |
| `/message-size [100-36000]` | Set response size threshold before attachment. |
| `/ls [path]` | List files (always available). |
| `/cd [path]` | Change working directory (disabled after lock). |
| `/set-current-path` | Lock the current working directory (one-time). |
| `/cwd [path]` | View or set and lock working directory. |
| `/clear` | Clear the current session. |
| `/resume <thread-id>` | Resume an existing Codex thread. |

## Configuration
Environment variables used by the runtime:
- `SLACK_BOT_TOKEN` (required)
- `SLACK_APP_TOKEN` (required)
- `SLACK_SIGNING_SECRET` (required)
- `DEFAULT_WORKING_DIR` (optional fallback working directory, used in `src/session-manager.ts`)

Environment variables used by tests:
- `SKIP_SDK_TESTS=true` skips live SDK tests in `src/__tests__/sdk-live/`.

## Scripts
From `package.json`:
- `npm run dev` - run the bot with `tsx` (development)
- `npm run build` - compile TypeScript to `dist/`
- `npm run start` - run the compiled bot
- `npm run test` - run unit/integration tests (excludes `sdk-live`)
- `npm run test:watch` - watch tests
- `npm run test:coverage` - coverage
- `npm run test:sdk` - run live SDK tests
- `npm run test:all` - run all tests

Makefile shortcuts are available in `Makefile` (setup, verify-tools, dev, build, start, test, sdk-test, all-test).

## Architecture
See `ARCHITECTURE.md` for a detailed, code-based design overview.
