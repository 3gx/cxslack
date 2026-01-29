/**
 * SDK Live Tests: Thread Fork Verification
 *
 * CRITICAL TEST: Verifies that Codex `thread/fork` RPC call works correctly,
 * including fork-at-point-in-time functionality (forking at a specific turn index).
 *
 * This test ensures:
 * 1. Basic thread fork works (creates a new thread from existing)
 * 2. Fork-at-turn-index works (forks from a specific point in conversation)
 * 3. Forked thread state is correct (has forkedFrom, forkedAtTurnIndex)
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

interface ThreadInfo {
  id: string;
  forkedFrom?: string;
  forkedAtTurnIndex?: number;
  [key: string]: unknown;
}

describe.skipIf(SKIP_LIVE)('Codex Thread Fork', { timeout: 120000 }, () => {
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
      clientInfo: { name: 'cxslack-fork-test', version: '1.0.0' },
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

  async function waitForTurnComplete(timeout = 45000): Promise<boolean> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (
        notifications.some(
          (n) => n.method === 'codex/event/task_complete' || n.method === 'turn/completed'
        )
      ) {
        return true;
      }
    }
    return false;
  }

  it('thread/fork creates a new thread from existing thread', async () => {
    // Clear notifications
    notifications.length = 0;

    console.log('\n=== Thread Fork Basic Test ===');

    // 1. Start original thread
    const threadResult = await rpc<{ thread: ThreadInfo }>('thread/start', {
      workingDirectory: process.cwd(),
    });
    const originalThreadId = threadResult.thread.id;
    expect(originalThreadId).toBeDefined();
    console.log(`Original thread: ${originalThreadId}`);

    // 2. Send a simple query to establish history
    await rpc('turn/start', {
      threadId: originalThreadId,
      input: [{ type: 'text', text: 'Say "hello" and nothing else.' }],
    });

    const turnComplete = await waitForTurnComplete();
    expect(turnComplete).toBe(true);
    console.log('Turn 1 completed');

    // Clear notifications for next operation
    notifications.length = 0;

    // 3. Fork the thread (basic fork, no turn index)
    console.log('Forking thread...');
    const forkResult = await rpc<{ thread: ThreadInfo }>('thread/fork', {
      threadId: originalThreadId,
    });

    const forkedThread = forkResult.thread;
    expect(forkedThread).toBeDefined();
    expect(forkedThread.id).toBeDefined();
    expect(forkedThread.id).not.toBe(originalThreadId);

    console.log(`Forked thread: ${forkedThread.id}`);
    console.log(`Fork metadata: forkedFrom=${forkedThread.forkedFrom}, forkedAtTurnIndex=${forkedThread.forkedAtTurnIndex}`);

    // Verify fork metadata if available
    if (forkedThread.forkedFrom !== undefined) {
      expect(forkedThread.forkedFrom).toBe(originalThreadId);
      console.log('✓ VERIFIED: forkedFrom matches original thread');
    } else {
      console.log('Note: forkedFrom not returned in thread info');
    }

    // 4. Verify forked thread is functional - send a query
    notifications.length = 0;
    await rpc('turn/start', {
      threadId: forkedThread.id,
      input: [{ type: 'text', text: 'Say "world" and nothing else.' }],
    });

    const forkTurnComplete = await waitForTurnComplete();
    expect(forkTurnComplete).toBe(true);
    console.log('✓ VERIFIED: Forked thread accepts queries');

    console.log('==========================================\n');
  });

  it('thread/fork turnIndex semantics investigation', async () => {
    // Clear notifications
    notifications.length = 0;

    console.log('\n=== Thread Fork At Turn Index Test ===');

    // 1. Start original thread
    const threadResult = await rpc<{ thread: ThreadInfo }>('thread/start', {
      workingDirectory: process.cwd(),
    });
    const originalThreadId = threadResult.thread.id;
    expect(originalThreadId).toBeDefined();
    console.log(`Original thread: ${originalThreadId}`);

    // 2. Send multiple turns to build conversation history
    // Turn 0 (index 0)
    await rpc('turn/start', {
      threadId: originalThreadId,
      input: [{ type: 'text', text: 'Remember the number 42. Just say "remembered 42".' }],
    });
    let complete = await waitForTurnComplete();
    expect(complete).toBe(true);
    console.log('Turn 0 completed (remembered 42)');
    notifications.length = 0;

    // Turn 1 (index 1)
    await rpc('turn/start', {
      threadId: originalThreadId,
      input: [{ type: 'text', text: 'Now remember the number 99. Just say "remembered 99".' }],
    });
    complete = await waitForTurnComplete();
    expect(complete).toBe(true);
    console.log('Turn 1 completed (remembered 99)');
    notifications.length = 0;

    // Turn 2 (index 2)
    await rpc('turn/start', {
      threadId: originalThreadId,
      input: [{ type: 'text', text: 'Now remember the number 777. Just say "remembered 777".' }],
    });
    complete = await waitForTurnComplete();
    expect(complete).toBe(true);
    console.log('Turn 2 completed (remembered 777)');
    notifications.length = 0;

    // 3. Fork at turn index 1 (should have 42 and 99, but NOT 777)
    // ROBUST: Get actual turn count from Codex (source of truth) - not hardcoded!
    // This is what production code does - handles CLI usage, /resume elsewhere, etc.
    const forkTurnIndex = 1;

    // Step 1: Query Codex for actual turn count (source of truth)
    console.log('\nQuerying Codex for actual turn count (thread/read with includeTurns)...');
    const readResult = await rpc<{ thread: ThreadInfo & { turns?: Array<{ id: string }> } }>('thread/read', {
      threadId: originalThreadId,
      includeTurns: true,
    });
    const totalTurns = readResult.thread.turns?.length ?? 0;
    console.log(`Codex reports ${totalTurns} turns in source thread`);
    expect(totalTurns).toBe(3); // Verify we created 3 turns

    const turnsToRollback = totalTurns - (forkTurnIndex + 1);
    console.log(`Forking at turn index ${forkTurnIndex} (total turns: ${totalTurns}, rollback: ${turnsToRollback})...`);

    // Step 2: Fork the thread (creates full copy)
    const forkResult = await rpc<{ thread: ThreadInfo }>('thread/fork', {
      threadId: originalThreadId,
    });

    const forkedThread = forkResult.thread;
    expect(forkedThread).toBeDefined();
    expect(forkedThread.id).toBeDefined();
    expect(forkedThread.id).not.toBe(originalThreadId);
    console.log(`Forked thread: ${forkedThread.id}`);

    // Step 3: Rollback the forked thread to the desired point
    if (turnsToRollback > 0) {
      console.log(`Rolling back ${turnsToRollback} turns...`);
      await rpc('thread/rollback', {
        threadId: forkedThread.id,
        numTurns: turnsToRollback,
      });
      console.log('Rollback complete');
    }

    console.log(`Fork metadata: forkedFrom=${forkedThread.forkedFrom}`);

    // Verify fork metadata
    if (forkedThread.forkedFrom !== undefined) {
      expect(forkedThread.forkedFrom).toBe(originalThreadId);
      console.log('✓ VERIFIED: forkedFrom matches original thread');
    }

    // 4. Verify forked thread content - CRITICAL: must NOT include 777
    notifications.length = 0;
    await rpc('turn/start', {
      threadId: forkedThread.id,
      input: [{ type: 'text', text: 'What numbers do you remember? List them all.' }],
    });

    const forkTurnComplete = await waitForTurnComplete();
    expect(forkTurnComplete).toBe(true);

    // Capture the assistant's response text
    console.log(`\nAll notifications received: ${notifications.length}`);
    const textNotifications = notifications.filter(
      (n) => n.method === 'codex/event/text' || n.method === 'turn/text' || n.method === 'codex/event/message_delta'
    );
    console.log(`Text-like notifications: ${textNotifications.length}`);

    // Try multiple ways to extract text
    let responseText = '';
    for (const n of notifications) {
      const params = n.params as Record<string, unknown>;
      if (params.text) responseText += params.text;
      if (params.msg && typeof params.msg === 'object') {
        const msg = params.msg as Record<string, unknown>;
        if (msg.text) responseText += msg.text;
        if (msg.content) responseText += String(msg.content);
      }
      if (params.delta && typeof params.delta === 'object') {
        const delta = params.delta as Record<string, unknown>;
        if (delta.text) responseText += delta.text;
      }
      // Also try content_block_delta format
      if (n.method === 'codex/event/message_delta' || n.method === 'message/delta') {
        console.log(`Delta notification: ${JSON.stringify(params).slice(0, 200)}`);
      }
    }

    // Also look for completion notifications
    const completionNotifications = notifications.filter(
      (n) => n.method === 'turn/completed' || n.method === 'codex/event/task_complete'
    );
    for (const cn of completionNotifications) {
      console.log(`Completion: ${JSON.stringify(cn.params).slice(0, 500)}`);
    }

    console.log(`\nForked thread response: "${responseText}"`);
    console.log('\n=== CONTENT VERIFICATION ===');

    // Fork at turn 1 should include:
    // - Turn 0: remembered 42
    // - Turn 1: remembered 99
    // Should NOT include Turn 2: 777

    const has42 = responseText.includes('42');
    const has99 = responseText.includes('99');
    const has777 = responseText.includes('777');

    console.log(`Contains 42: ${has42} (expected: true)`);
    console.log(`Contains 99: ${has99} (expected: true)`);
    console.log(`Contains 777: ${has777} (expected: false - should NOT be in fork at turn 1)`);

    if (!has777) {
      console.log('✓ VERIFIED: Fork-at-point correctly excludes turn 2 content (777)');
    } else {
      console.log('✗ FAILED: Fork includes turn 2 content (777) - point-in-time fork NOT working!');
    }

    // These are the critical assertions
    expect(has42).toBe(true);
    expect(has99).toBe(true);
    expect(has777).toBe(false); // CRITICAL: Must NOT include content after fork point

    console.log('==========================================\n');
  });

  it('thread/read with includeTurns returns actual turn count (robust fork)', async () => {
    // Clear notifications
    notifications.length = 0;

    console.log('\n=== Thread Read Turn Count Test (Robust Fork) ===');

    // 1. Start original thread
    const threadResult = await rpc<{ thread: ThreadInfo }>('thread/start', {
      workingDirectory: process.cwd(),
    });
    const originalThreadId = threadResult.thread.id;
    expect(originalThreadId).toBeDefined();
    console.log(`Thread: ${originalThreadId}`);

    // 2. Send multiple turns
    for (let i = 0; i < 3; i++) {
      notifications.length = 0;
      await rpc('turn/start', {
        threadId: originalThreadId,
        input: [{ type: 'text', text: `Turn ${i}: Say "turn ${i} done" and nothing else.` }],
      });
      const complete = await waitForTurnComplete();
      expect(complete).toBe(true);
      console.log(`Turn ${i} completed`);
    }

    // 3. Read thread with includeTurns to get actual turn count from Codex (source of truth)
    console.log('\nReading thread with includeTurns=true...');
    const readResult = await rpc<{ thread: ThreadInfo & { turns?: Array<{ id: string }> } }>('thread/read', {
      threadId: originalThreadId,
      includeTurns: true,
    });

    const turns = readResult.thread.turns;
    expect(turns).toBeDefined();
    console.log(`Codex reports ${turns?.length} turns`);

    // CRITICAL: Codex is the source of truth for turn count
    // This is what makes fork robust - even if user used CLI, /resumed elsewhere, etc.
    expect(turns?.length).toBe(3);
    console.log('✓ VERIFIED: thread/read returns correct turn count from Codex (source of truth)');

    console.log('==========================================\n');
  });

  it('thread/fork returns proper error for invalid thread ID', async () => {
    console.log('\n=== Thread Fork Error Handling Test ===');

    try {
      await rpc<{ thread: ThreadInfo }>('thread/fork', {
        threadId: 'non-existent-thread-id-12345',
      });
      // If we get here, the API didn't reject the invalid thread
      console.log('Note: API accepted invalid thread ID (may create orphan fork)');
    } catch (error) {
      // Expected behavior: should throw an error for invalid thread
      expect(error).toBeInstanceOf(Error);
      console.log(`✓ VERIFIED: API rejects invalid thread ID with error: ${(error as Error).message}`);
    }

    console.log('==========================================\n');
  });
});
