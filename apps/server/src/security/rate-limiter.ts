import { isIPv6 } from 'node:net';

export type RateLimitSurface =
  | 'seat-claim'
  | 'join'
  | 'protocol-abuse'
  | 'game-command'
  | 'game-read'
  | 'host-check';

/**
 * Who a request counts as. A valid session counts against its seat (or the
 * host); anything else, including a cookie that matches nobody, against its
 * address. The two never share counters, so a flood without a session never
 * blocks the people already playing.
 */
export type RateLimitTier = 'session' | 'address';

export interface RateLimitPolicy {
  readonly windowMs: number;
  readonly source: number;
  readonly target: number;
  /** Cap over every game together; only sessions use it, so a flood on one game stays there. */
  readonly global?: number;
}

export const DEFAULT_RATE_LIMIT_POLICIES: Readonly<
  Record<RateLimitSurface, RateLimitPolicy>
> = {
  // Seats free up one at a time, but a few wrong picks must not lock the game.
  'seat-claim': { windowMs: 5 * 60_000, source: 10, target: 30 },
  // Six people opening the invitation, reloading it and joining, with margin.
  join: { windowMs: 60_000, source: 20, target: 60 },
  'game-command': { windowMs: 1000, source: 30, target: 120, global: 600 },
  // Every announced change makes each open screen read its view again.
  'game-read': { windowMs: 1000, source: 30, target: 240, global: 1200 },
  // Each host cookie is checked against the saved login, which waits in the
  // same queue as the saves. Only cookies that fail stay counted, against
  // their address, so the real host is never slowed down or locked out.
  'host-check': { windowMs: 1000, source: 30, target: 30 },
  'protocol-abuse': {
    windowMs: 60_000,
    source: 30,
    target: 100,
    global: 500,
  },
};

/** IPv6 hands out whole /64 networks, so one network counts as one address. */
export function addressKey(ip: string): string {
  const bare = ip.split('%')[0]!;
  if (!isIPv6(bare)) return bare;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare);
  if (mapped) return mapped[1]!;
  const [head = '', tail = ''] = bare.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const width = (groups: string[]) =>
    groups.reduce((sum, group) => sum + (group.includes('.') ? 2 : 1), 0);
  const groups = bare.includes('::')
    ? [
        ...left,
        ...Array<string>(8 - width(left) - width(right)).fill('0'),
        ...right,
      ]
    : left;
  return (
    groups
      .slice(0, 4)
      .map((group) => parseInt(group, 16).toString(16))
      .join(':') + '::/64'
  );
}

interface Counter {
  count: number;
  expiresAt: number;
}

interface Table {
  readonly counters: Map<string, Counter>;
  sweepAt: number;
}

export class LayeredRateLimiter {
  // One table per surface and tier: filling one never blocks another.
  private readonly tables = new Map<string, Table>();

  private readonly policies: Readonly<
    Record<RateLimitSurface, RateLimitPolicy>
  >;

  constructor(
    // A surface left out keeps its default limit.
    policies: Partial<Record<RateLimitSurface, RateLimitPolicy>> = {},
    private readonly now: () => number = Date.now,
    private readonly maximumEntries = 4_096,
  ) {
    this.policies = { ...DEFAULT_RATE_LIMIT_POLICIES, ...policies };
  }

  consume(
    surface: RateLimitSurface,
    source: string,
    target: string,
    tier: RateLimitTier = 'address',
  ): boolean {
    const now = this.now();
    const policy = this.policies[surface];
    const table = this.table(`${tier}:${surface}`);
    if (now >= table.sweepAt || table.counters.size >= this.maximumEntries) {
      for (const [key, counter] of table.counters)
        if (counter.expiresAt <= now) table.counters.delete(key);
      table.sweepAt = now + policy.windowMs;
    }
    const layers: [string, number][] = [
      [`source:${source}`, policy.source],
      [`target:${target}`, policy.target],
    ];
    if (tier === 'session' && policy.global !== undefined)
      layers.push(['global', policy.global]);
    const live = (key: string) => {
      const counter = table.counters.get(key);
      return counter && counter.expiresAt > now ? counter : undefined;
    };
    if (
      table.counters.size +
        layers.filter(([key]) => !table.counters.has(key)).length >
      this.maximumEntries
    )
      return false;
    if (layers.some(([key, limit]) => (live(key)?.count ?? 0) >= limit))
      return false;
    for (const [key] of layers) {
      const current = live(key);
      table.counters.set(key, {
        count: (current?.count ?? 0) + 1,
        expiresAt: current?.expiresAt ?? now + policy.windowMs,
      });
    }
    return true;
  }

  /** Gives back one use, for a check that turned out to be legitimate. */
  refund(
    surface: RateLimitSurface,
    source: string,
    target: string,
    tier: RateLimitTier = 'address',
  ): void {
    const table = this.tables.get(`${tier}:${surface}`);
    const now = this.now();
    for (const key of [`source:${source}`, `target:${target}`, 'global']) {
      const counter = table?.counters.get(key);
      if (counter && counter.expiresAt > now && counter.count > 0)
        counter.count--;
    }
  }

  private table(name: string): Table {
    let table = this.tables.get(name);
    if (!table) {
      table = { counters: new Map(), sweepAt: 0 };
      this.tables.set(name, table);
    }
    return table;
  }
}

/**
 * Failed host logins slow down only the address that sent them: after a few
 * free tries each failure doubles the wait (1, 2, 4… seconds, up to a
 * minute). Nobody else waits, so nobody can lock the host out, and the access
 * code is far too long to guess anyway.
 */
export class LoginBackoff {
  private readonly entries = new Map<
    string,
    { failures: number; until: number; lastAt: number }
  >();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly freeAttempts = 5,
    private readonly maximumWaitMs = 60_000,
    private readonly forgetAfterMs = 15 * 60_000,
    private readonly maximumEntries = 4_096,
  ) {}

  /**
   * Counts an attempt as failed before checking it, so parallel tries can't
   * all slip in at once. Returns the milliseconds left to wait, or 0 to go on.
   */
  begin(source: string): number {
    const now = this.now();
    const entry = this.entries.get(source);
    const current =
      entry && entry.lastAt + this.forgetAfterMs > now ? entry : undefined;
    if (current && current.until > now) return current.until - now;
    const failures = (current?.failures ?? 0) + 1;
    this.entries.delete(source);
    if (this.entries.size >= this.maximumEntries) this.trim(now);
    this.entries.set(source, {
      failures,
      until:
        failures > this.freeAttempts
          ? now +
            Math.min(
              1000 * 2 ** (failures - this.freeAttempts - 1),
              this.maximumWaitMs,
            )
          : 0,
      lastAt: now,
    });
    return 0;
  }

  succeed(source: string): void {
    this.entries.delete(source);
  }

  private trim(now: number): void {
    for (const [key, entry] of this.entries)
      if (entry.lastAt + this.forgetAfterMs <= now) this.entries.delete(key);
    // Still full: the oldest go first.
    for (const key of this.entries.keys()) {
      if (this.entries.size < this.maximumEntries) break;
      this.entries.delete(key);
    }
  }
}
