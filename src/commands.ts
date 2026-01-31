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
 * - /message-size - Set message size limit
 * - /sandbox - Set sandbox mode
 * - /help - Show help
 */

import type { WebClient } from '@slack/web-api';
import type { CodexClient, ApprovalPolicy, ReasoningEffort, SandboxMode } from './codex-client.js';
import {
  getSession,
  saveSession,
  getThreadSession,
  saveThreadSession,
  saveApprovalPolicy,
  saveThreadCharLimit,
  clearSession,
  getEffectiveApprovalPolicy,
  getEffectiveWorkingDir,
  APPROVAL_POLICIES,
  LastUsage,
} from './session-manager.js';
import {
  buildPolicyStatusBlocks,
  buildPolicySelectionBlocks,
  buildClearBlocks,
  buildModelSelectionBlocks,
  buildReasoningStatusBlocks,
  buildTextBlocks,
  buildErrorBlocks,
  buildResumeConfirmationBlocks,
  buildSandboxSelectionBlocks,
  buildSandboxStatusBlocks,
  Block,
  ModelInfo,
} from './blocks.js';
import fs from 'fs';
import path from 'path';

/**
 * Default model and reasoning when not explicitly set.
 */
export const DEFAULT_MODEL = 'gpt-5.2-codex';
export const DEFAULT_MODEL_DISPLAY = 'GPT-5.2 Codex';
export const DEFAULT_REASONING: ReasoningEffort = 'xhigh';

/**
 * Message size configuration for thread responses.
 */
