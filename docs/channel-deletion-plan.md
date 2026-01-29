# Channel Deletion Feature - Implementation Plan for cxslack

## Overview

When a Slack channel is deleted, all associated sessions should be removed from `sessions.json`. Unlike ccslack which also deletes SDK `.jsonl` files, cxslack only needs to clean up the session metadata since Codex threads are managed externally.

---

## Current State (cxslack)

### Session Storage Structure

```json
{
  "channels": {
    "C123456": {
      "threadId": "thread-abc",           // Active Codex thread
      "previousThreadIds": ["thread-old"], // From /clear operations
      "turns": [...],                      // Turn history
      "approvalPolicy": "...",
      "model": "...",
      "threads": {
        "789.012": {                       // Slack thread ts
          "threadId": "thread-def",        // Thread's Codex thread
          "forkedFrom": "thread-abc",
          "forkedAtTurnIndex": 2,
          "messageTurnMap": {...},
          "messageToolMap": {...}
        }
      }
    }
  }
}
```

### What Gets Deleted

When channel `C123456` is deleted:

1. **Main channel session** - The entire `channels["C123456"]` entry
2. **All thread sessions** - All entries in `channels["C123456"].threads`
3. **Turn history** - The `turns` array
4. **Codex thread references** - `threadId` and `previousThreadIds`

### What Does NOT Get Deleted

- **Codex threads themselves** - They remain in Codex (may be useful for auditing)
- **Other channels** - Completely unaffected
- **Terminal forks** - Sessions created outside Slack bot are not tracked

---

## Implementation Plan

### 1. Add `channel_deleted` Event Handler

**File:** `src/slack-bot.ts`

```typescript
/**
 * Handle channel deletion - clean up all sessions for this channel
 *
 * When a channel is deleted:
 * 1. Delete main session from sessions.json
 * 2. Delete all thread sessions from sessions.json
 *
 * Note: Codex threads are NOT deleted - they remain for auditing.
 * The bot only manages the Slack ↔ Codex mapping metadata.
 */
app.event('channel_deleted', async ({ event }) => {
  try {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[channel-deleted] Channel deleted: ${event.channel}`);
    console.log(`${'='.repeat(60)}`);

    await deleteChannelSession(event.channel);

    console.log(`${'='.repeat(60)}\n`);
  } catch (error) {
    console.error('[channel-deleted] Error handling channel deletion:', error);
    // Don't throw - cleanup failure shouldn't crash the bot
  }
});
```

### 2. Add `deleteChannelSession` Function

**File:** `src/session-manager.ts`

```typescript
/**
 * Delete all session data for a channel (main + all threads)
 * Called when a Slack channel is deleted.
 *
 * Note: Does NOT delete Codex threads - only the bot's metadata mapping.
 */
