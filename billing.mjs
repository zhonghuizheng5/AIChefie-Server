import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  Environment,
  SignedDataVerifier,
} from "@apple/app-store-server-library";
import {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
} from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import {
  FieldValue,
  Timestamp,
  getFirestore,
} from "firebase-admin/firestore";

const PREMIUM_PRODUCT_ID = "com.zhonghuizheng.CookLens.premium.monthly";
const TIME_ZONE_CHANGE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const RESERVATION_TIMEOUT_MS = 10 * 60 * 1000;

export class BillingService {
  constructor(config) {
    this.config = config;
    this.memory = new MemoryBillingStore();
    this.firebase = initializeFirebase(config);
    this.appleVerifiers = createAppleVerifiers(config);
  }

  async authenticate(request) {
    const authorization = request.headers.authorization || "";
    const token = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : "";
    if (!token) {
      throw billingError(401, "Sign in is required.", "authentication_required");
    }

    try {
      const decoded = await this.firebase.auth.verifyIdToken(token);
      return { uid: decoded.uid };
    } catch {
      throw billingError(
        401,
        "Your CookLens sign-in session could not be verified.",
        "authentication_required"
      );
    }
  }

  async status(uid, requestedTimeZone) {
    const timeZone = await this.resolveTimeZone(uid, requestedTimeZone);
    const entitlement = await this.entitlement(uid);
    return this.usageStore().status(uid, entitlement.tier, timeZone);
  }

  async reserveImage(uid, requestedTimeZone) {
    const timeZone = await this.resolveTimeZone(uid, requestedTimeZone);
    const entitlement = await this.entitlement(uid);
    return this.usageStore().reserve(uid, entitlement.tier, timeZone);
  }

  async finishImage(reservation, success, costUSD = 0) {
    await this.usageStore().finish(reservation, success, costUSD);
    return this.usageStore().status(
      reservation.uid,
      reservation.tier,
      reservation.timeZone
    );
  }

  async syncSignedTransaction(uid, signedTransaction) {
    const transaction = await this.verifyTransaction(signedTransaction);
    if (transaction.productId !== PREMIUM_PRODUCT_ID) {
      throw billingError(400, "This purchase is not a CookLens Premium subscription.");
    }
    if (!transaction.originalTransactionId) {
      throw billingError(400, "The App Store transaction is missing its original identifier.");
    }

    await this.bindTransaction(uid, transaction);
    return this.status(uid, "UTC");
  }

  async processNotification(signedPayload) {
    const { verifier, notification } = await this.verifyNotification(signedPayload);
    const signedTransaction = notification.data?.signedTransactionInfo;
    if (!signedTransaction) {
      return { ok: true, ignored: true };
    }

    const transaction = await verifier.verifyAndDecodeTransaction(signedTransaction);
    const originalTransactionId = transaction.originalTransactionId;
    if (!originalTransactionId) {
      return { ok: true, ignored: true };
    }

    const binding = await this.transactionBinding(originalTransactionId);
    if (!binding?.uid) {
      return { ok: true, ignored: true };
    }

    await this.bindTransaction(binding.uid, transaction, { allowExistingBinding: true });
    return { ok: true };
  }

  usageStore() {
    return this.firebase.hasAdminCredentials ? this.firebaseStore() : this.memory;
  }

  firebaseStore() {
    if (!this._firebaseStore) {
      this._firebaseStore = new FirestoreBillingStore(this.firebase.firestore);
    }
    return this._firebaseStore;
  }

  async entitlement(uid) {
    if (!this.firebase.hasAdminCredentials) {
      return this.memory.entitlement(uid);
    }

    const snapshot = await this.firebase.firestore.doc(`billing/${uid}`).get();
    const data = snapshot.data() || {};
    const expiresAt = timestampMillis(data.expiresAt);
    const active =
      data.status === "active"
      && expiresAt !== null
      && expiresAt > Date.now();
    return {
      tier: active ? "premium" : "free",
      expiresAt,
    };
  }

