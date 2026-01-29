/**
 * Block Kit builders for Slack messages.
 * Centralizes construction of interactive message blocks.
 */

import type { ApprovalPolicy, ReasoningEffort } from './codex-client.js';

// Slack Block Kit types (simplified for our use case)
export interface Block {
  type: string;
  block_id?: string;
  text?: {
    type: string;
    text: string;
  };
  elements?: unknown[];
  accessory?: unknown;
}

// ============================================================================
// Status Blocks
// ============================================================================

export interface StatusBlockParams {
  status: 'processing' | 'aborted' | 'error' | 'complete';
  messageTs?: string;
  errorMessage?: string;
  conversationKey?: string; // For abort button
  durationMs?: number; // For complete status
}

/**
 * Build blocks for processing status messages.
 */
export function buildStatusBlocks(params: StatusBlockParams): Block[] {
  const { status, messageTs, errorMessage, conversationKey, durationMs } = params;
  const blocks: Block[] = [];

  switch (status) {
    case 'processing':
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: ':gear: *Processing...*',
        },
      });

      // Add abort button if we have a conversation key
      if (conversationKey) {
        blocks.push({
          type: 'actions',
          block_id: `abort_${messageTs || 'unknown'}`,
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Abort' },
              action_id: `abort_${conversationKey}`,
              style: 'danger',
            },
          ],
        });
      }
      break;

    case 'aborted':
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: ':octagonal_sign: *Aborted*',
        },
      });
      break;

    case 'error':
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:x: *Error*${errorMessage ? `\n${errorMessage}` : ''}`,
        },
      });
      break;

    case 'complete': {
      // Complete status shows checkmark with duration
      const durationText = durationMs ? ` | ${(durationMs / 1000).toFixed(1)}s` : '';
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:white_check_mark: *Complete*${durationText}`,
        },
      });
      break;
    }
  }

  return blocks;
}

// ============================================================================
// Header Blocks
// ============================================================================

export interface HeaderBlockParams {
  status: 'starting' | 'processing' | 'complete' | 'aborted' | 'error';
  approvalPolicy: ApprovalPolicy;
  conversationKey?: string; // For abort button
  model?: string;
  durationMs?: number;
  errorMessage?: string;
}

/**
 * Build a compact header block showing status and metadata.
 */
export function buildHeaderBlock(params: HeaderBlockParams): Block {
  const { status, approvalPolicy, model, durationMs, errorMessage } = params;

  const statusEmoji = {
    starting: ':hourglass_flowing_sand:',
    processing: ':gear:',
    complete: ':white_check_mark:',
    aborted: ':stop_sign:',
    error: ':x:',
  }[status];

  const parts: string[] = [];

  // Status
  parts.push(`${statusEmoji} *${status.charAt(0).toUpperCase() + status.slice(1)}*`);

  // Policy badge
  const policyBadge = {
    never: ':unlock:',
    'on-request': ':question:',
    'on-failure': ':construction:',
    untrusted: ':lock:',
  }[approvalPolicy];
  parts.push(`${policyBadge} ${approvalPolicy}`);

  // Model (if provided)
  if (model) {
    parts.push(`| ${model}`);
  }

  // Duration (if complete)
  if (status === 'complete' && durationMs) {
    const seconds = (durationMs / 1000).toFixed(1);
    parts.push(`| ${seconds}s`);
  }

  // Error message (if error)
  if (status === 'error' && errorMessage) {
    parts.push(`\n${errorMessage}`);
  }

  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: parts.join(' '),
    },
  };
}

// ============================================================================
// Approval Blocks
// ============================================================================

export interface CommandApprovalBlockParams {
  itemId: string;
  threadId: string;
  turnId: string;
  parsedCmd: string;
  risk: string;
  sandboxed: boolean;
  requestId: number;
}

export interface FileChangeApprovalBlockParams {
  itemId: string;
  threadId: string;
  turnId: string;
  filePath: string;
  reason: string;
  requestId: number;
}

/**
 * Build blocks for command execution approval request.
 */
export function buildCommandApprovalBlocks(params: CommandApprovalBlockParams): Block[] {
  const { parsedCmd, risk, sandboxed, requestId } = params;
  const blocks: Block[] = [];

  // Command preview
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `:terminal: *Command Approval Requested*\n\`\`\`${parsedCmd}\`\`\``,
    },
  });

  // Risk level and sandbox status
  const riskEmoji = {
    low: ':white_check_mark:',
    medium: ':warning:',
    high: ':exclamation:',
  }[risk] || ':question:';

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `${riskEmoji} Risk: ${risk} | ${sandboxed ? ':shield: Sandboxed' : ':warning: Not sandboxed'}`,
      },
    ],
  });

  // Approve/Deny buttons
  blocks.push({
    type: 'actions',
    block_id: `approval_${requestId}`,
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Approve' },
        action_id: `approve_${requestId}`,
        style: 'primary',
        value: JSON.stringify({ requestId, decision: 'accept' }),
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Deny' },
        action_id: `deny_${requestId}`,
        style: 'danger',
        value: JSON.stringify({ requestId, decision: 'decline' }),
      },
    ],
  });

  return blocks;
}

/**
 * Build blocks for file change approval request.
 */
export function buildFileChangeApprovalBlocks(params: FileChangeApprovalBlockParams): Block[] {
  const { filePath, reason, requestId } = params;
  const blocks: Block[] = [];

  // File change preview
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `:page_facing_up: *File Change Approval Requested*\n*File:* \`${filePath}\`\n*Reason:* ${reason}`,
    },
  });

  // Approve/Deny buttons
  blocks.push({
    type: 'actions',
    block_id: `approval_${requestId}`,
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Approve' },
        action_id: `approve_${requestId}`,
        style: 'primary',
        value: JSON.stringify({ requestId, decision: 'accept' }),
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Deny' },
        action_id: `deny_${requestId}`,
        style: 'danger',
        value: JSON.stringify({ requestId, decision: 'decline' }),
      },
    ],
  });

  return blocks;
}

