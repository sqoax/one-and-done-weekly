// ============================================================================
// Golf Pick'em Pool — Multi-Week Cloudflare Worker
// KV Binding: PICKS_KV
// Environment Variable: ADMIN_KEY
// ============================================================================

const POOL_MEMBERS = ["Hiatt", "Caden", "Bennett", "Ryan", "William", "Ian", "Mason", "Tim", "Drew", "Ben"];
const TOURNAMENTS = [
  "Genesis", "Genesis", "Cognizant", "API", "Players", "Valspar", "Houston", "Valero",
  "Masters", "Heritage", "Cadillac", "Truist", "PGA", "Byron Nelson", "Schwab",
  "Memorial", "Canadian", "US Open", "Travelers", "John Deere", "Scottish",
  "The Open", "3M", "Rocket", "Wyndham"
];

// ============================================================================
// Helpers
// ============================================================================

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function error(message, status = 400) {
  return json({ error: message }, status);
}

/** Get current time in ET (handles EST/EDT automatically) */
function getNowET() {
  const now = new Date();
  const etString = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const et = new Date(etString);
  return {
    day: et.getDay(),    // 0=Sun, 3=Wed
    hour: et.getHours(),
    minute: et.getMinutes(),
    iso: now.toISOString(),
  };
}

/**
 * Should we auto-reveal the current week?
 * After advanceWeek, the new week starts fresh (unlocked/unrevealed).
 * We reveal once we hit the configured day/time again.
 */
function shouldAutoReveal(settings) {
  if (!settings.autoReveal) return false;
  const now = getNowET();
  if (now.day === settings.revealDow) {
    return (now.hour > settings.revealHour) ||
           (now.hour === settings.revealHour && now.minute >= settings.revealMinute);
  }
  if (now.day > settings.revealDow) return true;
  // day < revealDow — haven't reached reveal day yet this week
  return false;
}

// ============================================================================
// KV Initialization & Lazy Creation
// ============================================================================

async function getSettings(kv) {
  let settings = await kv.get("global:settings", "json");
  if (!settings) {
    settings = {
      currentWeek: 1,
      autoReveal: true,
      revealDow: 3,       // Wednesday
      revealHour: 21,      // 9 PM ET
      revealMinute: 0,
    };
    await kv.put("global:settings", JSON.stringify(settings));
  }
  return settings;
}

async function getWeeksIndex(kv, settings) {
  let weeks = await kv.get("global:weeks", "json");
  if (!weeks) {
    weeks = [{ week: 1, tournament: TOURNAMENTS[0], status: "active" }];
    await kv.put("global:weeks", JSON.stringify(weeks));
  }
  return weeks;
}

async function getWeekMeta(kv, weekNum) {
  const key = `week:${weekNum}:meta`;
  let meta = await kv.get(key, "json");
  if (!meta) {
    const idx = weekNum - 1;
    const tournament = idx < TOURNAMENTS.length ? TOURNAMENTS[idx] : `Week ${weekNum}`;
    meta = {
      week: weekNum,
      tournament,
      locked: false,
      revealed: false,
      revealedAt: null,
      createdAt: new Date().toISOString(),
    };
    await kv.put(key, JSON.stringify(meta));
  }
  return meta;
}

async function getWeekPicks(kv, weekNum) {
  return (await kv.get(`week:${weekNum}:picks`, "json")) || {};
}

// ============================================================================
// Auto-Reveal Check (runs on every inbound request)
// ============================================================================

async function checkAutoReveal(kv) {
  const settings = await getSettings(kv);
  if (!shouldAutoReveal(settings)) return;

  const meta = await getWeekMeta(kv, settings.currentWeek);
  if (meta.revealed) return;

  meta.locked = true;
  meta.revealed = true;
  meta.revealedAt = new Date().toISOString();
  await kv.put(`week:${settings.currentWeek}:meta`, JSON.stringify(meta));

  const weeks = await getWeeksIndex(kv, settings);
  const entry = weeks.find((w) => w.week === settings.currentWeek);
  if (entry) {
    entry.status = "revealed";
    await kv.put("global:weeks", JSON.stringify(weeks));
  }
}

// ============================================================================
// Route Handlers
// ============================================================================

/** GET /status */
async function handleStatus(kv) {
  const settings = await getSettings(kv);
  const meta = await getWeekMeta(kv, settings.currentWeek);

  return json({
    currentWeek: settings.currentWeek,
    tournament: meta.tournament,
    locked: meta.locked,
    revealed: meta.revealed,
    autoReveal: {
      enabled: settings.autoReveal,
      revealDow: settings.revealDow,
      revealHour: settings.revealHour,
      revealMinute: settings.revealMinute,
    },
  });
}

/** GET /weeks */
async function handleWeeks(kv) {
  const settings = await getSettings(kv);
  const weeks = await getWeeksIndex(kv, settings);
  return json({ weeks });
}

/**
 * GET /picks?week={n}
 * Picks visible only if revealed or admin. Before reveal: names-only list.
 */
async function handleGetPicks(kv, url, request, env) {
  const settings = await getSettings(kv);
  const weekParam = url.searchParams.get("week");
  const weekNum = weekParam ? parseInt(weekParam, 10) : settings.currentWeek;

  if (isNaN(weekNum) || weekNum < 1) return error("Invalid week number");

  const meta = await getWeekMeta(kv, weekNum);
  const adminKey = request.headers.get("X-Admin-Key");
  const isAdmin = adminKey && adminKey === env.ADMIN_KEY;

  let picks = null;
  let submitted = null;

  if (meta.revealed || isAdmin) {
    picks = await getWeekPicks(kv, weekNum);
  } else {
    const allPicks = await getWeekPicks(kv, weekNum);
    submitted = Object.keys(allPicks);
  }

  return json({
    week: meta.week,
    tournament: meta.tournament,
    locked: meta.locked,
    revealed: meta.revealed,
    revealedAt: meta.revealedAt,
    picks,
    submitted,
  });
}

