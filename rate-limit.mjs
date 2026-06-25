import { createHmac } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { serviceError } from "./billing.mjs";

export const RATE_LIMITS = {
  ai: {
    user: [
      { name: "tenMinutes", limit: 10, windowSeconds: 10 * 60 },
      { name: "day", limit: 30, windowSeconds: 24 * 60 * 60 },
    ],
    ip: [
      { name: "tenMinutes", limit: 30, windowSeconds: 10 * 60 },
      { name: "day", limit: 100, windowSeconds: 24 * 60 * 60 },
    ],
  },
  image: {
    user: [{ name: "day", limit: 6, windowSeconds: 24 * 60 * 60 }],
    ip: [{ name: "day", limit: 12, windowSeconds: 24 * 60 * 60 }],
  },
};

export class RateLimitService {
  constructor({ firestore, production, secret, now = () => Date.now() }) {
    if (production && !secret) {
      throw new Error("RATE_LIMIT_HASH_SECRET is required in production.");
    }
    this.firestore = firestore;
    this.production = production;
    this.secret = secret || "development-only-rate-limit-secret";
    this.now = now;
    this.memory = new Map();
  }

  hash(value) {
    return createHmac("sha256", this.secret)
      .update(String(value))
      .digest("hex");
  }

  async consume(kind, { uid, ip }) {
    const rules = RATE_LIMITS[kind];
    if (!rules) throw new Error(`Unknown rate limit kind: ${kind}`);
    const identities = [
      ...rules.user.map((rule) => ({
        identity: this.hash(`user:${uid}`),
        type: "user",
        rule,
      })),
      ...rules.ip.map((rule) => ({
        identity: this.hash(`ip:${ip}`),
        type: "ip",
        rule,
      })),
    ];

    if (this.production || this.firestore) {
      return this.consumeFirestore(kind, identities);
    }
    return this.consumeMemory(kind, identities);
  }

  consumeMemory(kind, identities) {
    const now = this.now();
    const updates = [];
    for (const entry of identities) {
      const windowStart =
        Math.floor(now / (entry.rule.windowSeconds * 1000))
        * entry.rule.windowSeconds
        * 1000;
      const key = `${kind}:${entry.type}:${entry.identity}:${entry.rule.name}:${windowStart}`;
      const count = this.memory.get(key) || 0;
      if (count >= entry.rule.limit) {
        throw rateLimitError(
          entry.rule,
          windowStart + entry.rule.windowSeconds * 1000,
          now
        );
      }
      updates.push({ key, count: count + 1 });
    }
    for (const update of updates) this.memory.set(update.key, update.count);
  }

  async consumeFirestore(kind, identities) {
    const now = this.now();
    const records = identities.map((entry) => {
      const windowStart =
        Math.floor(now / (entry.rule.windowSeconds * 1000))
        * entry.rule.windowSeconds
        * 1000;
      const id = `${kind}-${entry.type}-${entry.rule.name}-${entry.identity}-${windowStart}`;
      return {
        ...entry,
        windowStart,
        resetAt: windowStart + entry.rule.windowSeconds * 1000,
        reference: this.firestore.collection("rateLimits").doc(id),
      };
    });

    await this.firestore.runTransaction(async (transaction) => {
      const snapshots = await Promise.all(
        records.map((record) => transaction.get(record.reference))
      );
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        const count = Number(snapshots[index].data()?.count || 0);
        if (count >= record.rule.limit) {
          throw rateLimitError(record.rule, record.resetAt, now);
        }
      }
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        const count = Number(snapshots[index].data()?.count || 0);
        transaction.set(record.reference, {
          count: count + 1,
          resetAt: new Date(record.resetAt),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    });
  }
}

function rateLimitError(rule, resetAtMillis, nowMillis) {
  const retryAfter = Math.max(1, Math.ceil((resetAtMillis - nowMillis) / 1000));
  const error = serviceError(
    429,
    "Too many requests. Try again after the retry period.",
    "rate_limit_exceeded"
  );
  error.details = {
    retryAfter,
    resetAt: new Date(resetAtMillis).toISOString(),
    limit: rule.limit,
    windowSeconds: rule.windowSeconds,
  };
  return error;
}
