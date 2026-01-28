/**
 * JSON-RPC 2.0 helpers for communicating with Codex App-Server.
 *
 * The Codex App-Server uses JSON-RPC 2.0 over stdin/stdout with JSONL (newline-delimited JSON).
 *
 * Protocol:
 * - Requests: { jsonrpc: "2.0", id: number, method: string, params?: object }
 * - Responses: { jsonrpc: "2.0", id: number, result?: any, error?: { code: number, message: string } }
 * - Notifications: { jsonrpc: "2.0", method: string, params?: object } (no id, no response expected)
 */

// Request ID counter
let requestIdCounter = 0;

/**
 * Generate a unique request ID.
 */
export function generateRequestId(): number {
  return ++requestIdCounter;
}

/**
 * Reset the request ID counter (for testing).
 */
export function resetRequestIdCounter(): void {
  requestIdCounter = 0;
}

/**
 * JSON-RPC 2.0 Request.
 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * JSON-RPC 2.0 Response.
 */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: JsonRpcError;
}

/**
 * JSON-RPC 2.0 Error.
 */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * JSON-RPC 2.0 Notification (no id, no response expected).
 */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Union type for any JSON-RPC message.
 */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

/**
 * Create a JSON-RPC request.
 */
export function createRequest(method: string, params?: Record<string, unknown>): JsonRpcRequest {
  const request: JsonRpcRequest = {
    jsonrpc: '2.0',
    id: generateRequestId(),
    method,
  };
  if (params !== undefined) {
    request.params = params;
  }
  return request;
}

/**
 * Serialize a JSON-RPC message to JSONL format (with newline).
 */
export function serializeMessage(message: JsonRpcMessage): string {
  return JSON.stringify(message) + '\n';
}

/**
 * Parse a JSON-RPC message from a JSON string.
 * Returns null if parsing fails.
 */
export function parseMessage(json: string): JsonRpcMessage | null {
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    if (parsed.jsonrpc !== '2.0') {
      return null;
    }
    return parsed as JsonRpcMessage;
  } catch {
    return null;
  }
}

/**
 * Check if a message is a request (has id and method).
 */
export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return 'id' in message && 'method' in message;
}

/**
 * Check if a message is a response (has id but no method).
 */
export function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return 'id' in message && !('method' in message);
}

/**
 * Check if a message is a notification (has method but no id).
 */
export function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return 'method' in message && !('id' in message);
}

/**
 * Check if a response is an error response.
 */
export function isErrorResponse(response: JsonRpcResponse): boolean {
  return response.error !== undefined;
}

/**
 * Standard JSON-RPC error codes.
 */
export const ErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // Server errors: -32000 to -32099
  SERVER_ERROR: -32000,
} as const;

/**
 * Pending request tracker for correlating responses to requests.
 */
export interface PendingRequest {
  id: number;
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout?: ReturnType<typeof setTimeout>;
}

/**
 * Create a pending request tracker.
 */
export function createPendingRequestTracker() {
  const pending = new Map<number, PendingRequest>();

  return {
    /**
     * Add a pending request with optional timeout.
     */
    add(
      id: number,
      method: string,
      resolve: (result: unknown) => void,
      reject: (error: Error) => void,
      timeoutMs?: number
    ): void {
      const request: PendingRequest = { id, method, resolve, reject };

      if (timeoutMs && timeoutMs > 0) {
        request.timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Request ${method} (id=${id}) timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      pending.set(id, request);
    },

    /**
     * Resolve a pending request with a response.
     */
    resolve(response: JsonRpcResponse): boolean {
      const request = pending.get(response.id);
      if (!request) {
        return false;
      }

      pending.delete(response.id);
      if (request.timeout) {
        clearTimeout(request.timeout);
      }

      if (response.error) {
        request.reject(new JsonRpcResponseError(response.error));
      } else {
        request.resolve(response.result);
      }

      return true;
    },

    /**
     * Reject all pending requests (e.g., when connection closes).
     */
    rejectAll(error: Error): void {
      for (const request of pending.values()) {
        if (request.timeout) {
          clearTimeout(request.timeout);
        }
        request.reject(error);
      }
      pending.clear();
    },

    /**
     * Get the number of pending requests.
     */
    get size(): number {
      return pending.size;
    },

    /**
     * Check if there are any pending requests.
     */
    get hasPending(): boolean {
      return pending.size > 0;
    },
  };
}

/**
 * Custom error class for JSON-RPC response errors.
 */
export class JsonRpcResponseError extends Error {
  constructor(
    public readonly error: JsonRpcError
  ) {
    super(error.message);
    this.name = 'JsonRpcResponseError';
  }

  get code(): number {
    return this.error.code;
  }

  get data(): unknown {
    return this.error.data;
  }
}
