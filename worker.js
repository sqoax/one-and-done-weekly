// Golf Pick'em — One and Done Weekly League
// Cloudflare Worker (ES Module)

const TOURNAMENTS = [
  "Cognizant", "API", "Players", "Valspar", "Houston", "Valero", "Masters",
  "Heritage", "Cadillac", "Truist", "PGA", "Byron Nelson", "Schwab", "Memorial",
  "Canadian", "US Open", "Travelers", "John Deere", "Scottish", "The Open",
  "3M", "Rocket", "Wyndham"
];

const POOL_MEMBERS = [
  "Hiatt", "Caden", "Bennett", "Ryan", "William", "Ian", "Mason", "Tim", "Drew", "Ben"
];

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

function jsonError(message, status = 400) {
  return json({ error: message }, status);
}

// ---------- revealAfter calculation ----------

function getNextWednesday9pmET() {
  const now = new Date();
  const etFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });

  const parts = etFormatter.formatToParts(now);
  const et = {};
  parts.forEach((p) => { et[p.type] = p.value; });

  const etYear = parseInt(et.year);
  const etMonth = parseInt(et.month) - 1;
  const etDay = parseInt(et.day);
  const etHour = parseInt(et.hour === "24" ? "0" : et.hour); // midnight edge case

  // Build a pseudo-UTC date that actually represents ET components
  const etNow = new Date(Date.UTC(etYear, etMonth, etDay, etHour, parseInt(et.minute), parseInt(et.second)));
  const dayOfWeek = etNow.getUTCDay();

  let daysUntilWed = (3 - dayOfWeek + 7) % 7;
  if (daysUntilWed === 0 && etHour >= 21) {
    daysUntilWed = 7;
  }

  // Target Wednesday at 21:00 ET
  // Try both EST (UTC-5) and EDT (UTC-4)
  const candidateEST = new Date(Date.UTC(etYear, etMonth, etDay + daysUntilWed, 21 + 5, 0, 0));
  const candidateEDT = new Date(Date.UTC(etYear, etMonth, etDay + daysUntilWed, 21 + 4, 0, 0));

  function getETHour(date) {
    const p = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour: "numeric", hour12: false,
    }).formatToParts(date);
    return parseInt(p.find((x) => x.type === "hour").value);
  }

  return (getETHour(candidateEDT) === 21 ? candidateEDT : candidateEST).toISOString();
}

// ---------- Auto-reveal check ----------

async function checkAutoReveal(env) {
  const settings = await getSettings(env);
  if (!settings.autoReveal) return;

  const meta = await getMeta(env, settings.currentWeek);
  if (!meta || meta.revealed) return;

  if (Date.now() >= Date.parse(meta.revealAfter)) {
    // Lock and reveal
    meta.locked = true;
    meta.revealed = true;
    meta.revealedAt = new Date().toISOString();
    await env.PICKS_KV.put(`week:${meta.week}:meta`, JSON.stringify(meta));

    // Update weeks index
    const weeks = await getWeeks(env);
    const entry = weeks.find((w) => w.week === meta.week);
    if (entry) {
      entry.status = "revealed";
      await env.PICKS_KV.put("global:weeks", JSON.stringify(weeks));
    }
  }
}

// ---------- KV helpers ----------

async function getSettings(env) {
  const raw = await env.PICKS_KV.get("global:settings");
  return raw ? JSON.parse(raw) : null;
}

async function getWeeks(env) {
  const raw = await env.PICKS_KV.get("global:weeks");
  return raw ? JSON.parse(raw) : [];
}

async function getMeta(env, week) {
  const raw = await env.PICKS_KV.get(`week:${week}:meta`);
  return raw ? JSON.parse(raw) : null;
}

async function getPicks(env, week) {
  const raw = await env.PICKS_KV.get(`week:${week}:picks`);
  return raw ? JSON.parse(raw) : {};
}

// ---------- Initialization ----------

async function initialize(env) {
  const existing = await getSettings(env);
  if (existing) return;

  const revealAfter = getNextWednesday9pmET();
  const now = new Date().toISOString();

  await env.PICKS_KV.put("global:settings", JSON.stringify({ currentWeek: 1, autoReveal: true }));
  await env.PICKS_KV.put("global:weeks", JSON.stringify([{ week: 1, tournament: "Cognizant", status: "active" }]));
  await env.PICKS_KV.put(`week:1:meta`, JSON.stringify({
    week: 1,
    tournament: "Cognizant",
    locked: false,
    revealed: false,
    revealedAt: null,
    revealAfter,
    createdAt: now,
  }));
  await env.PICKS_KV.put(`week:1:picks`, JSON.stringify({}));
}

