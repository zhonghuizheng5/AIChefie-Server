# AIChefie Server

Authenticated OpenRouter proxy for the AIChefie iOS app.

## API

`GET /health` is public. Every `/api/*` route requires both:

```text
Authorization: Bearer <Firebase ID token>
X-Firebase-AppCheck: <Firebase App Check token>
```

Current API version: 5.

```text
POST   /api/analyze
POST   /api/recipes
POST   /api/dish-image
POST   /api/generate
GET    /api/quota/status
POST   /api/account/merge-anonymous
DELETE /api/account
```

Production enforces Firebase-backed user and hashed-IP rate limits, a
three-successful-images-per-day quota, a 4 MB request limit, recent
reauthentication for permanent account deletion, and Auth/App Check validation.
In-memory quota and rate-limit state are development-only.

## Configuration

Copy `.env.example` to `.env`. Production requires:

```text
NODE_ENV=production
OPENROUTER_API_KEY=...
FIREBASE_PROJECT_ID=cooklens-ef35c
FIREBASE_STORAGE_BUCKET=cooklens-ef35c.firebasestorage.app
FIREBASE_SERVICE_ACCOUNT_JSON={...}
RATE_LIMIT_HASH_SECRET=<at least 32 random bytes>
```

`GOOGLE_APPLICATION_CREDENTIALS` may replace
`FIREBASE_SERVICE_ACCOUNT_JSON`. Production startup fails if Firebase Admin
credentials or the rate-limit hashing secret are unavailable.

Local Debug builds may use `http://127.0.0.1:8787` in the simulator or Bonjour
on a development iPhone. Release builds use only the Railway HTTPS server.

```bash
npm test
npm start
```

Logs contain request ID, endpoint, status, latency, model, cost, and a hashed
user identifier. Ingredient photos, ingredient and pantry content, cooking
notes, and AI response content are not logged.