  async resolveTimeZone(uid, requestedTimeZone) {
    const candidate = validTimeZone(requestedTimeZone) ? requestedTimeZone : "UTC";
    if (!this.firebase.hasAdminCredentials) {
      return this.memory.resolveTimeZone(uid, candidate);
    }

    const profileRef = this.firebase.firestore.doc(`imageUsage/${uid}`);
    return this.firebase.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(profileRef);
      const data = snapshot.data() || {};
      const current = validTimeZone(data.timeZone) ? data.timeZone : null;
      const changedAt = timestampMillis(data.timeZoneUpdatedAt) || 0;

      if (!current) {
        transaction.set(
          profileRef,
          {
            timeZone: candidate,
            timeZoneUpdatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        return candidate;
      }

      if (current === candidate) {
        return current;
      }

      if (Date.now() - changedAt < TIME_ZONE_CHANGE_COOLDOWN_MS) {
        return current;
      }

      transaction.set(
        profileRef,
        {
          timeZone: candidate,
          timeZoneUpdatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      return candidate;
    });
  }

  async verifyTransaction(signedTransaction) {
    let lastError;
    for (const verifier of this.appleVerifiers) {
      try {
        return await verifier.verifyAndDecodeTransaction(signedTransaction);
      } catch (error) {
        lastError = error;
      }
    }
    throw billingError(
      400,
      `The App Store transaction could not be verified${lastError ? `: ${lastError.message}` : "."}`
    );
  }

  async verifyNotification(signedPayload) {
    let lastError;
    for (const verifier of this.appleVerifiers) {
      try {
        return {
          verifier,
          notification: await verifier.verifyAndDecodeNotification(signedPayload),
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw billingError(
      400,
      `The App Store notification could not be verified${lastError ? `: ${lastError.message}` : "."}`
    );
  }

  async bindTransaction(uid, transaction, options = {}) {
    const originalTransactionId = transaction.originalTransactionId;
    const expiresAt = Number(transaction.expiresDate || 0);
    const active =
      transaction.revocationDate == null
      && expiresAt > Date.now();

    if (!this.firebase.hasAdminCredentials) {
      this.memory.bindTransaction(uid, originalTransactionId, active, expiresAt);
      return;
    }

    const bindingRef = this.firebase.firestore.doc(
      `appleTransactions/${originalTransactionId}`
    );
    const billingRef = this.firebase.firestore.doc(`billing/${uid}`);
    await this.firebase.firestore.runTransaction(async (firestoreTransaction) => {
      const bindingSnapshot = await firestoreTransaction.get(bindingRef);
      const existingUID = bindingSnapshot.data()?.uid;
      if (existingUID && existingUID !== uid) {
        throw billingError(
          409,
          "This App Store subscription is already connected to another CookLens account."
        );
      }
      if (!existingUID || options.allowExistingBinding) {
        firestoreTransaction.set(
          bindingRef,
          {
            uid,
            productID: transaction.productId,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }
      firestoreTransaction.set(
        billingRef,
        {
          tier: active ? "premium" : "free",
          status: active ? "active" : "expired",
          productID: transaction.productId,
          originalTransactionID: originalTransactionId,
          expiresAt: expiresAt ? Timestamp.fromMillis(expiresAt) : null,
          environment: transaction.environment || null,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    });
  }

  async transactionBinding(originalTransactionId) {
    if (!this.firebase.hasAdminCredentials) {
      return this.memory.transactionBinding(originalTransactionId);
    }
    const snapshot = await this.firebase.firestore
      .doc(`appleTransactions/${originalTransactionId}`)
      .get();
    return snapshot.data() || null;
  }
}

class FirestoreBillingStore {
  constructor(firestore) {
    this.firestore = firestore;
  }

  async status(uid, tier, timeZone) {
    const now = new Date();
    const dateKey = localDateKey(now, timeZone);
    const snapshot = await this.firestore
      .doc(`imageUsage/${uid}/days/${dateKey}`)
      .get();
    const usedCount = Number(snapshot.data()?.usedCount || 0);
    const dailyLimit = limitForTier(tier);
    return statusPayload(tier, dailyLimit, usedCount, timeZone, now);
  }

  async reserve(uid, tier, timeZone) {
    const now = new Date();
    const dateKey = localDateKey(now, timeZone);
    const dailyRef = this.firestore.doc(`imageUsage/${uid}/days/${dateKey}`);
    const reservationID = crypto.randomUUID();

    await this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(dailyRef);
      const data = snapshot.data() || {};
      const usedCount = Number(data.usedCount || 0);
      const reservations = activeReservations(data.reservations, now.getTime());
      const dailyLimit = limitForTier(tier);

      if (usedCount + Object.keys(reservations).length >= dailyLimit) {
        throw quotaError(
          statusPayload(tier, dailyLimit, usedCount, timeZone, now)
        );
      }

      reservations[reservationID] = now.toISOString();
      transaction.set(
        dailyRef,
        {
          tier,
          timeZone,
          usedCount,
          reservations,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    });

    return { uid, tier, timeZone, dateKey, reservationID };
  }

  async finish(reservation, success, costUSD) {
    const dailyRef = this.firestore.doc(
      `imageUsage/${reservation.uid}/days/${reservation.dateKey}`
    );
    await this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(dailyRef);
      const data = snapshot.data() || {};
      const reservations = { ...(data.reservations || {}) };
      if (!reservations[reservation.reservationID]) {
        return;
      }
      delete reservations[reservation.reservationID];

      const update = {
        reservations,
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (success) {
        update.usedCount = Number(data.usedCount || 0) + 1;
        update.successfulCostUSD = Number(data.successfulCostUSD || 0) + Number(costUSD || 0);
      }
      transaction.set(dailyRef, update, { merge: true });
    });
  }
}

class MemoryBillingStore {
  constructor() {
    this.users = new Map();
    this.bindings = new Map();
  }

  user(uid) {
    if (!this.users.has(uid)) {
      this.users.set(uid, {
        tier: "free",
        expiresAt: null,
        timeZone: "UTC",
        timeZoneUpdatedAt: 0,
        days: new Map(),
      });
    }
    return this.users.get(uid);
  }

  entitlement(uid) {
    const user = this.user(uid);
    const active = user.tier === "premium" && user.expiresAt > Date.now();
    return { tier: active ? "premium" : "free", expiresAt: user.expiresAt };
  }

  resolveTimeZone(uid, candidate) {
    const user = this.user(uid);
    if (user.timeZone === candidate) {
      return candidate;
    }
    if (Date.now() - user.timeZoneUpdatedAt < TIME_ZONE_CHANGE_COOLDOWN_MS) {
      return user.timeZone;
    }
    user.timeZone = candidate;
    user.timeZoneUpdatedAt = Date.now();
    return candidate;
  }

  status(uid, tier, timeZone) {
    const now = new Date();
    const day = this.day(uid, localDateKey(now, timeZone));
    return statusPayload(tier, limitForTier(tier), day.usedCount, timeZone, now);
  }

  reserve(uid, tier, timeZone) {
    const now = new Date();
    const dateKey = localDateKey(now, timeZone);
    const day = this.day(uid, dateKey);
    day.reservations = activeReservations(day.reservations, now.getTime());
    const dailyLimit = limitForTier(tier);
    if (day.usedCount + Object.keys(day.reservations).length >= dailyLimit) {
      throw quotaError(statusPayload(tier, dailyLimit, day.usedCount, timeZone, now));
    }
    const reservationID = crypto.randomUUID();
    day.reservations[reservationID] = now.toISOString();
    return { uid, tier, timeZone, dateKey, reservationID };
  }

  finish(reservation, success, costUSD) {
    const day = this.day(reservation.uid, reservation.dateKey);
    if (!day.reservations[reservation.reservationID]) {
      return;
    }
    delete day.reservations[reservation.reservationID];
    if (success) {
      day.usedCount += 1;
      day.successfulCostUSD += Number(costUSD || 0);
    }
  }

  bindTransaction(uid, originalTransactionId, active, expiresAt) {
    const existingUID = this.bindings.get(originalTransactionId);
    if (existingUID && existingUID !== uid) {
      throw billingError(
        409,
        "This App Store subscription is already connected to another CookLens account."
      );
    }
    this.bindings.set(originalTransactionId, uid);
    const user = this.user(uid);
    user.tier = active ? "premium" : "free";
    user.expiresAt = expiresAt;
  }

  transactionBinding(originalTransactionId) {
    const uid = this.bindings.get(originalTransactionId);
    return uid ? { uid } : null;
  }

  day(uid, dateKey) {
    const user = this.user(uid);
    if (!user.days.has(dateKey)) {
      user.days.set(dateKey, {
        usedCount: 0,
        successfulCostUSD: 0,
        reservations: {},
      });
    }
    return user.days.get(dateKey);
  }
}

function initializeFirebase(config) {
  let credential;
  let hasAdminCredentials = false;

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    credential = cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
    hasAdminCredentials = true;
  } else {
    credential = applicationDefault();
    hasAdminCredentials = Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  }

  const app = getApps()[0] || initializeApp({
    credential,
    projectId: config.firebaseProjectID,
  });
  return {
    auth: getAuth(app),
    firestore: getFirestore(app),
    hasAdminCredentials,
  };
}

function createAppleVerifiers(config) {
  if (!config.appleRootCADirectory) {
    return [];
  }

  const roots = readdirSync(config.appleRootCADirectory)
    .filter((name) => name.endsWith(".cer"))
    .map((name) => readFileSync(join(config.appleRootCADirectory, name)));
  if (roots.length === 0) {
    return [];
  }

  return [
    new SignedDataVerifier(
      roots,
      true,
      Environment.PRODUCTION,
      config.bundleID,
      config.appAppleID || undefined
    ),
    new SignedDataVerifier(
      roots,
      true,
      Environment.SANDBOX,
      config.bundleID
    ),
  ];
}

function activeReservations(value, nowMillis) {
  const reservations = value && typeof value === "object" ? { ...value } : {};
  for (const [key, timestamp] of Object.entries(reservations)) {
    const createdAt = Date.parse(timestamp);
    if (!Number.isFinite(createdAt) || nowMillis - createdAt > RESERVATION_TIMEOUT_MS) {
      delete reservations[key];
    }
  }
  return reservations;
}

function limitForTier(tier) {
  return tier === "premium" ? 10 : 1;
}

function statusPayload(tier, dailyLimit, usedCount, timeZone, now) {
  return {
    tier,
    dailyLimit,
    remainingToday: Math.max(0, dailyLimit - usedCount),
    resetAt: nextLocalMidnight(now, timeZone).toISOString(),
  };
}

function quotaError(status) {
  const error = billingError(
    429,
    status.tier === "premium"
      ? "You have used today’s Premium picture allowance."
      : "Your free picture for today has already been used.",
    "image_quota_exceeded"
  );
  error.details = status;
  return error;
}

function billingError(statusCode, message, code = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) {
    error.code = code;
  }
  return error;
}

function timestampMillis(value) {
  if (!value) {
    return null;
  }
  if (typeof value.toMillis === "function") {
    return value.toMillis();
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function validTimeZone(value) {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function localDateKey(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function nextLocalMidnight(date, timeZone) {
  const currentKey = localDateKey(date, timeZone);
  let lower = date.getTime();
  let upper = lower + 60 * 60 * 1000;

  while (localDateKey(new Date(upper), timeZone) === currentKey) {
    lower = upper;
    upper += 60 * 60 * 1000;
  }

  while (upper - lower > 1000) {
    const midpoint = Math.floor((lower + upper) / 2);
    if (localDateKey(new Date(midpoint), timeZone) === currentKey) {
      lower = midpoint;
    } else {
      upper = midpoint;
    }
  }
  return new Date(upper);
}

export { PREMIUM_PRODUCT_ID };
