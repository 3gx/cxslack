/**
 * SDK Live Test: Session file contains authoritative final assistant output.
 *
 * Run with: make sdk-test
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import readline from 'readline';
import { CodexClient } from '../../codex-client.js';

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

describe.skipIf(SKIP_LIVE)('Codex Session Final Output', { timeout: 60000 }, () => {
  let server: ChildProcess;
  let rl: readline.Interface;
  let requestId = 0;
  const responseHandlers = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const notifications: Array<{ method: string; params: unknown }> = [];

  beforeAll(async () => {
    server = spawn('codex', ['app-server'], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    rl = readline.createInterface({
      input: server.stdout!,
      crlfDelay: Infinity,
    });

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
        // Ignore non-JSON lines
      }
    });

    await rpc('initialize', {
      clientInfo: { name: 'cxslack-session-output-test', version: '1.0.0' },
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

      setTimeout(() => {
        if (responseHandlers.has(id)) {
          responseHandlers.delete(id);
          reject(new Error(`Request ${method} (id=${id}) timed out`));
        }
      }, 30000);
    });
  }

  async function waitForTurnComplete(timeoutMs = 30000): Promise<boolean> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      if (notifications.some(
        (n) => n.method === 'codex/event/task_complete' || n.method === 'turn/completed'
      )) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  it('session file contains exact assistant output for repeated characters', async () => {
    notifications.length = 0;

    const expected = '/Users/egx/ai/ccslack  /Users/egx/ai/cxslack  //////  END';

    const threadResult = await rpc<{ thread: { id: string } }>('thread/start', {
      workingDirectory: process.cwd(),
    });
    const threadId = threadResult.thread.id;
    expect(threadId).toBeDefined();

    await rpc('turn/start', {
      threadId,
      input: [{ type: 'text', text: `Output exactly this line (no extra text): ${expected}` }],
    });

    const completed = await waitForTurnComplete();
    expect(completed).toBe(true);

    const readResult = await rpc<{ thread: { path?: string } }>('thread/read', { threadId });
    const sessionPath = readResult.thread.path;
    expect(sessionPath).toBeDefined();

    const client = new CodexClient({ requestTimeout: 10 });
    const parsed = sessionPath ? client.parseSessionFileLatestAssistantMessage(sessionPath) : null;
    expect(parsed?.text).toBe(expected);
  });
});
