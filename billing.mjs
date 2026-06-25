import { randomUUID } from "node:crypto";
import {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
} from "firebase-admin/app";
import { getAppCheck } from "firebase-admin/app-check";
import { getAuth } from "firebase-admin/auth";
import {
  FieldValue,
  getFirestore,
} from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

export const DAILY_IMAGE_LIMIT = 3;

const TIME_ZONE_CHANGE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const RESERVATION_TIMEOUT_MS = 10 * 60 * 1000;
const RECENT_SIGN_IN_SECONDS = 10 * 60;

export class BillingService {
  constructor(config, dependencies = {}) {
    this.production = Boolean(config.production);
    this.memory = new MemoryBillingStore();
    this.firebase = dependencies.firebase || initializeFirebase(config);

    if (this.production && !this.firebase.hasAdminCredentials) {
      throw new Error(
        "Firebase Admin credentials are required in production. "
        + "Set FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS."
      );
    }
  }

  async authenticate(request) {
    const authorization = request.headers.authorization || "";
    const idToken = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : "";
    const appCheckToken = String(
      request.headers["x-firebase-appcheck"] || ""
    ).trim();

    if (!idToken) {
      throw serviceError(401, "Sign in is required.", "authentication_required");
    }
    if (!appCheckToken) {
      throw serviceError(401, "App verification is required.", "app_check_required");
    }

    try {
      const [decoded, appCheck] = await Promise.all([
        this.firebase.auth.verifyIdToken(idToken),
        this.firebase.appCheck.verifyToken(appCheckToken),
      ]);
      return {
        uid: decoded.uid,
        isAnonymous:
          decoded.firebase?.sign_in_provider === "anonymous",
        authTime: Number(decoded.auth_time || 0),
        appID: appCheck.appId,
      };
    } catch {
      throw serviceError(
        401,
        "Your AIChefie session or app verification could not be verified.",
        "authentication_required"
      );
    }
  }

  async verifyAnonymousIDToken(idToken, targetUID) {
    try {
      const decoded = await this.firebase.auth.verifyIdToken(idToken);
      if (
        decoded.uid === targetUID
        || decoded.firebase?.sign_in_provider !== "anonymous"
      ) {
        throw new Error("Token is not an obsolete anonymous account.");
      }
      return decoded.uid;
    } catch {
      throw serviceError(
        400,
        "The anonymous account could not be verified.",
        "invalid_anonymous_account"
      );
    }
  }

  requireRecentSignIn(user, nowSeconds = Math.floor(Date.now() / 1000)) {
    if (user.isAnonymous) return;
    if (!user.authTime || nowSeconds - user.authTime > RECENT_SIGN_IN_SECONDS) {
      throw serviceError(
        401,
        "Sign in again before permanently deleting this account.",
        "recent_authentication_required"
      );
    }
  }

  async deleteObsoleteAnonymousAccount(uid) {
    await this.deleteUserData(uid, { deleteAuthUser: true });
  }

  async deleteAccount(user) {
    this.requireRecentSignIn(user);
    await this.deleteUserData(user.uid, { deleteAuthUser: true });
  }

  async deleteUserData(uid, { deleteAuthUser }) {
    if (!this.firebase.hasAdminCredentials && !this.production) {
      this.memory.deleteUser(uid);
      return;
    }

    const firestore = this.firebase.firestore;
    await deleteDocumentTree(firestore, `users/${uid}`);
    await deleteStoragePrefix(this.firebase.storage, `users/${uid}/`);
    await Promise.all([
      deleteDocumentTree(firestore, `imageUsage/${uid}`),
      deleteDocumentTree(firestore, `billing/${uid}`),
      deleteLegacyTransactions(firestore, uid),
    ]);

    if (deleteAuthUser) {
      try {
        await this.firebase.auth.deleteUser(uid);
      } catch (error) {
        if (error?.code !== "auth/user-not-found") throw error;
      }
    }
  }

  async status(uid, requestedTimeZone) {
    const timeZone = await this.resolveTimeZone(uid, requestedTimeZone);
    return this.usageStore().status(uid, timeZone);
  }

  async reserveImage(uid, requestedTimeZone) {
    const timeZone = await this.resolveTimeZone(uid, requestedTimeZone);
    return this.usageStore().reserve(uid, timeZone);
  }

  async finishImage(reservation, success, costUSD = 0) {
    await this.usageStore().finish(reservation, success, costUSD);
    return this.usageStore().status(reservation.uid, reservation.timeZone);
  }

  usageStore() {
    if (this.firebase.hasAdminCredentials) return this.firebaseStore();
    if (this.production) {
      throw new Error("In-memory quota storage is disabled in production.");
    }
    return this.memory;
  }

  firebaseStore() {
    if (!this._firebaseStore) {
      this._firebaseStore = new FirestoreBillingStore(this.firebase.firestore);
    }
    return this._firebaseStore;
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
        transaction.set(profileRef, {
          timeZone: candidate,
          timeZoneUpdatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        return candidate;
      }
      if (current === candidate) return current;
      if (Date.now() - changedAt < TIME_ZONE_CHANGE_COOLDOWN_MS) return current;

      transaction.set(profileRef, {
        timeZone: candidate,
        timeZoneUpdatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return candidate;
    });
  }
}

class FirestoreBillingStore {
  constructor(firestore) {
    this.firestore = firestore;
  }

