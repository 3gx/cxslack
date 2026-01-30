/**
 * Block Kit builders for Slack messages.
 * Centralizes construction of interactive message blocks.
 */

import type { ApprovalPolicy, ReasoningEffort, SandboxMode } from './codex-client.js';

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
  /** Codex turn ID - used to query actual index from Codex (source of truth) */
  turnId: string;
  slackTs: string;
  conversationKey: string;
}

/**
 * Build blocks for "Fork here" button.
 * Matches ccslack style: emoji + text, shown only after query completes.
 *
 * NOTE: We store turnId (not turnIndex) because the index must always be
 * queried from Codex at fork time to handle CLI usage, bot restarts, etc.
 */
export function buildForkButton(params: ForkBlockParams): Block {
  const { turnId, slackTs, conversationKey } = params;

  return {
    type: 'actions',
    block_id: `fork_${slackTs}`,
    elements: [
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: ':twisted_rightwards_arrows: Fork here',
          emoji: true,
        },
        action_id: `fork_${conversationKey}_${turnId}`,
        value: JSON.stringify({ turnId, slackTs, conversationKey }),
      },
    ],
  };
}

// ============================================================================
// Activity Entry Blocks
// ============================================================================

export interface ActivityEntryActionParams {
  conversationKey: string;
  /** Codex turn ID - used to query actual index from Codex (source of truth) */
  turnId: string;
  slackTs: string;
  includeFork?: boolean;
  includeAttachThinking?: boolean;
}

export function buildActivityEntryActions(params: ActivityEntryActionParams): Block {
  const { conversationKey, turnId, slackTs, includeFork = true, includeAttachThinking = true } = params;
  const elements: any[] = [];
  if (includeFork) {
    elements.push({
      type: 'button',
      text: {
        type: 'plain_text',
        text: ':twisted_rightwards_arrows: Fork here',
        emoji: true,
      },
      action_id: `fork_${conversationKey}_${turnId}`,
      value: JSON.stringify({ turnId, slackTs, conversationKey }),
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

// Helper for mapping tool/thinking entries to block actions in thread activity
// NOTE: Fork button should ONLY appear on the main activity/status panel (buildActivityBlocks),
// NOT on individual per-entry thread posts. This matches ccslack behavior.
export function buildActivityEntryActionParams(
  entry: import('./activity-thread.js').ActivityEntry,
  conversationKey: string,
  turnId: string,
  slackTs: string,
  includeAttachThinking: boolean
): ActivityEntryActionParams | undefined {
  // Fork button is DISABLED on per-entry posts - it should only appear on the status panel
  // This matches ccslack behavior where fork is only on the main activity message
  const includeFork = false;
  const isThinking = entry.type === 'thinking';
  if (!includeFork && !(includeAttachThinking && isThinking)) {
    return undefined;
  }
  return {
    conversationKey,
    turnId,
    slackTs,
    includeFork,
    includeAttachThinking: includeAttachThinking && isThinking,
  };
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
      never: 'Never prompt, auto-approve all actions (default)',
      'on-request': 'Model decides when to ask',
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
    never: 'Never prompt, auto-approve all actions (default)',
    'on-request': 'Model decides when to ask',
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
    {
      type: 'actions',
      block_id: 'policy_cancel',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: 'Cancel' },
        action_id: 'policy_picker_cancel',
      }],
    },
  ];
}

/**
 * Build blocks for policy picker cancellation.
 */
export function buildPolicyPickerCancelledBlocks(): Block[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ':x: Policy selection cancelled.',
      },
    },
  ];
}

export interface SandboxStatusBlockParams {
  currentMode?: SandboxMode;
  newMode?: SandboxMode;
}

function formatSandboxMode(mode?: SandboxMode): string {
  return mode ?? 'default';
}

/**
 * Build blocks for /sandbox command response.
 */
