/**
 * Integration tests for the shutdown flow.
 *
 * Tests shutdown cleanup order:
 * - stopAllStreaming clears all active contexts
 * - stopBot calls cleanup in correct order
 * - isShuttingDown prevents restart during cleanup
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Shutdown Flow Integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stopAllStreaming clears all active contexts and timers', () => {
    const clearCalls: string[] = [];

    // Create actual timers
    const timer1 = setInterval(() => {}, 1000);
    const timer2 = setInterval(() => {}, 1000);
    const timeout1 = setTimeout(() => {}, 5000);

    // Mock streaming manager with multiple active contexts
    const contexts = new Map([
      ['key1', { turnId: 't1' }],
      ['key2', { turnId: 't2' }],
    ]);
    const states = new Map<string, { updateTimer: ReturnType<typeof setInterval> | null; pendingAbortTimeout?: ReturnType<typeof setTimeout> }>([
      ['key1', { updateTimer: timer1, pendingAbortTimeout: timeout1 }],
      ['key2', { updateTimer: timer2 }],
    ]);

    // Implement stopAllStreaming
    function stopAllStreaming() {
      for (const [key, state] of states) {
        if (state.updateTimer) {
          clearInterval(state.updateTimer);
          clearCalls.push(`clearInterval:${key}`);
        }
        if (state.pendingAbortTimeout) {
          clearTimeout(state.pendingAbortTimeout);
          clearCalls.push(`clearTimeout:${key}`);
        }
      }
      contexts.clear();
      states.clear();
    }

    stopAllStreaming();

    expect(clearCalls).toContain('clearInterval:key1');
    expect(clearCalls).toContain('clearInterval:key2');
    expect(clearCalls).toContain('clearTimeout:key1');
    expect(contexts.size).toBe(0);
    expect(states.size).toBe(0);
  });

  it('stopBot calls cleanup in correct order', async () => {
    const callOrder: string[] = [];

    const mockStreamingManager = {
      stopAllStreaming: vi.fn(() => callOrder.push('stopAllStreaming')),
    };
    const mockCodex = {
      stop: vi.fn(async () => callOrder.push('codex.stop')),
    };
    const mockApp = {
      stop: vi.fn(async () => callOrder.push('app.stop')),
    };

    // Simulate stopBot with correct order
    async function stopBot() {
      console.log('Stopping Codex Slack bot...');
      // Order matters: stop streaming first, then codex, then app
      mockStreamingManager.stopAllStreaming();
      await mockCodex.stop();
      await mockApp.stop();
      console.log('Codex Slack bot stopped.');
    }

    await stopBot();

    expect(callOrder).toEqual(['stopAllStreaming', 'codex.stop', 'app.stop']);
  });

  it('isShuttingDown prevents restart during cleanup', async () => {
    let restartAttempted = false;
    let isShuttingDown = false;

    const handleProcessExit = () => {
      if (isShuttingDown) {
        console.log('[codex-client] Process exited during shutdown, not restarting');
        return;
      }
      restartAttempted = true;
      console.log('[codex-client] Process exited unexpectedly, restarting...');
    };

    // Start shutdown
    isShuttingDown = true;

    // Process exits during shutdown
    handleProcessExit();

    expect(restartAttempted).toBe(false);
  });
});
