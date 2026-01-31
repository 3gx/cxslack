/**
 * Session manager for mapping Slack channels/threads to Codex threads.
 *
 * Handles:
 * - Thread ID persistence (Codex thread IDs mapped to Slack channels/threads)
 * - Approval policy settings per session
 * - Working directory configuration
 * - Session forking tracking
 */

import fs from 'fs';
import { Mutex } from 'async-mutex';
import type { ApprovalPolicy, ReasoningEffort } from './codex-client.js';

/**
 * Mutex for serializing access to sessions.json file.
 * Prevents race conditions when multiple concurrent operations
 * try to read-modify-write the file simultaneously.
 */
const sessionsMutex = new Mutex();

/**
 * Default approval policy.
 */
export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = 'never';

/**
 * All available approval policies for UI display.
 */
export const APPROVAL_POLICIES: readonly ApprovalPolicy[] = [
  'never',
  'on-request',
  'on-failure',
  'untrusted',
];

/**
 * Usage data from the last query (for /status and /context commands).
 */
export interface LastUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens?: number;
  totalTokens?: number;
  contextWindow: number;
  model: string;
  maxOutputTokens?: number;
}

/**
 * Main channel session.
 */
export interface Session {
  /** Codex thread ID (null if no thread started yet) */
  threadId: string | null;
  /** Previous thread IDs (for /resume after /clear) */
  previousThreadIds?: string[];
  /** Turn history (channel scope) for fork/abort mapping */
  turns?: TurnInfo[];
  /** Working directory for Codex */
  workingDir: string;
  /** Approval policy */
  approvalPolicy: ApprovalPolicy;
  /** Selected model ID */
  model?: string;
  /** Reasoning effort level */
  reasoningEffort?: ReasoningEffort;
  /** Session creation time */
  createdAt: number;
  /** Last activity time */
  lastActiveAt: number;
  /** Path configuration (immutable once set) */
  pathConfigured: boolean;
  configuredPath: string | null;
  configuredBy: string | null;
  configuredAt: number | null;
  /** Message update rate in seconds (1-10, default 3) */
  updateRateSeconds?: number;
  /** Max response chars before truncation/attachment */
  threadCharLimit?: number;
  /** Usage data from last query (for /status and /context) */
  lastUsage?: LastUsage;
  /** Parent thread ID this channel was forked from (for fork-to-channel) */
  forkedFrom?: string;
  /** Turn index where fork happened (for point-in-time forking) */
  forkedAtTurnIndex?: number;
}

/**
 * Thread session (forked from main session).
 */
export interface ThreadSession {
  /** Codex thread ID */
  threadId: string | null;
  /** Parent thread ID this was forked from */
  forkedFrom: string | null;
  /** Turn index where fork happened (for point-in-time forking) */
  forkedAtTurnIndex?: number;
  /** Working directory (inherited from channel) */
  workingDir: string;
  /** Approval policy */
  approvalPolicy: ApprovalPolicy;
  /** Selected model ID (inherited from channel) */
  model?: string;
  /** Reasoning effort level (inherited from channel) */
  reasoningEffort?: ReasoningEffort;
  /** Thread creation time */
  createdAt: number;
  /** Last activity time */
  lastActiveAt: number;
  /** Path configuration (inherited from channel) */
  pathConfigured: boolean;
  configuredPath: string | null;
  configuredBy: string | null;
  configuredAt: number | null;
  /** Message update rate in seconds (inherited from channel) */
  updateRateSeconds?: number;
  /** Max response chars before truncation/attachment (inherited from channel) */
  threadCharLimit?: number;
  /** Previous thread IDs (for /resume after /clear) */
  previousThreadIds?: string[];
  /** Usage data from last query (for /status and /context) */
  lastUsage?: LastUsage;
  /** Message mapping: Slack ts -> Codex turnId */
  messageTurnMap?: Record<string, string>;
  /** Message mapping: Slack ts -> Codex toolUseId (activity posts) */
  messageToolMap?: Record<string, string>;
  /** Last thinking content (for attach-thinking action) */
  lastThinkingContent?: string;
  /** Last thinking preview (for attach-thinking message updates) */
  lastThinkingDisplay?: string;
  /** Last thinking content length (for attach-thinking validation) */
  lastThinkingCharCount?: number;
  /** Last thinking duration in ms (for attach-thinking display) */
  lastThinkingDurationMs?: number;
  /** Slack ts of the thinking message to update */
  lastThinkingMessageTs?: string;
  /** Turn counter for this thread (incremented per turn) */
  turnCounter?: number;
}

