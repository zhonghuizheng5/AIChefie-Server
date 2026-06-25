import assert from "node:assert/strict";
import test from "node:test";
import {
  BillingService,
  DAILY_IMAGE_LIMIT,
  localDateKey,
  nextLocalMidnight,
  validTimeZone,
} from "./billing.mjs";
import { RateLimitService } from "./rate-limit.mjs";

test("launch image allowance is three photos for every user", () => {
  assert.equal(DAILY_IMAGE_LIMIT, 3);
});

test("authentication rejects an unsigned Firebase token", async () => {
  const service = new BillingService({
    firebaseProjectID: "cooklens-ef35c",
    appleRootCADirectory: null,
  });
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsignedToken = [
    encode({ alg: "none", typ: "JWT" }),
    encode({
      aud: "cooklens-ef35c",
      iss: "https://securetoken.google.com/cooklens-ef35c",
      sub: "forged-user",
      user_id: "forged-user",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
    "",
  ].join(".");

  await assert.rejects(
    service.authenticate({
      headers: {
        authorization: `Bearer ${unsignedToken}`,
        "x-firebase-appcheck": "forged-app-check-token",
      },
    }),
    (error) =>
      error.statusCode === 401
      && error.code === "authentication_required"
  );
});

test("authentication rejects a missing App Check token before verification", async () => {
  const service = new BillingService({
    firebaseProjectID: "cooklens-ef35c",
    production: false,
  });
  await assert.rejects(
    service.authenticate({
      headers: { authorization: "Bearer token" },
    }),
    (error) =>
      error.statusCode === 401
      && error.code === "app_check_required"
  );
});

test("non-anonymous account deletion requires a recent sign-in", () => {
  const service = new BillingService({
    firebaseProjectID: "cooklens-ef35c",
    production: false,
  });
  assert.throws(
    () => service.requireRecentSignIn({
      isAnonymous: false,
      authTime: Math.floor(Date.now() / 1000) - 601,
    }),
    (error) =>
      error.statusCode === 401
      && error.code === "recent_authentication_required"
  );
  assert.doesNotThrow(() => service.requireRecentSignIn({
    isAnonymous: true,
    authTime: 0,
  }));
});

test("AI user rate limit returns structured retry timing", async () => {
  let now = Date.parse("2026-06-22T12:00:00.000Z");
  const service = new RateLimitService({
    production: false,
    secret: "test-secret",
    now: () => now,
  });
  for (let index = 0; index < 10; index += 1) {
    await service.consume("ai", { uid: "user-1", ip: "192.0.2.1" });
  }
  await assert.rejects(
    service.consume("ai", { uid: "user-1", ip: "192.0.2.1" }),
    (error) =>
      error.statusCode === 429
      && error.code === "rate_limit_exceeded"
      && error.details.retryAfter > 0
      && Boolean(error.details.resetAt)
  );
  now += 10 * 60 * 1000;
  await service.consume("ai", { uid: "user-1", ip: "192.0.2.1" });
});

test("image attempts stop after six per user per day", async () => {
  const service = new RateLimitService({
    production: false,
    secret: "test-secret",
    now: () => Date.parse("2026-06-22T12:00:00.000Z"),
  });
  for (let index = 0; index < 6; index += 1) {
    await service.consume("image", { uid: "user-1", ip: `192.0.2.${index}` });
  }
  await assert.rejects(
    service.consume("image", { uid: "user-1", ip: "192.0.2.99" }),
    (error) =>
      error.statusCode === 429
      && error.code === "rate_limit_exceeded"
  );
});

test("validTimeZone accepts IANA zones and rejects invalid values", () => {
  assert.equal(validTimeZone("America/New_York"), true);
  assert.equal(validTimeZone("Asia/Tokyo"), true);
  assert.equal(validTimeZone("not/a-zone"), false);
  assert.equal(validTimeZone(""), false);
});

test("localDateKey uses the user's local calendar date", () => {
  const instant = new Date("2026-06-11T02:30:00.000Z");

  assert.equal(localDateKey(instant, "America/New_York"), "2026-06-10");
  assert.equal(localDateKey(instant, "Asia/Tokyo"), "2026-06-11");
});

test("nextLocalMidnight handles the spring daylight-saving transition", () => {
  const instant = new Date("2026-03-08T05:30:00.000Z");

  assert.equal(
    nextLocalMidnight(instant, "America/New_York").toISOString(),
    "2026-03-09T04:00:00.000Z"
  );
});

test("nextLocalMidnight handles the fall daylight-saving transition", () => {
  const instant = new Date("2026-11-01T04:30:00.000Z");

  assert.equal(
    nextLocalMidnight(instant, "America/New_York").toISOString(),
    "2026-11-02T05:00:00.000Z"
  );
});
