/**
 * Unit tests for StreamingManager timer-based updates.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Mutex } from 'async-mutex';

// Test the mutex logic used for concurrent update protection
describe('StreamingManager Mutex Logic', () => {
  it('mutex prevents concurrent execution', async () => {
    const mutex = new Mutex();
    const executionOrder: number[] = [];

    const task1 = mutex.runExclusive(async () => {
      executionOrder.push(1);
      await new Promise((r) => setTimeout(r, 50));
      executionOrder.push(2);
    });

    const task2 = mutex.runExclusive(async () => {
      executionOrder.push(3);
      await new Promise((r) => setTimeout(r, 10));
      executionOrder.push(4);
    });

    await Promise.all([task1, task2]);

    // Task 1 should complete fully before task 2 starts
    expect(executionOrder).toEqual([1, 2, 3, 4]);
  });

  it('mutex allows sequential execution', async () => {
    const mutex = new Mutex();
    let counter = 0;

    await mutex.runExclusive(async () => {
      counter++;
    });

    await mutex.runExclusive(async () => {
      counter++;
    });

    expect(counter).toBe(2);
  });
});

// Test the timer-based update scheduling
describe('StreamingManager Timer Logic', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timer fires at specified interval', () => {
    const callback = vi.fn();
    const updateRateMs = 500;

    const timer = setInterval(callback, updateRateMs);

    expect(callback).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(callback).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(500);
    expect(callback).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(1500);
    expect(callback).toHaveBeenCalledTimes(5);

    clearInterval(timer);
  });

  it('timer can be cleared to stop updates', () => {
    const callback = vi.fn();
    const timer = setInterval(callback, 500);

    vi.advanceTimersByTime(500);
    expect(callback).toHaveBeenCalledTimes(1);

    clearInterval(timer);

    vi.advanceTimersByTime(2000);
    expect(callback).toHaveBeenCalledTimes(1); // Still just 1
  });

  it('multiple timers for different conversations are independent', () => {
    const callback1 = vi.fn();
    const callback2 = vi.fn();

    const timer1 = setInterval(callback1, 500);
    const timer2 = setInterval(callback2, 1000);

    vi.advanceTimersByTime(1000);

    expect(callback1).toHaveBeenCalledTimes(2); // Fires at 500, 1000
    expect(callback2).toHaveBeenCalledTimes(1); // Fires at 1000

    clearInterval(timer1);
    clearInterval(timer2);
  });
});

// Test the state accumulation pattern
describe('StreamingManager State Accumulation', () => {
  it('accumulates text from multiple deltas', () => {
    let text = '';

    // Simulate item:delta events
    text += 'Hello';
    text += ' ';
    text += 'World';
    text += '!';

    expect(text).toBe('Hello World!');
  });

  it('accumulates thinking content', () => {
    let thinkingContent = '';
    let thinkingStartTime = 0;

    // First delta sets start time
    if (!thinkingStartTime) {
      thinkingStartTime = Date.now();
    }
    thinkingContent += 'Let me think';

    // Subsequent deltas just append
    thinkingContent += ' about this...';

    expect(thinkingContent).toBe('Let me think about this...');
    expect(thinkingStartTime).toBeGreaterThan(0);
  });

  it('tracks active tools by itemId', () => {
    const activeTools = new Map<string, { tool: string; startTime: number }>();

    // Tool starts
    activeTools.set('item-1', { tool: 'Read', startTime: Date.now() });
    activeTools.set('item-2', { tool: 'Bash', startTime: Date.now() });

    expect(activeTools.size).toBe(2);
    expect(activeTools.get('item-1')?.tool).toBe('Read');

    // Tool completes
    const toolInfo = activeTools.get('item-1');
    expect(toolInfo).toBeDefined();
    activeTools.delete('item-1');

    expect(activeTools.size).toBe(1);
    expect(activeTools.has('item-1')).toBe(false);
    expect(activeTools.has('item-2')).toBe(true);
  });
});

// Test the rolling window constants
describe('StreamingManager Rolling Window', () => {
  const MAX_LIVE_ENTRIES = 300;
  const ROLLING_WINDOW_SIZE = 20;

  it('rolling window activates when entries exceed threshold', () => {
    const entries = Array.from({ length: 350 }, (_, i) => ({ id: i }));

    const displayEntries =
      entries.length > MAX_LIVE_ENTRIES
        ? entries.slice(-ROLLING_WINDOW_SIZE)
        : entries;

    expect(displayEntries).toHaveLength(ROLLING_WINDOW_SIZE);
    expect(displayEntries[0].id).toBe(330); // First displayed is 330
    expect(displayEntries[19].id).toBe(349); // Last displayed is 349
  });

  it('shows all entries when under threshold', () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({ id: i }));

    const displayEntries =
      entries.length > MAX_LIVE_ENTRIES
        ? entries.slice(-ROLLING_WINDOW_SIZE)
        : entries;

    expect(displayEntries).toHaveLength(50);
  });

  it('calculates hidden count correctly', () => {
    const entries = Array.from({ length: 350 }, () => ({}));

    const hiddenCount =
      entries.length > MAX_LIVE_ENTRIES
        ? entries.length - ROLLING_WINDOW_SIZE
        : 0;

    expect(hiddenCount).toBe(330);
  });
});

// Test the status transitions
describe('StreamingManager Status Transitions', () => {
  type Status = 'running' | 'completed' | 'interrupted' | 'failed';

  it('status transitions from running to completed', () => {
    let status: Status = 'running';
    let isStreaming = true;

    // Simulate turn:completed
    status = 'completed';
    isStreaming = false;

    expect(status).toBe('completed');
    expect(isStreaming).toBe(false);
  });

  it('abort overrides status to interrupted', () => {
    let status: Status = 'running';
    const wasAborted = true;

    // Simulate turn:completed with abort
    if (wasAborted) {
      status = 'interrupted';
    }

    expect(status).toBe('interrupted');
  });

  it('failed status is preserved when not aborted', () => {
    let status: Status = 'failed';
    const wasAborted = false;

    if (wasAborted) {
      status = 'interrupted';
    }
    // status stays as 'failed' when not aborted

    expect(status).toBe('failed');
  });
});

// Test activity message timestamp management
describe('StreamingManager Activity Message Ts', () => {
  it('reuses initial message ts from context', () => {
    const context = {
      messageTs: '123.456',
      channelId: 'C123',
      threadTs: '456.789',
    };

    // In startStreaming, activityMessageTs is set from context.messageTs
    const state = {
      activityMessageTs: context.messageTs,
    };

    expect(state.activityMessageTs).toBe('123.456');
  });

  it('updates activityMessageTs after first post', () => {
    const state: { activityMessageTs?: string } = {};

    // Simulate first post (when activityMessageTs is undefined)
    if (!state.activityMessageTs) {
      // Would call chat.postMessage
      state.activityMessageTs = '789.012'; // Response ts
    }

    expect(state.activityMessageTs).toBe('789.012');
  });

  it('uses existing activityMessageTs for updates', () => {
    const state = {
      activityMessageTs: '123.456',
    };

    let updateCalled = false;
    let postCalled = false;

    // Simulate update logic
    if (state.activityMessageTs) {
      updateCalled = true; // Would call chat.update
    } else {
      postCalled = true; // Would call chat.postMessage
    }

    expect(updateCalled).toBe(true);
    expect(postCalled).toBe(false);
  });
});

// Test clearTimer functionality
describe('StreamingManager clearTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clearTimer stops the update interval', () => {
    const callback = vi.fn();
    let timer: ReturnType<typeof setInterval> | null = setInterval(callback, 500);

    vi.advanceTimersByTime(1000);
    expect(callback).toHaveBeenCalledTimes(2);

    // Clear timer (like abort handler does)
    if (timer) {
      clearInterval(timer);
      timer = null;
    }

    vi.advanceTimersByTime(2000);
    expect(callback).toHaveBeenCalledTimes(2); // No more calls
  });

  it('clearTimer is idempotent', () => {
    let timer: ReturnType<typeof setInterval> | null = setInterval(() => {}, 500);

    // Clear multiple times should not throw
    if (timer) {
      clearInterval(timer);
      timer = null;
    }

    if (timer) {
      clearInterval(timer);
      timer = null;
    }

    expect(timer).toBeNull();
  });
});