/**
 * Turn tracking for abort and fork operations.
 */
export interface TurnInfo {
  /** Turn ID (from Codex) */
  turnId: string;
  /** Turn index (0-based) */
  turnIndex: number;
  /** Slack message timestamp associated with this turn */
  slackTs: string;
}

/**
 * Channel session data including main session and thread sessions.
 */
interface ChannelSession extends Session {
  threads?: {
    [threadTs: string]: ThreadSession;
  };
  /** Map of turn index → turn info for fork operations */
  turns?: TurnInfo[];
}

interface SessionStore {
  channels: {
    [channelId: string]: ChannelSession;
  };
}

const SESSIONS_FILE = './sessions.json';

/**
 * Load sessions from disk. Handles corrupted files gracefully.
 */
export function loadSessions(): SessionStore {
  if (fs.existsSync(SESSIONS_FILE)) {
    try {
      const content = fs.readFileSync(SESSIONS_FILE, 'utf-8');
      const parsed = JSON.parse(content);
      // Validate basic structure
      if (parsed && typeof parsed === 'object' && parsed.channels) {
        return parsed;
      }
      console.error('sessions.json has invalid structure, resetting');
      return { channels: {} };
    } catch (error) {
      console.error('Failed to parse sessions.json, resetting:', error);
      return { channels: {} };
    }
  }
  return { channels: {} };
}

/**
 * Save sessions to disk.
 */
export function saveSessions(store: SessionStore): void {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(store, null, 2));
}

/**
 * Get a channel session.
 */
export function getSession(channelId: string): Session | null {
  const store = loadSessions();
  return store.channels[channelId] || null;
}

/**
 * Save a channel session.
 */
export async function saveSession(channelId: string, session: Partial<Session>): Promise<void> {
  await sessionsMutex.runExclusive(() => {
    const store = loadSessions();
    const existing = store.channels[channelId];

    store.channels[channelId] = {
      threadId: existing?.threadId ?? null,
      previousThreadIds: existing?.previousThreadIds ?? [],
      workingDir: existing?.workingDir ?? process.cwd(),
      approvalPolicy: existing?.approvalPolicy ?? DEFAULT_APPROVAL_POLICY,
      model: existing?.model,
      reasoningEffort: existing?.reasoningEffort,
      createdAt: existing?.createdAt ?? Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: existing?.pathConfigured ?? false,
      configuredPath: existing?.configuredPath ?? null,
      configuredBy: existing?.configuredBy ?? null,
      configuredAt: existing?.configuredAt ?? null,
      updateRateSeconds: existing?.updateRateSeconds,
      threadCharLimit: existing?.threadCharLimit,
      threads: existing?.threads,
      turns: existing?.turns,
      lastUsage: existing?.lastUsage,
      // message mappings only apply at thread level; no-op here
      ...session,
    };
    saveSessions(store);
  });
}

// ============================================================================
// Thread Session Management
// ============================================================================

/**
 * Get a thread session if it exists.
 */
export function getThreadSession(
  channelId: string,
  threadTs: string
): ThreadSession | null {
  const store = loadSessions();
  const channel = store.channels[channelId];
  if (!channel?.threads) {
    return null;
  }
  return channel.threads[threadTs] || null;
}

/**
 * Save a thread session.
 */
