# CXSlack Architecture

This document describes the architecture of the CXSlack Slack bot, which integrates OpenAI Codex with Slack.

## Overview

CXSlack follows an **event-driven service integration architecture** that bridges two systems:
1. **Slack** - For user interaction via the Bolt framework with Socket Mode
2. **Codex App-Server** - For AI capabilities via JSON-RPC 2.0 over stdin/stdout

The architecture emphasizes:
- Single-flight concurrency (one turn per channel at a time)
- Timer-based message throttling (not event-driven updates)
- Mutex-protected state management
- Graceful error handling and recovery

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Slack                                    │
│  (Events: app_mention, message, button actions, modals)          │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                    Application Layer                              │
│                                                                   │
│   index.ts ──────► slack-bot.ts                                  │
│   (Entry point)    (Event handlers, orchestration)               │
└──────────────────────────────┬───────────────────────────────────┘
                               │
         ┌─────────────────────┼─────────────────────┐
         │                     │                     │
         ▼                     ▼                     ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ StreamingManager│  │ ApprovalHandler │  │ SessionManager  │
│ (streaming.ts)  │  │ (approval-      │  │ (session-       │
│                 │  │  handler.ts)    │  │  manager.ts)    │
│ - Timer updates │  │ - Approval UI   │  │ - File storage  │
│ - Activity log  │  │ - Approve/deny  │  │ - Thread mapping│
│ - Token tracking│  │ - Reminders     │  │ - Settings      │
└────────┬────────┘  └─────────────────┘  └─────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────────┐
│                      CodexClient                                  │
│                    (codex-client.ts)                             │
│                                                                   │
│  - Process lifecycle (spawn, restart, shutdown)                  │
│  - JSON-RPC 2.0 communication                                    │
│  - Event emission (turn:*, item:*, tokens:*, etc.)              │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                    Codex App-Server                               │
│                 (spawned child process)                          │
│                                                                   │
│  stdin ◄──── JSON-RPC requests (thread/start, turn/start, etc.) │
│  stdout ───► JSON-RPC responses + notifications                  │
└──────────────────────────────────────────────────────────────────┘
```

## Core Components

### 1. Entry Point (`index.ts`)

Responsibilities:
- Load environment configuration via dotenv
- Start the Slack bot
- Handle graceful shutdown (SIGTERM, SIGINT)
- Force exit after 6-second timeout

### 2. Slack Bot (`slack-bot.ts`)

The main orchestrator that:
- Initializes Slack App with Socket Mode
- Initializes CodexClient, StreamingManager, ApprovalHandler
- Routes Slack events to handlers
- Manages pending selections (model, policy, sandbox)
- Handles button actions and modal submissions

Key event handlers:
- `app_mention` - User mentions the bot
- `message` - Thread messages
- `channel_deleted` - Clean up session
- Button actions - Model/policy/sandbox selection, approve/deny, fork/abort

### 3. Streaming Manager (`streaming.ts`)

Manages real-time message updates from Codex to Slack.

Architecture:
- **Timer-based updates** (not event-driven) for efficiency
- Per-conversation state: `StreamingContext` + `StreamingState`
- Rolling window of activity entries (max 20 displayed)
- Mutex-protected concurrent access

Key data structures:
```typescript
StreamingContext {
  channelId, threadTs, messageTs    // Slack identifiers
  threadId, turnId                   // Codex identifiers
  approvalPolicy, reasoningEffort    // Settings
  model, updateRateMs, startTime     // Execution context
}

StreamingState {
  text, status                       // Accumulated response
  inputTokens, outputTokens          // Token tracking
  thinkingContent, thinkingSegments  // Reasoning content
  activeTools                        // Tool execution tracking
  updateTimer, spinnerIndex          // Update loop control
}
```

Operations:
- `startStreaming(context)` - Initialize state and timer
- `stopStreaming(key)` - Cleanup state and timer
- `registerTurnId(key, turnId)` - Map turn for event routing
- Timer callback updates activity message every N seconds

### 4. Codex Client (`codex-client.ts`)

Wraps the Codex App-Server process with:
- Process lifecycle management
- JSON-RPC 2.0 over stdin/stdout (JSONL format)
- Exponential backoff on restarts
- Event emission for all Codex notifications

RPC Methods:
```
account/read              → AccountInfo
thread/start              → ThreadInfo
thread/resume             → ThreadInfo
thread/fork               → ThreadInfo
turn/start                → { turnId }
turn/interrupt            → void
turn/continue             → void
item/setApprovalPolicy    → void
approval/respond          → void
```

Events emitted:
- `server:started`, `server:died`, `server:restarting`
- `turn:started`, `turn:completed`
- `item:started`, `item:delta`, `item:completed`
- `thinking:started`, `thinking:delta`, `thinking:complete`
- `approval:requested`
- `tokens:updated`

### 5. Session Manager (`session-manager.ts`)

File-based persistence for Slack-to-Codex mappings.

Data model:
```typescript
Session {
  threadId                    // Codex thread mapping
  previousThreadIds           // For resume after clear
  workingDir, approvalPolicy  // Settings
  model, reasoningEffort      // Preferences
  pathConfigured, configuredPath  // Path lock state
  turns[]                     // Turn history for fork tracking
  lastUsage                   // Token usage
}

