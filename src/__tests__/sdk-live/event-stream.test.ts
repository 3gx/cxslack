/**
 * SDK Live Tests: Event Stream Verification
 *
 * These tests verify that Codex App-Server sends the expected notification
 * events that the bot relies on. If the API changes, these tests will catch it.
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

describe.skipIf(SKIP_LIVE)('Codex Event Stream', { timeout: 60000 }, () => {
  let server: ChildProcess;
  let rl: readline.Interface;
  let requestId = 0;
  const responseHandlers = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const notifications: Array<{ method: string; params: unknown }> = [];

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
        }
      } catch {
        // Ignore non-JSON lines
      }
    });

    // Initialize
    await rpc('initialize', {
      clientInfo: { name: 'cxslack-event-test', version: '1.0.0' },
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

  it('receives expected notification events during a turn', async () => {
    // Clear notifications from initialization
    notifications.length = 0;

    // Start a thread
    const threadResult = await rpc<{ thread: { id: string } }>('thread/start', {
      workingDirectory: process.cwd(),
    });
    const threadId = threadResult.thread.id;
    expect(threadId).toBeDefined();

    // Send a simple message and wait for completion
    await rpc('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'Say hello in exactly 3 words.' }],
    });

    // Wait for turn to complete (poll notifications)
    const startTime = Date.now();
    const timeout = 30000;
    let turnComplete = false;

    while (!turnComplete && Date.now() - startTime < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Check for task_complete or turn/completed
      turnComplete = notifications.some(
        (n) => n.method === 'codex/event/task_complete' || n.method === 'turn/completed'
      );
    }

    expect(turnComplete).toBe(true);

    // Log all received notification methods for debugging
    const methods = [...new Set(notifications.map((n) => n.method))];
    console.log('Received notification methods:', methods.join(', '));

    // Verify we received the critical events the bot depends on
    const receivedMethods = new Set(methods);

    // Task lifecycle events (at least one of each pair)
    const hasTaskStart = receivedMethods.has('codex/event/task_started') || receivedMethods.has('turn/started');
    const hasTaskComplete = receivedMethods.has('codex/event/task_complete') || receivedMethods.has('turn/completed');

    expect(hasTaskStart).toBe(true);
    expect(hasTaskComplete).toBe(true);

    // Message content events (need at least one delta event for streaming)
    const hasMessageDelta =
      receivedMethods.has('codex/event/agent_message_content_delta') ||
      receivedMethods.has('codex/event/agent_message_delta') ||
      receivedMethods.has('item/agentMessage/delta');

    expect(hasMessageDelta).toBe(true);
  });

  it('agent_message_content_delta contains text content', async () => {
    // Find a delta notification
    const deltaNotification = notifications.find(
      (n) =>
        n.method === 'codex/event/agent_message_content_delta' ||
        n.method === 'codex/event/agent_message_delta' ||
        n.method === 'item/agentMessage/delta'
    );

    expect(deltaNotification).toBeDefined();

    // Verify the params structure has content we can extract
    const params = deltaNotification!.params as Record<string, unknown>;

    // Log the structure for debugging
    console.log('Delta notification params keys:', Object.keys(params));
    console.log('Delta notification sample:', JSON.stringify(params, null, 2).slice(0, 500));

    // The Codex API nests content in params.msg for codex/event/* notifications
    // or directly in params for item/* notifications
    const msg = params.msg as Record<string, unknown> | undefined;

    const hasExtractableContent =
      // Direct fields (old-style item/* events)
      'delta' in params ||
      'content' in params ||
      'text' in params ||
      // Nested in msg (new-style codex/event/* events)
      (msg && 'delta' in msg) ||
      (msg && 'content' in msg) ||
      (msg && 'text' in msg);

    expect(hasExtractableContent).toBe(true);

    // Verify we can actually extract the delta text
    const deltaText = params.delta || params.content || params.text ||
                      msg?.delta || msg?.content || msg?.text;
    expect(deltaText).toBeDefined();
    expect(typeof deltaText).toBe('string');
    console.log('Extracted delta text:', deltaText);
  });

  it('task_complete indicates success status', async () => {
    // Find the task_complete notification
    const completeNotification = notifications.find(
      (n) => n.method === 'codex/event/task_complete' || n.method === 'turn/completed'
    );

    expect(completeNotification).toBeDefined();

    const params = completeNotification!.params as Record<string, unknown>;
    console.log('Task complete params:', JSON.stringify(params, null, 2));

    // Verify we can determine success (status field or absence of error)
    // The bot checks for status: 'completed' | 'interrupted' | 'failed'
    if (params.status) {
      expect(['completed', 'success', 'done']).toContain(params.status);
    }
    // If no status field, absence of error indicates success
  });

  it('documents all notification methods received', async () => {
    // This test just documents what notifications we received
    // Useful for detecting API changes
    const methodCounts = new Map<string, number>();

    for (const n of notifications) {
      methodCounts.set(n.method, (methodCounts.get(n.method) || 0) + 1);
    }

    console.log('\n=== Notification Method Summary ===');
    for (const [method, count] of [...methodCounts.entries()].sort()) {
      console.log(`  ${method}: ${count}x`);
    }
    console.log('===================================\n');

    // Always pass - this is just for documentation
    expect(true).toBe(true);
  });
});
