/**
 * Slash command handlers for the Codex Slack bot.
 *
 * Available commands:
 * - /policy - View/set approval policy
 * - /clear - Clear session (start fresh)
 * - /model - View/set model
 * - /reasoning - View/set reasoning effort
 * - /status - Show session status
 * - /cwd - Set working directory
 * - /update-rate - Set message update rate
 * - /help - Show help
 */

import type { WebClient } from '@slack/web-api';
import type { CodexClient, ApprovalPolicy, ReasoningEffort } from './codex-client.js';
import {
  getSession,
  saveSession,
  getThreadSession,
  saveThreadSession,
  clearSession,
  getEffectiveApprovalPolicy,
  getEffectiveWorkingDir,
  APPROVAL_POLICIES,
} from './session-manager.js';
import {
  buildPolicyStatusBlocks,
  buildPolicySelectionBlocks,
  buildClearBlocks,
  buildModelSelectionBlocks,
  buildReasoningStatusBlocks,
  buildTextBlocks,
  buildErrorBlocks,
  Block,
  ModelInfo,
} from './blocks.js';
import fs from 'fs';

/**
 * Default model and reasoning when not explicitly set.
 */
export const DEFAULT_MODEL = 'gpt-5.2-codex';
export const DEFAULT_MODEL_DISPLAY = 'GPT-5.2 Codex';
export const DEFAULT_REASONING: ReasoningEffort = 'xhigh';

/**
 * Fallback model list when server doesn't provide models.
 * Uses ModelInfo format for consistency with button-based UI.
 */
export const FALLBACK_MODELS: ModelInfo[] = [
  { value: 'gpt-5.2-codex', displayName: 'GPT-5.2 Codex', description: 'Latest frontier agentic coding model.' },
  { value: 'gpt-5.2', displayName: 'GPT-5.2', description: 'Latest frontier model with improvements across knowledge, reasoning and coding.' },
  { value: 'gpt-5.1-codex-max', displayName: 'GPT-5.1 Codex Max', description: 'Codex-optimized flagship for deep and fast reasoning.' },
  { value: 'gpt-5.1-codex-mini', displayName: 'GPT-5.1 Codex Mini', description: 'Optimized for codex. Cheaper, faster, but less capable.' },
];

/**
 * Get model info by value.
 */
export function getModelInfo(modelValue: string): ModelInfo | undefined {
  return FALLBACK_MODELS.find(m => m.value === modelValue);
}

/**
 * Command result to return to the caller.
 */
export interface CommandResult {
  blocks: Block[];
  text: string; // Fallback text
  ephemeral?: boolean; // Whether to send as ephemeral message
  showModelSelection?: boolean; // Flag to trigger model picker with emoji tracking
}

/**
 * Command context.
 */
export interface CommandContext {
  channelId: string;
  threadTs?: string;
  userId: string;
  text: string; // Full message text (or command arguments when passed to handlers)
}

/**
 * Internal context with parsed args.
 */
interface HandlerContext extends CommandContext {
  args: string;
}

/**
 * Parse a command from message text.
 * Returns null if not a command, or { command, args } if it is.
 */
export function parseCommand(text: string): { command: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  const spaceIndex = trimmed.indexOf(' ');
  if (spaceIndex === -1) {
    return { command: trimmed.slice(1).toLowerCase(), args: '' };
  }

  return {
    command: trimmed.slice(1, spaceIndex).toLowerCase(),
    args: trimmed.slice(spaceIndex + 1).trim(),
  };
}

/**
 * Handle /policy command.
 */
export async function handlePolicyCommand(
  context: CommandContext,
  codex: CodexClient
): Promise<CommandResult> {
  const { channelId, threadTs, text: args } = context;

  const currentPolicy = getEffectiveApprovalPolicy(channelId, threadTs);

  if (!args) {
    // Show policy selection prompt
    return {
      blocks: buildPolicySelectionBlocks(currentPolicy),
      text: `Select approval policy (current: ${currentPolicy})`,
    };
  }

  // Parse new policy
  let newPolicy: ApprovalPolicy;
  const normalizedArg = args.toLowerCase().trim();

  // Handle aliases
  if (normalizedArg === 'default') {
    newPolicy = 'on-request';
  } else if (APPROVAL_POLICIES.includes(normalizedArg as ApprovalPolicy)) {
    newPolicy = normalizedArg as ApprovalPolicy;
  } else {
    return {
      blocks: buildErrorBlocks(
        `Invalid policy: "${args}"\nValid policies: ${APPROVAL_POLICIES.join(', ')}, default`
      ),
      text: `Invalid policy: ${args}`,
    };
  }

  // Update session
  if (threadTs) {
    await saveThreadSession(channelId, threadTs, { approvalPolicy: newPolicy });
  } else {
    await saveSession(channelId, { approvalPolicy: newPolicy });
  }

  return {
    blocks: buildPolicyStatusBlocks({ currentPolicy, newPolicy }),
    text: `Approval policy changed: ${currentPolicy} → ${newPolicy}`,
  };
}

