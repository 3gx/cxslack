/**
 * Main Slack bot for Codex integration.
 *
 * Uses Slack Bolt framework with Socket Mode for real-time events.
 * Integrates with Codex App-Server for AI capabilities.
 */

import { App, LogLevel } from '@slack/bolt';
import { CodexClient, ApprovalRequest, TurnContent } from './codex-client.js';
import { StreamingManager, makeConversationKey, StreamingContext } from './streaming.js';
import { ApprovalHandler } from './approval-handler.js';
import { handleCommand, CommandContext } from './commands.js';
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
  buildStatusBlocks,
  buildErrorBlocks,
  buildTextBlocks,
  buildAbortConfirmationModalView,
  Block,
} from './blocks.js';
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
      markAborted(conversationKey);
      const context = streamingManager.getContext(conversationKey);
      if (context) {
        await codex.interruptTurn(context.threadId, context.turnId);
      }
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
        // Fork action - handle thread forking
        const value = (action as { value: string }).value;
        const { turnIndex, conversationKey } = JSON.parse(value);
        const messageTs = (body as { message?: { ts?: string } }).message?.ts;
        await handleFork(conversationKey, turnIndex, channelId, messageTs);
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

  // Check if this is a command
  const commandContext: CommandContext = {
    channelId,
    threadTs: postingThreadTs, // Use posting thread for session lookup
    userId,
    text,
  };

  const commandResult = await handleCommand(commandContext, codex);
  if (commandResult) {
    // Send command response in thread
    await app.client.chat.postMessage({
      channel: channelId,
      thread_ts: postingThreadTs,
      blocks: commandResult.blocks,
      text: commandResult.text,
    });
    return;
  }

  // Regular message - send to Codex
  // Use postingThreadTs for all session lookups since that's our thread key
  const workingDir = getEffectiveWorkingDir(channelId, postingThreadTs);
  const approvalPolicy = getEffectiveApprovalPolicy(channelId, postingThreadTs);
  let threadId = getEffectiveThreadId(channelId, postingThreadTs);

  // Get session info - always use thread session since all conversations are in threads
  const session = getThreadSession(channelId, postingThreadTs) ?? getSession(channelId);

  // Start or resume thread
  if (!threadId) {
    // Check if this is a Slack thread that needs forking (only for existing threads, not new anchors)
    if (threadTs) {
      const result = await getOrCreateThreadSession(channelId, postingThreadTs);
      if (result.isNewFork && result.session.forkedFrom) {
        // Fork the Codex thread
        const forkedThread = await codex.forkThread(
          result.session.forkedFrom,
          result.session.forkedAtTurnIndex
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
      // Session is keyed by the anchor message ts (postingThreadTs = messageTs in this case)
      const newThread = await codex.startThread(workingDir);
      threadId = newThread.id;
      await saveThreadSession(channelId, postingThreadTs, { threadId });
    }
  } else {
    // Resume existing thread
    await codex.resumeThread(threadId);
  }

  // Post initial "processing" message IN THE THREAD
  const initialResult = await app.client.chat.postMessage({
    channel: channelId,
    thread_ts: postingThreadTs, // Always post in thread!
    blocks: buildStatusBlocks({ status: 'processing', conversationKey }),
    text: 'Processing...',
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
    model: session?.model,
    startTime: Date.now(),
  };

  streamingManager.startStreaming(streamingContext);

  // Start the turn
  const input: TurnContent[] = [{ type: 'text', text }];
  const turnId = await codex.startTurn(threadId, input, {
    approvalPolicy,
    reasoningEffort: session?.reasoningEffort,
    model: session?.model,
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
 * Handle fork action.
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

  // Get source thread ID
  const sourceThreadId = getEffectiveThreadId(sourceChannelId, sourceThreadTs);
  if (!sourceThreadId) {
    await app.client.chat.postMessage({
      channel: channelId,
      text: 'Cannot fork: No active session found.',
    });
    return;
  }

  // Fork the Codex thread
  const forkedThread = await codex.forkThread(sourceThreadId, turnIndex);

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
