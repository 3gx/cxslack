/**
 * Block Kit builders for Slack messages.
 * Centralizes construction of interactive message blocks.
 */

import type { ApprovalPolicy } from './codex-client.js';

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
    });
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
      });
    }
  }

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

export interface UnifiedStatusLineParams {
  approvalPolicy: ApprovalPolicy;
  model?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Build a unified status line showing policy, model, duration, and tokens.
 */
export function buildUnifiedStatusLine(params: UnifiedStatusLineParams): string {
  const parts: string[] = [];

  // Policy badge
  const policyEmoji: Record<ApprovalPolicy, string> = {
    never: ':unlock:',
    'on-request': ':question:',
    'on-failure': ':construction:',
    untrusted: ':lock:',
  };
  parts.push(`${policyEmoji[params.approvalPolicy]} ${params.approvalPolicy}`);

  // Model
  if (params.model) {
    parts.push(`| ${params.model}`);
  }

  // Duration
  if (params.durationMs) {
    parts.push(`| ${(params.durationMs / 1000).toFixed(1)}s`);
  }

  // Tokens
  if (params.inputTokens || params.outputTokens) {
    const inp = params.inputTokens || 0;
    const out = params.outputTokens || 0;
    parts.push(`| ${inp}/${out} tokens`);
  }

  return `_${parts.join(' ')}_`;
}

// ============================================================================
// Abort Confirmation Modal
// ============================================================================

export interface AbortConfirmationModalParams {
  conversationKey: string;
  channelId: string;
  messageTs: string;
}

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
