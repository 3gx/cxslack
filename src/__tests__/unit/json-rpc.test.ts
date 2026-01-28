/**
 * Unit tests for JSON-RPC helpers.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  generateRequestId,
  resetRequestIdCounter,
  createRequest,
  serializeMessage,
  parseMessage,
  isRequest,
  isResponse,
  isNotification,
  isErrorResponse,
  createPendingRequestTracker,
  JsonRpcResponseError,
  ErrorCodes,
} from '../../json-rpc.js';

describe('JSON-RPC Helpers', () => {
  beforeEach(() => {
    resetRequestIdCounter();
  });

  describe('generateRequestId', () => {
    it('generates sequential IDs', () => {
      expect(generateRequestId()).toBe(1);
      expect(generateRequestId()).toBe(2);
      expect(generateRequestId()).toBe(3);
    });

    it('resets correctly', () => {
      generateRequestId();
      generateRequestId();
      resetRequestIdCounter();
      expect(generateRequestId()).toBe(1);
    });
  });

  describe('createRequest', () => {
    it('creates a valid request without params', () => {
      const request = createRequest('test/method');
      expect(request).toEqual({
        jsonrpc: '2.0',
        id: 1,
        method: 'test/method',
      });
    });

    it('creates a valid request with params', () => {
      const request = createRequest('test/method', { foo: 'bar' });
      expect(request).toEqual({
        jsonrpc: '2.0',
        id: 1,
        method: 'test/method',
        params: { foo: 'bar' },
      });
    });
  });

  describe('serializeMessage', () => {
    it('serializes with newline', () => {
      const request = createRequest('test');
      const serialized = serializeMessage(request);
      expect(serialized.endsWith('\n')).toBe(true);
      expect(JSON.parse(serialized.trim())).toEqual(request);
    });
  });

  describe('parseMessage', () => {
    it('parses valid request', () => {
      const json = '{"jsonrpc":"2.0","id":1,"method":"test"}';
      const parsed = parseMessage(json);
      expect(parsed).toEqual({
        jsonrpc: '2.0',
        id: 1,
        method: 'test',
      });
    });

    it('parses valid response', () => {
      const json = '{"jsonrpc":"2.0","id":1,"result":{"data":"test"}}';
      const parsed = parseMessage(json);
      expect(parsed).toEqual({
        jsonrpc: '2.0',
        id: 1,
        result: { data: 'test' },
      });
    });

    it('parses valid notification', () => {
      const json = '{"jsonrpc":"2.0","method":"notify","params":{}}';
      const parsed = parseMessage(json);
      expect(parsed).toEqual({
        jsonrpc: '2.0',
        method: 'notify',
        params: {},
      });
    });

    it('returns null for invalid JSON', () => {
      expect(parseMessage('not json')).toBeNull();
    });

    it('accepts and normalizes messages without jsonrpc field (Codex compatibility)', () => {
      // Codex App-Server sometimes omits jsonrpc field
      const parsed = parseMessage('{"id":1,"result":{"data":"test"}}');
      expect(parsed).toEqual({
        jsonrpc: '2.0',
        id: 1,
        result: { data: 'test' },
      });
    });

    it('returns null for wrong jsonrpc version', () => {
      expect(parseMessage('{"jsonrpc":"1.0","id":1,"method":"test"}')).toBeNull();
    });
  });

  describe('type guards', () => {
    it('isRequest identifies requests', () => {
      const request = { jsonrpc: '2.0' as const, id: 1, method: 'test' };
      const response = { jsonrpc: '2.0' as const, id: 1, result: {} };
      const notification = { jsonrpc: '2.0' as const, method: 'test' };

      expect(isRequest(request)).toBe(true);
      expect(isRequest(response)).toBe(false);
      expect(isRequest(notification)).toBe(false);
    });

    it('isResponse identifies responses', () => {
      const request = { jsonrpc: '2.0' as const, id: 1, method: 'test' };
      const response = { jsonrpc: '2.0' as const, id: 1, result: {} };
      const notification = { jsonrpc: '2.0' as const, method: 'test' };

      expect(isResponse(request)).toBe(false);
      expect(isResponse(response)).toBe(true);
      expect(isResponse(notification)).toBe(false);
    });

    it('isNotification identifies notifications', () => {
      const request = { jsonrpc: '2.0' as const, id: 1, method: 'test' };
      const response = { jsonrpc: '2.0' as const, id: 1, result: {} };
      const notification = { jsonrpc: '2.0' as const, method: 'test' };

      expect(isNotification(request)).toBe(false);
      expect(isNotification(response)).toBe(false);
      expect(isNotification(notification)).toBe(true);
    });

    it('isErrorResponse identifies error responses', () => {
      const successResponse = { jsonrpc: '2.0' as const, id: 1, result: {} };
      const errorResponse = {
        jsonrpc: '2.0' as const,
        id: 1,
        error: { code: -32600, message: 'Invalid Request' },
      };

      expect(isErrorResponse(successResponse)).toBe(false);
      expect(isErrorResponse(errorResponse)).toBe(true);
    });
  });

  describe('createPendingRequestTracker', () => {
    it('tracks and resolves pending requests', async () => {
      const tracker = createPendingRequestTracker();
      const result = { data: 'test' };

      const promise = new Promise((resolve, reject) => {
        tracker.add(1, 'test', resolve, reject);
      });

      expect(tracker.size).toBe(1);
      expect(tracker.hasPending).toBe(true);

      tracker.resolve({ jsonrpc: '2.0', id: 1, result });

      expect(tracker.size).toBe(0);
      expect(await promise).toEqual(result);
    });

    it('rejects on error response', async () => {
      const tracker = createPendingRequestTracker();

      const promise = new Promise((resolve, reject) => {
        tracker.add(1, 'test', resolve, reject);
      });

      tracker.resolve({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32600, message: 'Invalid Request' },
      });

      await expect(promise).rejects.toBeInstanceOf(JsonRpcResponseError);
    });

    it('handles timeout', async () => {
      const tracker = createPendingRequestTracker();

      const promise = new Promise((resolve, reject) => {
        tracker.add(1, 'test', resolve, reject, 10); // 10ms timeout
      });

      await expect(promise).rejects.toThrow(/timed out/);
    });

    it('rejectAll clears all pending', async () => {
      const tracker = createPendingRequestTracker();
      const promises: Promise<unknown>[] = [];

      for (let i = 0; i < 3; i++) {
        promises.push(
          new Promise((resolve, reject) => {
            tracker.add(i, 'test', resolve, reject);
          })
        );
      }

      expect(tracker.size).toBe(3);

      tracker.rejectAll(new Error('Connection closed'));

      expect(tracker.size).toBe(0);

      for (const promise of promises) {
        await expect(promise).rejects.toThrow('Connection closed');
      }
    });

    it('returns false for unknown response ID', () => {
      const tracker = createPendingRequestTracker();
      const result = tracker.resolve({ jsonrpc: '2.0', id: 999, result: {} });
      expect(result).toBe(false);
    });
  });

  describe('JsonRpcResponseError', () => {
    it('contains error details', () => {
      const error = new JsonRpcResponseError({
        code: ErrorCodes.INVALID_REQUEST,
        message: 'Invalid Request',
        data: { detail: 'test' },
      });

      expect(error.code).toBe(ErrorCodes.INVALID_REQUEST);
      expect(error.message).toBe('Invalid Request');
      expect(error.data).toEqual({ detail: 'test' });
      expect(error.name).toBe('JsonRpcResponseError');
    });
  });
});