/**
 * Build blocks showing approval was granted.
 */
export function buildApprovalGrantedBlocks(command?: string): Block[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: command
          ? `:white_check_mark: *Approved*\n\`\`\`${command}\`\`\``
          : ':white_check_mark: *Approved*',
      },
    },
  ];
}

/**
 * Build blocks showing approval was denied.
 */
export function buildApprovalDeniedBlocks(command?: string): Block[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: command
          ? `:no_entry_sign: *Denied*\n\`\`\`${command}\`\`\``
          : ':no_entry_sign: *Denied*',
      },
    },
  ];
}

// ============================================================================
// Fork Blocks
// ============================================================================

export interface ForkBlockParams {
  turnIndex: number;
  slackTs: string;
  conversationKey: string;
}

/**
 * Build blocks for "Fork here" button.
 */
export function buildForkButton(params: ForkBlockParams): Block {
  const { turnIndex, slackTs, conversationKey } = params;

  return {
    type: 'actions',
    block_id: `fork_${slackTs}`,
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Fork here' },
        action_id: `fork_${conversationKey}_${turnIndex}`,
        value: JSON.stringify({ turnIndex, slackTs, conversationKey }),
      },
    ],
  };

}

// ============================================================================
// Activity Entry Blocks
// ============================================================================

export interface ActivityEntryActionParams {
  conversationKey: string;
  turnIndex: number;
  slackTs: string;
  includeFork?: boolean;
  includeAttachThinking?: boolean;
}

export function buildActivityEntryActions(params: ActivityEntryActionParams): Block {
  const { conversationKey, turnIndex, slackTs, includeFork = true, includeAttachThinking = true } = params;
  const elements: any[] = [];
  if (includeFork) {
    elements.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Fork here' },
      action_id: `fork_${conversationKey}_${turnIndex}`,
      value: JSON.stringify({ turnIndex, slackTs, conversationKey }),
    });
  }
  if (includeAttachThinking) {
    elements.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Attach thinking' },
      action_id: `attach_thinking_${slackTs}`,
      value: JSON.stringify({ conversationKey, slackTs }),
    });
  }
  return {
    type: 'actions',
    block_id: `activity_actions_${slackTs}`,
    elements,
  } as Block;
}

export interface ActivityEntryBlockParams {
  text: string;
  actions?: ActivityEntryActionParams;
}

export function buildActivityEntryBlocks(params: ActivityEntryBlockParams): Block[] {
  const blocks: Block[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: params.text },
    },
  ];
  if (params.actions) {
    blocks.push(buildActivityEntryActions(params.actions));
  }
  return blocks;
}


// ============================================================================
// Command Response Blocks
// ============================================================================

export interface PolicyStatusBlockParams {
  currentPolicy: ApprovalPolicy;
  newPolicy?: ApprovalPolicy;
}

/**
 * Build blocks for /policy command response.
 */
export function buildPolicyStatusBlocks(params: PolicyStatusBlockParams): Block[] {
  const { currentPolicy, newPolicy } = params;
  const blocks: Block[] = [];

  if (newPolicy) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:arrows_counterclockwise: Approval policy changed: *${currentPolicy}* → *${newPolicy}*`,
      },
    });
  } else {
    const descriptions: Record<ApprovalPolicy, string> = {
      never: 'Never prompt, auto-approve all actions',
      'on-request': 'Model decides when to ask (default)',
      'on-failure': 'Auto-run in sandbox, prompt only on failure',
      untrusted: 'Prompt for everything except safe reads',
    };

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:clipboard: *Current Approval Policy:* ${currentPolicy}\n_${descriptions[currentPolicy]}_`,
      },
    });

    // Show available policies
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Available policies: ${['never', 'on-request', 'on-failure', 'untrusted'].join(', ')}`,
        },
      ],
    });
  }

  return blocks;
}

/**
 * Build blocks for /policy command selection prompt.
 */
export function buildPolicySelectionBlocks(currentPolicy: ApprovalPolicy): Block[] {
  const descriptions: Record<ApprovalPolicy, string> = {
    never: 'Never prompt, auto-approve all actions',
    'on-request': 'Model decides when to ask (default)',
    'on-failure': 'Auto-run in sandbox, prompt only on failure',
    untrusted: 'Prompt for everything except safe reads',
  };

  const button = (policy: ApprovalPolicy, label: string) => ({
    type: 'button',
    text: { type: 'plain_text', text: label },
    action_id: `policy_select_${policy}`,
    value: policy,
    ...(currentPolicy === policy ? { style: 'primary' as const } : {}),
  });

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:clipboard: *Select Approval Policy*\nCurrent: *${currentPolicy}*`,
      },
    },
    {
      type: 'actions',
      block_id: 'policy_selection',
      elements: [
        button('never', ':unlock: never'),
        button('on-request', ':question: on-request'),
        button('on-failure', ':construction: on-failure'),
        button('untrusted', ':lock: untrusted'),
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text:
            `- *never* - ${descriptions.never}\n` +
            `- *on-request* - ${descriptions['on-request']}\n` +
            `- *on-failure* - ${descriptions['on-failure']}\n` +
            `- *untrusted* - ${descriptions.untrusted}`,
        },
      ],
    },
  ];
}

/**
 * Build blocks for /clear command response.
 */
export function buildClearBlocks(): Block[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ':broom: *Session cleared.* Starting fresh conversation.',
      },
    },
  ];
}

/**
 * Build blocks for /model command response.
 */
