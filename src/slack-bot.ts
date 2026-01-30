/**
 * Main Slack bot for Codex integration.
 *
 * Uses Slack Bolt framework with Socket Mode for real-time events.
 * Integrates with Codex App-Server for AI capabilities.
 */

import { App, LogLevel } from '@slack/bolt';
import { Mutex } from 'async-mutex';
import { CodexClient, ApprovalRequest, TurnContent, ReasoningEffort, ApprovalPolicy, SandboxMode } from './codex-client.js';
import { StreamingManager, makeConversationKey, StreamingContext } from './streaming.js';
import { ApprovalHandler } from './approval-handler.js';
import {
  handleCommand,
  CommandContext,
  parseCommand,
  FALLBACK_MODELS,
  getModelInfo,
  DEFAULT_MODEL,
  DEFAULT_REASONING,
} from './commands.js';
import {
  getSession,
  saveSession,
  getThreadSession,
  saveThreadSession,
  getOrCreateThreadSession,
  getEffectiveWorkingDir,
  getEffectiveApprovalPolicy,
  getEffectiveThreadId,
  recordTurn,
  deleteChannelSession,
  saveModelSettings,
  saveApprovalPolicy,
} from './session-manager.js';
import {
  buildActivityBlocks,
  buildPolicyStatusBlocks,
  buildModelSelectionBlocks,
  buildReasoningSelectionBlocks,
  buildModelConfirmationBlocks,
  buildModelPickerCancelledBlocks,
  buildErrorBlocks,
  buildTextBlocks,
  buildAbortConfirmationModalView,
  buildForkToChannelModalView,
  buildSandboxStatusBlocks,
  Block,
} from './blocks.js';
import { withSlackRetry } from './slack-retry.js';

// ============================================================================
// Pending Model Selection Tracking (for emoji cleanup)
// ============================================================================

interface PendingModelSelection {
  originalTs: string;   // User's message timestamp (for emoji cleanup)
  channelId: string;
  threadTs?: string;
}

// Track pending model selections for emoji cleanup
export const pendingModelSelections = new Map<string, PendingModelSelection>();
import { toUserMessage } from './errors.js';
import { markAborted } from './abort-tracker.js';

// Global instances
let app: App;
let codex: CodexClient;
let streamingManager: StreamingManager;
let approvalHandler: ApprovalHandler;

// Mutex management for message updates (fork link/refresh)
const updateMutexes = new Map<string, Mutex>();
function getUpdateMutex(key: string): Mutex {
  if (!updateMutexes.has(key)) {
    updateMutexes.set(key, new Mutex());
  }
  return updateMutexes.get(key)!;
}

/**
 * Extract the bot user ID from an app mention.
 */
function extractBotMention(text: string, botUserId: string): string {
  const mentionPattern = new RegExp(`<@${botUserId}>\\s*`, 'g');
  return text.replace(mentionPattern, '').trim();
}

/**
 * Start the Slack bot.
 */
export async function startBot(): Promise<void> {
  // Validate environment
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;
  const signingSecret = process.env.SLACK_SIGNING_SECRET;

  if (!botToken || !appToken || !signingSecret) {
    console.error('Missing required environment variables:');
    if (!botToken) console.error('  - SLACK_BOT_TOKEN');
    if (!appToken) console.error('  - SLACK_APP_TOKEN');
    if (!signingSecret) console.error('  - SLACK_SIGNING_SECRET');
    process.exit(1);
  }

  // Initialize Codex client
  codex = new CodexClient();

  codex.on('server:started', () => {
    console.log('Codex App-Server started');
  });

  codex.on('server:died', (code) => {
    console.error(`Codex App-Server died with code ${code}`);
  });

  codex.on('server:restarting', (attempt) => {
    console.log(`Codex App-Server restarting (attempt ${attempt})...`);
  });

  codex.on('server:restart-failed', (error) => {
    console.error('Codex App-Server restart failed:', error);
  });

  codex.on('error', (error) => {
    console.error('Codex error:', error);
  });

  // Start Codex
  console.log('Starting Codex App-Server...');
  await codex.start();

  // Verify authentication
  const account = await codex.getAccount();
  if (!account) {
    console.error('Codex not authenticated. Please run `codex auth login` first.');
    process.exit(1);
  }
  console.log(`Codex authenticated as ${account.type}${account.email ? ` (${account.email})` : ''}`);

  // Initialize Slack app
  app = new App({
    token: botToken,
    appToken: appToken,
    signingSecret: signingSecret,
    socketMode: true,
    logLevel: LogLevel.INFO,
  });

  // Initialize managers
  streamingManager = new StreamingManager(app.client, codex);
  approvalHandler = new ApprovalHandler(app.client, codex);

  // Set up approval callback
  streamingManager.onApprovalRequest(async (request: ApprovalRequest, context: StreamingContext) => {
    await approvalHandler.handleApprovalRequest(
      request,
      context.channelId,
      context.threadTs,
      context.userId
    );
  });

  // Register event handlers
  setupEventHandlers();

  // Start the app
  await app.start();
  console.log('Codex Slack bot is running!');
}

/**
 * Stop the Slack bot.
 */
export async function stopBot(): Promise<void> {
  console.log('Stopping Codex Slack bot...');
  // Order matters: stop streaming first, then codex, then app
  streamingManager?.stopAllStreaming();
  await codex?.stop();
  await app?.stop();
  console.log('Codex Slack bot stopped.');
}

/**
 * Set up Slack event handlers.
 */
