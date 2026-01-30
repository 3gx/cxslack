/**
 * SDK Live Test: .git folder write permission verification
 *
 * Tests whether Codex app-server can write files to the .git folder.
 *
 * Run with: make sdk-test
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import readline from 'readline';
import fs from 'fs';
import path from 'path';

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

describe.skipIf(SKIP_LIVE)('Codex .git Folder Write Test', { timeout: 120000 }, () => {
  let server: ChildProcess;
  let rl: readline.Interface;
  let requestId = 0;
  const responseHandlers = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const notifications: Array<{ method: string; params: unknown }> = [];

  const testFileName = 'cxslack-write-test-' + Date.now() + '.txt';
  const gitFolderPath = path.join(process.cwd(), '.git');
  const testFilePath = path.join(gitFolderPath, testFileName);

  beforeAll(async () => {
    // Spawn app-server - use sandbox_mode (not sandbox.mode) to disable sandbox
    server = spawn('codex', [
      'app-server',
      '-c', 'sandbox_mode="danger-full-access"',
    ], {
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
      clientInfo: { name: 'cxslack-git-write-test', version: '1.0.0' },
    });
  });

  afterAll(() => {
    rl?.close();
    server?.kill();

    // Clean up test file if it exists
    try {
      if (fs.existsSync(testFilePath)) {
        fs.unlinkSync(testFilePath);
        console.log(`Cleaned up test file: ${testFilePath}`);
      }
    } catch (e) {
      console.log('Could not clean up test file:', e);
    }
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

  it('tests if Codex can touch a file in .git folder', async () => {
    console.log('\n=== .git Folder Write Test ===');
    console.log(`Test file: ${testFilePath}`);

    // Clear notifications from initialization
    notifications.length = 0;

    // Start a thread
    const threadResult = await rpc<{ thread: { id: string } }>('thread/start', {
      workingDirectory: process.cwd(),
    });
    const threadId = threadResult.thread.id;
    expect(threadId).toBeDefined();
    console.log(`Thread started: ${threadId}`);

    // Ask Codex to touch a file in .git folder - explicitly use bash touch
    const prompt = `Run this exact bash command: touch "${testFilePath}"

Do not use the Write tool. Use Bash with touch command only. Do not explain, just run the command.`;

    console.log(`\nSending prompt to Codex...`);
    console.log(`Prompt: ${prompt}`);

    await rpc('turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt }],
      approvalPolicy: 'never', // Auto-approve to test actual write behavior
    });

    // Wait for turn to complete (poll notifications)
    const startTime = Date.now();
    const timeout = 90000;
    let turnComplete = false;

    while (!turnComplete && Date.now() - startTime < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Check for task_complete or turn/completed
      turnComplete = notifications.some(
        (n) => n.method === 'codex/event/task_complete' || n.method === 'turn/completed'
      );
    }

    expect(turnComplete).toBe(true);
    console.log(`\nTurn completed in ${Date.now() - startTime}ms`);

    // Log all received notification methods for debugging
    const methods = [...new Set(notifications.map((n) => n.method))];
    console.log('Notification methods received:', methods.join(', '));

    // Check if the file was actually created
    const fileExists = fs.existsSync(testFilePath);
    console.log(`\n=== RESULT ===`);
    console.log(`File created: ${fileExists}`);
    console.log(`Path checked: ${testFilePath}`);

    // Find any commandExecution or exec_command notifications
    const commandNotifications = notifications.filter((n) =>
      n.method.includes('command') || n.method.includes('exec')
    );

    if (commandNotifications.length > 0) {
      console.log('\nCommand-related notifications:');
      for (const n of commandNotifications) {
        console.log(`  ${n.method}:`, JSON.stringify(n.params, null, 2).slice(0, 500));
      }
    }

    // Check for any error messages in agent deltas
    const deltaNotifications = notifications.filter((n) =>
      n.method.includes('delta') || n.method.includes('message')
    );

    let agentResponse = '';
    for (const n of deltaNotifications) {
      const params = n.params as Record<string, unknown>;
      const msg = params.msg as Record<string, unknown> | undefined;
      const delta = params.delta || msg?.delta || params.content || msg?.content || params.text || msg?.text;
      if (delta && typeof delta === 'string') {
        agentResponse += delta;
      }
    }

    console.log('\nAgent response (first 1000 chars):');
    console.log(agentResponse.slice(0, 1000));

    // Write results to a file for inspection
    const resultLog = `
=== .git Folder Write Test Results ===
Test file path: ${testFilePath}
File created: ${fileExists}
Agent response: ${agentResponse.slice(0, 2000)}
Notification methods: ${methods.join(', ')}
==========================================
`;
    fs.writeFileSync(path.join(process.cwd(), 'git-write-test-result.txt'), resultLog);

    // If the file doesn't exist, the test documents that Codex cannot write to .git
    if (!fileExists) {
      console.log('\n*** RESULT: Codex CANNOT write to .git folder ***');
      console.log('This may be due to sandbox restrictions or explicit .git protection.');
    } else {
      console.log('\n*** RESULT: Codex CAN write to .git folder ***');
    }

    console.log('==============================\n');
  });

  it('tests if Codex can write to a regular folder (control test)', async () => {
    console.log('\n=== Control Test: Regular Folder Write ===');

    const regularTestFileName = 'cxslack-control-test-' + Date.now() + '.txt';
    const regularTestFilePath = path.join(process.cwd(), regularTestFileName);
    console.log(`Test file: ${regularTestFilePath}`);

    // Clear notifications
    notifications.length = 0;

    // Start a new thread
    const threadResult = await rpc<{ thread: { id: string } }>('thread/start', {
      workingDirectory: process.cwd(),
    });
    const threadId = threadResult.thread.id;

    // Ask Codex to touch a file in regular folder
    const prompt = `Please create/touch a file at this exact path: ${regularTestFilePath}

Use the touch command or write an empty file. Just create the file, nothing else. Do not explain, just do it.`;

    await rpc('turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt }],
      approvalPolicy: 'never',
    });

    // Wait for turn to complete
    const startTime = Date.now();
    let turnComplete = false;
    while (!turnComplete && Date.now() - startTime < 60000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      turnComplete = notifications.some(
        (n) => n.method === 'codex/event/task_complete' || n.method === 'turn/completed'
      );
    }

    expect(turnComplete).toBe(true);

    // Check if the file was created
    const fileExists = fs.existsSync(regularTestFilePath);
    console.log(`\n=== CONTROL RESULT ===`);
    console.log(`File created: ${fileExists}`);

    // Clean up
    if (fileExists) {
      fs.unlinkSync(regularTestFilePath);
      console.log('Cleaned up control test file');
    }

    console.log('==============================\n');

    // This control test should succeed - Codex should be able to write to regular folders
    expect(fileExists).toBe(true);
  });
});