export function buildModelStatusBlocks(
  currentModel: string | undefined,
  availableModels: string[],
  newModel?: string
): Block[] {
  const blocks: Block[] = [];

  if (newModel) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:robot_face: Model changed: *${currentModel || 'default'}* → *${newModel}*`,
      },
    });
  } else {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:robot_face: *Current Model:* ${currentModel || 'default'}`,
      },
    });

    if (availableModels.length > 0) {
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Available models: ${availableModels.join(', ')}`,
          },
        ],
      });
    }
  }

  return blocks;
}

// ============================================================================
// Model Selection Blocks (Button-based two-step flow like ccslack)
// ============================================================================

export interface ModelInfo {
  value: string;       // e.g., "gpt-5.2-codex"
  displayName: string; // e.g., "GPT-5.2 Codex"
  description: string; // Human-readable description
}

/**
 * Build blocks for model selection (Step 1 of 2).
 * Shows model buttons - user clicks one to proceed to reasoning selection.
 */
export function buildModelSelectionBlocks(
  models: ModelInfo[],
  currentModel?: string
): Block[] {
  // Create buttons for each model (max 5 for Slack actions block)
  const buttons = models.slice(0, 5).map(model => ({
    type: 'button' as const,
    text: {
      type: 'plain_text' as const,
      text: model.displayName,
      emoji: true,
    },
    action_id: `model_select_${model.value}`,
    value: model.value,
    ...(currentModel === model.value ? { style: 'primary' as const } : {}),
  }));

  // Build description context
  const descriptions = models.slice(0, 5).map(m =>
    `• *${m.displayName}*: ${m.description}`
  ).join('\n');

  const blocks: Block[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Select Model* (Step 1/2)\nCurrent: \`${currentModel || 'default'}\``,
      },
    },
  ];

  if (buttons.length > 0) {
    blocks.push({
      type: 'actions',
      block_id: 'model_selection',
      elements: buttons,
    });
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: descriptions,
      }],
    });
  } else {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ':warning: No models available. Using default.',
      },
    });
  }

  // Cancel button
  blocks.push({
    type: 'actions',
    block_id: 'model_cancel',
    elements: [{
      type: 'button',
      text: { type: 'plain_text', text: 'Cancel' },
      action_id: 'model_picker_cancel',
    }],
  });

  return blocks;
}

/**
 * Build blocks for reasoning selection (Step 2 of 2).
 * Shows reasoning buttons after model is selected.
 */
export function buildReasoningSelectionBlocks(
  selectedModel: string,
  selectedModelDisplayName: string,
  currentReasoning?: ReasoningEffort
): Block[] {
  const reasoningLevels: Array<{ value: string; label: string; description: string }> = [
    { value: 'minimal', label: 'Minimal', description: 'Fastest, minimal reasoning' },
    { value: 'low', label: 'Low', description: 'Fast responses with light reasoning' },
    { value: 'medium', label: 'Medium', description: 'Balanced speed and depth (default)' },
    { value: 'high', label: 'High', description: 'Greater depth for complex problems' },
    { value: 'xhigh', label: 'Extra High', description: 'Maximum reasoning depth' },
  ];

  const buttons = reasoningLevels.map(level => ({
    type: 'button' as const,
    text: {
      type: 'plain_text' as const,
      text: level.label,
      emoji: true,
    },
    action_id: `reasoning_select_${level.value}`,
    value: JSON.stringify({ model: selectedModel, reasoning: level.value }),
    ...(currentReasoning === level.value ? { style: 'primary' as const } : {}),
  }));

  const descriptions = reasoningLevels.map(l =>
    `• *${l.label}*: ${l.description}`
  ).join('\n');

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Select Reasoning Level* (Step 2/2)\nModel: \`${selectedModelDisplayName}\``,
      },
    },
    {
      type: 'actions',
      block_id: 'reasoning_selection',
      elements: buttons,
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: descriptions,
      }],
    },
    {
      type: 'actions',
      block_id: 'reasoning_cancel',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: 'Cancel' },
        action_id: 'model_picker_cancel',
      }],
    },
  ];
}

/**
 * Build blocks for model selection confirmation.
 */
export function buildModelConfirmationBlocks(
  modelDisplayName: string,
  modelValue: string,
  reasoning: string
): Block[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:white_check_mark: *Settings Updated*\nModel: \`${modelDisplayName}\`\nReasoning: \`${reasoning}\``,
      },
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: 'Changes apply on the next turn.',
      }],
    },
  ];
}

/**
 * Build blocks for model picker cancellation.
 */
export function buildModelPickerCancelledBlocks(): Block[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ':x: Model selection cancelled.',
      },
    },
  ];
}

/**
 * Build blocks for /reasoning command response.
 */
export function buildReasoningStatusBlocks(
  currentEffort: string | undefined,
  newEffort?: string
): Block[] {
  const blocks: Block[] = [];

  if (newEffort) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:brain: Reasoning effort changed: *${currentEffort || 'default'}* → *${newEffort}*`,
      },
    });
  } else {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:brain: *Current Reasoning Effort:* ${currentEffort || 'default'}`,
      },
    });

    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'Available levels: minimal, low, medium, high, xhigh',
        },
      ],
    });
  }

  return blocks;
}

// ============================================================================
// Message Content Blocks
// ============================================================================

/**
 * Build blocks for a text message response.
 */
export function buildTextBlocks(text: string): Block[] {
  // Split long messages into multiple blocks if needed (Slack has 3000 char limit per block)
  const MAX_BLOCK_LENGTH = 2900;
  const blocks: Block[] = [];

  if (text.length <= MAX_BLOCK_LENGTH) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text,
      },
      expand: true, // Prevent Slack "See more" collapse
    } as Block);
  } else {
    // Split at paragraph boundaries when possible
    let remaining = text;
    while (remaining.length > 0) {
      let chunk: string;
      if (remaining.length <= MAX_BLOCK_LENGTH) {
        chunk = remaining;
        remaining = '';
      } else {
        // Try to split at paragraph boundary
        let splitIndex = remaining.lastIndexOf('\n\n', MAX_BLOCK_LENGTH);
        if (splitIndex === -1 || splitIndex < MAX_BLOCK_LENGTH / 2) {
          // No good paragraph boundary, split at line boundary
          splitIndex = remaining.lastIndexOf('\n', MAX_BLOCK_LENGTH);
        }
        if (splitIndex === -1 || splitIndex < MAX_BLOCK_LENGTH / 2) {
          // No good line boundary, split at word boundary
          splitIndex = remaining.lastIndexOf(' ', MAX_BLOCK_LENGTH);
        }
        if (splitIndex === -1) {
          // No good boundary, hard split
          splitIndex = MAX_BLOCK_LENGTH;
        }

        chunk = remaining.slice(0, splitIndex);
        remaining = remaining.slice(splitIndex).trimStart();
      }

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: chunk,
        },
        expand: true, // Prevent Slack "See more" collapse
      } as Block);
    }
  }

  return blocks;
}