function setupEventHandlers(): void {
  // Handle app mentions (@codex)
  app.event('app_mention', async ({ event, say, client }) => {
    const channelId: string = event.channel;
    const threadTs: string | undefined = event.thread_ts;
    const messageTs: string = event.ts;
    // Always reply in a thread: use existing thread or create new one under user's message
    const replyThreadTs = threadTs ?? messageTs;

    try {
      const userId: string = event.user || '';
      const botUserId = (await client.auth.test()).user_id as string;
      const text: string = extractBotMention(event.text, botUserId);

      if (!text) {
        await say({
          thread_ts: replyThreadTs,
          text: 'Hello! How can I help you? Try asking me a question or use `/help` for commands.',
        });
        return;
      }

      await handleUserMessage(channelId, threadTs, userId, text, messageTs);
    } catch (error) {
      console.error('Error handling app_mention:', error);
      await say({
        thread_ts: replyThreadTs,
        text: toUserMessage(error),
      });
    }
  });

  // Handle direct messages
  app.event('message', async ({ event, say }) => {
    // Type guard for message events
    const msg = event as {
      subtype?: string;
      bot_id?: string;
      channel: string;
      thread_ts?: string;
      user?: string;
      text?: string;
      ts: string;
    };

    // Skip bot messages and app mentions (handled separately)
    if (msg.bot_id || msg.subtype) {
      return;
    }

    // Only handle DMs (channel IDs starting with D)
    if (!msg.channel.startsWith('D')) {
      return;
    }

    const channelId = msg.channel;
    const threadTs = msg.thread_ts;
    const messageTs = msg.ts;
    const userId = msg.user || '';
    const text = msg.text || '';
    // For DMs, always reply in thread to keep conversation organized
    const replyThreadTs = threadTs ?? messageTs;

    if (!text.trim() || !userId) {
      return;
    }

    try {
      await handleUserMessage(channelId, threadTs, userId, text, messageTs);
    } catch (error) {
      console.error('Error handling message:', error);
      await say({
        thread_ts: replyThreadTs,
        text: toUserMessage(error),
      });
    }
  });

  // Handle abort confirmation modal submission
  app.view('abort_confirmation_modal', async ({ ack, view }) => {
    await ack();
    // Mark as aborted before interrupting so status transition knows
    // Modal private_metadata contains: { conversationKey, channelId, messageTs }
    const metadata = JSON.parse(view.private_metadata || '{}');
    const { conversationKey } = metadata;
    if (conversationKey) {
      // IMMEDIATELY clear the timer (don't wait for turn:completed)
      streamingManager.clearTimer(conversationKey);
      markAborted(conversationKey);
      // Queue abort - will execute immediately if turnId available,
      // or wait for turn:started/context:turnId if not
      streamingManager.queueAbort(conversationKey);
    }
  });

  // Handle fork-to-channel modal submission
  app.view('fork_to_channel_modal', async ({ ack, view, client, body }) => {
    // Get channel name from input
    const channelNameInput = view.state?.values?.channel_name_block?.channel_name_input?.value;
    if (!channelNameInput) {
      await ack({
        response_action: 'errors',
        errors: { channel_name_block: 'Channel name is required' },
      });
      return;
    }

    // Validate channel name format (lowercase, numbers, hyphens only)
    const normalizedName = channelNameInput.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (normalizedName.length < 1 || normalizedName.length > 80) {
      await ack({
        response_action: 'errors',
        errors: { channel_name_block: 'Channel name must be 1-80 characters' },
      });
      return;
    }

    await ack();

    // Parse metadata - contains turnId (Codex identifier), NOT turnIndex
    const metadata = JSON.parse(view.private_metadata || '{}') as {
      sourceChannelId: string;
      sourceChannelName: string;
      sourceMessageTs: string;
      sourceThreadTs: string;
      conversationKey: string;
      turnId: string;
    };

    const userId = body.user.id;

    try {
      // Create the fork channel and session
      // createForkChannel queries Codex for actual turn index using turnId
      const result = await createForkChannel({
        channelName: normalizedName,
        sourceChannelId: metadata.sourceChannelId,
        sourceThreadTs: metadata.sourceThreadTs,
        conversationKey: metadata.conversationKey,
        turnId: metadata.turnId,
        userId,
        client,
      });

      // Update source message to show fork link (preserve activity blocks)
      if (metadata.sourceMessageTs && metadata.sourceChannelId) {
        try {
          await updateSourceMessageWithForkLink(
            client,
            metadata.sourceChannelId,
            metadata.sourceMessageTs,
            result.channelId,
            {
              threadTs: metadata.sourceThreadTs || undefined,
              conversationKey: metadata.conversationKey,
              turnId: metadata.turnId,
            }
          );
        } catch (updateError) {
          console.warn('Failed to update source message after fork:', updateError);
        }
      }
    } catch (error) {
      console.error('Fork to channel failed:', error);
      // Post ephemeral error to user
      await client.chat.postEphemeral({
        channel: metadata.sourceChannelId,
        user: userId,
        text: toUserMessage(error),
      });
    }
  });

  // Handle button actions (approve/deny/abort/fork)
  app.action(/^(approve|deny|abort|fork)_/, async ({ action, ack, body, client }) => {
    await ack();

    const actionId = (action as { action_id: string }).action_id;
    const channelId = body.channel?.id;

    if (!channelId) {
      console.error('No channel ID in action');
      return;
    }

    try {
      if (actionId.startsWith('approve_') || actionId.startsWith('deny_')) {
        // Approval action
        const requestId = parseInt(actionId.split('_')[1], 10);
        const decision = actionId.startsWith('approve_') ? 'accept' : 'decline';
        await approvalHandler.handleApprovalDecision(requestId, decision as 'accept' | 'decline');
      } else if (actionId.startsWith('abort_')) {
        // Abort action - open confirmation modal
        const conversationKey = actionId.replace('abort_', '');
        const context = streamingManager.getContext(conversationKey);
        if (context) {
          const triggerBody = body as { trigger_id?: string };
          if (triggerBody.trigger_id) {
            await client.views.open({
              trigger_id: triggerBody.trigger_id,
              view: buildAbortConfirmationModalView({
                conversationKey,
                channelId: context.channelId,
                messageTs: context.messageTs,
              }),
            });
          }
        }
      } else if (actionId.startsWith('fork_')) {
        // Fork action - open modal for channel name input
        // Button value contains turnId (Codex identifier), NOT turnIndex
        const value = (action as { value: string }).value;
        const { turnId, slackTs, conversationKey } = JSON.parse(value);
        const messageTs = (body as { message?: { ts?: string; thread_ts?: string } }).message?.ts;
        const threadTs = (body as { message?: { ts?: string; thread_ts?: string } }).message?.thread_ts ?? messageTs;

        // Get channel name and find next available fork name
        const triggerBody = body as { trigger_id?: string };
        if (triggerBody.trigger_id) {
          let channelName = 'channel';
          let suggestedName = 'channel-fork';

          try {
            const channelInfo = await client.conversations.info({ channel: channelId });
            channelName = (channelInfo.channel as { name?: string })?.name ?? 'channel';
            const baseForkName = `${channelName}-fork`;

            // List channels to find existing forks with this pattern
            // Include archived channels since Slack blocks names even for archived channels
            const existingNames = new Set<string>();
            let cursor: string | undefined;
            do {
              const listResult = await client.conversations.list({
                types: 'public_channel,private_channel',
                exclude_archived: false,
                limit: 200,
                cursor,
              });
              if (listResult.ok && listResult.channels) {
                for (const ch of listResult.channels) {
                  if (ch.name?.startsWith(baseForkName)) {
                    existingNames.add(ch.name);
                  }
                }
              }
              cursor = listResult.response_metadata?.next_cursor;
            } while (cursor);
            console.log(`[Fork] Found existing fork channels: ${[...existingNames].join(', ') || 'none'}`);

            // Find next available name: -fork, then -fork-1, -fork-2, etc.
            if (!existingNames.has(baseForkName)) {
              suggestedName = baseForkName;
            } else {
              let num = 1;
              while (existingNames.has(`${baseForkName}-${num}`)) {
                num++;
              }
              suggestedName = `${baseForkName}-${num}`;
            }
            console.log(`[Fork] Suggested name: ${suggestedName}`);
          } catch (error) {
            // Use default name if channel info unavailable
            console.log('[Fork] Could not get channel name for prefill:', error);
          }

          await client.views.open({
            trigger_id: triggerBody.trigger_id,
            view: buildForkToChannelModalView({
              sourceChannelId: channelId,
              sourceChannelName: channelName,
              sourceMessageTs: messageTs ?? '',
              sourceThreadTs: threadTs ?? '',
              conversationKey,
              turnId,
              suggestedName,
            }),
          });
        }
      }
    } catch (error) {
      console.error('Error handling action:', error);
      await client.chat.postEphemeral({
        channel: channelId,
        user: body.user.id,
        text: toUserMessage(error),
      });
    }
  });

  // Handle "Refresh fork" button click - restore Fork here if forked channel was deleted
  app.action(/^refresh_fork_(.+)$/, async ({ action, ack, body, client }) => {
    await ack();

    const bodyWithMessage = body as { channel?: { id?: string }; message?: { ts?: string } };
    const channelId = bodyWithMessage.channel?.id;
    const messageTs = bodyWithMessage.message?.ts;

    if (!channelId || !messageTs) {
      console.error('[RefreshFork] Missing channel or message info');
      return;
    }

    const valueStr = 'value' in action ? (action.value || '{}') : '{}';
    let forkInfo: {
      forkChannelId?: string;
      threadTs?: string;
      conversationKey?: string;
      turnId?: string;
    };
    try {
      forkInfo = JSON.parse(valueStr);
    } catch {
      console.error('[RefreshFork] Invalid button value');
      return;
    }

    if (forkInfo.forkChannelId) {
      try {
        await withSlackRetry(
          () => (client as any).conversations.info({ channel: forkInfo.forkChannelId }),
          'refresh.info'
        );
        console.log(`[RefreshFork] Channel ${forkInfo.forkChannelId} still exists, no action needed`);
        return;
      } catch {
        console.log(`[RefreshFork] Channel ${forkInfo.forkChannelId} not found, restoring Fork here button`);
      }
    }

    await restoreForkHereButton(client, {
      sourceChannelId: channelId,
      sourceMessageTs: messageTs,
      threadTs: forkInfo.threadTs,
      conversationKey: forkInfo.conversationKey,
      turnId: forkInfo.turnId,
    });
  });

  // Handle /policy selection buttons
  app.action(/^policy_select_(never|on-request|on-failure|untrusted)$/, async ({ action, ack, body, client }) => {
    await ack();

    const actionId = (action as { action_id: string }).action_id;
    const newPolicy = actionId.replace('policy_select_', '') as ApprovalPolicy;
    const channelId = body.channel?.id;
    const messageTs = (body as { message?: { ts?: string; thread_ts?: string } }).message?.ts;
    const threadTs = (body as { message?: { ts?: string; thread_ts?: string } }).message?.thread_ts
      ?? messageTs;

    if (!channelId || !messageTs) {
      return;
    }

    const currentPolicy = getEffectiveApprovalPolicy(channelId, threadTs);

    await saveApprovalPolicy(channelId, threadTs, newPolicy);

    // Update active context for status display (applies next turn)
    const conversationKey = makeConversationKey(channelId, threadTs);
    const context = streamingManager.getContext(conversationKey);
    if (context) {
      context.approvalPolicy = newPolicy;
    }

    await client.chat.update({
      channel: channelId,
      ts: messageTs,
      text: `Approval policy changed: ${currentPolicy} → ${newPolicy}`,
      blocks: buildPolicyStatusBlocks({ currentPolicy, newPolicy }),
    });
  });

  // Handle /sandbox selection buttons
  app.action(/^sandbox_select_(read-only|workspace-write|danger-full-access)$/, async ({ action, ack, body, client }) => {
    await ack();

    const actionId = (action as { action_id: string }).action_id;
    const newMode = actionId.replace('sandbox_select_', '') as SandboxMode;
    const channelId = body.channel?.id;
    const messageTs = (body as { message?: { ts?: string; thread_ts?: string } }).message?.ts;

    if (!channelId || !messageTs) {
      return;
    }

    if (streamingManager.isAnyStreaming()) {
      await client.chat.update({
        channel: channelId,
        ts: messageTs,
        text: 'Cannot change sandbox while processing',
        blocks: buildErrorBlocks('Cannot change sandbox while a turn is running. Please wait or abort.'),
      });
      return;
    }

    const currentMode = codex.getSandboxMode();

    try {
      await codex.restartWithSandbox(newMode);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      await client.chat.update({
        channel: channelId,
        ts: messageTs,
        text: `Failed to update sandbox: ${message}`,
        blocks: buildErrorBlocks(`Failed to update sandbox: ${message}`),
      });
      return;
    }

    await client.chat.update({
      channel: channelId,
      ts: messageTs,
      text: `Sandbox mode changed: ${currentMode ?? 'default'} → ${newMode}`,
      blocks: buildSandboxStatusBlocks({ currentMode, newMode }),
    });
  });

  // Handle model button clicks (Step 1 of 2)
  // Pattern matches model_select_<model_value>
  app.action(/^model_select_(.+)$/, async ({ action, ack, body, client }) => {
    await ack();

    const actionId = 'action_id' in action ? action.action_id : '';
    const modelValue = actionId.replace('model_select_', '');

    const channelId = body.channel?.id;
    const messageTs = (body as { message?: { ts?: string; thread_ts?: string } }).message?.ts;
    if (!channelId || !messageTs) return;

    // Use stored threadTs from pending selection (more reliable than message.thread_ts)
    const pending = pendingModelSelections.get(messageTs);
    const threadTs = pending?.threadTs ||
      (body as { message?: { ts?: string; thread_ts?: string } }).message?.thread_ts ||
      messageTs;

    console.log(`[model] Model button clicked: ${modelValue} for channel: ${channelId}, thread: ${threadTs}`);

    const conversationKey = makeConversationKey(channelId, threadTs);
    if (streamingManager.isStreaming(conversationKey)) {
      await client.chat.update({
        channel: channelId,
        ts: messageTs,
        text: 'Cannot change model while processing',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: ':warning: Cannot change model while a turn is running. Please wait or abort.',
            },
          },
        ],
      });
      return;
    }

    // Get model info for display name
    const modelInfo = getModelInfo(modelValue);
    const displayName = modelInfo?.displayName || modelValue;

    // Get current reasoning for initial selection
    const session = getThreadSession(channelId, threadTs) ?? getSession(channelId);

    // Show reasoning selection (Step 2)
    // Keep pending selection tracking for emoji cleanup
    await client.chat.update({
      channel: channelId,
      ts: messageTs,
      text: `Select reasoning for ${displayName}`,
      blocks: buildReasoningSelectionBlocks(modelValue, displayName, session?.reasoningEffort),
    });
  });

  // Handle reasoning button clicks (Step 2 of 2)
  // Pattern matches reasoning_select_<reasoning_value>
  app.action(/^reasoning_select_(.+)$/, async ({ action, ack, body, client }) => {
    await ack();

    const actionId = 'action_id' in action ? action.action_id : '';
    const reasoningValue = actionId.replace('reasoning_select_', '');

    // Value contains JSON with model and reasoning
    const actionValue = 'value' in action ? (action.value as string) : '';
    let modelValue = '';
    try {
      const parsed = JSON.parse(actionValue);
      modelValue = parsed.model;
    } catch {
      console.error('[model] Failed to parse reasoning action value:', actionValue);
      return;
    }

    const channelId = body.channel?.id;
    const messageTs = (body as { message?: { ts?: string; thread_ts?: string } }).message?.ts;
    if (!channelId || !messageTs) return;

    // Use stored threadTs from pending selection (more reliable than message.thread_ts)
    const pending = pendingModelSelections.get(messageTs);
    const threadTs = pending?.threadTs ||
      (body as { message?: { ts?: string; thread_ts?: string } }).message?.thread_ts ||
      messageTs;

    console.log(`[model] Reasoning selected: ${reasoningValue} for model: ${modelValue}, thread: ${threadTs}`);
    if (pending) {
      try {
        await client.reactions.remove({ channel: pending.channelId, timestamp: pending.originalTs, name: 'question' });
      } catch { /* ignore */ }
      try {
        await client.reactions.remove({ channel: pending.channelId, timestamp: pending.originalTs, name: 'eyes' });
      } catch { /* ignore */ }
      pendingModelSelections.delete(messageTs);
    }

    const conversationKey = makeConversationKey(channelId, threadTs);
    if (streamingManager.isStreaming(conversationKey)) {
      await client.chat.update({
        channel: channelId,
        ts: messageTs,
        text: 'Cannot change settings while processing',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: ':warning: Cannot change settings while a turn is running. Please wait or abort.',
            },
          },
        ],
      });
      return;
    }

    // Save both model and reasoning to session
    const reasoningEffort = reasoningValue as ReasoningEffort;
    console.log(`[model] Saving to session: channel=${channelId}, thread=${threadTs}, model=${modelValue}, reasoning=${reasoningEffort}`);
    await saveModelSettings(channelId, threadTs, modelValue, reasoningEffort);

    // Verify save worked
    const savedSession = getThreadSession(channelId, threadTs);
    console.log(`[model] Verified saved session: model=${savedSession?.model}, reasoning=${savedSession?.reasoningEffort}`);

    // Get model info for display name
    const modelInfo = getModelInfo(modelValue);
    const displayName = modelInfo?.displayName || modelValue;

    // Show confirmation
    await client.chat.update({
      channel: channelId,
      ts: messageTs,
      text: `Settings updated: ${displayName}, ${reasoningValue}`,
      blocks: buildModelConfirmationBlocks(displayName, modelValue, reasoningValue),
    });
  });

  // Handle model picker cancel button
  app.action('model_picker_cancel', async ({ ack, body, client }) => {
    await ack();

    const channelId = body.channel?.id;
    const messageTs = (body as { message?: { ts?: string; thread_ts?: string } }).message?.ts;
    if (!channelId || !messageTs) return;

    console.log('[model] Model picker cancelled');

    // Remove emojis from original message
    const pending = pendingModelSelections.get(messageTs);
    if (pending) {
      try {
        await client.reactions.remove({ channel: pending.channelId, timestamp: pending.originalTs, name: 'question' });
      } catch { /* ignore */ }
      try {
        await client.reactions.remove({ channel: pending.channelId, timestamp: pending.originalTs, name: 'eyes' });
      } catch { /* ignore */ }
      pendingModelSelections.delete(messageTs);
    }

    // Show cancellation message
    await client.chat.update({
      channel: channelId,
      ts: messageTs,
      text: 'Model selection cancelled',
      blocks: buildModelPickerCancelledBlocks(),
    });
  });

  // Handle channel deletion - clean up all sessions for this channel
  app.event('channel_deleted', async ({ event }) => {
    try {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`[channel-deleted] Channel deleted: ${event.channel}`);
      console.log(`${'='.repeat(60)}`);

      await deleteChannelSession(event.channel);

      console.log(`${'='.repeat(60)}\n`);
    } catch (error) {
      console.error('[channel-deleted] Error handling channel deletion:', error);
      // Don't throw - cleanup failure shouldn't crash the bot
    }
  });
}