export function buildSandboxStatusBlocks(params: SandboxStatusBlockParams): Block[] {
  const { currentMode, newMode } = params;
  const blocks: Block[] = [];

  const descriptions: Record<SandboxMode, string> = {
    'read-only': 'Read-only access (no edits or command execution)',
    'workspace-write': 'Read/write in workspace',
    'danger-full-access': 'Full access to filesystem + network (default for this bot)',
  };

  if (newMode) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:shield: Sandbox mode changed: *${formatSandboxMode(currentMode)}* → *${newMode}*`,
      },
    });
  } else {
    const display = formatSandboxMode(currentMode);
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:shield: *Current Sandbox Mode:* ${display}`,
      },
    });
  }

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text:
          `- *read-only* - ${descriptions['read-only']}\n` +
          `- *workspace-write* - ${descriptions['workspace-write']}\n` +
          `- *danger-full-access* - ${descriptions['danger-full-access']}`,
      },
    ],
  });

  return blocks;
}

/**
 * Build blocks for /sandbox command selection prompt.
 */
export function buildSandboxSelectionBlocks(currentMode?: SandboxMode): Block[] {
  const button = (mode: SandboxMode, label: string) => ({
    type: 'button',
    text: { type: 'plain_text', text: label },
    action_id: `sandbox_select_${mode}`,
    value: mode,
    ...(currentMode === mode ? { style: 'primary' as const } : {}),
    ...(mode === 'danger-full-access' && currentMode !== mode ? { style: 'danger' as const } : {}),
  });

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:shield: *Select Sandbox Mode*\nCurrent: *${formatSandboxMode(currentMode)}*`,
      },
    },
    {
      type: 'actions',
      block_id: 'sandbox_selection',
      elements: [
        button('read-only', ':lock: read-only'),
        button('workspace-write', ':memo: workspace-write'),
        button('danger-full-access', ':warning: danger-full-access'),
      ],
    },
    {
      type: 'actions',
      block_id: 'sandbox_cancel',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: 'Cancel' },
        action_id: 'sandbox_picker_cancel',
      }],
    },
  ];
}

/**
 * Build blocks for sandbox picker cancellation.
 */
export function buildSandboxPickerCancelledBlocks(): Block[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ':x: Sandbox selection cancelled.',
      },
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
  sandboxMode?: SandboxMode;
  sessionId?: string;
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
 * Line 2: ctx | tokens | cost | duration (only when available)
 */
export function buildUnifiedStatusLine(params: UnifiedStatusLineParams): string {
  const line1Parts: string[] = [];
  const line2Parts: string[] = [];

  // Default to gpt-5.2-codex with xhigh reasoning when not explicitly set
 const modelLabel = params.model || 'gpt-5.2-codex';
  const reasoningLabel = params.reasoningEffort || 'xhigh';
  const modelWithReasoning = `${modelLabel} [${reasoningLabel}]`;
  const sandboxLabel = params.sandboxMode || 'danger-full-access';
  const sessionLabel = params.sessionId || 'n/a';

  line1Parts.push(params.approvalPolicy);
  line1Parts.push(modelWithReasoning);
  line1Parts.push(sandboxLabel);
  line1Parts.push(sessionLabel);

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
// Fork to Channel Modal
// ============================================================================

export interface ForkToChannelModalParams {
  sourceChannelId: string;
  sourceChannelName: string;
  sourceMessageTs: string;
  sourceThreadTs: string;
  conversationKey: string;
  /** Codex turn ID - actual index is queried from Codex at fork execution time */
  turnId: string;
  /** Suggested channel name (computed by checking existing forks) */
  suggestedName: string;
}

/**
 * Build a modal view for fork-to-channel.
 * User can specify the new channel name (prefilled with {channelName}-fork).
 */
// Input block type for modals (uses singular 'element' not 'elements')
interface InputBlock {
  type: 'input';
  block_id: string;
  element: {
    type: 'plain_text_input';
    action_id: string;
    placeholder?: { type: 'plain_text'; text: string };
    initial_value?: string;
    max_length?: number;
  };
  label: { type: 'plain_text'; text: string };
  hint?: { type: 'plain_text'; text: string };
}

type ModalBlock = Block | InputBlock;

export function buildForkToChannelModalView(params: ForkToChannelModalParams): {
  type: 'modal';
  callback_id: string;
  private_metadata: string;
  title: { type: 'plain_text'; text: string };
  submit: { type: 'plain_text'; text: string };
  close: { type: 'plain_text'; text: string };
  blocks: ModalBlock[];
} {
  return {
    type: 'modal',
    callback_id: 'fork_to_channel_modal',
    private_metadata: JSON.stringify(params),
    title: { type: 'plain_text', text: 'Fork to Channel' },
    submit: { type: 'plain_text', text: 'Create Fork' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:twisted_rightwards_arrows: *Fork conversation from this point*\n\nThis will create a new channel with a forked copy of the conversation up to this point.`,
        },
      },
      {
        type: 'input',
        block_id: 'channel_name_block',
        element: {
          type: 'plain_text_input',
          action_id: 'channel_name_input',
          placeholder: { type: 'plain_text', text: 'Enter channel name' },
          initial_value: params.suggestedName,
          max_length: 80,
        },
        label: { type: 'plain_text', text: 'New Channel Name' },
        hint: { type: 'plain_text', text: 'Channel names can only contain lowercase letters, numbers, and hyphens.' },
      },
    ],
  };
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
  approvalPolicy: ApprovalPolicy;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  sandboxMode?: SandboxMode;
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
  /** Codex turn ID for fork button - index is queried from Codex at fork time */
  forkTurnId?: string;
  forkSlackTs?: string;
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
    approvalPolicy,
    model,
    reasoningEffort,
    sandboxMode,
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
          sandboxMode,
          sessionId,
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

  // Fork button on main activity/status panel - ONLY after query completes (matches ccslack UX)
  // During processing: show Abort button
  // After completion: show Fork button (replaces Abort)
  if (!isRunning && params.forkTurnId && params.forkSlackTs) {
    blocks.push(
      buildForkButton({
        turnId: params.forkTurnId,
        slackTs: params.forkSlackTs,
        conversationKey,
      })
    );
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
  TodoWrite: ':clipboard:',
  WebSearch: ':mag:',
  NotebookEdit: ':notebook:',
  Skill: ':zap:',
  AskUserQuestion: ':question:',
};

