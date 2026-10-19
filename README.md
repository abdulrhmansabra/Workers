# AI Shorts Backend — Cloudflare Worker

Backend server for AI Shorts app built on Cloudflare Workers with Firebase Authentication, Cloud Firestore, Crun.ai, R2, and AdMob SSV.

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /health | No | Health check |
| GET | /v1/models | No | List registered models |
| GET | /v1/templates | No | List active templates |
| GET | /v1/templates/:templateId | No | Template details |
| GET | /v1/me/balance | Firebase | Credits balance |
| POST | /v1/generations/quote | Firebase | Calculate generation price |
| POST | /v1/generations | Firebase | Create generation job |
| GET | /v1/generations/:jobId | Firebase | Job status |
| POST | /v1/uploads | Firebase | Upload file to R2 |
| GET | /v1/files/:key | Firebase | Download file (ownership checked) |
| GET/POST | /v1/admob-ssv | SSV signature | AdMob reward callback |
| POST | /v1/crun-webhook | - | Crun.ai result callback |
| POST | /v1/purchases | Firebase | Google Play purchase verification |

## Setup

```bash
npm install
wrangler secret put CRUN_API_KEY
wrangler secret put FIREBASE_SERVICE_ACCOUNT
npm test
npm run deploy
Security
No service keys in code — all secrets via wrangler secret
Firebase ID Token verification — RS256 + aud + iss + exp + sub
Server-side pricing — client never sends price
Firestore transactions — atomic credit deduction with idempotency keys
Crun.ai calls outside transaction
Refund once only — refunded flag prevents duplicates
R2 files private — access via protected Worker route with ownership check
AdMob SSV — signature verification + duplicate transaction_id prevention + daily limits
Safe logging — safeLog/safeError redact keys and tokens automatically 