/**
 * Handle a user message.
 */
async function handleUserMessage(
  channelId: string,
  threadTs: string | undefined,
  userId: string,
  text: string,
  messageTs: string
): Promise<void> {
  // CRITICAL: All bot responses go into threads, never pollute the main channel.
  // If user mentions bot in main channel, use their message as thread anchor.
  // If user is already in a thread, continue in that thread.
  const postingThreadTs = threadTs ?? messageTs;
  const conversationKey = makeConversationKey(channelId, postingThreadTs);

  const parsedCommand = parseCommand(text);

  // Prevent /resume while a turn is streaming to avoid state corruption
  if (parsedCommand?.command === 'resume' && streamingManager.isStreaming(conversationKey)) {
    await app.client.chat.postMessage({
      channel: channelId,
      thread_ts: postingThreadTs,
      blocks: buildErrorBlocks('Cannot resume while a turn is running. Abort first, or wait for completion.'),
      text: 'Cannot resume while a turn is running. Abort first, or wait for completion.',
    });
    return;
  }

  // Check if this is a command
  const commandContext: CommandContext = {
    channelId,
    threadTs: postingThreadTs, // Use posting thread for session lookup
    userId,
    text,
  };

  const commandResult = await handleCommand(commandContext, codex);
  if (commandResult) {
    if (commandResult.sandboxModeChange) {
      const newMode = commandResult.sandboxModeChange;
      const currentMode = codex.getSandboxMode();

      if (streamingManager.isAnyStreaming()) {
        await app.client.chat.postMessage({
          channel: channelId,
          thread_ts: postingThreadTs,
          blocks: buildErrorBlocks('Cannot change sandbox while a turn is running. Please wait or abort.'),
          text: 'Cannot change sandbox while a turn is running. Please wait or abort.',
        });
        return;
      }

      try {
        await codex.restartWithSandbox(newMode);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        await app.client.chat.postMessage({
          channel: channelId,
          thread_ts: postingThreadTs,
          blocks: buildErrorBlocks(`Failed to update sandbox: ${message}`),
          text: `Failed to update sandbox: ${message}`,
        });
        return;
      }

      await app.client.chat.postMessage({
        channel: channelId,
        thread_ts: postingThreadTs,
        blocks: buildSandboxStatusBlocks({ currentMode, newMode }),
        text: `Sandbox mode changed: ${currentMode ?? 'default'} → ${newMode}`,
      });
      return;
    }

    // Handle /model command with emoji tracking
    if (commandResult.showModelSelection) {
      const response = await app.client.chat.postMessage({
        channel: channelId,
        thread_ts: postingThreadTs,
        blocks: commandResult.blocks,
        text: commandResult.text,
      });

      // Track pending selection for emoji cleanup
      if (response.ts) {
        pendingModelSelections.set(response.ts, {
          originalTs: messageTs,
          channelId,
          threadTs: postingThreadTs,
        });
        // Add :question: emoji to user's message (keep :eyes: from message receipt)
        try {
          await app.client.reactions.add({ channel: channelId, timestamp: messageTs, name: 'question' });
        } catch { /* ignore if already added */ }
      }
      return;
    }

    // Send command response in thread
    await app.client.chat.postMessage({
      channel: channelId,
      thread_ts: postingThreadTs,
      blocks: commandResult.blocks,
      text: commandResult.text,
    });

    // Live update: adjust update rate for active streaming
    if (parsedCommand?.command === 'update-rate') {
      const session = getThreadSession(channelId, postingThreadTs) ?? getSession(channelId);
      const newRate = session?.updateRateSeconds ?? 3;
      streamingManager.updateRate(conversationKey, newRate * 1000);
    }
    return;
  }

  // Regular message - send to Codex
  // Use postingThreadTs for all session lookups since that's our thread key
  const workingDir = getEffectiveWorkingDir(channelId, postingThreadTs);
  const approvalPolicy = getEffectiveApprovalPolicy(channelId, postingThreadTs);
  let threadId = getEffectiveThreadId(channelId, postingThreadTs);

  // Get session info - always use thread session since all conversations are in threads
  const session = getThreadSession(channelId, postingThreadTs) ?? getSession(channelId);
  console.log(`[message] Session lookup: channel=${channelId}, slackThread=${postingThreadTs}, codexThread=${threadId}, model=${session?.model}, reasoning=${session?.reasoningEffort}`);

  // Start or resume thread
  if (!threadId) {
    console.log(`[message] No existing Codex thread, will create new one`);
    // Check if this is a Slack thread that needs forking (only for existing threads, not new anchors)
    if (threadTs) {
      const result = await getOrCreateThreadSession(channelId, postingThreadTs);
      if (result.isNewFork && result.session.forkedFrom) {
        // Fork the Codex thread at the specified turn
        // forkThreadAtTurn now gets actual turn count from Codex (source of truth)
        const forkTurnIndex = result.session.forkedAtTurnIndex ?? 0;
        const forkedThread = await codex.forkThreadAtTurn(
          result.session.forkedFrom,
          forkTurnIndex
        );
        threadId = forkedThread.id;
        await saveThreadSession(channelId, postingThreadTs, { threadId });
      } else {
        // Start new thread
        const newThread = await codex.startThread(workingDir);
        threadId = newThread.id;
        await saveThreadSession(channelId, postingThreadTs, { threadId });
      }
    } else {
      // New conversation from main channel mention - start new Codex thread
      // Save to BOTH channel session (for subsequent main channel mentions)
      // and thread session (for this specific thread anchor)
      const newThread = await codex.startThread(workingDir);
      threadId = newThread.id;
      await saveSession(channelId, { threadId });
      await saveThreadSession(channelId, postingThreadTs, { threadId });
    }
  } else {
    // Resume existing thread
    console.log(`[message] Resuming existing Codex thread: ${threadId}`);
    await codex.resumeThread(threadId);
    // Ensure this thread anchor also has the threadId saved
    await saveThreadSession(channelId, postingThreadTs, { threadId });
  }

  // Use defaults when model/reasoning not explicitly set
  const effectiveModel = session?.model || DEFAULT_MODEL;
  const effectiveReasoning = session?.reasoningEffort || DEFAULT_REASONING;
  const effectiveSandbox = codex.getSandboxMode();

  // Post initial "processing" message IN THE THREAD using activity format
  const initialResult = await app.client.chat.postMessage({
    channel: channelId,
    thread_ts: postingThreadTs, // Always post in thread!
    blocks: buildActivityBlocks({
      activityText: ':gear: Starting...',
      status: 'running',
      conversationKey,
      elapsedMs: 0,
      approvalPolicy,
      model: effectiveModel,
      reasoningEffort: effectiveReasoning,
      sandboxMode: effectiveSandbox,
      sessionId: threadId,
      spinner: '\u25D0',
    }),
    text: 'Starting...',
  });

  if (!initialResult.ts) {
    throw new Error('Failed to post message');
  }

  // Start streaming context
  const streamingContext: StreamingContext = {
    channelId,
    threadTs: postingThreadTs, // Track the thread we're posting to
    messageTs: initialResult.ts,
    originalTs: messageTs, // User's original message for emoji reactions
    userId, // Track user for DM notifications
    threadId,
    turnId: '', // Will be set when turn starts
    approvalPolicy,
    updateRateMs: (session?.updateRateSeconds ?? 3) * 1000,
    model: effectiveModel,
    reasoningEffort: effectiveReasoning,
    sandboxMode: effectiveSandbox,
    startTime: Date.now(),
  };

  streamingManager.startStreaming(streamingContext);

  // Start the turn
  const input: TurnContent[] = [{ type: 'text', text }];
  const turnId = await codex.startTurn(threadId, input, {
    approvalPolicy,
    reasoningEffort: effectiveReasoning,
    model: effectiveModel,
  });

  // Update context with turn ID
  streamingContext.turnId = turnId;

  // Record turn for fork tracking
  const turnIndex = (session as { turns?: unknown[] })?.turns?.length ?? 0;
  await recordTurn(channelId, postingThreadTs, {
    turnId,
    turnIndex,
    slackTs: initialResult.ts,
  });
}