ThreadSession {
  threadId                    // Thread-specific Codex thread
  forkedFrom, forkedAtTurnIndex  // Fork metadata
  workingDir, approvalPolicy  // Thread-level overrides
}
```

Storage: `sessions.json` with mutex-protected access

Inheritance: Thread sessions inherit from channel sessions

### 6. Approval Handler (`approval-handler.ts`)

Manages tool approval workflow:
1. Codex sends approval request
2. Handler posts approval buttons in Slack
3. User clicks Approve/Deny
4. Handler responds to Codex
5. Codex continues or aborts

Features:
- Approval reminders every 4 hours
- Auto-decline after 7 days
- Pending approval tracking

### 7. Commands (`commands.ts`)

Slash command handlers:

| Command | Handler Function |
|---------|-----------------|
| `/policy` | `handlePolicyCommand` |
| `/clear` | `handleClearCommand` |
| `/model` | `handleModelCommand` |
| `/reasoning` | `handleReasoningCommand` |
| `/status` | `handleStatusCommand` |
| `/cwd` | `handleCwdCommand` |
| `/ls` | `handleLsCommand` |
| `/cd` | `handleCdCommand` |
| `/set-current-path` | `handleSetCurrentPathCommand` |
| `/update-rate` | `handleUpdateRateCommand` |
| `/message-size` | `handleMessageSizeCommand` |
| `/sandbox` | `handleSandboxCommand` |
| `/resume` | `handleResumeCommand` |
| `/help` | `handleHelpCommand` |

### 8. Supporting Modules

| Module | Purpose |
|--------|---------|
| `blocks.ts` | Slack Block Kit builders |
| `activity-thread.ts` | Activity log posting to threads |
| `file-handler.ts` | Slack file download and processing |
| `content-builder.ts` | Build TurnContent for Codex |
| `json-rpc.ts` | JSON-RPC 2.0 protocol helpers |
| `slack-retry.ts` | Retry logic with exponential backoff |
| `errors.ts` | Error codes and user messages |
| `emoji-reactions.ts` | Mutex-protected emoji operations |
| `dm-notifications.ts` | DM notifications with debouncing |
| `markdown-png.ts` | Puppeteer-based markdown rendering |
| `abort-tracker.ts` | In-memory abort state |

## Data Flow

### Message Processing Flow

```
USER MESSAGE (@codex ...)
    │
    ▼
slack-bot.ts: app_mention handler
    │
    ├─ Parse command (if starts with /)
    ├─ Check path configured
    ├─ Check concurrent turn
    │
    ▼
Get/create Codex thread
    │
    ├─ SessionManager.getEffectiveThreadId()
    ├─ If none: CodexClient.startThread(workingDir)
    │
    ▼
Post initial message ("Starting...")
    │
    ▼
StreamingManager.startStreaming(context)
    │
    ├─ Initialize StreamingState
    ├─ Start update timer (every N seconds)
    │
    ▼
CodexClient.startTurn(threadId, input, options)
    │
    ▼
┌─────────────────────────────────────────┐
│         Codex App-Server                 │
│                                          │
│  Emits events:                          │
│  - turn:started                         │
│  - item:started/delta/completed         │
│  - thinking:started/delta/complete      │
│  - tokens:updated                       │
│  - turn:completed                       │
└──────────────────┬──────────────────────┘
                   │
                   ▼
StreamingManager event listeners
    │
    ├─ Accumulate text, tokens, thinking
    ├─ Track activeTools
    ├─ Add to activityBatch
    │
    ▼
Timer callback: updateActivityMessage()
    │
    ├─ Build activity blocks (status, metrics, spinner)
    ├─ Post activity entries to thread
    ├─ chat.update(activityMessageTs)
    │
    ▼
turn:completed event
    │
    ├─ Clear update timer
    ├─ Post final activity message
    ├─ Save usage stats
    └─ StreamingManager.stopStreaming()
```

### Approval Flow

```
CODEX: approval:requested event
    │
    ▼
StreamingManager → ApprovalHandler.handleApprovalRequest()
    │
    ▼
