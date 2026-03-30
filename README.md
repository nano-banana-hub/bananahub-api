# bananahub-api

Cloudflare Worker for BananaHub install count tracking and discovered-template intake.

## Endpoints

### POST /api/installs

Record a template install event.

```json
{
  "repo": "user/repo",
  "template_id": "cyberpunk-city",
  "template_path": "references/templates/cyberpunk-city",
  "install_target": "user/repo/cyberpunk-city",
  "cli_version": "0.1.0",
  "timestamp": "2026-03-25T12:00:00Z"
}
```

Besides incrementing install counters, this endpoint also upserts a discovered-template candidate keyed by `repo + template_id`.

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

### GET /api/discovered

List discovered template candidates inferred from real install events.

| Parameter | Default | Description                     |
|-----------|---------|----------------------------------|
| `limit`   | `200`   | Max results (1-1000)             |

Returns `{ "total": N, "items": [...] }`.

## KV Key Schema

Namespace binding: `INSTALLS`

| Key pattern                                | Purpose              | TTL     |
|--------------------------------------------|----------------------|---------|
| `count:{repo}:{template_id}`               | Per-template total   | none    |
| `repo-count:{repo}`                        | Repo aggregate       | none    |
| `daily:{YYYY-MM-DD}:{repo}:{template_id}`  | Trending data        | 7 days  |
| `discovered:{repo}:{template_id}`          | Discovered metadata  | none    |
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