/**
 * Create a fork channel with a forked Codex session.
 */
interface CreateForkChannelParams {
  channelName: string;
  sourceChannelId: string;
  sourceThreadTs: string;
  conversationKey: string;
  /** Codex turn ID - actual index is queried from Codex at fork time */
  turnId: string;
  userId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any; // Slack WebClient - using any for flexibility with Slack API types
}

interface CreateForkChannelResult {
  channelId: string;
  threadId: string;
}

async function createForkChannel(params: CreateForkChannelParams): Promise<CreateForkChannelResult> {
  const { channelName, sourceChannelId, sourceThreadTs, conversationKey, turnId, userId, client } = params;

  // Parse source conversation key to get source thread info
  const parts = conversationKey.split(':');
  const sourceConvChannelId = parts[0];
  const sourceConvThreadTs = parts[1];

  // Get source Codex thread ID
  const sourceThreadId = getEffectiveThreadId(sourceConvChannelId, sourceConvThreadTs);
  if (!sourceThreadId) {
    throw new Error('Cannot fork: No active session found in source thread.');
  }

  // Query Codex for actual turn index (source of truth)
  const turnIndex = await codex.findTurnIndex(sourceThreadId, turnId);
  if (turnIndex < 0) {
    throw new Error('Cannot fork: Turn not found in Codex thread.');
  }

  // 1. Create new Slack channel
  let createResult;
  try {
    createResult = await client.conversations.create({
      name: channelName,
      is_private: false,
    });
  } catch (error) {
    const errMsg = (error as { data?: { error?: string } })?.data?.error;
    switch (errMsg) {
      case 'name_taken':
        throw new Error(`Channel name "${channelName}" is already taken. Please choose a different name.`);
      case 'invalid_name_specials':
      case 'invalid_name_punctuation':
        throw new Error(`Channel name "${channelName}" contains invalid characters. Use only lowercase letters, numbers, and hyphens.`);
      case 'invalid_name':
      case 'invalid_name_required':
        throw new Error(`Invalid channel name "${channelName}". Channel names must be lowercase with no spaces.`);
      case 'invalid_name_maxlength':
        throw new Error(`Channel name "${channelName}" is too long. Maximum 80 characters allowed.`);
      case 'restricted_action':
        throw new Error('Channel creation is restricted by your workspace policy. Contact your admin.');
      case 'user_is_restricted':
        throw new Error('You do not have permission to create channels in this workspace.');
      case 'no_permission':
        throw new Error('The bot does not have permission to create channels. Please check bot permissions.');
      default:
        // Show the actual Slack error for debugging
        throw new Error(`Failed to create channel: ${errMsg || (error as Error)?.message || 'Unknown error'}`);
    }
  }

  if (!createResult.ok || !createResult.channel?.id) {
    throw new Error(`Failed to create channel: ${createResult.error || 'Unknown error'}`);
  }

  const newChannelId = createResult.channel.id;

  // 2. Invite user to the channel
  try {
    await client.conversations.invite({
      channel: newChannelId,
      users: userId,
    });
  } catch (error) {
    // Ignore 'already_in_channel' error
    const errMsg = (error as { data?: { error?: string } })?.data?.error;
    if (errMsg !== 'already_in_channel') {
      console.warn('Failed to invite user to fork channel:', error);
    }
  }

  // 3. Fork the Codex session at the specified turn (using fork + rollback)
  // ROBUST: forkThreadAtTurn gets actual turn count from Codex (source of truth)
  const forkedThread = await codex.forkThreadAtTurn(sourceThreadId, turnIndex);

  // 4. Save the forked session for the new channel
  await saveSession(newChannelId, {
    threadId: forkedThread.id,
    forkedFrom: sourceThreadId,
    forkedAtTurnIndex: turnIndex,
  });

  // 5. Post initial message in the new channel
  const sourceLink = `<https://slack.com/archives/${sourceChannelId}/p${sourceThreadTs.replace('.', '')}|source conversation>`;
  await client.chat.postMessage({
    channel: newChannelId,
    text: `:twisted_rightwards_arrows: Forked from ${sourceLink}.\n\nThis channel continues from that point in the conversation. Send a message to continue.`,
  });

  return {
    channelId: newChannelId,
    threadId: forkedThread.id,
  };
}

