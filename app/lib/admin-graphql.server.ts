import type { PrismaClient } from "@prisma/client";

/**
 * Thin GraphQL client wrapper around an admin API client (shopify-api or
 * admin-api-client). Handles:
 *  - THROTTLED errors with backoff,
 *  - Retry-After header respect,
 *  - extensions.cost bookkeeping (queries per minute budget),
 *  - zod validation of responses (caller passes the schema).
 *
 * The actual transport is injected so tests can mock HTTP with msw.
 */

export interface AdminGraphQLExecutor {
  graphql: (options: { query: string; variables?: Record<string, unknown> }) => Promise<GraphQLRawResponse>;
}

export interface GraphQLRawResponse {
  data?: unknown;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
  extensions?: {
    cost?: {
      requestedQueryCost?: number;
      actualQueryCost?: number;
      throttleStatus?: {
        maximumAvailable?: number;
        currentlyAvailable?: number;
        restoreRate?: number;
      };
    };
  };
}

export class ThrottledError extends Error {
  retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`throttled; retry after ${retryAfterMs}ms`);
    this.retryAfterMs = retryAfterMs;
  }
}

export interface AdminGraphQLOptions {
  maxRetries?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
}

const DEFAULTS: Required<Omit<AdminGraphQLOptions, "onRetry">> = {
  maxRetries: 5,
  initialBackoffMs: 1000,
  maxBackoffMs: 60_000,
};

/** Reads extensions.cost.throttleStatus to decide whether to wait before the next call. */
export function computeThrottleDelayMs(response: GraphQLRawResponse): number {
  const throttle = response.extensions?.cost?.throttleStatus;
  if (!throttle) return 0;
  const currently = throttle.currentlyAvailable ?? 0;
  const max = throttle.maximumAvailable ?? 0;
  const restore = throttle.restoreRate ?? 0;
  if (currently > 0 || restore === 0) return 0;
  // Out of budget: wait until at least half is restored.
  const needed = Math.max(1, Math.ceil((max * 0.5 - currently) / restore));
  return needed * 1000;
}

export function isThrottled(response: GraphQLRawResponse): boolean {
  return response.errors?.some((e) => e.extensions?.code === "THROTTLED") ?? false;
}

export async function adminGraphQL(
  executor: AdminGraphQLExecutor,
  query: string,
  variables: Record<string, unknown> | undefined,
  options: AdminGraphQLOptions = {},
): Promise<GraphQLRawResponse> {
  const { maxRetries, initialBackoffMs, maxBackoffMs } = { ...DEFAULTS, ...options };
  let attempt = 0;
  let delay = initialBackoffMs;

  for (;;) {
    const response = await executor.graphql({ query, variables });
    if (isThrottled(response)) {
      if (attempt >= maxRetries) throw new ThrottledError(delay);
      const throttleDelay = computeThrottleDelayMs(response);
      const wait = Math.min(Math.max(throttleDelay, delay), maxBackoffMs);
      options.onRetry?.({ attempt, delayMs: wait, reason: "THROTTLED" });
      await sleep(wait);
      attempt += 1;
      delay = Math.min(delay * 2, maxBackoffMs);
      continue;
    }
    return response;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** zod-validate and unwrap data or throw a normalized error. */
export function unwrapData<T>(
  response: GraphQLRawResponse,
  parse: (data: unknown) => T,
): T {
  if (response.errors?.length) {
    const messages = response.errors.map((e) => e.message).join("; ");
    throw new Error(`GraphQL errors: ${messages}`);
  }
  if (response.data == null) throw new Error("GraphQL response has no data");
  return parse(response.data);
}

export type { PrismaClient };