  async status(uid, timeZone) {
    const now = new Date();
    const dateKey = localDateKey(now, timeZone);
    const snapshot = await this.firestore
      .doc(`imageUsage/${uid}/days/${dateKey}`)
      .get();
    return statusPayload(Number(snapshot.data()?.usedCount || 0), timeZone, now);
  }

  async reserve(uid, timeZone) {
    const now = new Date();
    const dateKey = localDateKey(now, timeZone);
    const dailyRef = this.firestore.doc(`imageUsage/${uid}/days/${dateKey}`);
    const reservationID = randomUUID();

    await this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(dailyRef);
      const data = snapshot.data() || {};
      const usedCount = Number(data.usedCount || 0);
      const reservations = activeReservations(data.reservations, now.getTime());
      if (usedCount + Object.keys(reservations).length >= DAILY_IMAGE_LIMIT) {
        throw quotaError(statusPayload(usedCount, timeZone, now));
      }
      reservations[reservationID] = now.toISOString();
      transaction.set(dailyRef, {
        timeZone,
        usedCount,
        reservations,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });

    return { uid, timeZone, dateKey, reservationID };
  }

  async finish(reservation, success, costUSD) {
    const dailyRef = this.firestore.doc(
      `imageUsage/${reservation.uid}/days/${reservation.dateKey}`
    );
    await this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(dailyRef);
      const data = snapshot.data() || {};
      const reservations = { ...(data.reservations || {}) };
      if (!reservations[reservation.reservationID]) return;
      delete reservations[reservation.reservationID];
      const update = {
        reservations,
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (success) {
        update.usedCount = Number(data.usedCount || 0) + 1;
        update.successfulCostUSD =
          Number(data.successfulCostUSD || 0) + Number(costUSD || 0);
      }
      transaction.set(dailyRef, update, { merge: true });
    });
  }
}

class MemoryBillingStore {
  constructor() {
    this.users = new Map();
  }

  deleteUser(uid) {
    this.users.delete(uid);
  }

  user(uid) {
    if (!this.users.has(uid)) {
      this.users.set(uid, {
        timeZone: "UTC",
        timeZoneUpdatedAt: 0,
        days: new Map(),
      });
    }
    return this.users.get(uid);
  }

  resolveTimeZone(uid, candidate) {
    const user = this.user(uid);
    if (user.timeZone === candidate) return candidate;
    if (Date.now() - user.timeZoneUpdatedAt < TIME_ZONE_CHANGE_COOLDOWN_MS) {
      return user.timeZone;
    }
    user.timeZone = candidate;
    user.timeZoneUpdatedAt = Date.now();
    return candidate;
  }

  status(uid, timeZone) {
    const now = new Date();
    return statusPayload(
      this.day(uid, localDateKey(now, timeZone)).usedCount,
      timeZone,
      now
    );
  }

  reserve(uid, timeZone) {
    const now = new Date();
    const dateKey = localDateKey(now, timeZone);
    const day = this.day(uid, dateKey);
    day.reservations = activeReservations(day.reservations, now.getTime());
    if (day.usedCount + Object.keys(day.reservations).length >= DAILY_IMAGE_LIMIT) {
      throw quotaError(statusPayload(day.usedCount, timeZone, now));
    }
    const reservationID = randomUUID();
    day.reservations[reservationID] = now.toISOString();
    return { uid, timeZone, dateKey, reservationID };
  }

  finish(reservation, success, costUSD) {
    const day = this.day(reservation.uid, reservation.dateKey);
    if (!day.reservations[reservation.reservationID]) return;
    delete day.reservations[reservation.reservationID];
    if (success) {
      day.usedCount += 1;
      day.successfulCostUSD += Number(costUSD || 0);
    }
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
    storageBucket:
      process.env.FIREBASE_STORAGE_BUCKET
      || `${config.firebaseProjectID}.firebasestorage.app`,
  });
  return {
    auth: getAuth(app),
    appCheck: getAppCheck(app),
    firestore: getFirestore(app),
    storage: getStorage(app),
    hasAdminCredentials,
  };
}

async function deleteDocumentTree(firestore, path) {
  const reference = firestore.doc(path);
  try {
    await firestore.recursiveDelete(reference);
  } catch (error) {
    if (error?.code !== 5) throw error;
  }
}

async function deleteLegacyTransactions(firestore, uid) {
  const snapshot = await firestore
    .collection("appleTransactions")
    .where("uid", "==", uid)
    .get();
  if (snapshot.empty) return;
  const batch = firestore.batch();
  for (const document of snapshot.docs) batch.delete(document.ref);
  await batch.commit();
}

async function deleteStoragePrefix(storage, prefix) {
  try {
    await storage.bucket().deleteFiles({ prefix, force: true });
  } catch (error) {
    if (error?.code !== 404) throw error;
  }
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

function statusPayload(usedCount, timeZone, now) {
  return {
    dailyLimit: DAILY_IMAGE_LIMIT,
    remainingToday: Math.max(0, DAILY_IMAGE_LIMIT - usedCount),
    resetAt: nextLocalMidnight(now, timeZone).toISOString(),
  };
}

function quotaError(status) {
  const error = serviceError(
    429,
    `You have used today’s ${DAILY_IMAGE_LIMIT} AI dish photos.`,
    "image_quota_exceeded"
  );
  error.details = status;
  return error;
}

export function serviceError(statusCode, message, code = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

function timestampMillis(value) {
  if (!value) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function validTimeZone(value) {
  if (typeof value !== "string" || !value.trim()) return false;
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
