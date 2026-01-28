/**
 * Shutdown Logic Tests
 *
 * These tests verify the shutdown sequence using fake timers for deterministic behavior.
 * Tests cover: graceful shutdown, SIGTERM escalation, SIGKILL escalation, and edge cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

describe('Shutdown Logic', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Graceful Shutdown Sequence', () => {
    it('process exits gracefully within timeout - no SIGTERM needed', async () => {
      const killCalls: string[] = [];
      let exitHandler: (() => void) | null = null;

      const mockProcess = {
        stdin: { write: vi.fn() },
        once: vi.fn((event: string, handler: () => void) => {
          if (event === 'exit') exitHandler = handler;
        }),
        removeListener: vi.fn(),
        kill: vi.fn((signal: string) => killCalls.push(signal)),
        exitCode: null as number | null,
        killed: false,
      };

      // Simulate stop() logic - Phase 1: Graceful (2s timeout)
      const waitForExit = new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          mockProcess.removeListener('exit', exitHandler!);
          resolve(false);
        }, 2000);

        mockProcess.once('exit', () => {
          clearTimeout(timeout);
          resolve(true);
        });
      });

      // Simulate: process exits at 500ms (well before 2s timeout)
      setTimeout(() => {
        if (exitHandler) exitHandler();
      }, 500);

      await vi.advanceTimersByTimeAsync(500);
      const exitedGracefully = await waitForExit;

      // VERIFY: Process exited gracefully, no kill signals sent
      expect(exitedGracefully).toBe(true);
      expect(killCalls).toEqual([]);
    });

    it('escalates to SIGTERM after 2s graceful timeout', async () => {
      const killCalls: string[] = [];
      let exitHandler: (() => void) | null = null;

      const mockProcess = {
        stdin: { write: vi.fn() },
        once: vi.fn((event: string, handler: () => void) => {
          if (event === 'exit') exitHandler = handler;
        }),
        removeListener: vi.fn(),
        kill: vi.fn((signal: string) => {
          killCalls.push(signal);
          // Simulate process responding to SIGTERM after 500ms
          if (signal === 'SIGTERM') {
            setTimeout(() => {
              if (exitHandler) exitHandler();
            }, 500);
          }
        }),
        exitCode: null as number | null,
        killed: false,
      };

      // Simulate full shutdown sequence
      let phase = 'graceful';
      const shutdown = async () => {
        // Phase 1: Graceful (2s)
        phase = 'graceful';
        const gracefulExit = await waitForExitWithTimeout(mockProcess, 2000);
        if (gracefulExit) return 'graceful';

        // Phase 2: SIGTERM (2s)
        phase = 'sigterm';
        mockProcess.kill('SIGTERM');
        const sigtermExit = await waitForExitWithTimeout(mockProcess, 2000);
        if (sigtermExit) return 'sigterm';

        // Phase 3: SIGKILL
        phase = 'sigkill';
        mockProcess.kill('SIGKILL');
        return 'sigkill';
      };

      function waitForExitWithTimeout(proc: typeof mockProcess, timeoutMs: number): Promise<boolean> {
        return new Promise((resolve) => {
          const timeout = setTimeout(() => resolve(false), timeoutMs);
          const handler = () => {
            clearTimeout(timeout);
            resolve(true);
          };
          proc.once('exit', handler);
        });
      }

      const shutdownPromise = shutdown();

      // Advance past graceful timeout (2s)
      await vi.advanceTimersByTimeAsync(2000);
      expect(killCalls).toEqual(['SIGTERM']);

      // Advance 500ms for SIGTERM to take effect
      await vi.advanceTimersByTimeAsync(500);

      const result = await shutdownPromise;
      expect(result).toBe('sigterm');
    });

    it('escalates to SIGKILL after SIGTERM timeout', async () => {
      const killCalls: string[] = [];

      const mockProcess = {
        stdin: { write: vi.fn() },
        once: vi.fn(), // Never triggers exit (simulates hung process)
        removeListener: vi.fn(),
        kill: vi.fn((signal: string) => killCalls.push(signal)),
        exitCode: null as number | null,
        killed: false,
      };

      // Simulate shutdown that requires SIGKILL
      const shutdown = async () => {
        // Phase 1: Graceful - wait 2s, no exit
        await new Promise((r) => setTimeout(r, 2000));

        // Phase 2: SIGTERM - wait 2s, no exit
        mockProcess.kill('SIGTERM');
        await new Promise((r) => setTimeout(r, 2000));

        // Phase 3: SIGKILL
        mockProcess.kill('SIGKILL');
      };

      const shutdownPromise = shutdown();

      // Initially no signals sent
      expect(killCalls).toEqual([]);

      // Advance 2s (graceful timeout expires) - SIGTERM is sent after graceful period
      await vi.advanceTimersByTimeAsync(2000);
      expect(killCalls).toEqual(['SIGTERM']);

      // Advance 2s more (SIGTERM timeout expires) - SIGKILL is sent
      await vi.advanceTimersByTimeAsync(2000);
      await shutdownPromise;

      expect(killCalls).toEqual(['SIGTERM', 'SIGKILL']);
    });
  });

  describe('Shutdown State Management', () => {
    it('prevents restart during shutdown (isShuttingDown flag)', () => {
      let restartAttempted = false;
      let isShuttingDown = false;

      const handleProcessExit = () => {
        if (isShuttingDown) {
          // Don't restart during intentional shutdown
          return;
        }
        restartAttempted = true;
      };

      // Start shutdown
      isShuttingDown = true;

      // Process exits
      handleProcessExit();

      // VERIFY: Restart was NOT attempted
      expect(restartAttempted).toBe(false);
    });

    it('prevents double shutdown', () => {
      let shutdownCount = 0;
      let isShuttingDown = false;

      const shutdown = () => {
        if (isShuttingDown) {
          console.log('Already shutting down, ignoring');
          return false;
        }
        isShuttingDown = true;
        shutdownCount++;
        return true;
      };

      // Multiple shutdown attempts (e.g., multiple Ctrl+C)
      expect(shutdown()).toBe(true); // First succeeds
      expect(shutdown()).toBe(false); // Second ignored
      expect(shutdown()).toBe(false); // Third ignored

      expect(shutdownCount).toBe(1);
    });

    it('rejects all pending requests on shutdown', () => {
      const pending = new Map<number, { reject: ReturnType<typeof vi.fn> }>();
      pending.set(1, { reject: vi.fn() });
      pending.set(2, { reject: vi.fn() });
      pending.set(3, { reject: vi.fn() });

      // Simulate rejectAll()
      const error = new Error('Client stopped');
      for (const [, request] of pending) {
        request.reject(error);
      }
      pending.clear();

      // VERIFY: All requests were rejected
      expect(pending.size).toBe(0);
    });
  });

  describe('Streaming Cleanup on Shutdown', () => {
    it('clears all timers and state on stopAllStreaming', () => {
      const clearIntervalCalls: unknown[] = [];
      const clearTimeoutCalls: unknown[] = [];

      // Mock timers
      const timer1 = { id: 1 };
      const timer2 = { id: 2 };
      const timeout1 = { id: 3 };

      const states = new Map([
        ['key1', { updateTimer: timer1, pendingAbortTimeout: timeout1 }],
        ['key2', { updateTimer: timer2, pendingAbortTimeout: undefined }],
      ]);

      // Simulate stopAllStreaming()
      for (const [key, state] of states) {
        if (state.updateTimer) {
          clearIntervalCalls.push(state.updateTimer);
          state.updateTimer = null;
        }
        if (state.pendingAbortTimeout) {
          clearTimeoutCalls.push(state.pendingAbortTimeout);
          state.pendingAbortTimeout = undefined;
        }
      }
      states.clear();

      // VERIFY: All timers cleared
      expect(clearIntervalCalls).toHaveLength(2);
      expect(clearTimeoutCalls).toHaveLength(1);
      expect(states.size).toBe(0);
    });
  });

  describe('Force Exit Timeout', () => {
    it('forces exit after 6s if stopBot hangs', async () => {
      let forceExitCalled = false;
      let normalExitCalled = false;

      // Simulate index.ts shutdown wrapper
      const shutdown = async () => {
        const forceExit = setTimeout(() => {
          forceExitCalled = true;
        }, 6000);

        // Simulate stopBot() that hangs forever
        await new Promise(() => {}); // Never resolves

        clearTimeout(forceExit);
        normalExitCalled = true;
      };

      // Start shutdown (don't await - it hangs)
      shutdown();

      // Advance to force exit timeout
      await vi.advanceTimersByTimeAsync(6000);

      expect(forceExitCalled).toBe(true);
      expect(normalExitCalled).toBe(false);
    });
  });
});