export async function saveThreadSession(
  channelId: string,
  threadTs: string,
  session: Partial<ThreadSession>
): Promise<void> {
  await sessionsMutex.runExclusive(() => {
    const store = loadSessions();
    const channel = store.channels[channelId];

    if (!channel) {
      // No main session exists - create a minimal one
      store.channels[channelId] = {
        threadId: null,
        workingDir: process.cwd(),
        approvalPolicy: DEFAULT_APPROVAL_POLICY,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        pathConfigured: false,
        configuredPath: null,
        configuredBy: null,
        configuredAt: null,
        threads: {},
      };
    }

    if (!store.channels[channelId].threads) {
      store.channels[channelId].threads = {};
    }

    const existingThread = store.channels[channelId].threads![threadTs];
    const mainChannel = store.channels[channelId];

    store.channels[channelId].threads![threadTs] = {
      threadId: existingThread?.threadId ?? null,
      forkedFrom: existingThread?.forkedFrom ?? null,
      workingDir: existingThread?.workingDir ?? mainChannel.workingDir,
      approvalPolicy: existingThread?.approvalPolicy ?? mainChannel.approvalPolicy,
      model: existingThread?.model ?? mainChannel.model,
      reasoningEffort: existingThread?.reasoningEffort ?? mainChannel.reasoningEffort,
      createdAt: existingThread?.createdAt ?? Date.now(),
      lastActiveAt: Date.now(),
      pathConfigured: existingThread?.pathConfigured ?? mainChannel.pathConfigured,
      configuredPath: existingThread?.configuredPath ?? mainChannel.configuredPath,
      configuredBy: existingThread?.configuredBy ?? mainChannel.configuredBy,
      configuredAt: existingThread?.configuredAt ?? mainChannel.configuredAt,
      updateRateSeconds: existingThread?.updateRateSeconds ?? mainChannel.updateRateSeconds,
      threadCharLimit: existingThread?.threadCharLimit ?? mainChannel.threadCharLimit,
      lastUsage: existingThread?.lastUsage,
      messageTurnMap: existingThread?.messageTurnMap,
      messageToolMap: existingThread?.messageToolMap,
      lastThinkingContent: existingThread?.lastThinkingContent,
      lastThinkingDisplay: existingThread?.lastThinkingDisplay,
      lastThinkingCharCount: existingThread?.lastThinkingCharCount,
      lastThinkingDurationMs: existingThread?.lastThinkingDurationMs,
      lastThinkingMessageTs: existingThread?.lastThinkingMessageTs,
      turnCounter: existingThread?.turnCounter ?? 0,
      ...session,
    };

    saveSessions(store);
  });
}

/**
 * Save model + reasoning for both channel and thread (if provided).
 * Ensures new threads inherit the latest selection.
 */
export async function saveModelSettings(
  channelId: string,
  threadTs: string | undefined,
  model: string,
  reasoningEffort: ReasoningEffort
): Promise<void> {
  await saveSession(channelId, { model, reasoningEffort });
  if (threadTs) {
    await saveThreadSession(channelId, threadTs, { model, reasoningEffort });
  }
}

/**
 * Save approval policy for both channel and thread (if provided).
 * Ensures new threads inherit the latest selection.
 */
export async function saveApprovalPolicy(
  channelId: string,
  threadTs: string | undefined,
  approvalPolicy: ApprovalPolicy
): Promise<void> {
  await saveSession(channelId, { approvalPolicy });
  if (threadTs) {
    await saveThreadSession(channelId, threadTs, { approvalPolicy });
  }
}

/**
 * Save thread message size limit for both channel and thread (if provided).
 * Ensures new threads inherit the latest selection.
 */
export async function saveThreadCharLimit(
  channelId: string,
  threadTs: string | undefined,
  threadCharLimit: number
): Promise<void> {
  await saveSession(channelId, { threadCharLimit });
  if (threadTs) {
    await saveThreadSession(channelId, threadTs, { threadCharLimit });
  }
}

/**
 * Result of getting or creating a thread session.
 */
export interface ThreadSessionResult {
  session: ThreadSession;
  isNewFork: boolean; // True if this is the first message in thread (needs fork)
}

/**
 * Get or create a thread session.
 */
export async function getOrCreateThreadSession(
  channelId: string,
  threadTs: string,
  forkFromThreadId?: string,
  forkAtTurnIndex?: number
): Promise<ThreadSessionResult> {
  const existing = getThreadSession(channelId, threadTs);

  if (existing) {
    // Existing thread session - just update lastActiveAt
    await saveThreadSession(channelId, threadTs, {
      lastActiveAt: Date.now(),
    });
    return { session: existing, isNewFork: false };
  }

  // New thread - create with fork info
  const mainSession = getSession(channelId);
  const newSession: Partial<ThreadSession> = {
    forkedFrom: forkFromThreadId ?? mainSession?.threadId ?? null,
    forkedAtTurnIndex: forkAtTurnIndex,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  };

  await saveThreadSession(channelId, threadTs, newSession);
  const created = getThreadSession(channelId, threadTs)!;
  return { session: created, isNewFork: true };
}

