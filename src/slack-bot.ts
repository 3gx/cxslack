/**
 * Main Slack bot for Codex integration.
 *
 * Uses Slack Bolt framework with Socket Mode for real-time events.
 * Integrates with Codex App-Server for AI capabilities.
 */

import { App, LogLevel } from '@slack/bolt';
import { CodexClient, ApprovalRequest, TurnContent, ReasoningEffort, ApprovalPolicy } from './codex-client.js';
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
  Block,
} from './blocks.js';

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

      // Update source message to show fork link
      if (metadata.sourceMessageTs && metadata.sourceChannelId) {
        try {
          await client.chat.update({
            channel: metadata.sourceChannelId,
            ts: metadata.sourceMessageTs,
            text: `:twisted_rightwards_arrows: Forked to <#${result.channelId}>`,
            blocks: [
              {
                type: 'context',
                elements: [
                  {
                    type: 'mrkdwn',
                    text: `:twisted_rightwards_arrows: Forked to <#${result.channelId}>`,
                  },
                ],
              },
            ],
          });
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

        // Get channel name for suggested fork channel name
        const triggerBody = body as { trigger_id?: string };
        if (triggerBody.trigger_id) {
          let channelName = 'channel';
          try {
            const channelInfo = await client.conversations.info({ channel: channelId });
            channelName = (channelInfo.channel as { name?: string })?.name ?? 'channel';
          } catch {
            // Use default name if channel info unavailable
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

    if (threadTs) {
      await saveThreadSession(channelId, threadTs, { approvalPolicy: newPolicy });
    } else {
      await saveSession(channelId, { approvalPolicy: newPolicy });
    }

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
    const reasoningEffort = reasoningValue === 'medium' ? undefined : (reasoningValue as ReasoningEffort);
    console.log(`[model] Saving to session: channel=${channelId}, thread=${threadTs}, model=${modelValue}, reasoning=${reasoningEffort}`);
    await saveThreadSession(channelId, threadTs, { model: modelValue, reasoningEffort });

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
    if (errMsg === 'name_taken') {
      throw new Error(`Channel name "${channelName}" is already taken. Please choose a different name.`);
    } else if (errMsg === 'invalid_name_specials') {
      throw new Error(`Channel name "${channelName}" contains invalid characters. Use only lowercase letters, numbers, and hyphens.`);
    }
    throw error;
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
export { app, codex, streamingManager, approvalHandler };