Post approval message with Approve/Deny buttons
    │
    ▼
User clicks button
    │
    ▼
slack-bot.ts: action handler
    │
    ▼
ApprovalHandler.handleApprovalResponse(approved)
    │
    ▼
CodexClient.respondToApproval(requestId, approved)
    │
    ▼
Codex continues or aborts
```

### Fork Flow

```
User clicks "Fork here" button
    │
    ▼
createForkChannel()
    │
    ├─ codex.findTurnIndex(threadId, turnId)
    ├─ conversations.create (new Slack channel)
    ├─ Invite user
    │
    ▼
codex.forkThreadAtTurn(sourceThreadId, turnIndex)
    │
    ▼
saveSession(newChannelId, {
  threadId: forkedThread.id,
  forkedFrom: sourceThreadId,
  forkedAtTurnIndex: turnIndex,
  workingDir: inherited
})
    │
    ▼
Post "Forked from..." message in fork channel
Update source message with fork link
```

## Concurrency Model

### Mutex Usage

1. **sessionsMutex** - Protects `sessions.json` file access
2. **Per-message emoji mutex** - Prevents race conditions in emoji operations
3. **Per-conversation update mutex** - Serializes streaming updates

### Single-Flight Turns

Only one turn can run per channel at a time. The bot checks `isAnyStreaming()` before starting a new turn and rejects concurrent requests.

## Error Handling

### Error Categories (`errors.ts`)

```typescript
ErrorCode {
  // Slack errors
  SLACK_API_ERROR, SLACK_RATE_LIMITED, SLACK_NETWORK_ERROR,
  SLACK_PERMISSION_DENIED, SLACK_CHANNEL_NOT_FOUND,

  // Codex errors
  CODEX_SERVER_ERROR, CODEX_NOT_AUTHENTICATED, CODEX_TIMEOUT,
  CODEX_PROCESS_DIED, CODEX_RESTART_FAILED,

  // JSON-RPC errors
  JSONRPC_PARSE_ERROR, JSONRPC_INVALID_REQUEST, JSONRPC_METHOD_NOT_FOUND,
  JSONRPC_INVALID_PARAMS, JSONRPC_INTERNAL_ERROR, JSONRPC_TIMEOUT,

  // Session errors
  SESSION_NOT_FOUND, SESSION_SAVE_FAILED, WORKING_DIR_NOT_FOUND,

  // File errors
  FILE_TOO_LARGE, FILE_DOWNLOAD_FAILED, FILE_PROCESSING_ERROR,

  // Other
  INVALID_INPUT, APPROVAL_TIMEOUT, APPROVAL_DENIED
}
```

### Recovery Strategies

- **Slack rate limits**: Exponential backoff with `withSlackRetry()`
- **Codex process death**: Auto-restart with exponential backoff
- **Session file corruption**: Graceful fallback to defaults
- **Network errors**: Retry with backoff

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_BOT_TOKEN` | Yes | Bot token (xoxb-...) |
| `SLACK_APP_TOKEN` | Yes | App-level token (xapp-...) |
| `SLACK_SIGNING_SECRET` | Yes | Signing secret |
| `DEFAULT_WORKING_DIR` | No | Default working directory |
| `UPDATE_RATE_MS` | No | Message update throttle (default: 500) |

### Session Configuration

Per-session settings stored in `sessions.json`:
- `approvalPolicy`: never, on-request, on-failure, untrusted
- `model`: gpt-5.2-codex, gpt-5.2, gpt-5.1-codex-max, gpt-5.1-codex-mini
- `reasoningEffort`: minimal, low, medium, high, xhigh
- `updateRateSeconds`: 1-10 (default: 3)
- `threadCharLimit`: 100-36000 (default: 500)

## Testing Architecture

### Test Categories

| Category | Count | Location | Description |
|----------|-------|----------|-------------|
| Unit | 23 | `src/__tests__/unit/` | Mock-based, fast execution |
| Integration | 19 | `src/__tests__/integration/` | Component interactions |
| SDK Live | 8 | `src/__tests__/sdk-live/` | Requires Codex App-Server |

### Test Execution

```bash
# Unit + Integration (parallel)
make test

# SDK live tests (require Codex)
make sdk-test

# All tests
make all-test
```

## Performance Considerations

1. **Timer-based updates**: Updates every N seconds instead of per-event reduces Slack API calls
2. **Rolling window**: Activity entries capped at 20 visible to prevent message bloat
3. **Delta deduplication**: 100ms TTL prevents duplicate text
4. **Mutex optimization**: Per-resource mutexes instead of global lock
5. **Lazy Puppeteer**: Browser only launched when markdown→PNG needed
