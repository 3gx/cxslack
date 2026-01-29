/**
 * SDK Live Tests: Token Accumulation Verification
 *
 * CRITICAL TEST: Verifies that Codex token events send CUMULATIVE TOTALS,
 * not deltas. This test was created after discovering that using += instead
 * of = caused runaway token accumulation (showing "252k used" on new sessions).
 *
 * Run with: make sdk-test
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import readline from 'readline';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

// Helper to create JSON-RPC request
function createRequest(id: number, method: string, params?: Record<string, unknown>) {
  const request: Record<string, unknown> = {
    jsonrpc: '2.0',
    id,
    method,
  };
  if (params) {
    request.params = params;
  }
  return JSON.stringify(request) + '\n';
}

interface TokenEvent {
  method: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
}

describe.skipIf(SKIP_LIVE)('Codex Token Events', { timeout: 60000 }, () => {
  let server: ChildProcess;
  let rl: readline.Interface;
  let requestId = 0;
  const responseHandlers = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const notifications: Array<{ method: string; params: unknown }> = [];
  const tokenEvents: TokenEvent[] = [];

  beforeAll(async () => {
    // Spawn app-server
    server = spawn('codex', ['app-server'], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    // Set up line reader for responses
    rl = readline.createInterface({
      input: server.stdout!,
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && responseHandlers.has(msg.id)) {
          // Response to a request
          const handler = responseHandlers.get(msg.id)!;
          responseHandlers.delete(msg.id);
          if (msg.error) {
            handler.reject(new Error(msg.error.message));
          } else {
            handler.resolve(msg.result);
          }
        } else if (msg.method) {
          // Notification
          notifications.push({ method: msg.method, params: msg.params });

          // Capture token events specifically
          if (msg.method === 'codex/event/token_count') {
            const p = msg.params as { msg?: { info?: { total_token_usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number; cached_input_tokens?: number } } } };
            const usage = p.msg?.info?.total_token_usage;
            if (usage) {
              tokenEvents.push({
                method: msg.method,
                inputTokens: usage.input_tokens ?? 0,
                outputTokens: usage.output_tokens ?? 0,
                totalTokens: usage.total_tokens ?? 0,
                cachedInputTokens: usage.cached_input_tokens,
              });
            }
          } else if (msg.method === 'thread/tokenUsage/updated') {
            const p = msg.params as { tokenUsage?: { total?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; cachedInputTokens?: number } } };
            const usage = p.tokenUsage?.total;
            if (usage) {
              tokenEvents.push({
                method: msg.method,
                inputTokens: usage.inputTokens ?? 0,
                outputTokens: usage.outputTokens ?? 0,
                totalTokens: usage.totalTokens ?? 0,
                cachedInputTokens: usage.cachedInputTokens,
              });
            }
          }
        }
      } catch {
        // Ignore non-JSON lines
      }
    });

    // Initialize
    await rpc('initialize', {
      clientInfo: { name: 'cxslack-token-test', version: '1.0.0' },
    });
  });

  afterAll(() => {
    rl?.close();
    server?.kill();
  });

  async function rpc<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      responseHandlers.set(id, { resolve: resolve as (v: unknown) => void, reject });
      server.stdin!.write(createRequest(id, method, params));

      // Timeout after 30 seconds
      setTimeout(() => {
        if (responseHandlers.has(id)) {
          responseHandlers.delete(id);
          reject(new Error(`Request ${method} (id=${id}) timed out`));
        }
      }, 30000);
    });
  }

  it('token events send CUMULATIVE TOTALS, not deltas', async () => {
    // Clear any events from initialization
    tokenEvents.length = 0;
    notifications.length = 0;

    // Start a thread
    const threadResult = await rpc<{ thread: { id: string } }>('thread/start', {
      workingDirectory: process.cwd(),
    });
    const threadId = threadResult.thread.id;
    expect(threadId).toBeDefined();

    console.log('\n=== Token Accumulation Verification ===');
    console.log(`Thread: ${threadId}`);

    // Send a query that generates multiple token updates
    await rpc('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'Count from 1 to 10, saying each number on a new line.' }],
    });

    // Wait for turn to complete
    const startTime = Date.now();
    const timeout = 45000;
    let turnComplete = false;

    while (!turnComplete && Date.now() - startTime < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      turnComplete = notifications.some(
        (n) => n.method === 'codex/event/task_complete' || n.method === 'turn/completed'
      );
    }

    expect(turnComplete).toBe(true);

    console.log(`\nTotal token events received: ${tokenEvents.length}`);

    // Log all token events
    for (let i = 0; i < tokenEvents.length; i++) {
      const e = tokenEvents[i];
      console.log(`[Event ${i + 1}] input=${e.inputTokens}, output=${e.outputTokens}, total=${e.totalTokens}`);
    }

    // CRITICAL VERIFICATION: Token events should be TOTALS, not DELTAS
    // Evidence: Values should be the same or increasing (not small increments that reset)
    if (tokenEvents.length >= 2) {
      console.log('\n=== ANALYSIS ===');

      // Check if values decrease (would indicate deltas) or stay same/increase (totals)
      let valuesDecrease = false;
      let valuesIdentical = true;

      for (let i = 1; i < tokenEvents.length; i++) {
        const prev = tokenEvents[i - 1];
        const curr = tokenEvents[i];

        if (curr.inputTokens < prev.inputTokens || curr.outputTokens < prev.outputTokens) {
          valuesDecrease = true;
        }
        if (curr.inputTokens !== prev.inputTokens || curr.outputTokens !== prev.outputTokens) {
          valuesIdentical = false;
        }

        const inputDiff = curr.inputTokens - prev.inputTokens;
        const outputDiff = curr.outputTokens - prev.outputTokens;
        console.log(`Event ${i} → ${i + 1}: input diff=${inputDiff}, output diff=${outputDiff}`);
      }

      // If values are identical across events, they're definitely totals (not deltas)
      if (valuesIdentical) {
        console.log('\n✓ VERIFIED: Values identical across events = CUMULATIVE TOTALS');
        console.log('  The bot MUST use = not += when updating token state');
      }

      // If values never decrease and are non-zero, they're cumulative totals
      if (!valuesDecrease && tokenEvents[0].inputTokens > 0) {
        console.log('\n✓ VERIFIED: Values never decrease = CUMULATIVE TOTALS');
      }

      // FAIL if we see evidence of deltas (values decreasing or very small)
      expect(valuesDecrease).toBe(false);
    }

    // Verify token counts are reasonable for a simple query
    const lastEvent = tokenEvents[tokenEvents.length - 1];
    if (lastEvent) {
      console.log(`\nFinal token counts: input=${lastEvent.inputTokens}, output=${lastEvent.outputTokens}`);

      // Input tokens should be reasonable for a simple prompt (typically 100-20000)
      expect(lastEvent.inputTokens).toBeGreaterThan(0);
      expect(lastEvent.inputTokens).toBeLessThan(50000);

      // Output tokens should be reasonable for "count 1 to 10" (typically 10-500)
      expect(lastEvent.outputTokens).toBeGreaterThan(0);
      expect(lastEvent.outputTokens).toBeLessThan(5000);
    }

    console.log('==========================================\n');
  });

  it('cached_input_tokens is a SUBSET of input_tokens, not additional', async () => {
    // Clear events
    tokenEvents.length = 0;
    notifications.length = 0;

    // Start a thread
    const threadResult = await rpc<{ thread: { id: string } }>('thread/start', {
      workingDirectory: process.cwd(),
    });
    const threadId = threadResult.thread.id;

    // First query to populate cache
    await rpc('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'What is 2+2?' }],
    });

    // Wait for completion
    let startTime = Date.now();
    while (Date.now() - startTime < 30000) {
      await new Promise((r) => setTimeout(r, 100));
      if (notifications.some((n) => n.method === 'codex/event/task_complete' || n.method === 'turn/completed')) {
        break;
      }
    }

    // Clear and do second query (should hit cache)
    const firstQueryTokens = tokenEvents.length > 0 ? tokenEvents[tokenEvents.length - 1] : null;
    tokenEvents.length = 0;
    notifications.length = 0;

    await rpc('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'What is 3+3?' }],
    });

    // Wait for completion
    startTime = Date.now();
    while (Date.now() - startTime < 30000) {
      await new Promise((r) => setTimeout(r, 100));
      if (notifications.some((n) => n.method === 'codex/event/task_complete' || n.method === 'turn/completed')) {
        break;
      }
    }

    console.log('\n=== Cache Token Analysis ===');

    if (firstQueryTokens) {
      console.log(`First query: input=${firstQueryTokens.inputTokens}, cached=${firstQueryTokens.cachedInputTokens ?? 'N/A'}`);
    }

    const lastEvent = tokenEvents[tokenEvents.length - 1];
    if (lastEvent) {
      console.log(`Second query: input=${lastEvent.inputTokens}, cached=${lastEvent.cachedInputTokens ?? 'N/A'}`);

      // CRITICAL: If cached_input_tokens exists, it must be <= input_tokens
      // because it's a SUBSET (tokens read from cache), not additional tokens
      if (lastEvent.cachedInputTokens !== undefined) {
        console.log(`\nVerifying: cached_input_tokens (${lastEvent.cachedInputTokens}) <= input_tokens (${lastEvent.inputTokens})`);
        expect(lastEvent.cachedInputTokens).toBeLessThanOrEqual(lastEvent.inputTokens);
        console.log('✓ VERIFIED: cached_input_tokens is subset of input_tokens');
      } else {
        console.log('Note: cached_input_tokens not present in response (may not be using cache)');
      }
    }

    console.log('==========================================\n');
  });
});