// ============================================================================
// Turn Tracking (for abort and fork)
// ============================================================================

/**
 * Record a turn for a channel session.
 */
export async function recordTurn(
  channelId: string,
  threadTs: string | null,
  turn: TurnInfo
): Promise<void> {
  await sessionsMutex.runExclusive(() => {
    const store = loadSessions();
    const channel = store.channels[channelId];

    if (!channel) {
      return;
    }

    if (threadTs) {
      // Thread turn - we don't track turns for threads currently
      return;
    }

    // Main channel turn
    if (!channel.turns) {
      channel.turns = [];
    }
    channel.turns.push(turn);
    saveSessions(store);
  });
}

/**
 * Get the last turn for a session.
 */
export function getLastTurn(channelId: string): TurnInfo | null {
  const store = loadSessions();
  const channel = store.channels[channelId];
  if (!channel?.turns?.length) {
    return null;
  }
  return channel.turns[channel.turns.length - 1];
}

/**
 * Get turn info by Slack message timestamp.
 */
export function getTurnBySlackTs(channelId: string, slackTs: string): TurnInfo | null {
  const store = loadSessions();
  const channel = store.channels[channelId];
  if (!channel?.turns) {
    return null;
  }
  return channel.turns.find((t) => t.slackTs === slackTs) || null;
}

// ============================================================================
// Session Clearing
// ============================================================================

/**
 * Delete all session data for a channel (main + all threads).
 * Called when a Slack channel is deleted.
 *
 * Note: Does NOT delete Codex threads - only the bot's metadata mapping.
 * Codex threads can still be resumed via /resume <thread-id> in another channel
 * if someone has the thread ID.
 */
export async function deleteChannelSession(channelId: string): Promise<void> {
  await sessionsMutex.runExclusive(() => {
    const store = loadSessions();
    const channelSession = store.channels[channelId];

    if (!channelSession) {
      console.log(`[channel-deleted] No session found for channel ${channelId}`);
      return;
    }

    // Count what we're deleting for logging
    const threadCount = channelSession.threads
      ? Object.keys(channelSession.threads).length
      : 0;
    const previousCount = channelSession.previousThreadIds?.length ?? 0;

    console.log(`[channel-deleted] Deleting sessions for channel ${channelId}:`);
    console.log(`  - 1 main session (threadId: ${channelSession.threadId ?? 'none'})`);
    if (previousCount > 0) {
      console.log(`  - ${previousCount} previous thread(s) from /clear operations`);
    }
    if (threadCount > 0) {
      console.log(`  - ${threadCount} Slack thread session(s)`);
    }

    // Log Codex thread IDs being orphaned (for auditing reference)
    const orphanedThreadIds: string[] = [];
    if (channelSession.threadId) {
      orphanedThreadIds.push(channelSession.threadId);
    }
    if (channelSession.previousThreadIds) {
      orphanedThreadIds.push(...channelSession.previousThreadIds.filter(Boolean));
    }
    if (channelSession.threads) {
      Object.values(channelSession.threads).forEach((t) => {
        if (t.threadId) orphanedThreadIds.push(t.threadId);
      });
    }
    if (orphanedThreadIds.length > 0) {
      console.log(
        `  - Codex threads orphaned (NOT deleted, can be /resume'd): ${orphanedThreadIds.join(', ')}`
      );
    }

    // Delete the channel entry entirely
    delete store.channels[channelId];
    saveSessions(store);

    console.log(`[channel-deleted] ✓ Removed channel ${channelId} from sessions.json`);
  });
}

/**
 * Clear the current session (for /clear command).
 * Preserves the thread ID in previousThreadIds for potential resume.
 */
