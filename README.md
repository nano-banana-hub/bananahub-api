# bananahub-api

Cloudflare Worker for BananaHub install count tracking.

## Endpoints

### POST /api/installs

Record a template install event.

```json
{
  "repo": "user/repo",
  "template_id": "cyberpunk-city",
  "cli_version": "0.1.0",
  "timestamp": "2026-03-25T12:00:00Z"
}
```

Rate limited to 10 writes/min per IP. Returns `{ "ok": true }` on success or 429 when rate limited.

### GET /api/stats

Query install counts.

| Parameter     | Required | Description                    |
|---------------|----------|--------------------------------|
| `repo`        | yes      | Repository in `owner/name` format |
| `template_id` | no       | Specific template to query     |

Returns `{ "repo": "...", "template_id": "...", "installs": 142 }`.

### GET /api/trending

Get trending templates.

| Parameter | Default | Description                     |
|-----------|---------|----------------------------------|
| `period`  | `24h`   | Time window: `24h` or `7d`      |
| `limit`   | `20`    | Max results (1-100)              |

Returns `{ "period": "24h", "templates": [...] }`.

## KV Key Schema

Namespace binding: `INSTALLS`

| Key pattern                                | Purpose              | TTL     |
|--------------------------------------------|----------------------|---------|
| `count:{repo}:{template_id}`               | Per-template total   | none    |
| `repo-count:{repo}`                        | Repo aggregate       | none    |
| `daily:{YYYY-MM-DD}:{repo}:{template_id}`  | Trending data        | 7 days  |
| `ratelimit:{ip}:{minute}`                  | Rate limit counter   | 120s    |

## Development

```bash
npm install
npm run dev
```

## Deployment

```bash
npm run deploy
```

Before deploying, update `wrangler.toml` with real KV namespace IDs:
```bash
npx wrangler kv namespace create INSTALLS
```