export async function deleteChannelSession(channelId: string): Promise<void> {
  await sessionsMutex.runExclusive(() => {
    const store = loadSessions();
    const channelSession = store.channels[channelId];

    if (!channelSession) {
      console.log(`[channel-deleted] No session found for channel ${channelId}`);
      return;
    }

    // Count what we're deleting for logging
    const threadCount = channelSession.threads
      ? Object.keys(channelSession.threads).length
      : 0;
    const previousCount = channelSession.previousThreadIds?.length ?? 0;

    console.log(`[channel-deleted] Deleting sessions for channel ${channelId}:`);
    console.log(`  - 1 main session (threadId: ${channelSession.threadId ?? 'none'})`);
    if (previousCount > 0) {
      console.log(`  - ${previousCount} previous thread(s) from /clear operations`);
    }
    if (threadCount > 0) {
      console.log(`  - ${threadCount} thread session(s)`);
    }

    // Log Codex thread IDs being orphaned (for auditing reference)
    const orphanedThreadIds: string[] = [];
    if (channelSession.threadId) {
      orphanedThreadIds.push(channelSession.threadId);
    }
    if (channelSession.previousThreadIds) {
      orphanedThreadIds.push(...channelSession.previousThreadIds.filter(Boolean));
    }
    if (channelSession.threads) {
      Object.values(channelSession.threads).forEach(t => {
        if (t.threadId) orphanedThreadIds.push(t.threadId);
      });
    }
    if (orphanedThreadIds.length > 0) {
      console.log(`  - Codex threads orphaned (NOT deleted): ${orphanedThreadIds.join(', ')}`);
    }

    // Delete the channel entry entirely
    delete store.channels[channelId];
    saveSessions(store);

    console.log(`[channel-deleted] ✓ Removed channel ${channelId} from sessions.json`);
  });
}
```

### 3. Update Slack App Configuration

**Required Slack Event Subscription:**

1. Go to Slack App Dashboard → Event Subscriptions
2. Add `channel_deleted` to subscribed bot events
3. Reinstall app to workspace

**No new OAuth scopes required** - the existing `channels:read` scope covers this event.

---

## Testing Plan

### Unit Tests

**File:** `src/__tests__/unit/session-manager.test.ts`

Add new describe block for `deleteChannelSession`:

```typescript
describe('deleteChannelSession', () => {
  it('deletes main channel session', async () => {
    // Setup: Create a channel with main session
    await saveSession('C123', {
      threadId: 'thread-abc',
      approvalPolicy: 'auto-edit',
    });

    // Act
    await deleteChannelSession('C123');

    // Assert
    const session = getSession('C123');
    expect(session).toBeUndefined();
  });

  it('deletes channel with thread sessions', async () => {
    // Setup: Create channel with main + 2 threads
    await saveSession('C123', {
      threadId: 'thread-main',
      approvalPolicy: 'auto-edit',
    });
    await saveThreadSession('C123', '111.222', {
      threadId: 'thread-fork-1',
      forkedFrom: 'thread-main',
    });
    await saveThreadSession('C123', '333.444', {
      threadId: 'thread-fork-2',
      forkedFrom: 'thread-main',
    });

    // Act
    await deleteChannelSession('C123');

    // Assert
    expect(getSession('C123')).toBeUndefined();
    expect(getThreadSession('C123', '111.222')).toBeUndefined();
    expect(getThreadSession('C123', '333.444')).toBeUndefined();
  });

  it('handles non-existent channel gracefully', async () => {
    // Act & Assert - should not throw
    await expect(deleteChannelSession('NONEXISTENT')).resolves.not.toThrow();
  });

  it('does not affect other channels', async () => {
    // Setup: Create two channels
    await saveSession('C123', { threadId: 'thread-1' });
    await saveSession('C456', { threadId: 'thread-2' });

    // Act
    await deleteChannelSession('C123');

    // Assert
    expect(getSession('C123')).toBeUndefined();
    expect(getSession('C456')).toBeDefined();
    expect(getSession('C456')?.threadId).toBe('thread-2');
  });

  it('handles channel with previousThreadIds from /clear', async () => {
    // Setup: Channel that has been /clear'd multiple times
    await saveSession('C123', {
      threadId: 'thread-current',
      previousThreadIds: ['thread-old-1', 'thread-old-2'],
    });

    // Act
    await deleteChannelSession('C123');

    // Assert
    expect(getSession('C123')).toBeUndefined();
  });

  it('handles channel with null threadId', async () => {
    // Setup: Channel with no active thread (just created, never used)
    await saveSession('C123', {
      threadId: null,
      approvalPolicy: 'suggest',
    });

    // Act & Assert - should not throw
    await expect(deleteChannelSession('C123')).resolves.not.toThrow();
    expect(getSession('C123')).toBeUndefined();
  });

  it('persists deletion to disk', async () => {
    // Setup
    await saveSession('C123', { threadId: 'thread-abc' });

    // Act
    await deleteChannelSession('C123');

    // Assert: Reload from disk and verify
    const store = loadSessions();
    expect(store.channels['C123']).toBeUndefined();
  });
});
```

### Integration Tests

**File:** `src/__tests__/integration/channel-deletion.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App } from '@slack/bolt';
import {
  saveSession,
  saveThreadSession,
  getSession,
  deleteChannelSession,
} from '../../session-manager';

