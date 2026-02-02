/**
 * SDK Live Tests: Multi-process isolation and thread portability.
 *
 * Verifies whether multiple Codex app-server processes can run in parallel,
 * and whether thread IDs are portable across processes.
 *
 * Run with: make sdk-test
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CodexClient } from '../../codex-client.js';

const SKIP_LIVE = process.env.SKIP_SDK_TESTS === 'true';

function waitForTurnComplete(
  codex: CodexClient,
  threadId: string,
  turnId: string,
  timeoutMs = 60000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for turn completion (threadId=${threadId}, turnId=${turnId})`));
    }, timeoutMs);

    const onComplete = (evt: { threadId?: string; turnId?: string; status?: string }) => {
      if (evt.threadId === threadId && evt.turnId === turnId) {
        cleanup();
        resolve();
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      codex.off('turn:completed', onComplete);
    };

    codex.on('turn:completed', onComplete);
  });
}

describe.skipIf(SKIP_LIVE)('Codex multi-process isolation', { timeout: 120000 }, () => {
  let codexA: CodexClient;
  let codexB: CodexClient;

  beforeAll(async () => {
    codexA = new CodexClient();
    codexB = new CodexClient();
    await codexA.start();
    await codexB.start();
  });

  afterAll(async () => {
    await codexA.stop();
    await codexB.stop();
  });

  it('runs turns in parallel on separate app-server processes', async () => {
    const threadA = await codexA.startThread(process.cwd());
    const threadB = await codexB.startThread(process.cwd());

    const turnA = await codexA.startTurn(threadA.id, [{ type: 'text', text: 'Reply with the single letter A.' }]);
    const turnB = await codexB.startTurn(threadB.id, [{ type: 'text', text: 'Reply with the single letter B.' }]);

    await Promise.all([
      waitForTurnComplete(codexA, threadA.id, turnA),
      waitForTurnComplete(codexB, threadB.id, turnB),
    ]);

    expect(true).toBe(true);
  });

  it('verifies thread portability across processes', async () => {
    const thread = await codexA.startThread(process.cwd());

    let portable = false;
    try {
      await codexB.readThread(thread.id, false);
      portable = true;
    } catch {
      portable = false;
    }

    // This must be true for per-session processes to preserve resume/fork behavior across restarts.
    expect(portable).toBe(true);
  });
});
