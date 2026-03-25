/**
 * BananaHub API — Cloudflare Worker
 *
 * Install-count tracking for the BananaHub template ecosystem.
 * Uses Workers KV (namespace binding: INSTALLS) to persist counters.
 *
 * KV key schema
 * ─────────────
 *   count:{repo}:{template_id}        per-template total   (no TTL)
 *   repo-count:{repo}                 repo-level aggregate (no TTL)
 *   daily:{YYYY-MM-DD}:{repo}:{template_id}   trending    (TTL 7d)
 *   ratelimit:{ip}:{minute}           rate-limit counter   (TTL 120s)
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

/** Return the current UTC minute key for rate-limiting (e.g. "2026-03-25T14:07"). */
function minuteKey() {
  const d = new Date();
  return d.toISOString().slice(0, 16); // "YYYY-MM-DDTHH:MM"
}

/** Return today's UTC date string (YYYY-MM-DD). */
function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * POST /api/installs
 *
 * Record an install event.  Increments three KV counters and enforces a
 * per-IP rate limit of 10 writes per minute.
 */
async function handleInstalls(request, env) {
  // --- Parse & validate body ---------------------------------------------------
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const { repo, template_id } = body;

  if (!repo || typeof repo !== "string" || !repo.includes("/")) {
    return json({ error: "invalid_repo", message: "repo is required and must contain '/'" }, 400);
  }
  if (!template_id || typeof template_id !== "string") {
    return json({ error: "invalid_template_id", message: "template_id is required" }, 400);
  }

  // --- Rate limiting (10 writes/min per IP) ------------------------------------
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const rlKey = `ratelimit:${ip}:${minuteKey()}`;
  const rlRaw = await env.INSTALLS.get(rlKey);
  const rlCount = rlRaw ? parseInt(rlRaw, 10) : 0;

  if (rlCount >= 10) {
    return json({ error: "rate_limited", retry_after: 60 }, 429);
  }

  // Increment rate-limit counter (TTL 120 s keeps it short-lived)
  await env.INSTALLS.put(rlKey, String(rlCount + 1), { expirationTtl: 120 });

  // --- Increment counters ------------------------------------------------------
  const countKey = `count:${repo}:${template_id}`;
  const repoKey = `repo-count:${repo}`;
  const dailyKey = `daily:${todayUTC()}:${repo}:${template_id}`;

  // Read current values in parallel
  const [countRaw, repoCountRaw, dailyRaw] = await Promise.all([
    env.INSTALLS.get(countKey),
    env.INSTALLS.get(repoKey),
    env.INSTALLS.get(dailyKey),
  ]);

  const newCount = (countRaw ? parseInt(countRaw, 10) : 0) + 1;
  const newRepoCount = (repoCountRaw ? parseInt(repoCountRaw, 10) : 0) + 1;
  const newDaily = (dailyRaw ? parseInt(dailyRaw, 10) : 0) + 1;

  // Write updated values in parallel
  await Promise.all([
    env.INSTALLS.put(countKey, String(newCount)),
    env.INSTALLS.put(repoKey, String(newRepoCount)),
    env.INSTALLS.put(dailyKey, String(newDaily), { expirationTtl: 604800 }), // 7 days
  ]);

  return json({ ok: true });
}

/**
 * GET /api/stats?repo=...&template_id=...
 *
 * Return install counts for a repo or specific template.
 */
async function handleStats(url, env) {
  const repo = url.searchParams.get("repo");
  if (!repo) {
    return json({ error: "missing_repo", message: "repo query parameter is required" }, 400);
  }

  const templateId = url.searchParams.get("template_id");

  if (templateId) {
    const raw = await env.INSTALLS.get(`count:${repo}:${templateId}`);
    return json({
      repo,
      template_id: templateId,
      installs: raw ? parseInt(raw, 10) : 0,
    });
  }

  const raw = await env.INSTALLS.get(`repo-count:${repo}`);
  return json({
    repo,
    installs: raw ? parseInt(raw, 10) : 0,
  });
}

/**
 * GET /api/trending?period=24h|7d&limit=20
 *
 * Aggregate daily install keys and return a ranked list.
 */
async function handleTrending(url, env) {
  const period = url.searchParams.get("period") || "24h";
  let limit = parseInt(url.searchParams.get("limit") || "20", 10);
  if (isNaN(limit) || limit < 1) limit = 20;
  if (limit > 100) limit = 100;

  // Determine which dates to include
  const today = todayUTC();
  let datesToInclude;
  if (period === "7d") {
    datesToInclude = new Set();
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i);
      datesToInclude.add(d.toISOString().slice(0, 10));
    }
  } else {
    // Default to 24h — today only
    datesToInclude = new Set([today]);
  }

  // Scan daily: prefix keys via KV.list()
  // KV.list returns up to 1000 keys per call; page through if needed.
  const aggregated = {}; // "repo:template_id" -> total

  let cursor = undefined;
  let done = false;

  while (!done) {
    const listOpts = { prefix: "daily:", limit: 1000 };
    if (cursor) listOpts.cursor = cursor;

    const result = await env.INSTALLS.list(listOpts);

    for (const key of result.keys) {
      // key.name = "daily:YYYY-MM-DD:owner/repo:template_id"
      const parts = key.name.split(":");
      // parts[0] = "daily"
      // parts[1] = "YYYY-MM-DD"
      // parts[2] = "owner/repo"  (contains /)
      // parts[3] = template_id
      if (parts.length < 4) continue;

      const date = parts[1];
      if (!datesToInclude.has(date)) continue;

      const repo = parts[2];
      const templateId = parts.slice(3).join(":"); // handle template_ids with colons
      const compositeKey = `${repo}:${templateId}`;

      // We need the actual value — batch reads would be ideal but KV
      // does not support multi-get; read individually.
      if (!(compositeKey in aggregated)) {
        aggregated[compositeKey] = { repo, template_id: templateId, installs: 0 };
      }
    }

    if (result.list_complete) {
      done = true;
    } else {
      cursor = result.cursor;
    }
  }

  // Now read the actual counts for the keys we found
  const compositeKeys = Object.keys(aggregated);

  // Build a flat list of { compositeKey, dailyKvKey } for each matching date
  const readTasks = [];
  for (const ck of compositeKeys) {
    const { repo, template_id } = aggregated[ck];
    for (const date of datesToInclude) {
      readTasks.push({
        compositeKey: ck,
        kvKey: `daily:${date}:${repo}:${template_id}`,
      });
    }
  }

  // Read values in batches of 50 to avoid overwhelming KV
  const BATCH = 50;
  for (let i = 0; i < readTasks.length; i += BATCH) {
    const batch = readTasks.slice(i, i + BATCH);
    const values = await Promise.all(batch.map((t) => env.INSTALLS.get(t.kvKey)));
    for (let j = 0; j < batch.length; j++) {
      if (values[j]) {
        aggregated[batch[j].compositeKey].installs += parseInt(values[j], 10);
      }
    }
  }

  // Sort descending by installs, apply limit
  const sorted = Object.values(aggregated)
    .filter((t) => t.installs > 0)
    .sort((a, b) => b.installs - a.installs)
    .slice(0, limit);

  return json({ period, templates: sorted });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // POST /api/installs
    if (method === "POST" && pathname === "/api/installs") {
      return handleInstalls(request, env);
    }

    // GET /api/stats
    if (method === "GET" && pathname === "/api/stats") {
      return handleStats(url, env);
    }

    // GET /api/trending
    if (method === "GET" && pathname === "/api/trending") {
      return handleTrending(url, env);
    }

    return json({ error: "not_found" }, 404);
  },
};
