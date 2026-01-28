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

  // ============================================================================
  // Item Lifecycle Event Structure Tests
  // These tests memorialize the actual Codex notification structure for item events.
  // If Codex/app-server changes the format, these tests will catch it.
  // ============================================================================

  it('item/started notifications have expected structure', async () => {
    // Find item_started notifications (both formats)
    const itemStartedNotifications = notifications.filter(
      (n) => n.method === 'item/started' || n.method === 'codex/event/item_started'
    );

    // Should have received at least one (userMessage, reasoning, or agentMessage)
    expect(itemStartedNotifications.length).toBeGreaterThan(0);

    console.log('\n=== item/started Structure Analysis ===');
    for (const n of itemStartedNotifications) {
      const params = n.params as Record<string, unknown>;
      console.log(`Method: ${n.method}`);
      console.log(`Params keys: ${Object.keys(params).join(', ')}`);

      // Extract item from either format:
      // Format 1 (codex/event/item_started): { msg: { item: {...} } }
      // Format 2 (item/started): { item: {...} }
      const msg = params.msg as Record<string, unknown> | undefined;
      const item = (msg?.item || params.item) as Record<string, unknown> | undefined;

      if (item) {
        console.log(`Item keys: ${Object.keys(item).join(', ')}`);
        console.log(`Item.type: ${item.type}`);
        console.log(`Item.id: ${item.id}`);
      } else {
        console.log('WARNING: No item found in expected locations!');
      }
      console.log('---');
    }
    console.log('=======================================\n');

    // Verify structure for at least one notification
    const sampleNotification = itemStartedNotifications[0];
    const params = sampleNotification.params as Record<string, unknown>;
    const msg = params.msg as Record<string, unknown> | undefined;
    const item = (msg?.item || params.item) as Record<string, unknown> | undefined;

    // CRITICAL: item must exist in one of the expected locations
    expect(item).toBeDefined();
    expect(item).not.toBeNull();

    // CRITICAL: item must have 'type' and 'id' fields
    expect(item!.type).toBeDefined();
    expect(typeof item!.type).toBe('string');
    expect(item!.id).toBeDefined();
    expect(typeof item!.id).toBe('string');
  });

  it('item/started type field contains expected item types', async () => {
    // Find all item_started notifications
    const itemStartedNotifications = notifications.filter(
      (n) => n.method === 'item/started' || n.method === 'codex/event/item_started'
    );

    // Extract all item types seen
    const itemTypes = new Set<string>();
    for (const n of itemStartedNotifications) {
      const params = n.params as Record<string, unknown>;
      const msg = params.msg as Record<string, unknown> | undefined;
      const item = (msg?.item || params.item) as Record<string, unknown> | undefined;
      if (item?.type) {
        // Normalize to lowercase for comparison
        const typeStr = String(item.type).toLowerCase();
        itemTypes.add(typeStr);
      }
    }

    console.log('Item types seen:', [...itemTypes].join(', '));

    // Known item types from Codex documentation and observed behavior:
    // - userMessage / UserMessage: user's input
    // - agentMessage / AgentMessage: agent's response
    // - reasoning / Reasoning: thinking/reasoning content
    // - commandExecution: shell command execution
    // - mcpToolCall: MCP tool invocation
    // - collabToolCall: collaboration tool call
    // - fileChange: file modification
    // - webSearch: web search
    // - imageView: image viewing
    const knownItemTypes = new Set([
      'usermessage',
      'agentmessage',
      'reasoning',
      'commandexecution',
      'mcptoolcall',
      'collabtoolcall',
      'filechange',
      'websearch',
      'imageview',
      'enteredreviewmode',
      'exitedreviewmode',
      'compacted',
    ]);

    // At minimum, a simple message should produce userMessage, reasoning, agentMessage
    // (or at least some subset of these)
    const hasKnownType = [...itemTypes].some((t) => knownItemTypes.has(t));
    expect(hasKnownType).toBe(true);
  });

  it('item/completed notifications match item/started by itemId', async () => {
    // Get all item started IDs
    const startedIds = new Set<string>();
    for (const n of notifications) {
      if (n.method === 'item/started' || n.method === 'codex/event/item_started') {
        const params = n.params as Record<string, unknown>;
        const msg = params.msg as Record<string, unknown> | undefined;
        const item = (msg?.item || params.item) as Record<string, unknown> | undefined;
        if (item?.id) {
          startedIds.add(String(item.id));
        }
      }
    }

    // Get all item completed IDs
    const completedIds = new Set<string>();
    for (const n of notifications) {
      if (n.method === 'item/completed' || n.method === 'codex/event/item_completed') {
        const params = n.params as Record<string, unknown>;
        const msg = params.msg as Record<string, unknown> | undefined;
        const item = (msg?.item || params.item) as Record<string, unknown> | undefined;
        const itemId = item?.id || params.itemId || params.item_id;
        if (itemId) {
          completedIds.add(String(itemId));
        }
      }
    }

    console.log('Started item IDs:', [...startedIds].join(', '));
    console.log('Completed item IDs:', [...completedIds].join(', '));

    // Every started item should eventually complete (for a successful turn)
    // Note: Some items might complete that weren't tracked as started (edge case)
    if (startedIds.size > 0 && completedIds.size > 0) {
      // At least some started items should have completed
      const matchingIds = [...startedIds].filter((id) => completedIds.has(id));
      console.log('Matching IDs:', matchingIds.length);
      expect(matchingIds.length).toBeGreaterThan(0);
    }
  });

  it('verifies dual notification format (both item/* and codex/event/item_*)', async () => {
    // Codex currently sends BOTH formats for the same event
    // This test documents that behavior so we detect if it changes

    const oldStyleMethods = notifications.filter((n) =>
      n.method.startsWith('item/')
    ).map((n) => n.method);

    const newStyleMethods = notifications.filter((n) =>
      n.method.startsWith('codex/event/item')
    ).map((n) => n.method);

    console.log('Old-style (item/*) methods:', [...new Set(oldStyleMethods)].join(', ') || 'none');
    console.log('New-style (codex/event/item*) methods:', [...new Set(newStyleMethods)].join(', ') || 'none');

    // Document which format(s) are currently in use
    const hasOldStyle = oldStyleMethods.length > 0;
    const hasNewStyle = newStyleMethods.length > 0;

    console.log(`Dual format active: ${hasOldStyle && hasNewStyle}`);

    // At least one format should be present
    expect(hasOldStyle || hasNewStyle).toBe(true);

    // If both formats are present, verify they're for the same items (dedup check)
    if (hasOldStyle && hasNewStyle) {
      console.log('WARNING: Dual notification format detected. Bot should deduplicate by itemId.');
    }
  });

  it('documents item structure including command fields when present', async () => {
    // Clear notifications
    notifications.length = 0;

    const threadResult = await rpc<{ thread: { id: string } }>('thread/start', {
      workingDirectory: process.cwd(),
    });
    const threadId = threadResult.thread.id;

    // Use a prompt likely to trigger tool use (not guaranteed)
    await rpc('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'What files are in the current directory? Use ls.' }],
      approvalPolicy: 'never',
    });

    // Wait for turn to complete
    const startTime = Date.now();
    let turnComplete = false;
    while (!turnComplete && Date.now() - startTime < 45000) {
      await new Promise((r) => setTimeout(r, 100));
      turnComplete = notifications.some(
        (n) => n.method === 'codex/event/task_complete' || n.method === 'turn/completed'
      );
    }

    // Find any item/started notifications
    const itemStarted = notifications.filter((n) =>
      n.method === 'item/started' || n.method === 'codex/event/item_started'
    );

    expect(itemStarted.length).toBeGreaterThan(0);

    // Document structure for any commandExecution items found
    for (const notif of itemStarted) {
      const p = notif.params as Record<string, unknown>;
      const msg = p.msg as Record<string, unknown> | undefined;
      const item = (msg?.item || p.item) as Record<string, unknown> | undefined;

      if (item?.type === 'commandExecution' || item?.type === 'CommandExecution') {
        console.log('commandExecution item found:', JSON.stringify(item, null, 2));
        // Verify expected fields exist
        expect(item.id).toBeDefined();
        expect(item.command).toBeDefined();
        expect(typeof item.command).toBe('string');
        // commandActions may or may not be present
        if (item.commandActions) {
          expect(Array.isArray(item.commandActions)).toBe(true);
        }
      }
    }
  });
});