/**
 * Handle /clear command.
 */
export async function handleClearCommand(
  context: CommandContext
): Promise<CommandResult> {
  const { channelId, threadTs } = context;

  await clearSession(channelId, threadTs);

  return {
    blocks: buildClearBlocks(),
    text: 'Session cleared. Starting fresh conversation.',
  };
}

/**
 * Handle /model command.
 * Returns showModelSelection flag so slack-bot.ts can handle emoji tracking.
 */
export async function handleModelCommand(
  context: CommandContext,
  _codex: CodexClient
): Promise<CommandResult> {
  const { channelId, threadTs } = context;

  // Get current model
  const session = threadTs
    ? getThreadSession(channelId, threadTs)
    : getSession(channelId);
  const currentModel = session?.model;

  // Use fallback models (button-based UI)
  // The actual model list would come from SDK if available
  const models = FALLBACK_MODELS;

  // Return flag for slack-bot.ts to handle with emoji tracking
  return {
    blocks: buildModelSelectionBlocks(models, currentModel),
    text: 'Select a model.',
    showModelSelection: true,
  };
}

/**
 * Handle /reasoning command.
 */
export async function handleReasoningCommand(
  context: CommandContext
): Promise<CommandResult> {
  const { channelId, threadTs, text: args } = context;

  const validLevels: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh'];

  // Get current level
  const session = threadTs
    ? getThreadSession(channelId, threadTs)
    : getSession(channelId);
  const currentEffort = session?.reasoningEffort;

  if (!args) {
    // Show current level
    return {
      blocks: buildReasoningStatusBlocks(currentEffort),
      text: `Current reasoning effort: ${currentEffort || 'default'}`,
    };
  }

  // Validate and set new level
  const newEffort = args.trim().toLowerCase() as ReasoningEffort;
  if (!validLevels.includes(newEffort)) {
    return {
      blocks: buildErrorBlocks(
        `Invalid reasoning effort: "${args}"\nValid levels: ${validLevels.join(', ')}`
      ),
      text: `Invalid reasoning effort: ${args}`,
    };
  }

  // Update session
  if (threadTs) {
    await saveThreadSession(channelId, threadTs, { reasoningEffort: newEffort });
  } else {
    await saveSession(channelId, { reasoningEffort: newEffort });
  }

  return {
    blocks: buildReasoningStatusBlocks(currentEffort, newEffort),
    text: `Reasoning effort changed: ${currentEffort || 'default'} → ${newEffort}`,
  };
}

/**
 * Handle /status command.
 */
export async function handleStatusCommand(
  context: CommandContext,
  codex: CodexClient
): Promise<CommandResult> {
  const { channelId, threadTs } = context;

  const session = threadTs
    ? getThreadSession(channelId, threadTs)
    : getSession(channelId);

  const workingDir = getEffectiveWorkingDir(channelId, threadTs);
  const policy = getEffectiveApprovalPolicy(channelId, threadTs);

  // Get account info
  let accountInfo = 'Unknown';
  try {
    const account = await codex.getAccount();
    if (account) {
      accountInfo = account.type === 'chatgpt'
        ? `ChatGPT${account.isPlus ? ' Plus' : ''} (${account.email || 'unknown'})`
        : `API Key`;
    } else {
      accountInfo = 'Not authenticated';
    }
  } catch (err) {
    accountInfo = 'Error checking auth';
  }

  // Get effective threadId (may come from channel session via fallback)
  const effectiveThreadId = session?.threadId || getSession(channelId)?.threadId;

  // Format model like CLI: "gpt-5.2-codex (reasoning xhigh)"
  const modelName = session?.model || DEFAULT_MODEL;
  const reasoning = session?.reasoningEffort || DEFAULT_REASONING;

  const lines: string[] = [
    ':information_source: *Codex Session Status*',
    '',
    `*Model:* ${modelName} (reasoning ${reasoning})`,
    `*Directory:* \`${workingDir}\``,
    `*Approval:* ${policy}`,
    `*Account:* ${accountInfo}`,
    `*Session:* \`${effectiveThreadId || 'none'}\``,
  ];

  // Show fork info if applicable
  if (threadTs) {
    const threadSession = getThreadSession(channelId, threadTs);
    if (threadSession?.forkedFrom) {
      lines.push(`*Forked From:* \`${threadSession.forkedFrom}\``);
    }
  }

  return {
    blocks: buildTextBlocks(lines.join('\n')),
    text: 'Session status',
  };
}

/**
 * Handle /cwd command (set working directory).
 */
