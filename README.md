# CXSlack - OpenAI Codex Slack Bot

[**DEPRECATED** in favour of [C.A.I.A. project](https://github.com/3gx/caia)]

A Slack bot that integrates the OpenAI Codex App-Server with Slack, providing real-time AI-powered code generation, tool execution, and approval workflows directly within Slack channels.

## Features

- **Real-time Streaming**: Timer-based message updates with activity tracking
- **Session Management**: Per-channel and per-thread Codex session mapping
- **Tool Approval Workflow**: Interactive approve/deny buttons for command execution
- **File Processing**: Upload and process images and text files
- **Multiple Models**: Support for GPT-5.2 Codex, GPT-5.2, GPT-5.1 Codex Max/Mini
- **Configurable Settings**: Approval policies, reasoning effort, sandbox modes
- **Activity Logging**: Dedicated thread for tool execution logs
- **Markdown Rendering**: Convert long responses to PNG attachments

## Prerequisites

- Node.js (ES2022 compatible)
- npm
- Codex CLI installed and authenticated (`codex auth login`)
- Slack App with Socket Mode enabled

## Installation

```bash
# Install dependencies
make setup

# Install native dependencies (Puppeteer/Chromium on Linux)
make setup-tools

# Verify all dependencies
make verify-tools
```

## Configuration

See [SETUP.md](SETUP.md) for complete Slack app setup instructions.

Quick start:

1. Copy `.env.example` to `.env`
2. Configure your Slack tokens (see [SETUP.md](SETUP.md) for how to obtain them):

```bash
# Required
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
SLACK_SIGNING_SECRET=your-signing-secret

# Optional
DEFAULT_WORKING_DIR=/path/to/your/project
UPDATE_RATE_MS=500
```

## Usage

### Running the Bot

```bash
# Development (with hot reload)
make dev

# Production
make build
make start
```

### Interacting with the Bot

Mention the bot in a channel to start a conversation:

```
@codex write a function to calculate fibonacci numbers
```

### Commands

| Command | Description |
|---------|-------------|
| `/help` | Show all available commands |
| `/status` | Show current session status |
| `/clear` | Clear session and start fresh |
| `/model` | Select AI model |
| `/policy [policy]` | View/set approval policy |
| `/reasoning [level]` | View/set reasoning effort |
| `/sandbox [mode]` | Set sandbox mode |
| `/cwd [path]` | View/set working directory |
| `/ls [path]` | List files in directory |
| `/cd <path>` | Navigate to directory (before path lock) |
| `/set-current-path` | Lock current directory permanently |
| `/update-rate [1-10]` | Set message update rate in seconds |
| `/message-size [n]` | Set message size limit (100-36000) |
| `/resume <thread-id>` | Resume an existing Codex session |

### Approval Policies

| Policy | Description |
|--------|-------------|
| `never` | Auto-approve all actions (default) |
| `on-request` | Model decides when to ask for approval |
| `on-failure` | Auto-run in sandbox, prompt on failure |
| `untrusted` | Prompt for everything except safe reads |

### Models

| Model | Description |
|-------|-------------|
| `gpt-5.2-codex` | Latest frontier agentic coding model (default) |
| `gpt-5.2` | Latest frontier model with improvements across knowledge, reasoning and coding |
| `gpt-5.1-codex-max` | Codex-optimized flagship for deep and fast reasoning |
| `gpt-5.1-codex-mini` | Optimized for codex. Cheaper, faster, but less capable |

### Reasoning Effort Levels

- `minimal` - Minimal reasoning
- `low` - Low reasoning effort
- `medium` - Medium reasoning effort
- `high` - High reasoning effort
- `xhigh` - Maximum reasoning effort (default)

### Sandbox Modes

| Mode | Description |
|------|-------------|
| `read-only` | Read-only file access |
| `workspace-write` | Write access to workspace only |
| `danger-full-access` | Full system access |

## Testing

```bash
# Run unit and integration tests
make test

# Run with coverage
make test-coverage

# Run SDK live tests (requires Codex App-Server)
make sdk-test

# Run all tests
make all-test

# Run tests in watch mode
make test-watch
```

Test suite:
- 23 unit tests
- 19 integration tests
- 8 SDK live tests

## Project Structure

```
src/
├── index.ts              # Entry point, process lifecycle
├── slack-bot.ts          # Main Slack bot orchestration
├── streaming.ts          # Real-time message streaming
├── codex-client.ts       # Codex App-Server communication
├── session-manager.ts    # Session persistence
├── approval-handler.ts   # Tool approval workflow
├── activity-thread.ts    # Activity log posting
├── blocks.ts             # Slack Block Kit builders
├── commands.ts           # Slash command handlers
├── file-handler.ts       # Slack file processing
├── content-builder.ts    # Message content assembly
├── json-rpc.ts           # JSON-RPC 2.0 protocol
├── slack-retry.ts        # Retry logic with backoff
├── errors.ts             # Error handling
├── emoji-reactions.ts    # Emoji state management
├── dm-notifications.ts   # DM notifications
├── markdown-png.ts       # Markdown to PNG rendering
├── abort-tracker.ts      # Abort state tracking
└── __tests__/            # Test suite
    ├── unit/             # Unit tests
    ├── integration/      # Integration tests
    └── sdk-live/         # SDK live tests
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed architecture documentation.

## Dependencies

### Runtime
- `@slack/bolt` - Slack Bolt framework
- `@slack/web-api` - Slack Web API client
- `async-mutex` - Mutex for concurrent operations
- `dotenv` - Environment configuration
- `highlight.js` - Syntax highlighting
- `markdown-it` - Markdown parsing
- `puppeteer` - Markdown to PNG rendering
- `sharp` - Image processing
- `zod` - Schema validation

### Development
- `typescript` - TypeScript compiler
- `tsx` - TypeScript execution
- `vitest` - Test framework
- `@vitest/coverage-v8` - Code coverage

## License

BSD-3-Clause - see [LICENSE](LICENSE) for details.