interface SlackMessageSummary {
  ts?: string;
  text?: string;
  blocks?: any[];
}

interface SlackMessagesResult {
  messages?: SlackMessageSummary[];
}

// Update source activity message: remove Fork button and add fork link, preserving blocks.
async function updateSourceMessageWithForkLink(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  channelId: string,
  messageTs: string,
  forkChannelId: string,
  forkInfo?: {
    threadTs?: string;
    conversationKey?: string;
    turnId?: string;
  }
): Promise<void> {
  const threadTs = forkInfo?.threadTs;
  const isThreadReply = Boolean(threadTs && threadTs !== messageTs);
  const mutexKey = `${channelId}_${messageTs}`;
  const mutex = getUpdateMutex(mutexKey);

  await mutex.runExclusive(async () => {
    // Fetch the original message to preserve blocks
    let historyResult: SlackMessagesResult | undefined;

    if (isThreadReply) {
      historyResult = (await withSlackRetry(
        () =>
          client.conversations.replies({
            channel: channelId,
            ts: threadTs,
          }),
        'fork.replies'
      )) as SlackMessagesResult;
    } else {
      historyResult = (await withSlackRetry(
        () =>
          client.conversations.history({
            channel: channelId,
            latest: messageTs,
            inclusive: true,
            limit: 1,
          }),
        'fork.history'
      )) as SlackMessagesResult;
    }

    // Fallback to replies if history didn't find the message and we have a thread parent
    let messages = historyResult?.messages || [];
    let msg = isThreadReply ? messages.find((m) => m.ts === messageTs) : messages[0];
    if (!msg && threadTs && threadTs !== messageTs) {
      const repliesResult = (await withSlackRetry(
        () =>
          client.conversations.replies({
            channel: channelId,
            ts: threadTs,
          }),
        'fork.replies.fallback'
      )) as SlackMessagesResult;
      messages = repliesResult?.messages || [];
      msg = messages.find((m) => m.ts === messageTs);
    }

    if (!msg?.blocks) {
      console.warn('[Fork] Source message blocks not found; skipping update');
      return;
    }

    const updatedBlocks: any[] = [];
    let forkContextAdded = false;
    let refreshButtonAdded = false;
    let actionsBlockIndex = -1;

    const refreshButton =
      forkInfo?.conversationKey && forkInfo?.turnId
        ? {
            type: 'button',
            text: { type: 'plain_text', text: '🔄 Refresh fork', emoji: true },
            action_id: `refresh_fork_${forkInfo.conversationKey}`,
            value: JSON.stringify({
              forkChannelId,
              threadTs: forkInfo.threadTs,
              conversationKey: forkInfo.conversationKey,
              turnId: forkInfo.turnId,
            }),
          }
        : undefined;

    for (const block of msg.blocks) {
      if (block.type === 'actions' && Array.isArray(block.elements)) {
        actionsBlockIndex = updatedBlocks.length;
        const remainingElements = block.elements.filter(
          (el: any) =>
            !(typeof el.action_id === 'string' && el.action_id.startsWith('fork_')) &&
            !(typeof el.action_id === 'string' && el.action_id.startsWith('refresh_fork_'))
        );
        if (!forkContextAdded) {
          updatedBlocks.push({
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `:twisted_rightwards_arrows: Forked to <#${forkChannelId}>`,
              },
            ],
          });
          forkContextAdded = true;
        }
        if (refreshButton) {
          remainingElements.push(refreshButton);
          refreshButtonAdded = true;
        }
        updatedBlocks.push({ ...block, elements: remainingElements });
        continue;
      }
      updatedBlocks.push(block);
    }

    if (!forkContextAdded) {
      updatedBlocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `:twisted_rightwards_arrows: Forked to <#${forkChannelId}>`,
          },
        ],
      });
    }

    if (refreshButton && !refreshButtonAdded) {
      const actionsBlock = {
        type: 'actions',
        block_id: `fork_${messageTs}`,
        elements: [refreshButton],
      };
      if (actionsBlockIndex >= 0) {
        updatedBlocks.splice(actionsBlockIndex + 1, 0, actionsBlock);
      } else {
        updatedBlocks.push(actionsBlock);
      }
    }

    await withSlackRetry(
      () =>
        client.chat.update({
          channel: channelId,
          ts: messageTs,
          blocks: updatedBlocks,
          text: msg.text,
        }),
      'fork.update'
    );
  });
}

