# CookLens Server

Local OpenRouter proxy for the CookLens iOS MVP.

## Start

```bash
cd /Users/huizheng/Documents/CookLens/CookLensServer
npm start
```

You can also double-click `start.command` in this folder. Keep that Terminal
window open while testing the app.

For this Mac, Codex also installed a background LaunchAgent:

```text
/Users/huizheng/Library/LaunchAgents/com.cooklens.server.plist
```

It starts the server in the background and writes logs to:

```text
/tmp/cooklens-server.log
/tmp/cooklens-server.err.log
```

CookLens uses separate endpoints so recipe text survives image failures:

```text
POST /api/analyze
POST /api/recipes
POST /api/dish-image
```

`/api/generate` remains available for compatibility, but the iOS app now saves
the two recipe choices before requesting each validated picture.

The real iPhone must call the Mac's network URL instead of `127.0.0.1`. The server prints that URL when it starts.
The server also publishes `_cooklens._tcp.local.` over Bonjour, so the iPhone app
can find the Mac automatically even when its Wi-Fi IP address changes.

Every response includes an `X-Request-ID` header and a `requestID` JSON field.
Server logs use the same ID for each OpenRouter stage, including model, attempt,
latency, finish reason, and reported cost.

## Config

Create `.env` from `.env.example` and set:

```text
OPENROUTER_API_KEY=...
OPENROUTER_ANALYSIS_MODEL=google/gemini-3.1-pro-preview
OPENROUTER_RECIPE_MODEL=google/gemini-3.1-flash-lite
OPENROUTER_REVIEW_MODEL=google/gemini-3.1-pro-preview
OPENROUTER_SECOND_OPINION_MODEL=openai/gpt-5.4-mini
OPENROUTER_PRIMARY_IMAGE_MODEL=black-forest-labs/flux.2-klein-4b
OPENROUTER_FALLBACK_IMAGE_MODEL=bytedance-seed/seedream-4.5
PORT=8787
```

Do not commit `.env`.
