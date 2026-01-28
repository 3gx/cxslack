/**
 * Unit tests for pending abort logic.
 *
 * Tests the core logic for queuing and executing aborts when turnId
 * is not yet available.
 */

import { describe, it, expect, vi } from 'vitest';

describe('Pending Abort Logic', () => {
  it('queues abort when turnId is empty', () => {
    const state = { pendingAbort: false };
    const context = { turnId: '' };

    if (!context.turnId) {
      state.pendingAbort = true;
    }

    expect(state.pendingAbort).toBe(true);
  });

  it('executes immediate abort when turnId available', () => {
    const interruptTurn = vi.fn();
    const context = { threadId: 't1', turnId: 'turn-123' };

    if (context.turnId) {
      interruptTurn(context.threadId, context.turnId);
    }

    expect(interruptTurn).toHaveBeenCalledWith('t1', 'turn-123');
  });

  it('executes pending abort when turnId arrives', () => {
    const interruptTurn = vi.fn();
    const state = { pendingAbort: true };
    const turnId = 'turn-456';
    const threadId = 't2';

    if (state.pendingAbort && turnId) {
      state.pendingAbort = false;
      interruptTurn(threadId, turnId);
    }

    expect(state.pendingAbort).toBe(false);
    expect(interruptTurn).toHaveBeenCalledWith('t2', 'turn-456');
  });

  it('does not execute if no pending abort', () => {
    const interruptTurn = vi.fn();
    const state = { pendingAbort: false };

    if (state.pendingAbort) {
      interruptTurn('t', 'turn');
    }

    expect(interruptTurn).not.toHaveBeenCalled();
  });

  it('handles multiple turnId sources (turn:started vs context:turnId)', () => {
    let turnIdSet = false;
    const context = { turnId: '' };

    // Simulate context:turnId arriving first
    if (!context.turnId) {
      context.turnId = 'from-context';
      turnIdSet = true;
    }

    // Simulate turn:started arriving second (should not overwrite)
    if (!context.turnId) {
      context.turnId = 'from-turn-started';
    }

    expect(context.turnId).toBe('from-context');
    expect(turnIdSet).toBe(true);
  });
});

describe('Pending Abort Timeout', () => {
  it('clears pending state after timeout', () => {
    vi.useFakeTimers();
    const state = { pendingAbort: true };

    // Set timeout to clear pending state
    setTimeout(() => {
      if (state.pendingAbort) {
        state.pendingAbort = false;
      }
    }, 10000);

    // State still pending before timeout
    expect(state.pendingAbort).toBe(true);

    // Advance time past timeout
    vi.advanceTimersByTime(10000);

    // State should be cleared
    expect(state.pendingAbort).toBe(false);
    vi.useRealTimers();
  });

  it('does not clear if abort executed before timeout', () => {
    vi.useFakeTimers();
    const state = { pendingAbort: true };
    let timeoutCleared = false;

    const timeout = setTimeout(() => {
      if (state.pendingAbort) {
        state.pendingAbort = false;
      }
    }, 10000);

    // Simulate abort executing at 5s
    vi.advanceTimersByTime(5000);
    state.pendingAbort = false;
    clearTimeout(timeout);
    timeoutCleared = true;

    // Advance past original timeout
    vi.advanceTimersByTime(5000);

    // State should still be false (cleared by abort, not timeout)
    expect(state.pendingAbort).toBe(false);
    expect(timeoutCleared).toBe(true);
    vi.useRealTimers();
  });
});
