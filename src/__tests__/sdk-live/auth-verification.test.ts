/**
 * SDK Live Tests: Auth Verification
 *
 * These tests verify that Codex authentication is working correctly.
 * They require a configured Codex CLI with valid credentials.
 *
 * Run with: make sdk-test
 * Skip with: SKIP_SDK_TESTS=true make sdk-test
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

describe.skipIf(SKIP_LIVE)('Codex Auth Verification', { timeout: 30000 }, () => {
  let server: ChildProcess;
  let rl: readline.Interface;
  let requestId = 0;
  const responseHandlers = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

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
          const handler = responseHandlers.get(msg.id)!;
          responseHandlers.delete(msg.id);
          if (msg.error) {
            handler.reject(new Error(msg.error.message));
          } else {
            handler.resolve(msg.result);
          }
        }
      } catch {
        // Ignore non-JSON lines
      }
    });

    // Initialize
    await rpc('initialize', {
      clientInfo: { name: 'cxslack-test', version: '1.0.0' },
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

      // Timeout after 20 seconds
      setTimeout(() => {
        if (responseHandlers.has(id)) {
          responseHandlers.delete(id);
          reject(new Error(`Request ${method} (id=${id}) timed out`));
        }
      }, 20000);
    });
  }

  it('account/read returns authenticated account (OAuth or API key)', async () => {
    const result = await rpc<{ account: { type: string; email?: string } | null }>('account/read', {
      refreshToken: false,
    });

    // Bot doesn't care which auth type - just that account exists
    expect(result.account).not.toBeNull();
    expect(['chatgpt', 'apiKey']).toContain(result.account!.type);

    console.log(`Auth type: ${result.account!.type}`);
    if (result.account!.email) {
      console.log(`Email: ${result.account!.email}`);
    }
  });

  it('thread/start succeeds with valid auth', async () => {
    const result = await rpc<{ thread: { id: string } }>('thread/start', {
      workingDirectory: process.cwd(),
    });

    expect(result.thread).toBeDefined();
    expect(result.thread.id).toBeDefined();
    expect(typeof result.thread.id).toBe('string');

    console.log(`Thread ID: ${result.thread.id}`);
  });

  it('config/read returns configuration (model info)', async () => {
    // Note: model/list may not exist in App-Server; use config/read instead
    const result = await rpc<{ config?: { model?: string } }>('config/read', {});

    // Config should be readable
    expect(result).toBeDefined();
    console.log('Config result:', JSON.stringify(result, null, 2));
  });
});
