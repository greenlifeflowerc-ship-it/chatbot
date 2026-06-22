# Backend — the bot

Node 20+ / TypeScript / Fastify. Receives Instagram webhooks, runs RAG, sends
replies via the Graph API, and exposes authenticated endpoints for the agent
dashboard. All bot logic lives here; the Flutter app contains none.

## Run locally

```bash
cp .env.example .env        # fill in the values
npm install
npm run dev                 # tsx watch, loads .env
```

Other scripts:

| Script | What it does |
|---|---|
| `npm start` | Production start (`tsx src/server.ts`, reads process env) |
| `npm run typecheck` | `tsc --noEmit`, strict |
| `npm run lint` | ESLint |
| `npm test` | Vitest unit + server-inject tests |
| `npm run seed -- ./scripts/sample-faq.md "Sample FAQ"` | Ingest a document into the KB |
| `npm run refresh-token` | Refresh the long-lived Instagram token (see below) |

## Layout

```
src/
  config/env.ts            zod-validated env, fail fast at startup
  app.ts                   Fastify factory (injectable for tests)
  server.ts                bootstrap: listen + graceful shutdown
  routes/
    webhook.ts             GET verify + POST receive (signature, 200, dedupe, enqueue)
    health.ts              /health → tiny Supabase read (keep-alive)
    agent.ts               authenticated dashboard actions (JWT verified)
  services/
    instagram/             signature, payload parse, Graph API client
    rag/                   ingest, retrieve, generate
    llm/ embeddings/       provider interfaces + Anthropic / OpenAI impls
    conversation/store.ts  customer/conversation/message upserts + state transitions
    handover/escalate.ts   escalation rules
  workers/
    processEvent.ts        async pipeline for one webhook event
    runtime.ts             shared in-process queue
  lib/                     supabase, logger, errors, retry, queue, limiters, auth, vector
```

## Request flow

1. `POST /webhook` verifies `X-Hub-Signature-256` (constant-time HMAC over the
   raw body), returns `200` immediately, dedupes by message id into
   `webhook_events`, and enqueues new events.
2. `processEvent` (off the request path) upserts customer/conversation/message,
   and if the conversation is bot-handled: embeds → `match_chunks` → generates a
   grounded answer with a can-answer signal → decides escalation (keyword /
   model-deferred / low-confidence) → sends via the Graph API or escalates to a
   human and writes a handover.

## Reliability

- Every external input validated with zod; malformed payloads rejected cleanly.
- Idempotent webhook processing (`webhook_events.event_key` unique) prevents
  duplicate replies on Meta redelivery.
- The worker isolates failures: one bad event is caught, logged with a
  correlation id, recorded on the event row, and never crashes the process or
  blocks siblings.
- Exponential backoff (capped, jittered) on all LLM, embedding, and Graph calls;
  a concurrency limiter on LLM calls.
- Structured pino logs; secrets and message bodies redacted.
- `config/env.ts` validates all env at boot and exits with a clear message if
  anything is missing.

## Instagram token refresh

Long-lived Instagram tokens last ~60 days. Run `npm run refresh-token` on a
schedule (e.g. monthly) and update `IG_ACCESS_TOKEN` in the deployment
environment with the printed value. The script calls
`GET {GRAPH_BASE}/refresh_access_token?grant_type=ig_refresh_token`.

## Deploy (Render)

`render.yaml` is a Blueprint: it typechecks on build, runs `npm start`, and
health-checks `/health`. Set the `sync: false` secrets in the Render dashboard.
Then register the webhook URL + verify token in the Meta app and subscribe to the
`messages` field. Point UptimeRobot at `/health` every 5 minutes to keep the free
service and the Supabase project warm.

## Database

This server expects the Supabase schema (Postgres + pgvector) — tables,
`match_chunks`, RLS, and Realtime on `conversations` + `messages`. That schema and
the Flutter agent dashboard live outside this repo.