// ============================================================================
// Tool Formatting Helpers (ported from ccslack)
// ============================================================================

function truncatePath(path: string, maxLen: number): string {
  if (path.length <= maxLen) return path;
  const parts = path.split('/');
  if (parts.length <= 2) return path.slice(-maxLen);
  // Keep last 2 segments
  const lastTwo = parts.slice(-2).join('/');
  return lastTwo.length <= maxLen ? lastTwo : '...' + path.slice(-(maxLen - 3));
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

function truncateUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 20 ? u.pathname.slice(0, 17) + '...' : u.pathname;
    return u.hostname + path;
  } catch {
    return truncateText(url, 35);
  }
}

/**
 * Canonical tool name mapping.
 * Maps alternative/legacy tool names to their display names.
 */
const TOOL_NAME_ALIASES: Record<string, string> = {
  commandexecution: 'Bash',
  fileread: 'Read',
  filewrite: 'Write',
  shell: 'Bash',
};

/**
 * Normalize tool name for display and comparison.
 * Handles:
 * - MCP-style names like "mcp__claude-code__Read" -> "Read"
 * - Legacy names like "commandExecution" -> "Bash"
 * - Case normalization
 */
export function normalizeToolName(toolName: string): string {
  // Handle MCP-style names first
  let name = toolName;
  if (name.includes('__')) {
    name = name.split('__').pop()!;
  }

  // Check for aliases (case-insensitive)
  const alias = TOOL_NAME_ALIASES[name.toLowerCase()];
  if (alias) {
    return alias;
  }

  return name;
}

/**
 * Get formatted tool name with emoji.
 */
export function formatToolName(tool: string): string {
  const normalized = normalizeToolName(tool);
  const emoji = THREAD_TOOL_EMOJI[normalized] || ':gear:';
  return `${emoji} *${normalized}*`;
}