export const MESSAGE_SIZE_MIN = 100;
export const MESSAGE_SIZE_MAX = 36000; // ~90% of Slack's 40k char limit
export const MESSAGE_SIZE_DEFAULT = 500;
export const THINKING_MESSAGE_SIZE = 3000;

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
  showPolicySelection?: boolean; // Flag to trigger policy picker with emoji tracking
  showSandboxSelection?: boolean; // Flag to trigger sandbox picker with emoji tracking
  sandboxModeChange?: SandboxMode; // Flag to restart app-server with new sandbox mode
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
      showPolicySelection: true,
    };
  }

  // Parse new policy
  let newPolicy: ApprovalPolicy;
  const normalizedArg = args.toLowerCase().trim();

  // Handle aliases
  if (normalizedArg === 'default') {
    newPolicy = 'never';
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

  // Update session (channel + thread for inheritance)
  await saveApprovalPolicy(channelId, threadTs, newPolicy);

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
  const { channelId, threadTs, userId } = context;

  await clearSession(channelId, threadTs, userId);

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
 * Handle /resume command.
 * Resumes an existing Codex thread and pins it to the Slack channel/thread session.
 */
export async function handleResumeCommand(
  context: CommandContext,
  codex: CodexClient
): Promise<CommandResult> {
  const { channelId, threadTs, userId, text: args } = context;

  const resumeThreadId = args.trim();
  if (!resumeThreadId) {
    return {
      blocks: buildErrorBlocks('Usage: `/resume <thread-id>`'),
      text: 'Usage: /resume <thread-id>',
    };
  }

  try {
    const threadInfo = await codex.resumeThread(resumeThreadId);

    if (!threadInfo.workingDirectory) {
      throw new Error('Codex did not return a working directory for this session.');
    }

    // Load existing sessions to preserve previous thread IDs and path metadata
    const channelSession = getSession(channelId);
    const threadSession = threadTs ? getThreadSession(channelId, threadTs) : null;

    const previousChannelIds = channelSession?.previousThreadIds ?? [];
    const previousThreadIds = threadSession?.previousThreadIds ?? [];

    const oldChannelThreadId = channelSession?.threadId;
    const oldThreadThreadId = threadSession?.threadId;

    const workingDir = threadInfo.workingDirectory;
    const now = Date.now();

    const isNewContext = threadTs ? !threadSession?.pathConfigured : !channelSession?.pathConfigured;
    const previousPath = threadTs
      ? (threadSession?.configuredPath ?? threadSession?.workingDir)
      : (channelSession?.configuredPath ?? channelSession?.workingDir);
    const pathChanged =
      !!(threadTs ? threadSession?.pathConfigured : channelSession?.pathConfigured) &&
      !!previousPath &&
      previousPath !== workingDir;

    // Update channel-level session (fallback for main-channel mentions)
    await saveSession(channelId, {
      threadId: resumeThreadId,
      workingDir,
      configuredPath: workingDir,
      configuredBy: userId,
      configuredAt: channelSession?.configuredAt ?? now,
      pathConfigured: true,
      previousThreadIds:
        oldChannelThreadId && oldChannelThreadId !== resumeThreadId
          ? [...previousChannelIds, oldChannelThreadId]
          : previousChannelIds,
    });

    // Update thread-level session if applicable
    if (threadTs) {
      const threadIsNew = !threadSession?.pathConfigured;
      await saveThreadSession(channelId, threadTs, {
        threadId: resumeThreadId,
        workingDir,
        configuredPath: workingDir,
        configuredBy: userId,
        configuredAt: threadSession?.configuredAt ?? (threadIsNew ? now : threadSession?.configuredAt),
        pathConfigured: true,
        previousThreadIds:
          oldThreadThreadId && oldThreadThreadId !== resumeThreadId
            ? [...previousThreadIds, oldThreadThreadId]
            : previousThreadIds,
      });
    }

    const previousThreadId =
      oldThreadThreadId && oldThreadThreadId !== resumeThreadId
        ? oldThreadThreadId
        : oldChannelThreadId && oldChannelThreadId !== resumeThreadId
          ? oldChannelThreadId
          : undefined;

    return {
      blocks: buildResumeConfirmationBlocks({
        resumedThreadId: resumeThreadId,
        workingDir,
        previousThreadId,
        isNewChannel: isNewContext,
        previousPath: pathChanged ? previousPath : undefined,
      }),
      text: `Resuming session ${resumeThreadId} in ${workingDir}. Your next message will continue this session.`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return {
      blocks: buildErrorBlocks(`Failed to resume session: ${message}`),
      text: `Failed to resume session: ${message}`,
    };
  }
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

  // Get token usage from Codex session file (source of truth)
  // This correctly tracks usage across multiple clients (bot, CLI, etc.)
  let tokenUsage: { inputTokens: number; outputTokens: number; totalTokens: number; contextWindow: number } | null = null;
  if (effectiveThreadId) {
    try {
      tokenUsage = await codex.getThreadTokenUsage(effectiveThreadId);
    } catch (err) {
      console.error('[status] Failed to get token usage from Codex:', err);
    }
  }

  // Fallback to bot's session storage only if Codex session file unavailable
  const lastUsage = tokenUsage ? null : (session?.lastUsage || getSession(channelId)?.lastUsage);

  // Format model like CLI: "gpt-5.2-codex (reasoning xhigh)"
  const modelName = session?.model || DEFAULT_MODEL;
  const reasoning = session?.reasoningEffort || DEFAULT_REASONING;
  const messageSize = session?.threadCharLimit ?? MESSAGE_SIZE_DEFAULT;
  const messageSizeSuffix = session?.threadCharLimit === undefined ? ' (default)' : '';
  const sandboxMode = codex.getSandboxMode();

  const lines: string[] = [
    ':information_source: *Codex Session Status*',
    '',
    `*Model:* ${modelName} (reasoning ${reasoning})`,
    `*Directory:* \`${workingDir}\``,
    `*Approval:* ${policy}`,
    `*Sandbox:* ${sandboxMode ?? 'default'}`,
    `*Message size:* ${messageSize}${messageSizeSuffix}`,
    `*Account:* ${accountInfo}`,
    `*Session:* \`${effectiveThreadId || 'none'}\``,
  ];

  // Show context window info - prefer Codex session file (source of truth)
  if (tokenUsage) {
    // Use token usage from Codex session file
    const totalTokens = tokenUsage.totalTokens;
    const contextWindow = tokenUsage.contextWindow;
    const contextPercent = contextWindow > 0
      ? Math.min(100, Math.max(0, Math.round((totalTokens / contextWindow) * 100)))
      : 0;
    const percentLeft = 100 - contextPercent;
    lines.push(`*Context window:* ${percentLeft}% left (${(totalTokens / 1000).toFixed(1)}K used / ${(contextWindow / 1000).toFixed(0)}K)`);
  } else if (lastUsage) {
    // Fallback to bot's session storage
    const totalTokens = lastUsage.totalTokens
      ?? (lastUsage.inputTokens + lastUsage.outputTokens);
    const contextPercent = lastUsage.contextWindow > 0
      ? Math.min(100, Math.max(0, Math.round((totalTokens / lastUsage.contextWindow) * 100)))
      : 0;
    const percentLeft = 100 - contextPercent;
    lines.push(`*Context window:* ${percentLeft}% left (${(totalTokens / 1000).toFixed(1)}K used / ${(lastUsage.contextWindow / 1000).toFixed(0)}K)`);
  }

  // Get rate limits and credits
  try {
    const rateLimits = await codex.getRateLimits();
    if (rateLimits) {
      // 5h limit
      if (rateLimits.primary) {
        const pctLeft = 100 - rateLimits.primary.usedPercent;
        const resetTime = rateLimits.primary.resetsAt
          ? new Date(rateLimits.primary.resetsAt * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
          : '';
        lines.push(`*5h limit:* ${pctLeft}% left${resetTime ? ` (resets ${resetTime})` : ''}`);
      }
      // Weekly limit
      if (rateLimits.secondary) {
        const pctLeft = 100 - rateLimits.secondary.usedPercent;
        const resetTime = rateLimits.secondary.resetsAt
          ? new Date(rateLimits.secondary.resetsAt * 1000).toLocaleDateString('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit' })
          : '';
        lines.push(`*Weekly limit:* ${pctLeft}% left${resetTime ? ` (resets ${resetTime})` : ''}`);
      }
      // Credits
      if (rateLimits.credits) {
        if (rateLimits.credits.unlimited) {
          lines.push(`*Credits:* unlimited`);
        } else if (rateLimits.credits.balance !== undefined) {
          const balanceNum = parseFloat(rateLimits.credits.balance);
          const formatted = isNaN(balanceNum) ? rateLimits.credits.balance : `$${balanceNum.toFixed(2)}`;
          lines.push(`*Credits:* ${formatted}`);
        }
      }
    }
  } catch (err) {
    // Rate limits not available
  }

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
 * Handle /sandbox command.
 */
export async function handleSandboxCommand(
  context: CommandContext,
  codex: CodexClient
): Promise<CommandResult> {
  const { text: args } = context;

  const currentMode = codex.getSandboxMode();

  if (!args) {
    return {
      blocks: buildSandboxSelectionBlocks(currentMode),
      text: `Select sandbox mode (current: ${currentMode ?? 'default'})`,
      showSandboxSelection: true,
    };
  }

  const normalized = args.trim().toLowerCase();
  const allowed: SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];
  if (!allowed.includes(normalized as SandboxMode)) {
    return {
      blocks: buildErrorBlocks(
        `Invalid sandbox mode: "${args}"\nValid modes: ${allowed.join(', ')}`
      ),
      text: `Invalid sandbox mode: ${args}`,
    };
  }

  const newMode = normalized as SandboxMode;
  return {
    blocks: buildSandboxStatusBlocks({ currentMode, newMode }),
    text: `Sandbox mode changed: ${currentMode ?? 'default'} → ${newMode}`,
    sandboxModeChange: newMode,
  };
}

/**
 * Handle /message-size command.
 * Sets max response chars before truncation/attachment.
 */
export async function handleMessageSizeCommand(
  context: CommandContext
): Promise<CommandResult> {
  const { channelId, threadTs, text: args } = context;

  const session = threadTs
    ? getThreadSession(channelId, threadTs)
    : getSession(channelId);
  const currentLimit = session?.threadCharLimit;

  if (!args) {
    const display = currentLimit ?? MESSAGE_SIZE_DEFAULT;
    const suffix = currentLimit === undefined ? ' (default)' : '';
    return {
      blocks: buildTextBlocks(`:straight_ruler: Message size limit: ${display}${suffix}`),
      text: `Message size limit: ${display}${suffix}`,
    };
  }

  const value = parseInt(args.trim(), 10);
  if (isNaN(value)) {
    return {
      blocks: buildErrorBlocks(
        `Invalid number. Usage: \`/message-size <${MESSAGE_SIZE_MIN}-${MESSAGE_SIZE_MAX}>\` (default=${MESSAGE_SIZE_DEFAULT})`
      ),
      text: 'Invalid message size',
    };
  }

  if (value < MESSAGE_SIZE_MIN || value > MESSAGE_SIZE_MAX) {
    return {
      blocks: buildErrorBlocks(
        `Value must be between ${MESSAGE_SIZE_MIN} and ${MESSAGE_SIZE_MAX}. Default is ${MESSAGE_SIZE_DEFAULT}.`
      ),
      text: 'Invalid message size',
    };
  }

  await saveThreadCharLimit(channelId, threadTs, value);

  return {
    blocks: buildTextBlocks(`:straight_ruler: Message size limit set to ${value}.`),
    text: `Message size limit set to ${value}.`,
  };
}

/**
 * Handle /ls command - List files in directory.
 * Accepts relative or absolute paths. Always available (before and after path lock).
 */
export async function handleLsCommand(
  context: CommandContext
): Promise<CommandResult> {
  const { channelId, threadTs, text: args } = context;

  // Read from channel session (authoritative source for workingDir and pathConfigured)
  const channelSession = getSession(channelId);
  const currentWorkingDir = channelSession?.workingDir || process.cwd();
  const pathConfigured = channelSession?.pathConfigured ?? false;
  const configuredPath = channelSession?.configuredPath;

  // Determine which directory to list
  let targetDir: string;
  const pathArg = args.trim();

  if (!pathArg) {
    targetDir = currentWorkingDir;
  } else if (pathArg.startsWith('/')) {
    // Absolute path
    targetDir = pathArg;
  } else {
    // Relative path
    targetDir = path.resolve(currentWorkingDir, pathArg);
  }

  // Validate path exists
  if (!fs.existsSync(targetDir)) {
    return {
      blocks: buildErrorBlocks(`Directory does not exist: \`${targetDir}\``),
      text: `Directory does not exist: ${targetDir}`,
    };
  }

  // Check if it's a directory
  try {
    const stats = fs.statSync(targetDir);
    if (!stats.isDirectory()) {
      return {
        blocks: buildErrorBlocks(`Not a directory: \`${targetDir}\``),
        text: `Not a directory: ${targetDir}`,
      };
    }
  } catch (error) {
    return {
      blocks: buildErrorBlocks(`Cannot access: \`${targetDir}\`\n\n${error instanceof Error ? error.message : String(error)}`),
      text: `Cannot access: ${targetDir}`,
    };
  }

  try {
    const files = fs.readdirSync(targetDir);
    const totalFiles = files.length;

    // Format file list with directory indicators
    const fileList = files.map(f => {
      try {
        const filePath = path.join(targetDir, f);
        const stat = fs.statSync(filePath);
        return stat.isDirectory() ? `${f}/` : f;
      } catch {
        return f;
      }
    }).join('\n');

    // Generate hint based on whether path is locked
    let hint: string;
    if (pathConfigured) {
      hint = `:lock: Current locked directory: \`${configuredPath}\``;
    } else {
      hint = `To navigate: \`/cd <path>\`\nTo lock directory: \`/set-current-path\``;
    }

    const lines = [
      `:file_folder: Files in \`${targetDir}\` (${totalFiles} total):`,
      '```',
      fileList || '(empty)',
      '```',
      '',
      hint,
    ];

    return {
      blocks: buildTextBlocks(lines.join('\n')),
      text: `Files in ${targetDir} (${totalFiles} total)`,
    };
  } catch (error) {
    return {
      blocks: buildErrorBlocks(`Cannot read directory: ${error instanceof Error ? error.message : String(error)}`),
      text: `Cannot read directory: ${targetDir}`,
    };
  }
}

/**
 * Handle /cd command - Change working directory (only before path locked).
 * Accepts relative or absolute paths.
 */
export async function handleCdCommand(
  context: CommandContext
): Promise<CommandResult> {
  const { channelId, threadTs, text: args } = context;

  // Read from channel session (authoritative source for workingDir and pathConfigured)
  const channelSession = getSession(channelId);
  const currentWorkingDir = channelSession?.workingDir || process.cwd();
  const pathConfigured = channelSession?.pathConfigured ?? false;
  const configuredPath = channelSession?.configuredPath;

  // Check if path already configured
  if (pathConfigured) {
    return {
      blocks: buildErrorBlocks(
        `/cd is disabled after path locked.\n\nWorking directory is locked to: \`${configuredPath}\`\n\nUse \`/ls [path]\` to explore other directories.`
      ),
      text: '/cd is disabled after path locked',
    };
  }

  // If no path provided, show current directory
  const pathArg = args.trim();
  if (!pathArg) {
    return {
      blocks: buildTextBlocks(
        `:file_folder: Current directory: \`${currentWorkingDir}\`\n\n` +
        `Usage: \`/cd <path>\` (relative or absolute)\n\n` +
        `To lock this directory: \`/set-current-path\``
      ),
      text: `Current directory: ${currentWorkingDir}`,
    };
  }

  // Resolve path (handle both relative and absolute)
  let targetPath: string;
  if (pathArg.startsWith('/')) {
    // Absolute path
    targetPath = pathArg;
  } else {
    // Relative path
    targetPath = path.resolve(currentWorkingDir, pathArg);
  }

  // Validate: path exists
  if (!fs.existsSync(targetPath)) {
    return {
      blocks: buildErrorBlocks(`Directory does not exist: \`${targetPath}\``),
      text: `Directory does not exist: ${targetPath}`,
    };
  }

  // Check if it's a directory (not a file)
  const stats = fs.statSync(targetPath);
  if (!stats.isDirectory()) {
    return {
      blocks: buildErrorBlocks(`Not a directory: \`${targetPath}\``),
      text: `Not a directory: ${targetPath}`,
    };
  }

  // Check read/execute permissions
  try {
    fs.accessSync(targetPath, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    return {
      blocks: buildErrorBlocks(`Cannot access directory: \`${targetPath}\`\n\nPermission denied or directory not readable.`),
      text: `Cannot access directory: ${targetPath}`,
    };
  }

  // Normalize path (resolve symlinks)
  const normalizedPath = fs.realpathSync(targetPath);

  // ALWAYS save to channel session (workingDir is channel-level before lock)
  await saveSession(channelId, { workingDir: normalizedPath });

  // Also update thread session if in a thread
  if (threadTs) {
    await saveThreadSession(channelId, threadTs, { workingDir: normalizedPath });
  }

  return {
    blocks: buildTextBlocks(
      `:file_folder: Changed to \`${normalizedPath}\`\n\n` +
      `Use \`/ls\` to see files, or \`/set-current-path\` to lock this directory.`
    ),
    text: `Changed to ${normalizedPath}`,
  };
}

/**
 * Handle /set-current-path command - Lock current working directory (one-time only).
 */
export async function handleSetCurrentPathCommand(
  context: CommandContext
): Promise<CommandResult> {
  const { channelId, threadTs, userId } = context;

  // Read from channel session (authoritative source for workingDir and pathConfigured)
  const channelSession = getSession(channelId);
  const currentWorkingDir = channelSession?.workingDir || process.cwd();
  const pathConfigured = channelSession?.pathConfigured ?? false;
  const configuredPath = channelSession?.configuredPath;

  // Check if path already configured
  if (pathConfigured) {
    return {
      blocks: buildErrorBlocks(
        `Working directory already locked: \`${configuredPath}\`\n\n` +
        `This cannot be changed. If you need a different directory, use a different channel.`
      ),
      text: `Working directory already locked: ${configuredPath}`,
    };
  }

  // Normalize path (resolve symlinks, remove trailing slash)
  let normalizedPath: string;
  try {
    normalizedPath = fs.realpathSync(currentWorkingDir);
  } catch (error) {
    return {
      blocks: buildErrorBlocks(`Cannot resolve path: \`${currentWorkingDir}\`\n\n${error instanceof Error ? error.message : String(error)}`),
      text: `Cannot resolve path: ${currentWorkingDir}`,
    };
  }

  const now = Date.now();

  // ALWAYS save to channel session (path config is channel-level)
  await saveSession(channelId, {
    pathConfigured: true,
    configuredPath: normalizedPath,
    workingDir: normalizedPath,
    configuredBy: userId,
    configuredAt: now,
  });

  // Also update thread session if in a thread
  if (threadTs) {
    await saveThreadSession(channelId, threadTs, {
      pathConfigured: true,
      configuredPath: normalizedPath,
      workingDir: normalizedPath,
      configuredBy: userId,
      configuredAt: now,
    });
  }

  return {
    blocks: buildTextBlocks(
      `:white_check_mark: Working directory locked to \`${normalizedPath}\`\n\n` +
      `:warning: This cannot be changed. \`/cd\` is now disabled. All Codex operations will use this directory.`
    ),
    text: `Working directory locked to ${normalizedPath}`,
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

*Directory Navigation (fresh session):*
\`/ls [path]\` - List files (always available)
\`/cd [path]\` - Navigate to directory (disabled after lock)
\`/set-current-path\` - Lock current directory (permanent)
\`/cwd [path]\` - View/set and lock working directory

*Configuration:*
\`/policy [policy]\` - View/set approval policy
  _Policies: never (default), on-request, on-failure, untrusted_
\`/model [model]\` - View/set model
\`/reasoning [level]\` - View/set reasoning effort
  _Levels: minimal, low, medium, high, xhigh_
\`/update-rate [1-10]\` - Set message update rate in seconds
\`/message-size [n]\` - Set message size limit before truncation (100-36000, default=500)
\`/sandbox [mode]\` - Set sandbox mode (read-only, workspace-write, danger-full-access)
\`/resume <thread-id>\` - Resume an existing Codex thread

*Help:*
\`/help\` - Show this help message

*Fresh Session Workflow:*
1. \`/ls\` - Explore current directory
2. \`/cd <path>\` - Navigate to target directory
3. \`/set-current-path\` - Lock directory permanently

*Approval Policies:*
• \`never\` - Auto-approve all actions (default)
• \`on-request\` - Model decides when to ask
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
    case 'ls':
      return handleLsCommand(contextWithArgs);
    case 'cd':
      return handleCdCommand(contextWithArgs);
    case 'set-current-path':
      return handleSetCurrentPathCommand(contextWithArgs);
    case 'cwd':
    case 'path':
      return handleCwdCommand(contextWithArgs);
    case 'update-rate':
      return handleUpdateRateCommand(contextWithArgs);
    case 'message-size':
      return handleMessageSizeCommand(contextWithArgs);
    case 'sandbox':
      return handleSandboxCommand(contextWithArgs, codex);
    case 'resume':
      return handleResumeCommand(contextWithArgs, codex);
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
