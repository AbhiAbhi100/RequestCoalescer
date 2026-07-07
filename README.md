# request-coalescer

[![npm version](https://img.shields.io/npm/v/request-coalescer.svg)](https://www.npmjs.com/package/request-coalescer)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-3178C6.svg)](https://www.typescriptlang.org/)

A production-quality, lightweight, and type-safe TypeScript utility to merge duplicate concurrent asynchronous requests into a single execution by sharing the same Promise.

Designed to prevent **Cache Stampede (Thundering Herd)** problems and reduce unnecessary API and database load.

---

## Table of Contents

- [The Problem](#the-problem)
- [How It Works](#how-it-works)
- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Advanced Usage](#advanced-usage)
- [API Reference](#api-reference)
- [License](#license)

---

## The Problem

When 1,000 users concurrently request the same resource (e.g. at flash sale launch or cache expiration), your server normally fires 1,000 duplicate queries to your database or downstream API. This can crash databases, hit rate limits, and consume excessive CPU/memory.

```text
[No Coalescing]
User 1  -----\
User 2  ------\
...            =====> [Server] =====> DB Query 1 (Slow)
User 1000 ----/                       DB Query 2 (Slow)
                                       ...
                                       DB Query 1000 (Slow)
```

## How It Works

With `request-coalescer`, only the **first** request initiates the async work. All subsequent concurrent callers for the same key share the **same pending Promise** reference.

```text
[With Coalescing]
User 1  -----> (Starts Query & Caches Promise) -------> [Database (1 call)]
User 2  -----> (Gets same Promise from Cache)
...
User 1000 ----> (Gets same Promise from Cache)
```

Once resolved or rejected, the Promise is immediately cleaned up from the cache, delivering the result to all callers from a single execution.

---

## Features

| Feature | Description |
|---|---|
| 🎯 **Core Deduplication** | Shares the underlying promise reference across concurrent calls for the same key. |
| 🛡️ **Caller Isolation** | Timeout and `AbortSignal` support are applied per-caller without interrupting other concurrent callers. |
| ⏱️ **Cache TTL** | Keep successful results cached in memory for a specified duration before eviction. |
| 🚦 **Concurrency Limiting** | Global execution limit (`maxPending`) prevents out-of-memory errors and client abuse. |
| ⚙️ **Higher-Order Wrapper** | Simple `.wrap()` helper to adapt existing async functions with zero boilerplate. |
| 📈 **Telemetry** | Built-in hooks (`onHit`, `onMiss`, `onResolve`, `onReject`) and live stats tracking. |
| 📦 **Dual Package** | Ships as ESM & CommonJS with full TypeScript declaration files. |

---

## Installation

```bash
npm install request-coalescer
```

```bash
yarn add request-coalescer
```

```bash
pnpm add request-coalescer
```

---

## Quick Start

```typescript
import { RequestCoalescer } from 'request-coalescer';

const coalescer = new RequestCoalescer();

// A slow asynchronous task (e.g. database lookup or HTTP fetch)
async function fetchUserProfile(userId: string) {
  console.log(`Executing real DB query for user ${userId}...`);
  return { id: userId, name: 'Alice' };
}

// Wrap your async calls with coalescer.coalesce()
async function getUser(userId: string) {
  return coalescer.coalesce(`user:${userId}`, () => fetchUserProfile(userId));
}

// Simulating 3 concurrent calls for the same user
const [u1, u2, u3] = await Promise.all([
  getUser('user-1'),
  getUser('user-1'),
  getUser('user-1'),
]);

// Console Output:
// "Executing real DB query for user user-1..." (logged only ONCE)
```

---

## Advanced Usage

### 1. Functional Wrapper Decorator (`wrap`)

Wrap any async function to automatically resolve cache keys from its arguments:

```typescript
const getCoalescedUser = coalescer.wrap(
  fetchUserProfile,
  (userId) => `user:${userId}`,
  { timeout: 5000 }
);

// Call it just like the original function:
const user = await getCoalescedUser('user-1');
```

### 2. Timeouts & AbortSignal (Isolated Execution)

Each caller can control its own wait independently — this never affects the shared underlying request:

```typescript
const controller = new AbortController();

const request1 = coalescer.coalesce('fetch-data', fetchData, {
  timeout: 1000, // Fails early for caller 1 if the task takes >1s
});

const request2 = coalescer.coalesce('fetch-data', fetchData, {
  signal: controller.signal, // Caller 2 can abort independently
});

// Abort caller 2 after 500ms — the underlying fetchData() call keeps running for request1
setTimeout(() => controller.abort(), 500);
```

### 3. Cache TTL (Temporary Result Cache)

Configure a Time-to-Live to keep successful values cached in memory for a short duration after they resolve:

```typescript
const value = await coalescer.coalesce('key', fetchSlowData, {
  ttl: 5000, // Keeps the resolved result cached for 5 seconds. Rejections are cleared instantly.
});
```

### 4. Concurrency Limiting

Cap how many distinct requests can be active at once — useful for protecting downstream systems from overload:

```typescript
const coalescer = new RequestCoalescer({ maxPending: 50 });

// The 51st concurrent unique key throws:
// Error: Max pending requests limit (50) reached
```

### 5. Telemetry Hooks

Track cache efficiency and request outcomes in real time:

```typescript
const coalescer = new RequestCoalescer({
  onHit: (key) => console.log(`Cache hit: ${key}`),
  onMiss: (key) => console.log(`Cache miss: ${key}`),
  onResolve: (key, durationMs) => console.log(`${key} resolved in ${durationMs}ms`),
  onReject: (key, error, durationMs) => console.error(`${key} failed after ${durationMs}ms`, error),
});

// ...later
console.log(coalescer.getStats());
// { hits: 12, misses: 3, resolves: 3, rejects: 0, active: 0 }
```

---

## API Reference

### `new RequestCoalescer(options?: CoalescerOptions)`

Creates a new instance with default configuration applied to every call unless overridden.

```typescript
interface CoalescerOptions {
  timeout?: number;      // Default timeout in ms for all requests
  ttl?: number;          // Default cache time-to-live in ms
  maxPending?: number;   // Maximum concurrent executions allowed
  onHit?: (key: string) => void;
  onMiss?: (key: string) => void;
  onResolve?: (key: string, durationMs: number) => void;
  onReject?: (key: string, error: any, durationMs: number) => void;
}
```

### Methods

#### `coalesce<T>(key: string, fn: () => Promise<T>, options?: CoalesceOptions): Promise<T>`

Merges duplicate concurrent requests sharing the same key.

| Param | Description |
|---|---|
| `key` | A unique string identifying the request. |
| `fn` | The underlying async operation to execute on a cache miss. |
| `options` | Per-call overrides: `timeout`, `ttl`, `signal`. |

#### `wrap<Args, R>(fn, keyGenerator, options?): (...args: Args) => Promise<R>`

Returns a coalescing-aware version of `fn`, deriving the cache key from its arguments via `keyGenerator`.

#### `getStats(): CoalescerStats`

Returns a snapshot of current counters: `{ hits, misses, resolves, rejects, active }`.

#### `resetStats(): void`

Resets all counters back to zero.

#### `clearCache(): void`

Evicts all cached and pending entries immediately. Does not cancel underlying in-flight requests.

---

## License

MIT