/**
 * Get emoji for a tool.
 */
export function getToolEmoji(tool: string): string {
  const normalized = normalizeToolName(tool);
  return THREAD_TOOL_EMOJI[normalized] || ':gear:';
}

/**
 * Format tool input as compact inline summary for display.
 * Returns a short string with the key parameter for each tool type.
 * Ported from ccslack - battle-tested tool-specific formatting.
 */
export function formatToolInputSummary(toolName: string, input?: string | Record<string, unknown>): string {
  if (!input) return '';

  // Handle string input (legacy format)
  if (typeof input === 'string') {
    const truncated = input.length > 80 ? input.slice(0, 77) + '...' : input;
    return ` \`${truncated}\``;
  }

  const tool = normalizeToolName(toolName).toLowerCase();

  switch (tool) {
    // Tools with special UI - show tool name only (no input details)
    case 'askuserquestion':
      return '';  // Has its own button UI

    case 'read':
    case 'edit':
    case 'write':
      return input.file_path ? ` \`${truncatePath(input.file_path as string, 40)}\`` : '';
    case 'grep':
      return input.pattern ? ` \`"${truncateText(input.pattern as string, 25)}"\`` : '';
    case 'glob':
      return input.pattern ? ` \`${truncateText(input.pattern as string, 30)}\`` : '';
    case 'bash':
    case 'commandexecution':
      return input.command ? ` \`${truncateText(input.command as string, 35)}\`` : '';
    case 'task':
      const subtype = input.subagent_type ? `:${input.subagent_type}` : '';
      const desc = input.description ? ` "${truncateText(input.description as string, 25)}"` : '';
      return `${subtype}${desc}`;
    case 'webfetch':
      return input.url ? ` \`${truncateUrl(input.url as string)}\`` : '';
    case 'websearch':
      if (input.query) {
        return ` "${truncateText(input.query as string, 30)}"`;
      }
      return input.url ? ` \`${truncateUrl(input.url as string)}\`` : '';
    case 'todowrite': {
      const todoItems = Array.isArray(input.todos) ? input.todos.filter(isTodoItem) : [];
      if (todoItems.length === 0) return '';
      const completedCnt = todoItems.filter((t: TodoItem) => t.status === 'completed').length;
      const inProgressCnt = todoItems.filter((t: TodoItem) => t.status === 'in_progress').length;
      const pendingCnt = todoItems.filter((t: TodoItem) => t.status === 'pending').length;
      // Build compact status: "3✓ 1→ 5☐" (omit zeros)
      const parts: string[] = [];
      if (completedCnt > 0) parts.push(`${completedCnt}✓`);
      if (inProgressCnt > 0) parts.push(`${inProgressCnt}→`);
      if (pendingCnt > 0) parts.push(`${pendingCnt}☐`);
      return parts.length > 0 ? ` ${parts.join(' ')}` : '';
    }
    case 'notebookedit':
      return input.notebook_path ? ` \`${truncatePath(input.notebook_path as string, 35)}\`` : '';
    case 'skill':
      return input.skill ? ` \`${input.skill}\`` : '';
    default:
      // Generic fallback: show first meaningful string parameter
      const firstParam = Object.entries(input)
        .find(([k, v]) => typeof v === 'string' && v.length > 0 && v.length < 50 && !k.startsWith('_'));
      if (firstParam) {
        return ` \`${truncateText(String(firstParam[1]), 30)}\``;
      }
      return '';
  }
}

/**
 * Format result metrics as inline summary for display.
 * Shows line counts, match counts, or edit diff depending on tool type.
 * Tool-aware: only shows lineCount for Read/Write, not for Bash.
 */
export function formatToolResultSummary(entry: ActivityEntry): string {
  const tool = normalizeToolName(entry.tool || '').toLowerCase();

  if (entry.matchCount !== undefined) {
    return ` → ${entry.matchCount} ${entry.matchCount === 1 ? 'match' : 'matches'}`;
  }
  // Only show lineCount for Read/Write tools, NOT for Bash commands
  if (entry.lineCount !== undefined && (tool === 'read' || tool === 'write')) {
    return ` (${entry.lineCount} lines)`;
  }
  if (entry.linesAdded !== undefined || entry.linesRemoved !== undefined) {
    return ` (+${entry.linesAdded || 0}/-${entry.linesRemoved || 0})`;
  }
  return '';
}

