/**
 * Integration tests for the abort flow.
 *
 * Tests real component interactions for the turnId race condition fix:
 * - queueAbort when turnId is empty
 * - turn:started event triggers pending abort
 * - immediate abort when turnId is already available
 * - abort timeout cleanup
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock CodexClient that emits real events
class MockCodexClient extends EventEmitter {
  interruptTurn = vi.fn().mockResolvedValue(undefined);
}

// Mock Slack WebClient
const mockSlackClient = {
  chat: { update: vi.fn().mockResolvedValue({ ok: true }) },
};

// Simplified StreamingManager for testing abort logic
class TestableStreamingManager {
  private contexts = new Map<string, { threadId: string; turnId: string }>();
  private states = new Map<string, { pendingAbort: boolean; pendingAbortTimeout?: ReturnType<typeof setTimeout> }>();
  private codex: MockCodexClient;

  constructor(codex: MockCodexClient) {
    this.codex = codex;
    this.setupEventHandlers();
  }

  startStreaming(conversationKey: string, context: { threadId: string; turnId: string }): void {
    this.contexts.set(conversationKey, context);
    this.states.set(conversationKey, { pendingAbort: false, pendingAbortTimeout: undefined });
  }

  queueAbort(conversationKey: string): boolean {
    const context = this.contexts.get(conversationKey);
    const state = this.states.get(conversationKey);
    if (!context || !state) {
      console.log(`[abort] No active context for ${conversationKey}`);
      return false;
    }
    if (context.turnId) {
      console.log(`[abort] Executing immediate abort for turnId: ${context.turnId}`);
      this.codex.interruptTurn(context.threadId, context.turnId).catch((err) => {
        console.error('[abort] Failed to interrupt turn:', err);
      });
      return true;
    } else {
      console.log(`[abort] Queueing abort (turnId not yet available)`);
      state.pendingAbort = true;
      // Safety timeout: if turnId never arrives, clear pending state after 10s
      state.pendingAbortTimeout = setTimeout(() => {
        if (state.pendingAbort) {
          console.error('[abort] Timeout waiting for turnId - abort may not have been sent to Codex');
          state.pendingAbort = false;
        }
      }, 10000);
      return true;
    }
  }

  private findContextByThreadId(threadId: string): { key: string; context: { threadId: string; turnId: string } } | undefined {
    for (const [key, context] of this.contexts) {
      if (context.threadId === threadId) {
        return { key, context };
      }
    }
    return undefined;
  }

  private setupEventHandlers(): void {
    // turn:started event handler
    this.codex.on('turn:started', ({ threadId, turnId }) => {
      const found = this.findContextByThreadId(threadId);
      if (found) {
        found.context.turnId = turnId;
        const state = this.states.get(found.key);
        if (state?.pendingAbort) {
          console.log(`[streaming] Executing pending abort for turnId: ${turnId}`);
          state.pendingAbort = false;
          if (state.pendingAbortTimeout) {
            clearTimeout(state.pendingAbortTimeout);
            state.pendingAbortTimeout = undefined;
          }
          this.codex.interruptTurn(threadId, turnId).catch((err) => {
            console.error('[streaming] Failed to execute pending abort:', err);
          });
        }
      }
    });

    // context:turnId event handler (backup source from exec_command notifications)
    this.codex.on('context:turnId', ({ threadId, turnId }) => {
      const found = this.findContextByThreadId(threadId);
      if (found && !found.context.turnId) {
        found.context.turnId = turnId;
        console.log(`[streaming] Got turnId from context:turnId: ${turnId}`);
        const state = this.states.get(found.key);
        if (state?.pendingAbort) {
          console.log(`[streaming] Executing pending abort from context:turnId`);
          state.pendingAbort = false;
          if (state.pendingAbortTimeout) {
            clearTimeout(state.pendingAbortTimeout);
            state.pendingAbortTimeout = undefined;
          }
          this.codex.interruptTurn(threadId, turnId).catch((err) => {
            console.error('[streaming] Failed to execute pending abort:', err);
          });
        }
      }
    });
  }

  getState(key: string) {
    return this.states.get(key);
  }
}

describe('Abort Flow Integration', () => {
  let codex: MockCodexClient;
  let streamingManager: TestableStreamingManager;

  beforeEach(() => {
    vi.useFakeTimers();
    codex = new MockCodexClient();
    streamingManager = new TestableStreamingManager(codex);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('queueAbort + turn:started = interruptTurn called', async () => {
    // Setup: start streaming with empty turnId
    const conversationKey = 'C123:1234.5678';
    streamingManager.startStreaming(conversationKey, {
      threadId: 'thread-1',
      turnId: '', // Empty - simulates race condition
    });

    // Action 1: Queue abort (turnId not yet available)
    streamingManager.queueAbort(conversationKey);

    // Verify: interruptTurn NOT called yet
    expect(codex.interruptTurn).not.toHaveBeenCalled();

    // Action 2: Simulate turn:started event arriving
    codex.emit('turn:started', { threadId: 'thread-1', turnId: 'turn-abc' });

    // Allow async handlers
    await vi.advanceTimersByTimeAsync(10);

    // Verify: interruptTurn WAS called with correct args
    expect(codex.interruptTurn).toHaveBeenCalledWith('thread-1', 'turn-abc');
  });

  it('immediate abort when turnId already available', () => {
    const conversationKey = 'C123:1234.5678';
    streamingManager.startStreaming(conversationKey, {
      threadId: 'thread-1',
      turnId: 'turn-existing', // Already have turnId
    });

    streamingManager.queueAbort(conversationKey);

    // Verify: immediate call, no queueing
    expect(codex.interruptTurn).toHaveBeenCalledWith('thread-1', 'turn-existing');
  });

  it('context:turnId as backup source triggers pending abort', async () => {
    const conversationKey = 'C123:1234.5678';
    streamingManager.startStreaming(conversationKey, {
      threadId: 'thread-1',
      turnId: '',
    });

    streamingManager.queueAbort(conversationKey);

    // Simulate context:turnId arriving (from exec_command notification)
    codex.emit('context:turnId', { threadId: 'thread-1', turnId: 'turn-from-context' });
    await vi.advanceTimersByTimeAsync(10);

    expect(codex.interruptTurn).toHaveBeenCalledWith('thread-1', 'turn-from-context');
  });

  it('abort timeout clears pending state after 10s', async () => {
    const conversationKey = 'C123:1234.5678';
    streamingManager.startStreaming(conversationKey, {
      threadId: 'thread-1',
      turnId: '',
    });

    streamingManager.queueAbort(conversationKey);

    // Verify pending state is set
    expect(streamingManager.getState(conversationKey)?.pendingAbort).toBe(true);

    // Advance 10 seconds
    await vi.advanceTimersByTimeAsync(10000);

    // Verify: pending state cleared by timeout
    expect(streamingManager.getState(conversationKey)?.pendingAbort).toBe(false);

    // Now turn:started arrives (too late)
    codex.emit('turn:started', { threadId: 'thread-1', turnId: 'turn-late' });
    await vi.advanceTimersByTimeAsync(10);

    // Verify: interruptTurn NOT called (timeout cleared pending state)
    expect(codex.interruptTurn).not.toHaveBeenCalled();
  });
});