export async function clearSession(
  channelId: string,
  threadTs?: string,
  userId?: string
): Promise<void> {
  // Always clear channel session's threadId (since main channel mentions use fallback)
  const channelSession = getSession(channelId);
  const threadSession = threadTs ? getThreadSession(channelId, threadTs) : null;

  // /clear implies /set-current-path in the previous session's directory
  const fallbackPath =
    threadSession?.configuredPath ||
    threadSession?.workingDir ||
    channelSession?.configuredPath ||
    channelSession?.workingDir ||
    process.env.DEFAULT_WORKING_DIR ||
    process.cwd();

  let normalizedPath = fallbackPath;
  try {
    normalizedPath = fs.realpathSync(fallbackPath);
  } catch {
    // Keep fallback path if realpath fails
  }

  const shouldLockChannel = !channelSession?.pathConfigured;
  const channelLockUpdate = shouldLockChannel
    ? {
        pathConfigured: true,
        configuredPath: normalizedPath,
        workingDir: normalizedPath,
        configuredBy: channelSession?.configuredBy ?? userId ?? null,
        configuredAt: channelSession?.configuredAt ?? Date.now(),
      }
    : {};

  if (channelSession?.threadId) {
    await saveSession(channelId, {
      threadId: null,
      previousThreadIds: [...(channelSession.previousThreadIds || []), channelSession.threadId],
      lastUsage: undefined,
      turns: [],
      ...channelLockUpdate,
    });
  } else if (channelSession) {
    // No active thread, still clear contextual usage/turns to start fresh
    await saveSession(channelId, {
      lastUsage: undefined,
      turns: [],
      ...channelLockUpdate,
    });
  } else if (shouldLockChannel) {
    // Create a minimal session so future messages can proceed
    await saveSession(channelId, {
      ...channelLockUpdate,
    });
  }

  // Also clear thread session if specified
  if (threadTs) {
    const existing = threadSession;
    const shouldLockThread = !!existing && !existing.pathConfigured;
    const threadLockUpdate = shouldLockThread
      ? {
          pathConfigured: true,
          configuredPath: normalizedPath,
          workingDir: normalizedPath,
          configuredBy: existing?.configuredBy ?? userId ?? null,
          configuredAt: existing?.configuredAt ?? Date.now(),
        }
      : {};

    if (existing?.threadId) {
      await saveThreadSession(channelId, threadTs, {
        threadId: null,
        previousThreadIds: [...(existing.previousThreadIds || []), existing.threadId],
        lastUsage: undefined,
        ...threadLockUpdate,
      });
    } else if (existing) {
      await saveThreadSession(channelId, threadTs, {
        lastUsage: undefined,
        ...threadLockUpdate,
      });
    }
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get effective working directory for a session.
 */
export function getEffectiveWorkingDir(
  channelId: string,
  threadTs?: string
): string {
  if (threadTs) {
    const threadSession = getThreadSession(channelId, threadTs);
    if (threadSession) {
      return threadSession.configuredPath || threadSession.workingDir;
    }
  }

  const session = getSession(channelId);
  if (session) {
    return session.configuredPath || session.workingDir;
  }

  return process.env.DEFAULT_WORKING_DIR || process.cwd();
}

/**
 * Get effective approval policy for a session.
 */
export function getEffectiveApprovalPolicy(
  channelId: string,
  threadTs?: string
): ApprovalPolicy {
  if (threadTs) {
    const threadSession = getThreadSession(channelId, threadTs);
    if (threadSession) {
      return threadSession.approvalPolicy;
    }
  }

  const session = getSession(channelId);
  return session?.approvalPolicy ?? DEFAULT_APPROVAL_POLICY;
}

/**
 * Get effective thread ID for a session.
 * Falls back to channel session if thread session has no threadId.
 * This ensures main channel @bot mentions share the same Codex thread.
 */
export function getEffectiveThreadId(
  channelId: string,
  threadTs?: string
): string | null {
  // First try thread-specific session
  if (threadTs) {
    const threadSession = getThreadSession(channelId, threadTs);
    if (threadSession?.threadId) {
      return threadSession.threadId;
    }
    // Thread session exists but has no threadId, or doesn't exist - fallback to channel
  }

  // Fallback to channel session
  const session = getSession(channelId);
  return session?.threadId ?? null;
}