// Restore Fork here button when a forked channel is deleted
async function restoreForkHereButton(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  forkInfo: {
    sourceChannelId: string;
    sourceMessageTs: string;
    threadTs?: string;
    conversationKey?: string;
    turnId?: string;
  }
): Promise<void> {
  const { sourceChannelId, sourceMessageTs, threadTs, conversationKey, turnId } = forkInfo;

  if (!conversationKey || !turnId) {
    console.log('[RestoreForkHere] Missing fork point info, cannot restore button');
    return;
  }

  const mutexKey = `${sourceChannelId}_${sourceMessageTs}`;
  const mutex = getUpdateMutex(mutexKey);

  await mutex.runExclusive(async () => {
    const historyResult = threadTs
      ? (await withSlackRetry(
          () =>
            client.conversations.replies({
              channel: sourceChannelId,
              ts: threadTs,
            }),
          'refresh.replies'
        )) as SlackMessagesResult
      : (await withSlackRetry(
          () =>
            client.conversations.history({
              channel: sourceChannelId,
              latest: sourceMessageTs,
              inclusive: true,
              limit: 1,
            }),
          'refresh.history'
        )) as SlackMessagesResult;

    const msg = threadTs
      ? historyResult.messages?.find((m) => m.ts === sourceMessageTs)
      : historyResult.messages?.[0];
    if (!msg?.blocks) {
      console.warn('[RestoreForkHere] Source message blocks not found; skipping update');
      return;
    }

    const updatedBlocks: any[] = [];
    let actionsBlockIndex = -1;

    for (const block of msg.blocks) {
      if (
        block.type === 'context' &&
        block.elements?.[0]?.text &&
        (block.elements[0].text.includes('Forked to') || block.elements[0].text.includes('Fork:'))
      ) {
        continue;
      }

      if (block.type === 'actions' && Array.isArray(block.elements)) {
        actionsBlockIndex = updatedBlocks.length;
        const filteredElements = block.elements.filter(
          (el: any) =>
            !(typeof el.action_id === 'string' && el.action_id.startsWith('refresh_fork_')) &&
            !(typeof el.action_id === 'string' && el.action_id.startsWith('fork_'))
        );
        updatedBlocks.push({ ...block, elements: filteredElements });
        continue;
      }

      updatedBlocks.push(block);
    }

    const forkButton = {
      type: 'button',
      text: { type: 'plain_text', text: ':twisted_rightwards_arrows: Fork here', emoji: true },
      action_id: `fork_${conversationKey}_${turnId}`,
      value: JSON.stringify({
        turnId,
        slackTs: sourceMessageTs,
        conversationKey,
      }),
    };

    if (actionsBlockIndex >= 0) {
      updatedBlocks[actionsBlockIndex].elements.push(forkButton);
    } else {
      updatedBlocks.push({
        type: 'actions',
        block_id: `fork_${sourceMessageTs}`,
        elements: [forkButton],
      });
    }

    await withSlackRetry(
      () =>
        client.chat.update({
          channel: sourceChannelId,
          ts: sourceMessageTs,
          blocks: updatedBlocks,
          text: msg.text,
        }),
      'refresh.update'
    );
  });
}