/** POST /submit — Body: { name, golferPick } */
async function handleSubmit(kv, request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return error("Invalid JSON body");
  }

  const { name, golferPick } = body;

  if (!name || !POOL_MEMBERS.includes(name)) {
    return error(`Invalid name. Must be one of: ${POOL_MEMBERS.join(", ")}`);
  }
  if (!golferPick || typeof golferPick !== "string" || golferPick.trim().length === 0) {
    return error("Golfer pick is required");
  }

  const settings = await getSettings(kv);
  const meta = await getWeekMeta(kv, settings.currentWeek);

  if (meta.locked) {
    return error(`Week ${settings.currentWeek} (${meta.tournament}) is locked. No more picks allowed.`);
  }

  // Read-modify-write (safe at this concurrency level — 10 people, slow picks)
  const picks = await getWeekPicks(kv, settings.currentWeek);
  picks[name] = {
    pick: golferPick.trim(),
    ts: new Date().toISOString(),
  };
  await kv.put(`week:${settings.currentWeek}:picks`, JSON.stringify(picks));

  return json({
    success: true,
    week: settings.currentWeek,
    tournament: meta.tournament,
    name,
    pick: golferPick.trim(),
  });
}

/**
 * POST /admin — Header: X-Admin-Key
 * Body: { action, weekNumber? }
 * Actions: "reveal", "advanceWeek", "viewAll"
 */
async function handleAdmin(kv, request, env) {
  const adminKey = request.headers.get("X-Admin-Key");
  if (!adminKey || adminKey !== env.ADMIN_KEY) {
    return error("Unauthorized", 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return error("Invalid JSON body");
  }

  const { action, weekNumber } = body;
  const settings = await getSettings(kv);

  // ---- REVEAL current week ----
  if (action === "reveal") {
    const meta = await getWeekMeta(kv, settings.currentWeek);
    meta.locked = true;
    meta.revealed = true;
    meta.revealedAt = new Date().toISOString();
    await kv.put(`week:${settings.currentWeek}:meta`, JSON.stringify(meta));

    const weeks = await getWeeksIndex(kv, settings);
    const entry = weeks.find((w) => w.week === settings.currentWeek);
    if (entry) entry.status = "revealed";
    await kv.put("global:weeks", JSON.stringify(weeks));

    const picks = await getWeekPicks(kv, settings.currentWeek);
    return json({
      success: true,
      action: "reveal",
      week: settings.currentWeek,
      tournament: meta.tournament,
      picks,
    });
  }

  // ---- ADVANCE to next week ----
  if (action === "advanceWeek") {
    const currentMeta = await getWeekMeta(kv, settings.currentWeek);

    // Auto-reveal current if not already
    if (!currentMeta.revealed) {
      currentMeta.locked = true;
      currentMeta.revealed = true;
      currentMeta.revealedAt = new Date().toISOString();
      await kv.put(`week:${settings.currentWeek}:meta`, JSON.stringify(currentMeta));
    }

    const nextWeek = settings.currentWeek + 1;
    if (nextWeek - 1 >= TOURNAMENTS.length) {
      return error(`No more tournaments. Season has ${TOURNAMENTS.length} weeks.`);
    }

    const nextTournament = TOURNAMENTS[nextWeek - 1];
    const nextMeta = {
      week: nextWeek,
      tournament: nextTournament,
      locked: false,
      revealed: false,
      revealedAt: null,
      createdAt: new Date().toISOString(),
    };
    await kv.put(`week:${nextWeek}:meta`, JSON.stringify(nextMeta));

    // Update weeks index
    const weeks = await getWeeksIndex(kv, settings);
    const currentEntry = weeks.find((w) => w.week === settings.currentWeek);
    if (currentEntry) currentEntry.status = "revealed";
    weeks.push({ week: nextWeek, tournament: nextTournament, status: "active" });
    await kv.put("global:weeks", JSON.stringify(weeks));

    settings.currentWeek = nextWeek;
    await kv.put("global:settings", JSON.stringify(settings));

    return json({
      success: true,
      action: "advanceWeek",
      previousWeek: nextWeek - 1,
      currentWeek: nextWeek,
      tournament: nextTournament,
    });
  }

  // ---- VIEW ALL (admin bypass for any week) ----
  if (action === "viewAll") {
    const targetWeek = weekNumber || settings.currentWeek;
    const meta = await getWeekMeta(kv, targetWeek);
    const picks = await getWeekPicks(kv, targetWeek);

    return json({
      success: true,
      action: "viewAll",
      week: meta.week,
      tournament: meta.tournament,
      locked: meta.locked,
      revealed: meta.revealed,
      picks,
    });
  }

  return error(`Unknown action: ${action}. Valid: reveal, advanceWeek, viewAll`);
}

// ============================================================================
// Router
// ============================================================================

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const kv = env.PICKS_KV;

    try {
      // Auto-reveal check fires on every request
      await checkAutoReveal(kv);

      if (path === "/status" && request.method === "GET")  return handleStatus(kv);
      if (path === "/weeks"  && request.method === "GET")  return handleWeeks(kv);
      if (path === "/picks"  && request.method === "GET")  return handleGetPicks(kv, url, request, env);
      if (path === "/submit" && request.method === "POST") return handleSubmit(kv, request);
      if (path === "/admin"  && request.method === "POST") return handleAdmin(kv, request, env);

      return error("Not found", 404);
    } catch (err) {
      console.error("Worker error:", err);
      return error(`Internal error: ${err.message}`, 500);
    }
  },
};