// ============================================================================
// Resume Confirmation Blocks
// ============================================================================

export interface ResumeConfirmationParams {
  resumedThreadId: string;
  workingDir: string;
  previousThreadId?: string;
}

/**
 * Build blocks for a resume confirmation message.
 * Mirrors ccslack style with bookmark affordances and a clear next-step hint.
 */
export function buildResumeConfirmationBlocks(params: ResumeConfirmationParams): Block[] {
  const { resumedThreadId, workingDir, previousThreadId } = params;
  const blocks: Block[] = [];

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `:bookmark_tabs: Resumed session \`${resumedThreadId}\` in \`${workingDir}\``,
    },
  });

  if (previousThreadId) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:bookmark: Previous session: \`${previousThreadId}\`\n• _Use_ \`/resume ${previousThreadId}\` _to return_`,
      },
    });
  }

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: 'Your next message will continue this session.',
      },
    ],
  });

  return blocks;
}

/**
 * Build blocks for an error message.
 */
export function buildErrorBlocks(message: string): Block[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:x: *Error*\n${message}`,
      },
    },
  ];
}

// ============================================================================
// Progress Indicators
// ============================================================================

// Auto-compact defaults (mirrors ccslack)
const COMPACT_BUFFER = 13000;
const DEFAULT_EFFECTIVE_MAX_OUTPUT_TOKENS = 32000;
export const DEFAULT_CONTEXT_WINDOW = 200000;

/**
 * Compute auto-compact threshold in tokens.
 */
export function computeAutoCompactThreshold(contextWindow: number, maxOutputTokens?: number): number {
  const effectiveMaxOutput = Math.min(
    DEFAULT_EFFECTIVE_MAX_OUTPUT_TOKENS,
    maxOutputTokens ?? DEFAULT_EFFECTIVE_MAX_OUTPUT_TOKENS
  );
  return contextWindow - effectiveMaxOutput - COMPACT_BUFFER;
}

/** Format token count as "x.yk" with one decimal for readability. */
function formatTokenCount(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return count.toString();
}

/** Format token count as "x.yk" for compact threshold display. */
export function formatTokensK(tokens: number): string {
  return `${(tokens / 1000).toFixed(1)}k`;
}

export interface UnifiedStatusLineParams {
  approvalPolicy: ApprovalPolicy;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  sessionId?: string;
  currentActivity?: string;
  contextPercent?: number;
  contextTokens?: number;
  contextWindow?: number;
  // COMMENTED OUT: compactPercent and tokensToCompact use assumed values (COMPACT_BUFFER=13000,
  // DEFAULT_EFFECTIVE_MAX_OUTPUT_TOKENS=32000) that Codex does NOT provide via API.
  // Verified via test-token-fields.ts: Codex only sends model_context_window, not maxOutputTokens.
  // Keep these fields in case Codex adds this info in the future.
  compactPercent?: number;
  tokensToCompact?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs?: number;
}

/**
 * Build a unified status line showing policy, model, session, and stats.
 * Line 1: policy | model [reason] | session
 * Line 2: activity | ctx/compact | tokens | cost | duration (only when available)
 */
export function buildUnifiedStatusLine(params: UnifiedStatusLineParams): string {
  const line1Parts: string[] = [];
  const line2Parts: string[] = [];

  // Default to gpt-5.2-codex with xhigh reasoning when not explicitly set
  const modelLabel = params.model || 'gpt-5.2-codex';
  const reasoningLabel = params.reasoningEffort || 'xhigh';
  const modelWithReasoning = `${modelLabel} [${reasoningLabel}]`;
  const sessionLabel = params.sessionId || 'n/a';

  line1Parts.push(params.approvalPolicy);
  line1Parts.push(modelWithReasoning);
  line1Parts.push(sessionLabel);

  if (params.currentActivity) {
    line2Parts.push(params.currentActivity);
  }

  // Show context usage: "X% left, Y used / Z"
  // Uses only verified data from Codex (contextWindow is sent via model_context_window)
  if (params.contextPercent !== undefined && params.contextTokens !== undefined && params.contextWindow !== undefined) {
    const percentLeft = (100 - params.contextPercent).toFixed(0);
    const usedK = formatTokensK(params.contextTokens);
    const windowK = formatTokensK(params.contextWindow);
    line2Parts.push(`${percentLeft}% left, ${usedK} / ${windowK}`);
  } else if (params.contextPercent !== undefined) {
    line2Parts.push(`${params.contextPercent.toFixed(1)}% ctx`);
  }

  // COMMENTED OUT: Auto-compact threshold display uses assumed values that Codex does NOT provide.
  // Verified via test-token-fields.ts: Codex only sends model_context_window, not maxOutputTokens.
  // Keep this code in case Codex adds maxOutputTokens in the future.
  // if (params.compactPercent !== undefined && params.tokensToCompact !== undefined) {
  //   line2Parts.push(
  //     `${params.contextPercent?.toFixed(1)}% ctx (${params.compactPercent.toFixed(1)}% ${formatTokensK(
  //       params.tokensToCompact
  //     )} tok to :zap:)`
  //   );
  // }

  if (params.inputTokens !== undefined || params.outputTokens !== undefined) {
    const inStr = formatTokenCount(params.inputTokens ?? 0);
    const outStr = formatTokenCount(params.outputTokens ?? 0);
    line2Parts.push(`${inStr}/${outStr}`);
  }

  if (params.costUsd !== undefined) {
    line2Parts.push(`$${params.costUsd.toFixed(2)}`);
  }

  if (params.durationMs !== undefined) {
    line2Parts.push(`${(params.durationMs / 1000).toFixed(1)}s`);
  }

  const line1 = `_${line1Parts.join(' | ')}_`;
  if (line2Parts.length === 0) {
    return line1;
  }
  return `${line1}\n_${line2Parts.join(' | ')}_`;
}

// ============================================================================
// Todo Extraction (simple, conservative)
// ============================================================================

const TODO_PATTERN = /^\s*[-*]\s*\[\s?\]\s*(.+)$/;

export function extractTodosFromText(text: string, maxItems = 5): string[] {
  const lines = text.split(/\r?\n/);
  const todos: string[] = [];
  for (const line of lines) {
    const match = line.match(TODO_PATTERN);
    if (match && match[1].trim()) {
      todos.push(match[1].trim());
      if (todos.length >= maxItems) break;
    }
  }
  return todos;
}

// ============================================================================
// Abort Confirmation Modal
// ============================================================================

export interface AbortConfirmationModalParams {
  conversationKey: string;
  channelId: string;
  messageTs: string;
}

// ============================================================================
// Activity Blocks
// ============================================================================

export interface ActivityBlockParams {
  activityText: string;
  status: 'running' | 'completed' | 'interrupted' | 'failed';
  conversationKey: string;
  elapsedMs: number;
  entries?: ActivityEntry[]; // For todo extraction
  currentActivity?: string;
  approvalPolicy: ApprovalPolicy;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  sessionId?: string;
  contextPercent?: number;
  contextTokens?: number;
  contextWindow?: number;
  compactPercent?: number;
  tokensToCompact?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  spinner?: string;
}

/**
 * Build blocks for activity message with rolling window of entries.
 * Includes spinner (in-progress), unified status line, and abort button during processing.
 * If entries are provided, extracts and prepends todo list.
 */
export function buildActivityBlocks(params: ActivityBlockParams): Block[] {
  const {
    activityText,
    status,
    conversationKey,
    elapsedMs,
    entries,
    currentActivity,
    approvalPolicy,
    model,
    reasoningEffort,
    sessionId,
    contextPercent,
    contextTokens,
    contextWindow,
    compactPercent,
    tokensToCompact,
    inputTokens,
    outputTokens,
    costUsd,
    spinner,
  } = params;
  const blocks: Block[] = [];
  const elapsedSec = (elapsedMs / 1000).toFixed(1);

  // Extract and format todo list if we have entries
  let displayText = '';
  if (entries && entries.length > 0) {
    const todos = extractLatestTodos(entries);
    const todoText = formatTodoListDisplay(todos);
    if (todoText) {
      displayText = todoText + '\n────\n';
    }
  }
  // Append inline todos from final text (simple) when no extracted todos
  if (!displayText && activityText && status !== 'running') {
    const inlineTodos = extractTodosFromText(activityText);
    if (inlineTodos.length > 0) {
      const todoLines = inlineTodos.map(t => `- [ ] ${t}`).join('\n');
      displayText = `*Todo*\n${todoLines}\n────\n`;
    }
  }
  displayText += activityText || ':gear: Starting...';

  // Activity log section - expand: true prevents Slack "See more" collapse
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: displayText,
    },
    expand: true,
  } as Block);

  const isRunning = status === 'running';

  // Spinner line (in-progress only)
  if (isRunning) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `${spinner || '\u25D0'} [${elapsedSec}s]` }],
    });
  }

  // Unified status line (policy | model | session [+ stats])
  const durationForStats = isRunning ? undefined : elapsedMs;
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: buildUnifiedStatusLine({
          approvalPolicy,
          model,
          reasoningEffort,
          sessionId,
          currentActivity,
          contextPercent,
          contextTokens,
          contextWindow,
          compactPercent,
          tokensToCompact,
          inputTokens,
          outputTokens,
          costUsd,
          durationMs: durationForStats,
        }),
      },
    ],
  });

  // Abort button (only during processing)
  if (isRunning) {
    blocks.push({
      type: 'actions',
      block_id: `status_panel_${conversationKey}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Abort' },
          style: 'danger',
          action_id: `abort_${conversationKey}`,
        },
      ],
    });
  }

  return blocks;
}

// ============================================================================
// Abort Confirmation Modal
// ============================================================================

/**
 * Build a modal view for abort confirmation.
 */
export function buildAbortConfirmationModalView(params: AbortConfirmationModalParams): {
  type: 'modal';
  callback_id: string;
  private_metadata: string;
  title: { type: 'plain_text'; text: string };
  submit: { type: 'plain_text'; text: string };
  close: { type: 'plain_text'; text: string };
  blocks: Block[];
} {
  return {
    type: 'modal',
    callback_id: 'abort_confirmation_modal',
    private_metadata: JSON.stringify(params),
    title: { type: 'plain_text', text: 'Confirm Abort' },
    submit: { type: 'plain_text', text: 'Abort' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: ':warning: *This will interrupt the current processing.*',
        },
      },
    ],
  };
}

// ============================================================================
// Thread Message Formatting (Ported from ccslack)
// ============================================================================

import type { ActivityEntry } from './activity-thread.js';

/**
 * Strip markdown code fence wrapper if present.
 *
 * Case A: Explicit ```markdown or ```md tag -> Always strip
 * Case B: Code blocks with language tags (```python, etc.) -> Never strip
 * Case C: Empty ``` (bare fence) -> Don't strip (preserve as-is)
 */
export function stripMarkdownCodeFence(content: string): string {
  // Must start with ``` and end with ``` on its own line
  if (!content.startsWith('```')) return content;
  if (!/\n```\s*$/.test(content)) return content;

  // Find first newline
  const firstNewline = content.indexOf('\n');
  if (firstNewline === -1) return content;

  // Extract first word as language tag (handles "js filename=x" info strings)
  const tagLine = content.slice(3, firstNewline).trim();
  const tag = tagLine.split(/\s/)[0].toLowerCase();

  // Helper to extract inner content
  const extractInner = (): string | null => {
    const afterFirstLine = content.slice(firstNewline + 1);
    const match = afterFirstLine.match(/^([\s\S]*)\n```\s*$/);
    return match ? match[1].replace(/\r$/, '') : null;
  };

  // CASE A: Explicit markdown/md tag -> strip
  if (tag === 'markdown' || tag === 'md') {
    return extractInner() ?? content;
  }

  // CASE B: Non-empty tag that isn't markdown/md -> don't strip (it's code)
  if (tag !== '') {
    return content;
  }

  // CASE C: Empty tag (bare fence) -> don't strip
  return content;
}