/**
 * Handle fork action (legacy - forks in same thread, not new channel).
 */
async function handleFork(
  sourceConversationKey: string,
  turnIndex: number,
  channelId: string,
  triggerMessageTs?: string
): Promise<void> {
  // Parse source conversation
  const parts = sourceConversationKey.split(':');
  const sourceChannelId = parts[0];
  const sourceThreadTs = parts[1];

  // Get source thread ID and turn count
  const sourceThreadId = getEffectiveThreadId(sourceChannelId, sourceThreadTs);
  if (!sourceThreadId) {
    await app.client.chat.postMessage({
      channel: channelId,
      text: 'Cannot fork: No active session found.',
    });
    return;
  }

  // Fork the Codex thread at the specified turn (using fork + rollback)
  // ROBUST: forkThreadAtTurn gets actual turn count from Codex (source of truth)
  const forkedThread = await codex.forkThreadAtTurn(sourceThreadId, turnIndex);

  // Create new thread in Slack
  const forkResult = await app.client.chat.postMessage({
    channel: channelId,
    thread_ts: triggerMessageTs,
    text: `:fork_and_knife: Forked from turn ${turnIndex}. New thread started.`,
  });

  if (forkResult.ts) {
    // Save the forked session
    await saveThreadSession(channelId, forkResult.ts, {
      threadId: forkedThread.id,
      forkedFrom: sourceThreadId,
      forkedAtTurnIndex: turnIndex,
    });
  }
}

// Export for testing
export { app, codex, streamingManager, approvalHandler, updateSourceMessageWithForkLink, restoreForkHereButton };