/**
 * Format tool output preview for display.
 * Handles different tool types with appropriate formatting.
 */
export function formatOutputPreview(tool: string, preview: string): string {
  const cleaned = preview.replace(/[\x00-\x1F\x7F]/g, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';

  const toolLower = normalizeToolName(tool).toLowerCase();
  switch (toolLower) {
    case 'bash':
    case 'commandexecution':
      return `\`${cleaned.slice(0, 150)}\`${cleaned.length > 150 ? '...' : ''}`;
    case 'grep':
    case 'glob':
      const matches = preview.split('\n').filter(l => l.trim()).slice(0, 3);
      return matches.length ? matches.map(m => `\`${m.slice(0, 50)}\``).join(', ') : 'No matches';
    case 'read':
      return `\`${cleaned.slice(0, 100)}\`${cleaned.length > 100 ? '...' : ''}`;
    case 'websearch':
      return cleaned;
    default:
      return cleaned.length > 100 ? cleaned.slice(0, 100) + '...' : cleaned;
  }
}

/**
 * Format tool details as bullet points for thread display.
 * Returns an array of detail lines to be prefixed with "• ".
 * Ported from ccslack - comprehensive tool-specific details.
 */
export function formatToolDetails(entry: ActivityEntry): string[] {
  const details: string[] = [];
  const tool = normalizeToolName(entry.tool || '').toLowerCase();
  const input = typeof entry.toolInput === 'object' ? entry.toolInput as Record<string, unknown> : undefined;

  // Tools with special UI - show duration only
  if (tool === 'askuserquestion') {
    if (entry.durationMs !== undefined) {
      details.push(`Duration: ${(entry.durationMs / 1000).toFixed(1)}s`);
    }
    return details;
  }

  if (tool === 'read' && entry.lineCount !== undefined) {
    details.push(`Read: ${entry.lineCount} lines`);
  }
  if (tool === 'edit' && (entry.linesAdded !== undefined || entry.linesRemoved !== undefined)) {
    details.push(`Changed: +${entry.linesAdded || 0}/-${entry.linesRemoved || 0} lines`);
  }
  if (tool === 'write' && entry.lineCount !== undefined) {
    details.push(`Wrote: ${entry.lineCount} lines`);
  }
  if (tool === 'grep') {
    if (input?.path) details.push(`Path: \`${input.path}\``);
    if (entry.matchCount !== undefined) details.push(`Found: ${entry.matchCount} matches`);
  }
  if (tool === 'glob' && entry.matchCount !== undefined) {
    details.push(`Found: ${entry.matchCount} files`);
  }
  if ((tool === 'bash' || tool === 'commandexecution') && input?.command) {
    details.push(`Command: \`${truncateText(input.command as string, 60)}\``);
  }
  if (tool === 'task') {
    if (input?.subagent_type) details.push(`Type: ${input.subagent_type}`);
    if (input?.description) details.push(`Task: ${truncateText(input.description as string, 50)}`);
  }
  if (tool === 'websearch') {
    if (input?.query) details.push(`Query: "${truncateText(input.query as string, 40)}"`);
  }
  if (tool === 'todowrite') {
    const todoItems = Array.isArray(input?.todos) ? input.todos.filter(isTodoItem) : [];
    if (todoItems.length > 0) {
      const completedCnt = todoItems.filter((t: TodoItem) => t.status === 'completed').length;
      const inProgressItems = todoItems.filter((t: TodoItem) => t.status === 'in_progress');
      const pendingCnt = todoItems.filter((t: TodoItem) => t.status === 'pending').length;
      const total = todoItems.length;

      if (completedCnt === total) {
        details.push(`All tasks completed`);
      } else {
        if (completedCnt > 0) details.push(`✓ ${completedCnt} completed`);
        for (const t of inProgressItems) {
          const text = t.activeForm || t.content;
          const truncated = text.length > 40 ? text.slice(0, 37) + '...' : text;
          details.push(`→ ${truncated}`);
        }
        if (pendingCnt > 0) details.push(`☐ ${pendingCnt} pending`);
      }
    }
  }

  // Generic fallback for unknown tools: show first 2 params
  if (details.length === 0 && input) {
    const params = Object.entries(input)
      .filter(([k, v]) => !k.startsWith('_') && v !== undefined && v !== null)
      .slice(0, 2);
    for (const [key, value] of params) {
      const displayValue = typeof value === 'string'
        ? truncateText(value, 40)
        : JSON.stringify(value).slice(0, 40);
      details.push(`${key}: \`${displayValue}\``);
    }
  }

  // Add output preview or error message before duration
  if (entry.toolIsError) {
    details.push(`:warning: Error: ${entry.toolErrorMessage?.slice(0, 100) || 'Unknown error'}`);
  } else if (entry.toolOutputPreview) {
    const outputPreview = formatOutputPreview(tool, entry.toolOutputPreview);
    if (outputPreview) {
      details.push(`Output: ${outputPreview}`);
    }
  }

  if (entry.durationMs !== undefined) {
    details.push(`Duration: ${(entry.durationMs / 1000).toFixed(1)}s`);
  }

  return details;
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

    const line = formatThreadActivityEntry(entry);
    if (line) {
      lines.push(line);
    }
  }

  return lines.join('\n');
}

