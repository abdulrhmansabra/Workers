# Deployment Guide — AI Shorts Backend

Prerequisites
Firebase
Create Firebase project, enable Authentication and Firestore
Download service account key (Project Settings > Service Accounts > Generate New Private Key)
Apply firestore.rules and firestore.indexes.json
Create templates in Firestore (see firestore-seed.example.json)
Create settings/ad_rewards document
Cloudflare
Create R2 bucket: wrangler r2 bucket create ai-shorts-media
Create KV namespace: wrangler kv namespace create KV_CACHE
Set secrets: wrangler secret put CRUN_API_KEY and wrangler secret put FIREBASE_SERVICE_ACCOUNT
Update wrangler.toml with FIREBASE_PROJECT_ID and KV namespace id
Crun.ai
Get API key from Crun.ai dashboard
Review Crun.ai API docs for endpoints, auth, request/response schemas
Implement model adapter in src/crun.ts (uncomment VideoGenAdapter)
Call registerModel() in initModels() after verification
Deploy
npm install
npm test
npm run typecheck
npm run deploy
Test after deploy
curl [https://your-worker.workers.dev/health](https://your-worker.workers.dev/health)
curl -H "Authorization: Bearer <FIREBASE_ID_TOKEN>" [https://your-worker.workers.dev/v1/me/balance](https://your-worker.workers.dev/v1/me/balance)
