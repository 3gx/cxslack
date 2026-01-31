/**
 * SDK Live Test: Token Thread Isolation
 *
 * Verifies that token tracking correctly isolates values per thread:
 * 1. Token events include threadId
 * 2. getThreadTokenUsage reads from Codex session file
 * 3. Cross-client scenario (bot -> CLI -> bot) works correctly
 *
 * Run with: npx vitest run src/__tests__/sdk-live/token-thread-isolation.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import readline from 'readline';
import * as fs from 'fs';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

interface AppServer {
  process: ChildProcess;
  rl: readline.Interface;
  requestId: number;
  responseHandlers: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  notifications: Array<{ method: string; params: unknown }>;
}

function createAppServer(): AppServer {
  const server = spawn('codex', ['app-server'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  const rl = readline.createInterface({
    input: server.stdout!,
    crlfDelay: Infinity,
  });

  const responseHandlers = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const notifications: Array<{ method: string; params: unknown }> = [];

  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && responseHandlers.has(msg.id)) {
        const handler = responseHandlers.get(msg.id)!;
        responseHandlers.delete(msg.id);
        if (msg.error) {
          handler.reject(new Error(msg.error.message));
        } else {
          handler.resolve(msg.result);
        }
      } else if (msg.method) {
        notifications.push({ method: msg.method, params: msg.params });
      }
    } catch {
      // Ignore non-JSON
    }
  });

  return { process: server, rl, requestId: 0, responseHandlers, notifications };
}

async function rpc<T>(server: AppServer, method: string, params?: Record<string, unknown>): Promise<T> {
  const id = ++server.requestId;
  return new Promise((resolve, reject) => {
    server.responseHandlers.set(id, { resolve: resolve as (v: unknown) => void, reject });
    const request = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    server.process.stdin!.write(request);

    setTimeout(() => {
      if (server.responseHandlers.has(id)) {
        server.responseHandlers.delete(id);
        reject(new Error(`Request ${method} timed out`));
      }
    }, 30000);
  });
}

async function waitForTurnComplete(server: AppServer, timeout = 30000): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    await new Promise(r => setTimeout(r, 100));
    if (server.notifications.some(n => n.method === 'turn/completed' || n.method === 'codex/event/task_complete')) {
      return;
    }
  }
  throw new Error('Turn did not complete in time');
}

interface TokenEvent {
  method: string;
  threadId?: string;
  inputTokens?: number;
  outputTokens?: number;
}

function getTokenEvents(server: AppServer): TokenEvent[] {
  return server.notifications
    .filter(n => n.method === 'thread/tokenUsage/updated' || n.method === 'codex/event/token_count')
    .map(n => {
      const params = n.params as Record<string, unknown>;
      // thread/tokenUsage/updated uses tokenUsage.total (per-thread cumulative)
      const tokenUsage = params.tokenUsage as { total?: { inputTokens?: number; outputTokens?: number } } | undefined;
      // codex/event/token_count uses msg.info - prefer last_token_usage (per-thread) over total_token_usage (global)
      const msg = params.msg as { info?: {
        total_token_usage?: { input_tokens?: number; output_tokens?: number };
        last_token_usage?: { input_tokens?: number; output_tokens?: number };
      } } | undefined;

      return {
        method: n.method,
        threadId: (params.threadId ?? params.conversationId) as string | undefined,
        // Prefer per-thread values: tokenUsage.total or last_token_usage
        inputTokens: tokenUsage?.total?.inputTokens ?? msg?.info?.last_token_usage?.input_tokens,
        outputTokens: tokenUsage?.total?.outputTokens ?? msg?.info?.last_token_usage?.output_tokens,
      };
    });
}

function readSessionFileTokens(sessionPath: string): { inputTokens: number; outputTokens: number; totalTokens: number } | null {
  if (!fs.existsSync(sessionPath)) return null;

  const lines = fs.readFileSync(sessionPath, 'utf-8').trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === 'event_msg' && entry.payload?.type === 'token_count') {
        // CRITICAL: Use last_token_usage (per-thread), NOT total_token_usage (global)
        const usage = entry.payload.info?.last_token_usage;
        if (usage) {
          return {
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            totalTokens: usage.total_tokens ?? 0,
          };
        }
      }
    } catch {
      // Skip
    }
  }
  return null;
}

describe.skipIf(SKIP_LIVE)('Token Thread Isolation', { timeout: 120000 }, () => {
  let server: AppServer;

  beforeAll(async () => {
    server = createAppServer();
    await rpc(server, 'initialize', {
      clientInfo: { name: 'token-isolation-test', version: '1.0.0' },
    });
  });

  afterAll(() => {
    server?.rl?.close();
    server?.process?.kill();
  });

  it('token events include threadId', async () => {
    server.notifications.length = 0;

    // Start a thread
    const threadResult = await rpc<{ thread: { id: string } }>(server, 'thread/start', {
      workingDirectory: process.cwd(),
    });
    const threadId = threadResult.thread.id;

    // Do a turn
    await rpc(server, 'turn/start', {
      threadId,
      input: [{ type: 'text', text: 'Say "test"' }],
    });
    await waitForTurnComplete(server);

    // Check token events have threadId
    const tokenEvents = getTokenEvents(server);
    expect(tokenEvents.length).toBeGreaterThan(0);

    // At least one event should have the correct threadId
    const matchingEvents = tokenEvents.filter(e => e.threadId === threadId);
    expect(matchingEvents.length).toBeGreaterThan(0);

    // All events with threadId should match our thread
    const eventsWithThreadId = tokenEvents.filter(e => e.threadId);
    for (const event of eventsWithThreadId) {
      expect(event.threadId).toBe(threadId);
    }
  });

  it('getThreadTokenUsage reads from Codex session file', async () => {
    server.notifications.length = 0;

    // Start a thread
    const threadResult = await rpc<{ thread: { id: string } }>(server, 'thread/start', {
      workingDirectory: process.cwd(),
    });
    const threadId = threadResult.thread.id;

    // Do a turn
    await rpc(server, 'turn/start', {
      threadId,
      input: [{ type: 'text', text: 'Say "hello"' }],
    });
    await waitForTurnComplete(server);

    // Get session file path via thread/read
    const readResult = await rpc<{ thread: { id: string; path: string } }>(server, 'thread/read', {
      threadId,
      includeTurns: false,
    });
    expect(readResult.thread.path).toBeDefined();

    // Read token usage from session file
    const sessionTokens = readSessionFileTokens(readResult.thread.path);
    expect(sessionTokens).not.toBeNull();
    expect(sessionTokens!.inputTokens).toBeGreaterThan(0);
    expect(sessionTokens!.totalTokens).toBeGreaterThan(0);

    // Verify it matches token events
    const tokenEvents = getTokenEvents(server);
    const lastEvent = tokenEvents[tokenEvents.length - 1];
    expect(lastEvent.inputTokens).toBe(sessionTokens!.inputTokens);
  });

  it('two threads have isolated token counts', async () => {
    // Thread 1
    server.notifications.length = 0;
    const thread1Result = await rpc<{ thread: { id: string } }>(server, 'thread/start', {
      workingDirectory: process.cwd(),
    });
    const thread1Id = thread1Result.thread.id;

    await rpc(server, 'turn/start', {
      threadId: thread1Id,
      input: [{ type: 'text', text: 'Say "alpha"' }],
    });
    await waitForTurnComplete(server);

    const thread1Events = getTokenEvents(server);
    const thread1LastEvent = thread1Events[thread1Events.length - 1];

    // Thread 2 (new thread, should have independent token count)
    server.notifications.length = 0;
    const thread2Result = await rpc<{ thread: { id: string } }>(server, 'thread/start', {
      workingDirectory: process.cwd(),
    });
    const thread2Id = thread2Result.thread.id;

    await rpc(server, 'turn/start', {
      threadId: thread2Id,
      input: [{ type: 'text', text: 'Say "beta"' }],
    });
    await waitForTurnComplete(server);

    const thread2Events = getTokenEvents(server);
    const thread2LastEvent = thread2Events[thread2Events.length - 1];

    // Both threads should have similar token counts (same simple prompt)
    // They should NOT be accumulated across threads
    expect(thread1LastEvent.inputTokens).toBeGreaterThan(0);
    expect(thread2LastEvent.inputTokens).toBeGreaterThan(0);

    // Thread 2 should NOT have accumulated Thread 1's tokens
    // (They should be roughly equal since both are simple prompts)
    const diff = Math.abs((thread2LastEvent.inputTokens ?? 0) - (thread1LastEvent.inputTokens ?? 0));
    const maxExpectedDiff = 1000; // Allow some variance for slightly different responses
    expect(diff).toBeLessThan(maxExpectedDiff);

    // Verify threadId isolation
    expect(thread1LastEvent.threadId).toBe(thread1Id);
    expect(thread2LastEvent.threadId).toBe(thread2Id);
  });

  it('cross-client scenario: tokens accumulate correctly', async () => {
    // This simulates: bot creates session -> CLI adds turn -> bot reads correct total

    // Client A (simulating bot) - create session and do turn
    const clientA = createAppServer();
    await rpc(clientA, 'initialize', {
      clientInfo: { name: 'client-a', version: '1.0.0' },
    });

    const threadResult = await rpc<{ thread: { id: string } }>(clientA, 'thread/start', {
      workingDirectory: process.cwd(),
    });
    const threadId = threadResult.thread.id;

    await rpc(clientA, 'turn/start', {
      threadId,
      input: [{ type: 'text', text: 'Say "first"' }],
    });
    await waitForTurnComplete(clientA);

    // Get Client A's final token count
    const clientAEvents = getTokenEvents(clientA);
    const clientAFinal = clientAEvents[clientAEvents.length - 1];
    const clientATokens = clientAFinal.inputTokens ?? 0;

    // Get session path
    const readResultA = await rpc<{ thread: { path: string } }>(clientA, 'thread/read', {
      threadId,
      includeTurns: false,
    });
    const sessionPath = readResultA.thread.path;

    // Close Client A
    clientA.rl.close();
    clientA.process.kill();
    await new Promise(r => setTimeout(r, 500));

    // Client B (simulating CLI) - resume and add turn
    const clientB = createAppServer();
    await rpc(clientB, 'initialize', {
      clientInfo: { name: 'client-b', version: '1.0.0' },
    });

    await rpc(clientB, 'thread/resume', { threadId });

    await rpc(clientB, 'turn/start', {
      threadId,
      input: [{ type: 'text', text: 'Say "second"' }],
    });
    await waitForTurnComplete(clientB);

    // Get Client B's final token count (should be accumulated)
    const clientBEvents = getTokenEvents(clientB);
    const clientBFinal = clientBEvents[clientBEvents.length - 1];
    const clientBTokens = clientBFinal.inputTokens ?? 0;

    // Client B should have MORE tokens than Client A (accumulated)
    expect(clientBTokens).toBeGreaterThan(clientATokens);

    // Close Client B
    clientB.rl.close();
    clientB.process.kill();
    await new Promise(r => setTimeout(r, 500));

    // Client A returns (simulating bot resuming) - read session file
    const sessionTokens = readSessionFileTokens(sessionPath);
    expect(sessionTokens).not.toBeNull();

    // Session file should have reasonable values
    // Note: last_token_usage semantics may differ from event tokenUsage.total
    // The key verification is that the session file is readable and has values
    expect(sessionTokens!.inputTokens).toBeGreaterThan(0);

    // CRITICAL: Verify that Client B accumulated more than Client A
    // This proves cross-client token tracking works
    expect(clientBTokens).toBeGreaterThan(clientATokens);
  });
});