export function formatThreadActivityEntry(entry: ActivityEntry): string {
  const toolEmoji = entry.tool ? getToolEmoji(entry.tool) : ':gear:';
  const toolInput = entry.toolInput ? formatToolInputSummary(entry.tool || '', entry.toolInput) : '';
  const resultSummary = formatToolResultSummary(entry);

  switch (entry.type) {
    case 'starting':
      return ':brain: *Analyzing request...*';
    case 'thinking': {
      // Use :bulb: for thinking (matches ccslack)
      const thinkingStatus = entry.thinkingInProgress ? '...' : '';
      const duration = entry.durationMs ? ` [${(entry.durationMs / 1000).toFixed(1)}s]` : '';
      return `:bulb: *Thinking${thinkingStatus}*${duration}${entry.charCount ? ` _[${entry.charCount} chars]_` : ''}`;
    }
    case 'tool_start':
      return `${toolEmoji} *${normalizeToolName(entry.tool || '')}*${toolInput} [in progress]`;
    case 'tool_complete': {
      const lines: string[] = [];
      // Use tool emoji instead of :white_check_mark: for thread messages
      const header = `${toolEmoji} *${normalizeToolName(entry.tool || '')}*${toolInput}`;
      lines.push(header);

      // Add bullet point details
      const details = formatToolDetails(entry);
      if (details.length > 0) {
        lines.push(...details.map(d => `• ${d}`));
      }

      return lines.join('\n');
    }
    case 'generating': {
      const duration = entry.durationMs ? ` [${(entry.durationMs / 1000).toFixed(1)}s]` : '';
      return `:memo: *Generating*${duration}${entry.charCount ? ` _[${entry.charCount} chars]_` : ''}`;
    }
    case 'error':
      return `:x: *Error:* ${entry.message || 'Unknown error'}`;
    case 'aborted':
      return ':octagonal_sign: *Aborted by user*';
    default: {
      const duration = entry.durationMs ? ` [${(entry.durationMs / 1000).toFixed(1)}s]` : '';
      return `${toolEmoji} ${entry.message || entry.type}${duration}`;
    }
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
 * Uses :bulb: emoji (matches ccslack).
 */
export function formatThreadThinkingMessage(content: string, durationMs?: number): string {
  const durationStr = durationMs ? ` [${(durationMs / 1000).toFixed(1)}s]` : '';
  const charStr = ` _[${content.length} chars]_`;
  return `:bulb: *Thinking*${durationStr}${charStr}`;
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
