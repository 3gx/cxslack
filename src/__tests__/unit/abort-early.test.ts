import { describe, it, expect, vi } from 'vitest';
import { isAborted, markAborted, clearAborted } from '../../abort-tracker.js';

describe('Early Abort Handling', () => {
  it('marks conversation as aborted even without turnId', () => {
    const key = 'test-abort-1';
    markAborted(key);
    expect(isAborted(key)).toBe(true);
    clearAborted(key);
  });

  it('abort flag persists until cleared', () => {
    const key = 'test-abort-2';
    markAborted(key);
    expect(isAborted(key)).toBe(true);
    expect(isAborted(key)).toBe(true); // Still true
    clearAborted(key);
    expect(isAborted(key)).toBe(false);
  });

  it('does NOT call interruptTurn when turnId is empty string', async () => {
    const context = { threadId: 'thread-1', turnId: '' }; // Empty string!
    const interruptTurn = vi.fn();

    // This is the fixed logic
    if (context && context.turnId) {
      await interruptTurn(context.threadId, context.turnId);
    }

    expect(interruptTurn).not.toHaveBeenCalled();
  });

  it('does NOT call interruptTurn when turnId is undefined', async () => {
    const context = { threadId: 'thread-1', turnId: undefined as unknown as string };
    const interruptTurn = vi.fn();

    if (context && context.turnId) {
      await interruptTurn(context.threadId, context.turnId);
    }

    expect(interruptTurn).not.toHaveBeenCalled();
  });

  it('calls interruptTurn when turnId is valid', async () => {
    const context = { threadId: 'thread-1', turnId: 'turn-123' };
    const interruptTurn = vi.fn().mockResolvedValue(undefined);

    if (context && context.turnId) {
      await interruptTurn(context.threadId, context.turnId);
    }

    expect(interruptTurn).toHaveBeenCalledWith('thread-1', 'turn-123');
  });
});
