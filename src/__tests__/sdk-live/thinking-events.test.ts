/**
 * SDK Live Tests: Thinking/Reasoning Event Verification
 *
 * These tests verify what notifications Codex sends for thinking/reasoning content.
 * The CLI shows thinking in italics - we need to find which events contain this.
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

describe.skipIf(SKIP_LIVE)('Codex Thinking/Reasoning Events', { timeout: 90000 }, () => {
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
      clientInfo: { name: 'cxslack-thinking-test', version: '1.0.0' },
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

      // Timeout after 60 seconds
      setTimeout(() => {
        if (responseHandlers.has(id)) {
          responseHandlers.delete(id);
          reject(new Error(`Request ${method} (id=${id}) timed out`));
        }
      }, 60000);
    });
  }

  it('discovers all thinking/reasoning related notification methods', async () => {
    // Clear notifications from initialization
    notifications.length = 0;

    // Start a thread with HIGH reasoning to ensure thinking content is generated
    const threadResult = await rpc<{ thread: { id: string } }>('thread/start', {
      workingDirectory: process.cwd(),
    });
    const threadId = threadResult.thread.id;
    expect(threadId).toBeDefined();

    console.log('\n=== Starting turn with xhigh reasoning ===');
    console.log('Thread ID:', threadId);

    // Send a message that will trigger extended thinking
    // Use xhigh reasoning to ensure thinking content is generated
    await rpc('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'Think step by step about what 2+2 equals. Show your reasoning.' }],
      reasoningEffort: 'xhigh',
    });

    // Wait for turn to complete
    const startTime = Date.now();
    const timeout = 60000;
    let turnComplete = false;

    while (!turnComplete && Date.now() - startTime < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      turnComplete = notifications.some(
        (n) => n.method === 'codex/event/task_complete' || n.method === 'turn/completed'
      );
    }

    expect(turnComplete).toBe(true);

    // =========================================================================
    // DISCOVER: Find ALL notification methods that might contain thinking
    // =========================================================================
    console.log('\n=== ALL Notification Methods Received ===');
    const allMethods = [...new Set(notifications.map((n) => n.method))].sort();
    console.log(allMethods.join('\n'));

    // =========================================================================
    // FILTER: Find methods that likely contain thinking/reasoning
    // =========================================================================
    console.log('\n=== Thinking/Reasoning Related Methods ===');
    const thinkingKeywords = ['think', 'reason', 'summary', 'reasoning'];
    const thinkingMethods = allMethods.filter((m) =>
      thinkingKeywords.some((k) => m.toLowerCase().includes(k))
    );
    console.log(thinkingMethods.length > 0 ? thinkingMethods.join('\n') : 'NONE FOUND');

    // =========================================================================
    // ANALYZE: Look at each potential thinking notification
    // =========================================================================
    console.log('\n=== Thinking Notification Details ===');
    for (const method of thinkingMethods) {
      const matchingNotifications = notifications.filter((n) => n.method === method);
      console.log(`\n--- ${method} (${matchingNotifications.length} occurrences) ---`);

      if (matchingNotifications.length > 0) {
        // Show first notification's params structure
        const params = matchingNotifications[0].params as Record<string, unknown>;
        console.log('Params keys:', Object.keys(params).join(', '));
        console.log('Sample params:', JSON.stringify(params, null, 2).slice(0, 500));

        // Try to extract text content from various possible locations
        const possibleTextFields = ['text', 'delta', 'content', 'part', 'thinking'];
        for (const field of possibleTextFields) {
          if (params[field]) {
            console.log(`*** FOUND TEXT in params.${field}:`, String(params[field]).slice(0, 100));
          }
          const msg = params.msg as Record<string, unknown> | undefined;
          if (msg && msg[field]) {
            console.log(`*** FOUND TEXT in params.msg.${field}:`, String(msg[field]).slice(0, 100));
          }
        }
      }
    }

    // =========================================================================
    // ANALYZE: Also check item/started for Reasoning type items
    // =========================================================================
    console.log('\n=== Reasoning Items in item/started ===');
    const itemStarted = notifications.filter((n) =>
      n.method === 'item/started' || n.method === 'codex/event/item_started'
    );

    for (const notif of itemStarted) {
      const params = notif.params as Record<string, unknown>;
      const msg = params.msg as Record<string, unknown> | undefined;
      const item = (msg?.item || params.item) as Record<string, unknown> | undefined;

      if (item && String(item.type).toLowerCase().includes('reason')) {
        console.log('Reasoning item found:');
        console.log('  Type:', item.type);
        console.log('  ID:', item.id);
        console.log('  Full item:', JSON.stringify(item, null, 2).slice(0, 500));
      }
    }

    // =========================================================================
    // ANALYZE: Check all item delta events for reasoning content
    // =========================================================================
    console.log('\n=== Item Delta Events (potential thinking content) ===');
    const deltaEvents = notifications.filter((n) =>
      n.method.includes('delta') || n.method.includes('Delta')
    );

    const deltaMethodsWithSamples: Record<string, string> = {};
    for (const notif of deltaEvents) {
      const params = notif.params as Record<string, unknown>;
      const msg = params.msg as Record<string, unknown> | undefined;

      // Extract any text content
      const text = params.delta || params.text || params.content ||
                   msg?.delta || msg?.text || msg?.content || '';

      if (text && typeof text === 'string' && text.length > 0) {
        if (!deltaMethodsWithSamples[notif.method]) {
          deltaMethodsWithSamples[notif.method] = text.slice(0, 100);
        }
      }
    }

    for (const [method, sample] of Object.entries(deltaMethodsWithSamples)) {
      console.log(`${method}: "${sample}..."`);
    }

    // Log summary
    console.log('\n=== SUMMARY ===');
    console.log('Total notifications:', notifications.length);
    console.log('Unique methods:', allMethods.length);
    console.log('Thinking-related methods:', thinkingMethods.length);
    console.log('Delta methods with text:', Object.keys(deltaMethodsWithSamples).length);

    // Write results to file for inspection
    const fs = await import('fs');
    const output = {
      allMethods,
      thinkingMethods,
      deltaMethodsWithSamples,
      sampleNotifications: notifications.slice(0, 50).map(n => ({
        method: n.method,
        paramsKeys: Object.keys(n.params as Record<string, unknown>),
        sample: JSON.stringify(n.params).slice(0, 300),
      })),
    };
    fs.writeFileSync('/tmp/thinking-events-output.json', JSON.stringify(output, null, 2));
    console.log('Results written to /tmp/thinking-events-output.json');
  });

  it('identifies the exact notification for CLI thinking display', async () => {
    // This test specifically looks for what the CLI uses to show italic thinking

    console.log('\n=== Looking for CLI Thinking Display Source ===');

    // Check each notification type that might have thinking content
    const candidateMethods = [
      'item/reasoning/summaryPartAdded',
      'item/reasoning/summaryTextDelta',
      'codex/event/reasoning_content_delta',
      'codex/event/agent_reasoning_delta',
      'codex/event/agent_reasoning',
    ];

    for (const method of candidateMethods) {
      const matches = notifications.filter((n) => n.method === method);
      console.log(`\n${method}: ${matches.length} occurrences`);

      if (matches.length > 0) {
        // Show structure of first match
        const params = matches[0].params as Record<string, unknown>;
        console.log('  Keys:', Object.keys(params).join(', '));

        // Log all matches' text content
        for (let i = 0; i < Math.min(matches.length, 3); i++) {
          const p = matches[i].params as Record<string, unknown>;
          const text = p.text || p.delta || p.content || p.part ||
                       (p.msg as Record<string, unknown>)?.text ||
                       (p.msg as Record<string, unknown>)?.delta ||
                       (p.msg as Record<string, unknown>)?.content;
          if (text) {
            console.log(`  [${i}] Text: "${String(text).slice(0, 80)}..."`);
          }
        }
      }
    }

    // Also check if thinking appears in agent_message content
    const agentMessageDeltas = notifications.filter((n) =>
      n.method === 'codex/event/agent_message_content_delta' ||
      n.method === 'item/agentMessage/delta'
    );

    console.log(`\nagent_message deltas: ${agentMessageDeltas.length}`);
    if (agentMessageDeltas.length > 0) {
      // Check if any have thinking-like content (italic markers or thinking prefix)
      for (const notif of agentMessageDeltas.slice(0, 5)) {
        const params = notif.params as Record<string, unknown>;
        const text = params.delta || params.text || params.content ||
                     (params.msg as Record<string, unknown>)?.delta || '';
        if (text && typeof text === 'string') {
          console.log(`  Delta: "${text.slice(0, 60)}..."`);
        }
      }
    }
  });
});