export async function handleCwdCommand(
  context: CommandContext
): Promise<CommandResult> {
  const { channelId, threadTs, userId, text: args } = context;

  if (!args) {
    // Show current working directory
    const workingDir = getEffectiveWorkingDir(channelId, threadTs);
    return {
      blocks: buildTextBlocks(`:file_folder: *Current Working Directory:*\n\`${workingDir}\``),
      text: `Current working directory: ${workingDir}`,
    };
  }

  // Validate the path exists
  const newPath = args.trim();
  if (!fs.existsSync(newPath)) {
    return {
      blocks: buildErrorBlocks(`Directory not found: \`${newPath}\``),
      text: `Directory not found: ${newPath}`,
    };
  }

  if (!fs.statSync(newPath).isDirectory()) {
    return {
      blocks: buildErrorBlocks(`Not a directory: \`${newPath}\``),
      text: `Not a directory: ${newPath}`,
    };
  }

  // Update session
  if (threadTs) {
    await saveThreadSession(channelId, threadTs, {
      workingDir: newPath,
      pathConfigured: true,
      configuredPath: newPath,
      configuredBy: userId,
      configuredAt: Date.now(),
    });
  } else {
    await saveSession(channelId, {
      workingDir: newPath,
      pathConfigured: true,
      configuredPath: newPath,
      configuredBy: userId,
      configuredAt: Date.now(),
    });
  }

  return {
    blocks: buildTextBlocks(`:white_check_mark: Working directory set to:\n\`${newPath}\``),
    text: `Working directory set to: ${newPath}`,
  };
}

/**
 * Handle /update-rate command.
 */
export async function handleUpdateRateCommand(
  context: CommandContext
): Promise<CommandResult> {
  const { channelId, threadTs, text: args } = context;

  const session = threadTs
    ? getThreadSession(channelId, threadTs)
    : getSession(channelId);
  const currentRate = session?.updateRateSeconds ?? 3;

  if (!args) {
    return {
      blocks: buildTextBlocks(
        `:clock1: *Message Update Rate:* ${currentRate} seconds\n` +
        `_Use \`/update-rate <1-10>\` to change_`
      ),
      text: `Message update rate: ${currentRate} seconds`,
    };
  }

  const newRate = parseInt(args.trim(), 10);
  if (isNaN(newRate) || newRate < 1 || newRate > 10) {
    return {
      blocks: buildErrorBlocks('Update rate must be between 1 and 10 seconds'),
      text: 'Invalid update rate',
    };
  }

  if (threadTs) {
    await saveThreadSession(channelId, threadTs, { updateRateSeconds: newRate });
  } else {
    await saveSession(channelId, { updateRateSeconds: newRate });
  }

  return {
    blocks: buildTextBlocks(`:clock1: Message update rate changed: ${currentRate}s → ${newRate}s`),
    text: `Update rate changed to ${newRate} seconds`,
  };
}

/**
 * Handle /help command.
 */
export function handleHelpCommand(): CommandResult {
  const helpText = `
:robot_face: *Codex Slack Bot Commands*

*Session Management:*
\`/clear\` - Clear session and start fresh
\`/status\` - Show session status

*Configuration:*
\`/policy [policy]\` - View/set approval policy
  _Policies: never, on-request (default), on-failure, untrusted_
\`/model [model]\` - View/set model
\`/reasoning [level]\` - View/set reasoning effort
  _Levels: minimal, low, medium, high, xhigh_
\`/cwd [path]\` - View/set working directory
\`/update-rate [1-10]\` - Set message update rate in seconds

*Help:*
\`/help\` - Show this help message

*Approval Policies:*
• \`never\` - Auto-approve all actions (risky)
• \`on-request\` - Model decides when to ask (default)
• \`on-failure\` - Auto-run in sandbox, prompt on failure
• \`untrusted\` - Prompt for everything except safe reads
`.trim();

  return {
    blocks: buildTextBlocks(helpText),
    text: 'Codex Slack Bot help',
  };
}

/**
 * Route a command to its handler.
 */
export async function handleCommand(
  context: CommandContext,
  codex: CodexClient
): Promise<CommandResult | null> {
  const parsed = parseCommand(context.text);
  if (!parsed) {
    return null;
  }

  const { command, args } = parsed;
  const contextWithArgs = { ...context, text: args };

  switch (command) {
    case 'policy':
      return handlePolicyCommand(contextWithArgs, codex);
    case 'clear':
      return handleClearCommand(contextWithArgs);
    case 'model':
      return handleModelCommand(contextWithArgs, codex);
    case 'reasoning':
      return handleReasoningCommand(contextWithArgs);
    case 'status':
      return handleStatusCommand(contextWithArgs, codex);
    case 'cwd':
    case 'path':
      return handleCwdCommand(contextWithArgs);
    case 'update-rate':
      return handleUpdateRateCommand(contextWithArgs);
    case 'help':
      return handleHelpCommand();
    default:
      // Unknown command - return error, don't send to Codex
      return {
        blocks: buildErrorBlocks(`Unknown command: \`/${command}\`\nType \`/help\` for available commands.`),
        text: `Unknown command: /${command}`,
      };
  }
}