/**
 * Convert standard Markdown to Slack mrkdwn format.
 *
 * Differences:
 * - Bold: **text** or __text__ -> *text*
 * - Italic: *text* or _text_ -> _text_
 * - Bold+Italic: ***text*** or ___text___ -> *_text_*
 * - Strikethrough: ~~text~~ -> ~text~
 * - Links: [text](url) -> <url|text>
 * - Headers: # Header -> *Header*
 * - Tables: | col | col | -> wrapped in code block (Slack doesn't support tables)
 * - Horizontal rules: --- -> unicode line separator
 */
export function markdownToSlack(text: string): string {
  let result = text;

  // Protect code blocks from conversion
  const codeBlocks: string[] = [];
  result = result.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `\u27E6CODE_BLOCK_${codeBlocks.length - 1}\u27E7`;
  });

  // Convert markdown tables to code blocks
  // Match consecutive lines that start and end with |
  result = result.replace(
    /(?:^[ \t]*\|.+\|[ \t]*$\n?)+/gm,
    (table) => {
      const wrapped = '```\n' + table.trimEnd() + '\n```';
      codeBlocks.push(wrapped);
      // If original table ended with newline, preserve it for spacing after code block
      const suffix = table.endsWith('\n') ? '\n' : '';
      return `\u27E6CODE_BLOCK_${codeBlocks.length - 1}\u27E7${suffix}`;
    }
  );

  // Protect inline code
  const inlineCode: string[] = [];
  result = result.replace(/`[^`]+`/g, (match) => {
    inlineCode.push(match);
    return `\u27E6INLINE_CODE_${inlineCode.length - 1}\u27E7`;
  });

  // Convert links: [text](url) -> <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

  // Convert headers: # Header -> temporary marker (will become bold)
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '\u27E6B\u27E7$1\u27E6/B\u27E7');

  // Convert bold+italic combinations FIRST (before bold/italic separately)
  // ***text*** -> *_text_* (bold+italic with asterisks)
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, '\u27E6BI\u27E7$1\u27E6/BI\u27E7');
  // ___text___ -> *_text_* (bold+italic with underscores)
  result = result.replace(/___(.+?)___/g, '\u27E6BI\u27E7$1\u27E6/BI\u27E7');

  // Convert bold: **text** or __text__ -> temporary marker
  result = result.replace(/\*\*(.+?)\*\*/g, '\u27E6B\u27E7$1\u27E6/B\u27E7');
  result = result.replace(/__(.+?)__/g, '\u27E6B\u27E7$1\u27E6/B\u27E7');

  // Convert italic *text* -> _text_ (safe now since bold/headers are marked)
  result = result.replace(/\*([^*\n]+)\*/g, '_$1_');

  // Restore bold+italic markers to _*text*_ (italic wrapping bold)
  result = result.replace(/\u27E6BI\u27E7/g, '_*').replace(/\u27E6\/BI\u27E7/g, '*_');

  // Restore bold markers to *text*
  result = result.replace(/\u27E6B\u27E7/g, '*').replace(/\u27E6\/B\u27E7/g, '*');

  // Convert strikethrough: ~~text~~ -> ~text~
  result = result.replace(/~~(.+?)~~/g, '~$1~');

  // Convert horizontal rules: --- or *** or ___ -> unicode line
  result = result.replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  // Restore inline code
  for (let i = 0; i < inlineCode.length; i++) {
    result = result.replace(`\u27E6INLINE_CODE_${i}\u27E7`, inlineCode[i]);
  }

  // Restore code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    result = result.replace(`\u27E6CODE_BLOCK_${i}\u27E7`, codeBlocks[i]);
  }

  return result;
}

/**
 * Truncate text and close any open formatting markers.
 * Handles: ``` code blocks, ` inline code, * bold, _ italic, ~ strikethrough
 */
export function truncateWithClosedFormatting(text: string, limit: number): string {
  if (text.length <= limit) return text;

  // Reserve space for suffix and potential closing markers
  const suffix = '\n\n_...truncated. Full response attached._';
  const maxContent = limit - suffix.length - 10; // 10 chars buffer for closing markers

  let truncated = text.substring(0, maxContent);

  // Find good break point (newline or space)
  const lastNewline = truncated.lastIndexOf('\n');
  const lastSpace = truncated.lastIndexOf(' ');
  const minBreak = Math.floor(maxContent * 0.8);
  const breakPoint = Math.max(
    lastNewline > minBreak ? lastNewline : -1,
    lastSpace > minBreak ? lastSpace : -1,
    minBreak
  );
  truncated = truncated.substring(0, breakPoint);

  // Close open code blocks (```)
  const codeBlockCount = (truncated.match(/```/g) || []).length;
  const insideCodeBlock = codeBlockCount % 2 === 1;
  if (insideCodeBlock) {
    truncated += '\n```';
  }

  // Only check inline formatting if NOT inside a code block
  // (inside code blocks, backticks/asterisks/etc are literal characters)
  if (!insideCodeBlock) {
    // Close open inline code (`) - count single backticks not part of ```
    const inlineCodeCount = (truncated.match(/(?<!`)`(?!`)/g) || []).length;
    if (inlineCodeCount % 2 === 1) {
      truncated += '`';
    }

    // Close open bold (*) - count single asterisks not part of ** or ***
    const boldCount = (truncated.match(/(?<!\*)\*(?!\*)/g) || []).length;
    if (boldCount % 2 === 1) {
      truncated += '*';
    }

    // Close open italic (_)
    const italicCount = (truncated.match(/(?<!_)_(?!_)/g) || []).length;
    if (italicCount % 2 === 1) {
      truncated += '_';
    }

    // Close open strikethrough (~)
    const strikeCount = (truncated.match(/~/g) || []).length;
    if (strikeCount % 2 === 1) {
      truncated += '~';
    }
  }

  return truncated + suffix;
}

// ============================================================================
// Thread Activity Formatting
// ============================================================================

// Tool emoji mapping for thread messages
const THREAD_TOOL_EMOJI: Record<string, string> = {
  Read: ':mag:',
  Glob: ':mag:',
  Grep: ':mag:',
  Edit: ':memo:',
  Write: ':memo:',
  Bash: ':computer:',
  Shell: ':computer:',
  WebFetch: ':globe_with_meridians:',
  Task: ':robot_face:',
  CommandExecution: ':computer:',
  FileRead: ':mag:',
  FileWrite: ':memo:',
};

/**
 * Get formatted tool name with emoji.
 */
export function formatToolName(tool: string): string {
  const emoji = THREAD_TOOL_EMOJI[tool] || ':gear:';
  return `${emoji} *${tool}*`;
}

/**
 * Format tool input for display (truncated).
 * Handles both string and Record types.
 */
export function formatToolInputSummary(tool: string, input?: string | Record<string, unknown>): string {
  if (!input) return '';

  // Convert Record to string representation for display
  let displayStr: string;
  if (typeof input === 'string') {
    displayStr = input;
  } else {
    // For objects (like TodoWrite input), just show the tool name
    // The actual todos are displayed separately via the todo list
    return '';
  }

  // Truncate to 80 chars max
  const truncated = displayStr.length > 80 ? displayStr.slice(0, 77) + '...' : displayStr;
  return ` \`${truncated}\``;
}

/**
 * Format activity batch entries for thread posting.
 * Groups tool_start and tool_complete for the same tool.
 */
export function formatThreadActivityBatch(entries: ActivityEntry[]): string {
  if (entries.length === 0) return '';

  // Build set of completed tool IDs
  const completedIds = new Set<string>();
  for (const entry of entries) {
    if (entry.type === 'tool_complete' && entry.toolUseId) {
      completedIds.add(entry.toolUseId);
    }
  }

  const lines: string[] = [];
  for (const entry of entries) {
    // Skip tool_start if we have a tool_complete for the same tool
    if (entry.type === 'tool_start' && entry.toolUseId && completedIds.has(entry.toolUseId)) {
      continue;
    }

    const line = formatActivityEntryForThread(entry);
    if (line) {
      lines.push(line);
    }
  }

  return lines.join('\n');
}

/**
 * Format a single activity entry for thread display.
 */
function formatActivityEntryForThread(entry: ActivityEntry): string {
  const duration = entry.durationMs ? ` [${(entry.durationMs / 1000).toFixed(1)}s]` : '';
  const toolEmoji = entry.tool ? THREAD_TOOL_EMOJI[entry.tool] || ':gear:' : ':gear:';
  const toolInput = entry.toolInput ? formatToolInputSummary(entry.tool || '', entry.toolInput) : '';

  switch (entry.type) {
    case 'starting':
      return ':brain: *Analyzing request...*';
    case 'thinking':
      return `:brain: *Thinking*${duration}${entry.charCount ? ` _[${entry.charCount} chars]_` : ''}`;
    case 'tool_start':
      return `${toolEmoji} *${entry.tool}*${toolInput} [in progress]`;
    case 'tool_complete':
      return `:white_check_mark: *${entry.tool}*${toolInput}${duration}`;
    case 'generating':
      return `:pencil: *Generating*${duration}${entry.charCount ? ` _[${entry.charCount} chars]_` : ''}`;
    case 'error':
      return `:x: ${entry.message || 'Error'}`;
    case 'aborted':
      return ':octagonal_sign: *Aborted by user*';
    default:
      return `${toolEmoji} ${entry.message || entry.type}${duration}`;
  }
}

/**
 * Format starting message for thread.
 */
export function formatThreadStartingMessage(): string {
  return ':brain: *Analyzing request...*';
}

/**
 * Format thinking message for thread.
 * Shows duration and character count.
 */
export function formatThreadThinkingMessage(content: string, durationMs?: number): string {
  const durationStr = durationMs ? ` [${(durationMs / 1000).toFixed(1)}s]` : '';
  const charStr = ` _[${content.length} chars]_`;
  return `:brain: *Thinking*${durationStr}${charStr}`;
}

/**
 * Format response message for thread.
 * Shows duration and character count.
 */
export function formatThreadResponseMessage(content: string, durationMs?: number): string {
  const durationStr = durationMs ? ` [${(durationMs / 1000).toFixed(1)}s]` : '';
  const charStr = ` _[${content.length} chars]_`;
  return `:speech_balloon: *Response*${durationStr}${charStr}`;
}

/**
 * Format error message for thread.
 */
export function formatThreadErrorMessage(message: string): string {
  return `:x: *Error*\n${message}`;
}

// ============================================================================
// Todo List Display (Ported from ccslack)
// ============================================================================

export const TODO_LIST_MAX_CHARS = 500; // Max chars for todo section at top of activity message

/**
 * Todo item from SDK TodoWrite tool.
 */
export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;  // Optional - may be missing in older SDK versions
}

/**
 * Type guard to validate a todo item structure.
 */
export function isTodoItem(item: unknown): item is TodoItem {
  return typeof item === 'object' && item !== null &&
    'content' in item && typeof (item as any).content === 'string' &&
    'status' in item && ['pending', 'in_progress', 'completed'].includes((item as any).status);
}

/**
 * Extract the latest todo list from activity log.
 * Searches backwards for the most recent TodoWrite tool_complete entry.
 * Falls back to tool_start if no complete entry exists (for in-progress display).
 */
export function extractLatestTodos(activityLog: ActivityEntry[]): TodoItem[] {
  // Search backwards for the most recent TodoWrite entry
  for (let i = activityLog.length - 1; i >= 0; i--) {
    const entry = activityLog[i];
    const toolName = (entry.tool || '').toLowerCase();

    // Prefer tool_complete entries
    if (entry.type === 'tool_complete' && toolName === 'todowrite') {
      const toolInput = entry.toolInput;
      if (toolInput && typeof toolInput === 'object' && 'todos' in toolInput) {
        const todos = (toolInput as { todos?: unknown }).todos;
        if (Array.isArray(todos)) {
          return todos.filter(isTodoItem);
        }
      }
    }
  }

  // Fallback: check for tool_start if no complete entry found
  for (let i = activityLog.length - 1; i >= 0; i--) {
    const entry = activityLog[i];
    const toolName = (entry.tool || '').toLowerCase();

    if (entry.type === 'tool_start' && toolName === 'todowrite') {
      const toolInput = entry.toolInput;
      if (toolInput && typeof toolInput === 'object' && 'todos' in toolInput) {
        const todos = (toolInput as { todos?: unknown }).todos;
        if (Array.isArray(todos)) {
          return todos.filter(isTodoItem);
        }
      }
    }
  }

  return [];
}

/**
 * Format a single todo item for display.
 * Truncates text to 50 chars max.
 */
function formatTodoItem(item: TodoItem): string {
  const text = item.status === 'in_progress'
    ? (item.activeForm || item.content)
    : item.content;
  const truncated = text.length > 50 ? text.slice(0, 47) + '...' : text;

  switch (item.status) {
    case 'completed':
      return `:ballot_box_with_check: ~${truncated}~`;
    case 'in_progress':
      return `:arrow_right: *${truncated}*`;
    case 'pending':
      return `:white_large_square: ${truncated}`;
    default:
      return `:white_large_square: ${truncated}`;
  }
}

/**
 * Format todo list for display at top of activity message.
 * Implements smart truncation algorithm:
 * 1. Try to fit all items first
 * 2. If exceeds maxChars, prioritize in_progress items
 * 3. Show up to 3 most recent completed, pending items until limit
 * 4. Add summaries for truncated sections
 */
export function formatTodoListDisplay(todos: TodoItem[], maxChars: number = TODO_LIST_MAX_CHARS): string {
  if (todos.length === 0) return '';

  // Separate todos by status (preserving order)
  const completed: TodoItem[] = [];
  const inProgress: TodoItem[] = [];
  const pending: TodoItem[] = [];

  for (const todo of todos) {
    if (todo.status === 'completed') completed.push(todo);
    else if (todo.status === 'in_progress') inProgress.push(todo);
    else pending.push(todo);
  }

  const total = todos.length;
  const completedCount = completed.length;
  const allDone = completedCount === total;

  // Header: 📋 Tasks (completed/total) ✓ (checkmark when all done)
  const header = allDone
    ? `:clipboard: *Tasks (${completedCount}/${total})* :white_check_mark:`
    : `:clipboard: *Tasks (${completedCount}/${total})*`;

  // Special case: no in_progress items - add divider between completed and pending
  const hasInProgress = inProgress.length > 0;
  const needsDivider = !hasInProgress && completed.length > 0 && pending.length > 0;

  // Try to fit all items first
  const allLines = [
    ...completed.map(formatTodoItem),
    ...(needsDivider ? ['────'] : []),
    ...inProgress.map(formatTodoItem),
    ...pending.map(formatTodoItem),
  ];
  const fullText = [header, ...allLines].join('\n');

  if (fullText.length <= maxChars) {
    // All items fit - return full list
    return fullText;
  }

  // Smart truncation needed
  const lines: string[] = [header];
  let charCount = header.length;

  // Track truncation
  let completedShown = 0;
  let pendingShown = 0;
  const MAX_COMPLETED_SHOWN = 3;
  const MAX_PENDING_SHOWN = 3;

  // Helper to add line if it fits
  const addLine = (line: string): boolean => {
    if (charCount + 1 + line.length <= maxChars - 30) { // Reserve 30 chars for summaries
      lines.push(line);
      charCount += 1 + line.length;
      return true;
    }
    return false;
  };

  // Show last 3 completed (most recent)
  const completedToShow = completed.slice(-MAX_COMPLETED_SHOWN);
  const completedTruncated = completed.length - completedToShow.length;

  // Add completed truncation summary at top if needed
  if (completedTruncated > 0) {
    addLine(`...${completedTruncated} more completed`);
  }

  // Add shown completed items
  for (const item of completedToShow) {
    if (addLine(formatTodoItem(item))) completedShown++;
  }

  // Add all in_progress items (non-negotiable)
  for (const item of inProgress) {
    addLine(formatTodoItem(item));
  }

  // Add divider if no in_progress (between completed and pending)
  if (!hasInProgress && completed.length > 0 && pending.length > 0) {
    addLine('────');
  }

  // Add pending items until limit
  for (const item of pending.slice(0, MAX_PENDING_SHOWN)) {
    if (addLine(formatTodoItem(item))) pendingShown++;
    else break;
  }

  // Add pending truncation summary if needed
  const pendingTruncated = pending.length - pendingShown;
  if (pendingTruncated > 0) {
    lines.push(`...${pendingTruncated} more pending`);
  }

  return lines.join('\n');
}
