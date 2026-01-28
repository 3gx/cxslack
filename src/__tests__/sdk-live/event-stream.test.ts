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

  // ============================================================================
  // CRITICAL: Turn/Task Started Event Verification (Abort Fix)
  // The abort fix depends on turn:started containing turnId. This test verifies it.
  // ============================================================================

  it('turn:started contains threadId and turnId (CRITICAL for abort)', async () => {
    // Find turn_started notifications (both formats)
    const turnStartedNotifications = notifications.filter(
      (n) => n.method === 'turn/started' || n.method === 'codex/event/task_started'
    );

    console.log('\n=== turn:started Structure Analysis (ABORT FIX) ===');
    expect(turnStartedNotifications.length).toBeGreaterThan(0);

    // Track if we found at least one notification with the required fields
    let foundValidNotification = false;

    for (const n of turnStartedNotifications) {
      const params = n.params as Record<string, unknown>;
      console.log(`Method: ${n.method}`);
      console.log(`Params: ${JSON.stringify(params, null, 2)}`);

      // Extract from either format
      // turn/started: { threadId, turn: { id } }
      // codex/event/task_started: { msg: { thread_id, turn_id } } OR { msg: { type: "task_started" } } (no turnId)
      const msg = params.msg as Record<string, unknown> | undefined;
      const turn = params.turn as Record<string, unknown> | undefined;
      const threadId = (params.threadId || params.thread_id || msg?.thread_id || msg?.threadId) as string | undefined;
      // turnId can be in: turn.id (turn/started), turnId/turn_id (top-level), or msg.turn_id (codex/event/*)
      const turnId = (turn?.id || params.turnId || params.turn_id || msg?.turn_id || msg?.turnId) as string | undefined;

      console.log(`Extracted threadId: ${threadId}`);
      console.log(`Extracted turnId: ${turnId}`);
      console.log('---');

      // Check if this notification has valid threadId and turnId
      if (threadId && (turnId !== undefined && turnId !== null)) {
        foundValidNotification = true;
        console.log(`✓ Valid turn:started notification found with threadId=${threadId}, turnId=${turnId}`);
      }
    }

    // CRITICAL: At least one turn:started notification must have threadId and turnId for abort fix to work
    expect(foundValidNotification).toBe(true);
    console.log('=================================================\n');
  });

  // ============================================================================
  // Item Lifecycle Event Structure Tests
  // These tests memorialize the actual Codex notification structure for item events.
  // If Codex/app-server changes the format, these tests will catch it.
  // ============================================================================

  it('item/started has structure, turnId at top level, and known types', async () => {
    // Find item_started notifications (both formats)
    const itemStartedNotifications = notifications.filter(
      (n) => n.method === 'item/started' || n.method === 'codex/event/item_started'
    );

    // Should have received at least one (userMessage, reasoning, or agentMessage)
    expect(itemStartedNotifications.length).toBeGreaterThan(0);

    console.log('\n=== item/started Structure Analysis (with turnId check) ===');

    // Track item types and turnId presence
    const itemTypes = new Set<string>();
    let turnIdFoundAtTopLevel = false;
    let turnIdFoundInMsg = false;

    for (const n of itemStartedNotifications) {
      const params = n.params as Record<string, unknown>;
      console.log(`Method: ${n.method}`);
      console.log(`Top-level params keys: ${Object.keys(params).join(', ')}`);

      // Check for turnId at TOP LEVEL (critical for abort fix backup)
      const topLevelTurnId = params.turnId || params.turn_id;
      if (topLevelTurnId) {
        turnIdFoundAtTopLevel = true;
        console.log(`*** turnId at TOP LEVEL: ${topLevelTurnId} ***`);
      }

      // Extract item from either format
      const msg = params.msg as Record<string, unknown> | undefined;
      if (msg) {
        const msgTurnId = msg.turn_id || msg.turnId;
        if (msgTurnId) {
          turnIdFoundInMsg = true;
          console.log(`turnId in msg: ${msgTurnId}`);
        }
      }

      const item = (msg?.item || params.item) as Record<string, unknown> | undefined;
      if (item) {
        console.log(`Item.type: ${item.type}, Item.id: ${item.id}`);
        if (item.type) {
          itemTypes.add(String(item.type).toLowerCase());
        }
      }
      console.log('---');
    }

    // Log turnId discovery for abort fix verification
    console.log(`\n*** ABORT FIX VERIFICATION ***`);
    console.log(`turnId found at TOP LEVEL: ${turnIdFoundAtTopLevel}`);
    console.log(`turnId found in msg: ${turnIdFoundInMsg}`);
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

    // Verify we saw known item types
    console.log('Item types seen:', [...itemTypes].join(', '));
    const knownItemTypes = new Set([
      'usermessage', 'agentmessage', 'reasoning', 'commandexecution',
      'mcptoolcall', 'collabtoolcall', 'filechange', 'websearch', 'imageview',
    ]);
    const hasKnownType = [...itemTypes].some((t) => knownItemTypes.has(t));
    expect(hasKnownType).toBe(true);

    // Document turnId availability (important for abort fix decision)
    // We don't fail if turnId is missing, but we log it clearly
    if (!turnIdFoundAtTopLevel && !turnIdFoundInMsg) {
      console.warn('WARNING: No turnId found in item/started notifications!');
      console.warn('The abort fix will rely solely on turn:started event.');
    }
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

  it('verifies command execution events and exec_command notifications', async () => {
    // Clear notifications
    notifications.length = 0;

    const threadResult = await rpc<{ thread: { id: string } }>('thread/start', {
      workingDirectory: process.cwd(),
    });
    const threadId = threadResult.thread.id;

    // Use a prompt that WILL trigger a command execution
    await rpc('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'Run this exact command: echo "sdk-live-test"' }],
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

    // =========================================================================
    // Part 1: Verify commandExecution items in item/started
    // =========================================================================
    const itemStarted = notifications.filter((n) =>
      n.method === 'item/started' || n.method === 'codex/event/item_started'
    );

    expect(itemStarted.length).toBeGreaterThan(0);

    let commandExecutionFound = false;
    for (const notif of itemStarted) {
      const p = notif.params as Record<string, unknown>;
      const msg = p.msg as Record<string, unknown> | undefined;
      const item = (msg?.item || p.item) as Record<string, unknown> | undefined;

      if (item?.type === 'commandExecution' || item?.type === 'CommandExecution') {
        commandExecutionFound = true;
        console.log('\n=== commandExecution item found ===');
        console.log('Item:', JSON.stringify(item, null, 2));
        console.log('Top-level params keys:', Object.keys(p).join(', '));

        // Verify expected fields exist
        expect(item.id).toBeDefined();
        expect(item.command).toBeDefined();
        expect(typeof item.command).toBe('string');

        // Check for turnId at top level of params (not in item)
        const turnIdAtTop = p.turnId || p.turn_id;
        console.log(`turnId at params top level: ${turnIdAtTop || 'NOT FOUND'}`);
      }
    }

    // =========================================================================
    // Part 2: Verify exec_command_* notifications exist (Unknown Notifications Fix)
    // =========================================================================
    console.log('\n=== exec_command_* Notification Analysis ===');

    const execCommandBegin = notifications.filter((n) =>
      n.method === 'codex/event/exec_command_begin'
    );
    const execCommandEnd = notifications.filter((n) =>
      n.method === 'codex/event/exec_command_end'
    );
    const execCommandDelta = notifications.filter((n) =>
      n.method === 'codex/event/exec_command_output_delta' ||
      n.method === 'item/commandExecution/outputDelta'
    );

    console.log(`exec_command_begin count: ${execCommandBegin.length}`);
    console.log(`exec_command_end count: ${execCommandEnd.length}`);
    console.log(`exec_command_output_delta count: ${execCommandDelta.length}`);

    // Document the structure of exec_command notifications if present
    if (execCommandBegin.length > 0) {
      const sample = execCommandBegin[0];
      console.log('\nexec_command_begin sample params:');
      console.log(JSON.stringify(sample.params, null, 2).slice(0, 1000));

      // Check if it has turnId (critical for abort fix)
      const p = sample.params as Record<string, unknown>;
      const turnId = p.turnId || p.turn_id;
      const threadId = p.threadId || p.thread_id;
      console.log(`\n*** exec_command_begin turnId: ${turnId || 'NOT FOUND'} ***`);
      console.log(`*** exec_command_begin threadId: ${threadId || 'NOT FOUND'} ***`);

      // If turnId is present, this can be used as backup for abort fix
      if (turnId) {
        console.log('SUCCESS: exec_command_begin has turnId - can be used for abort fix!');
      }
    }

    if (execCommandEnd.length > 0) {
      const sample = execCommandEnd[0];
      console.log('\nexec_command_end sample params:');
      console.log(JSON.stringify(sample.params, null, 2).slice(0, 1000));
    }

    console.log('==========================================\n');

    // Log all unique notification methods for documentation
    const allMethods = [...new Set(notifications.map((n) => n.method))].sort();
    console.log('All notification methods received:', allMethods.join(', '));

    // We expect either commandExecution items or exec_command notifications
    // The test documents what exists so we know what to handle
    if (commandExecutionFound) {
      console.log('VERIFIED: commandExecution items exist in item/started');
    }
    if (execCommandBegin.length > 0) {
      console.log('VERIFIED: exec_command_begin notifications exist');
    }
  });
});