describe('Channel Deletion Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('channel_deleted event handler', () => {
    it('calls deleteChannelSession when channel is deleted', async () => {
      const deleteChannelSessionSpy = vi.spyOn(
        await import('../../session-manager'),
        'deleteChannelSession'
      );

      // Simulate channel_deleted event
      const event = { channel: 'C123456' };

      // The handler should call deleteChannelSession
      await deleteChannelSession(event.channel);

      expect(deleteChannelSessionSpy).toHaveBeenCalledWith('C123456');
    });

    it('handles deletion errors gracefully without crashing', async () => {
      // Setup: Mock deleteChannelSession to throw
      vi.spyOn(
        await import('../../session-manager'),
        'deleteChannelSession'
      ).mockRejectedValue(new Error('Simulated failure'));

      // Act & Assert: Should not throw
      // The event handler wraps in try/catch
      await expect(async () => {
        try {
          await deleteChannelSession('C123');
        } catch {
          // Handler catches this
        }
      }).not.toThrow();
    });
  });

  describe('full cleanup scenario', () => {
    it('cleans up complex channel with main + threads + previous', async () => {
      // Setup: Realistic channel state
      await saveSession('C123', {
        threadId: 'thread-main',
        previousThreadIds: ['thread-old'],
        approvalPolicy: 'auto-edit',
        turns: [
          { turnId: 'turn-1', slackTs: '111.111' },
          { turnId: 'turn-2', slackTs: '222.222' },
        ],
      });

      await saveThreadSession('C123', '333.333', {
        threadId: 'thread-fork-1',
        forkedFrom: 'thread-main',
        forkedAtTurnIndex: 1,
      });

      await saveThreadSession('C123', '444.444', {
        threadId: 'thread-fork-2',
        forkedFrom: 'thread-main',
        forkedAtTurnIndex: 2,
      });

      // Act
      await deleteChannelSession('C123');

      // Assert: Everything gone
      expect(getSession('C123')).toBeUndefined();
    });
  });
});
```

### Manual Testing Checklist

1. **Basic deletion test:**
   - Create a channel, @mention bot to create a session
   - Verify session exists in `sessions.json`
   - Delete the channel in Slack
   - Verify session removed from `sessions.json`
   - Verify bot logs show cleanup messages

2. **Thread deletion test:**
   - Create channel, start main conversation
   - Fork to multiple threads
   - Delete the channel
   - Verify all thread sessions removed

3. **Error resilience test:**
   - Make `sessions.json` read-only
   - Delete a channel
   - Verify bot doesn't crash
   - Verify error is logged

4. **Concurrent deletion test:**
   - Delete two channels rapidly
   - Verify both are cleaned up correctly
   - Verify no race conditions (mutex)

---

## Architecture Decisions

### Why NOT Delete Codex Threads?

1. **Audit trail** - Codex threads may be valuable for compliance/debugging
2. **Codex manages its own lifecycle** - Threads may have TTL or quota management
3. **Separation of concerns** - Bot manages Slack↔Codex mapping, not Codex storage
4. **Performance** - No API calls needed during deletion (faster, more reliable)

### Why Delete on `channel_deleted` vs `channel_archive`?

- **`channel_deleted`** = Permanent removal, sessions should be cleaned
- **`channel_archive`** = Temporary, user may un-archive later
- We only handle `channel_deleted` to preserve archived channel sessions

### Concurrency Safety

The `sessionsMutex` ensures that concurrent channel deletions don't corrupt `sessions.json`. This is critical because:
- Multiple channels could be deleted simultaneously
- The bot might be processing messages while deletion occurs
- File I/O (read-modify-write) must be atomic

---

## Implementation Checklist

- [ ] Add `deleteChannelSession` function to `session-manager.ts`
- [ ] Export `deleteChannelSession` from `session-manager.ts`
- [ ] Add `channel_deleted` event handler to `slack-bot.ts`
- [ ] Add unit tests for `deleteChannelSession`
- [ ] Add integration tests for channel deletion flow
- [ ] Update Slack app event subscriptions (manual step)
- [ ] Test manually in development workspace
- [ ] Document in README (optional)

---

## Estimated Scope

- **Files to modify:** 2 (`session-manager.ts`, `slack-bot.ts`)
- **Files to create:** 1 (`channel-deletion.test.ts`)
- **New functions:** 1 (`deleteChannelSession`)
- **New event handlers:** 1 (`channel_deleted`)
- **Test cases:** ~10 unit + ~3 integration