// ---------- Create a new week helper ----------

async function createWeek(env, weekNumber) {
  const tournament = TOURNAMENTS[weekNumber - 1];
  const revealAfter = getNextWednesday9pmET();
  const now = new Date().toISOString();

  const meta = {
    week: weekNumber,
    tournament,
    locked: false,
    revealed: false,
    revealedAt: null,
    revealAfter,
    createdAt: now,
  };

  await env.PICKS_KV.put(`week:${weekNumber}:meta`, JSON.stringify(meta));
  await env.PICKS_KV.put(`week:${weekNumber}:picks`, JSON.stringify({}));

  // Update weeks index
  const weeks = await getWeeks(env);
  weeks.push({ week: weekNumber, tournament, status: "active" });
  await env.PICKS_KV.put("global:weeks", JSON.stringify(weeks));

  // Update settings
  const settings = await getSettings(env);
  settings.currentWeek = weekNumber;
  await env.PICKS_KV.put("global:settings", JSON.stringify(settings));

  return { meta, revealAfter };
}

// ---------- Route handlers ----------

async function handleStatus(env) {
  const settings = await getSettings(env);
  const meta = await getMeta(env, settings.currentWeek);
  return json({
    currentWeek: settings.currentWeek,
    tournament: meta.tournament,
    locked: meta.locked,
    revealed: meta.revealed,
    revealAfter: meta.revealAfter,
    autoReveal: settings.autoReveal,
  });
}

async function handleWeeks(env) {
  const weeks = await getWeeks(env);
  return json({ weeks });
}

async function handlePicks(request, env) {
  const url = new URL(request.url);
  const settings = await getSettings(env);
  const weekParam = url.searchParams.get("week");
  const weekNum = weekParam ? parseInt(weekParam) : settings.currentWeek;

  const meta = await getMeta(env, weekNum);
  if (!meta) return jsonError(`Week ${weekNum} not found`, 404);

  const picks = await getPicks(env, weekNum);
  const isAdmin = request.headers.get("X-Admin-Key") === env.ADMIN_KEY;
  const showPicks = meta.revealed || isAdmin;

  if (showPicks) {
    return json({
      week: meta.week,
      tournament: meta.tournament,
      locked: meta.locked,
      revealed: meta.revealed,
      revealedAt: meta.revealedAt,
      revealAfter: meta.revealAfter,
      picks,
      submitted: null,
    });
  } else {
    return json({
      week: meta.week,
      tournament: meta.tournament,
      locked: meta.locked,
      revealed: meta.revealed,
      revealAfter: meta.revealAfter,
      picks: null,
      submitted: Object.keys(picks),
    });
  }
}

async function handleSubmit(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body");
  }

  const { name, golferPick } = body;

  if (!name || !POOL_MEMBERS.includes(name)) {
    return jsonError(`Invalid name. Must be one of: ${POOL_MEMBERS.join(", ")}`);
  }
  if (!golferPick || typeof golferPick !== "string" || golferPick.trim() === "") {
    return jsonError("golferPick is required and must be a non-empty string");
  }

  const settings = await getSettings(env);
  const meta = await getMeta(env, settings.currentWeek);

  if (meta.locked) {
    return jsonError(`Week ${meta.week} (${meta.tournament}) is locked. No more picks allowed.`);
  }

  const picks = await getPicks(env, settings.currentWeek);
  picks[name] = { pick: golferPick.trim(), ts: new Date().toISOString() };
  await env.PICKS_KV.put(`week:${settings.currentWeek}:picks`, JSON.stringify(picks));

  return json({
    success: true,
    week: meta.week,
    tournament: meta.tournament,
    name,
    pick: golferPick.trim(),
  });
}

async function handleAdmin(request, env) {
  const adminKey = request.headers.get("X-Admin-Key");
  if (!adminKey || adminKey !== env.ADMIN_KEY) {
    return jsonError("Unauthorized", 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body");
  }

  const { action } = body;

  if (action === "reveal") {
    const settings = await getSettings(env);
    const meta = await getMeta(env, settings.currentWeek);
    const picks = await getPicks(env, settings.currentWeek);

    meta.locked = true;
    meta.revealed = true;
    meta.revealedAt = new Date().toISOString();
    await env.PICKS_KV.put(`week:${meta.week}:meta`, JSON.stringify(meta));

    const weeks = await getWeeks(env);
    const entry = weeks.find((w) => w.week === meta.week);
    if (entry) {
      entry.status = "revealed";
      await env.PICKS_KV.put("global:weeks", JSON.stringify(weeks));
    }

    return json({ success: true, week: meta.week, tournament: meta.tournament, picks });
  }

  if (action === "advanceWeek") {
    const settings = await getSettings(env);
    const nextWeek = settings.currentWeek + 1;

    if (nextWeek > TOURNAMENTS.length) {
      return jsonError("Already at the last tournament. Cannot advance further.");
    }

    // Reveal current week if not already
    const currentMeta = await getMeta(env, settings.currentWeek);
    if (!currentMeta.revealed) {
      currentMeta.locked = true;
      currentMeta.revealed = true;
      currentMeta.revealedAt = new Date().toISOString();
      await env.PICKS_KV.put(`week:${currentMeta.week}:meta`, JSON.stringify(currentMeta));

      const weeks = await getWeeks(env);
      const entry = weeks.find((w) => w.week === currentMeta.week);
      if (entry) {
        entry.status = "revealed";
        await env.PICKS_KV.put("global:weeks", JSON.stringify(weeks));
      }
    }

    // Create next week
    const { meta } = await createWeek(env, nextWeek);

    return json({
      success: true,
      currentWeek: nextWeek,
      tournament: meta.tournament,
      revealAfter: meta.revealAfter,
    });
  }

  if (action === "viewAll") {
    const weekNumber = body.weekNumber;
    if (!weekNumber) return jsonError("weekNumber is required");

    const meta = await getMeta(env, weekNumber);
    if (!meta) return jsonError(`Week ${weekNumber} not found`, 404);

    const picks = await getPicks(env, weekNumber);
    return json({
      week: meta.week,
      tournament: meta.tournament,
      locked: meta.locked,
      revealed: meta.revealed,
      revealedAt: meta.revealedAt,
      revealAfter: meta.revealAfter,
      picks,
    });
  }

  if (action === "setWeek") {
    const weekNumber = body.weekNumber;
    if (!weekNumber || weekNumber < 1 || weekNumber > TOURNAMENTS.length) {
      return jsonError(`weekNumber must be between 1 and ${TOURNAMENTS.length}`);
    }

    const tournament = body.tournament || TOURNAMENTS[weekNumber - 1];
    const revealAfter = getNextWednesday9pmET();
    const now = new Date().toISOString();

    // Create or overwrite the target week meta
    const meta = {
      week: weekNumber,
      tournament,
      locked: false,
      revealed: false,
      revealedAt: null,
      revealAfter,
      createdAt: now,
    };
    await env.PICKS_KV.put(`week:${weekNumber}:meta`, JSON.stringify(meta));

    // Ensure picks key exists
    const existingPicks = await getPicks(env, weekNumber);
    if (Object.keys(existingPicks).length === 0) {
      await env.PICKS_KV.put(`week:${weekNumber}:picks`, JSON.stringify({}));
    }

    // Rebuild weeks index
    const weeks = await getWeeks(env);
    // Mark all previous weeks as revealed if they aren't already
    for (const w of weeks) {
      if (w.week < weekNumber && w.status === "active") {
        w.status = "revealed";
      }
    }
    // Add or update current week entry
    const existing = weeks.find((w) => w.week === weekNumber);
    if (existing) {
      existing.tournament = tournament;
      existing.status = "active";
    } else {
      weeks.push({ week: weekNumber, tournament, status: "active" });
    }
    weeks.sort((a, b) => a.week - b.week);
    await env.PICKS_KV.put("global:weeks", JSON.stringify(weeks));

    // Update settings
    await env.PICKS_KV.put("global:settings", JSON.stringify({
      currentWeek: weekNumber,
      autoReveal: (await getSettings(env)).autoReveal,
    }));

    return json({ success: true, currentWeek: weekNumber, tournament, revealAfter });
  }

  if (action === "setAutoReveal") {
    if (typeof body.enabled !== "boolean") {
      return jsonError("enabled must be a boolean");
    }

    const settings = await getSettings(env);
    settings.autoReveal = body.enabled;
    await env.PICKS_KV.put("global:settings", JSON.stringify(settings));

    return json({ success: true, autoReveal: body.enabled });
  }

  return jsonError(`Unknown action: ${action}`);
}

// ---------- Main ----------

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Initialize on first request
    await initialize(env);

    // Auto-reveal check on every request
    await checkAutoReveal(env);

    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "GET") {
      if (path === "/status") return handleStatus(env);
      if (path === "/weeks") return handleWeeks(env);
      if (path === "/picks") return handlePicks(request, env);
    }

    if (request.method === "POST") {
      if (path === "/submit") return handleSubmit(request, env);
      if (path === "/admin") return handleAdmin(request, env);
    }

    return jsonError("Not found", 404);
  },
};
