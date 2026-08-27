// Nöbetçi App — backend proxy
//
// Why this exists: the frontend is a browser-only artifact, so it can never
// safely hold a Google API key (anyone can read it from the page source) and
// most place-data APIs block direct browser calls anyway (CORS). This tiny
// server sits in between: it holds the key, calls Google Places on the
// frontend's behalf, caches results briefly, and returns plain JSON shaped
// exactly like the static data the frontend already knows how to render.
//
// Run locally:   npm install && GOOGLE_PLACES_API_KEY=xxx npm start
// Deploy:         see README.md (Render.com free tier, ~5 minutes)

import express from "express";
import cors from "cors";
import fs from "fs";

const app = express();
app.use(cors()); // the app runs on a different origin/webview, so this must stay open
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GOOGLE_PLACES_API_KEY;

// category id (matches the frontend) -> Turkish search query sent to Google
const CATEGORY_QUERIES = {
  // -- most-searched first --
  eczane: "eczane",
  market: "market bakkal süpermarket",
  restoran: "restoran",
  atm: "ATM",
  banka: "banka şubesi",
  benzinlik: "benzin istasyonu",
  kuafor: "kuaför berber",
  kahvehane: "kahvehane kafe",
  avm: "alışveriş merkezi",
  firin: "fırın",
  giyim: "giyim mağazası",
  teknoloji: "teknoloji telefon mağazası",
  taksi: "taksi durağı",
  otobus: "otobüs durağı",
  metro_tramvay: "metro tramvay durağı",
  vapur: "vapur iskelesi",
  tamirci: "oto tamirci",
  lastikci: "lastikçi",
  cilingir: "çilingir",
  doviz: "döviz bürosu",
  kozmetik: "kozmetik mağazası",
  taki: "kuyumcu takı",
  cami: "cami mescit",
  belediye: "belediye muhtarlık",
  tuvalet: "umumi tuvalet",
  // -- emergency --
  hastane: "hastane",
  itfaiye: "itfaiye",
  polis: "polis merkezi",
  yolyardim: "oto yol yardım çekici",
};

// Public institutions get different disclaimer wording on the frontend
// (kurumla iletişime geç, not işletmeyle) — kept in sync with the
// PUBLIC_CATEGORY_IDS list in the app.
const PUBLIC_CATEGORY_IDS = new Set(["hastane", "itfaiye", "polis", "belediye", "cami", "tuvalet"]);

// ---- tiny in-memory cache (resets on restart — fine for this scale) -------
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const cache = new Map();

function cacheKeyFor(category, lat, lng, radius) {
  // round coordinates so nearby requests share a cache entry instead of
  // each pinging Google separately
  const rLat = Number(lat).toFixed(2);
  const rLng = Number(lng).toFixed(2);
  return `${category}:${rLat}:${rLng}:${radius}`;
}

// ---- tiny in-memory rate limiter (per IP) ---------------------------------
// Protects the API key from runaway costs if the URL leaks or gets hammered.
const RATE_LIMIT = 30; // requests
const RATE_WINDOW_MS = 60 * 1000; // per minute
const hits = new Map();

function rateLimit(req, res, next) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const entry = hits.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > RATE_WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count += 1;
  hits.set(ip, entry);
  if (entry.count > RATE_LIMIT) {
    return res.status(429).json({ error: "rate_limited" });
  }
  next();
}

// ---- Google Places calls ---------------------------------------------------

async function textSearch(query, lat, lng, radius) {
  const url = new URL("https://maps.googleapis.com/maps/api/place/textsearch/json");
  url.searchParams.set("query", query);
  url.searchParams.set("location", `${lat},${lng}`);
  url.searchParams.set("radius", radius);
  url.searchParams.set("key", API_KEY);
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
    throw new Error(`Places text search failed: ${data.status} ${data.error_message || ""}`);
  }
  return data.results || [];
}

async function placeDetails(placeId) {
  const url = new URL("https://maps.googleapis.com/maps/api/place/details/json");
  url.searchParams.set("place_id", placeId);
  url.searchParams.set(
    "fields",
    "name,formatted_address,formatted_phone_number,geometry,rating,user_ratings_total,opening_hours"
  );
  url.searchParams.set("key", API_KEY);
  const res = await fetch(url);
  const data = await res.json();
  return data.result || {};
}

function shapePlace(base, details, catId, idx) {
  const geom = details.geometry || base.geometry;
  return {
    catId,
    idx,
    place_id: base.place_id,
    name: details.name || base.name,
    address: details.formatted_address || base.formatted_address || "",
    lat: geom?.location?.lat,
    lng: geom?.location?.lng,
    phone: details.formatted_phone_number || null,
    rating: details.rating ?? base.rating ?? null,
    ratingCount: details.user_ratings_total ?? base.user_ratings_total ?? null,
    hours: details.opening_hours?.weekday_text || [],
  };
}

// ---- routes -----------------------------------------------------------------

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// ---- location search (manual location entry) ------------------------------
// Lets the app offer "type your city/address instead" as an alternative to
// device GPS — useful when location permission is denied, unavailable, or
// the person just wants to check a different city. Reuses the already-
// enabled Places Text Search rather than requiring a separate Geocoding
// API key/enablement.

app.get("/api/geocode", rateLimit, async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({ error: "server_misconfigured", detail: "GOOGLE_PLACES_API_KEY is not set" });
  }
  const { q } = req.query;
  if (!q || !q.trim()) {
    return res.status(400).json({ error: "invalid_params", detail: "q is required" });
  }
  try {
    const url = new URL("https://maps.googleapis.com/maps/api/place/textsearch/json");
    url.searchParams.set("query", q);
    url.searchParams.set("key", API_KEY);
    const r = await fetch(url);
    const data = await r.json();
    if (data.status !== "OK" || !data.results || data.results.length === 0) {
      return res.status(404).json({ error: "not_found", detail: data.status || "no results" });
    }
    const top = data.results[0];
    res.json({
      name: top.name,
      address: top.formatted_address,
      lat: top.geometry.location.lat,
      lng: top.geometry.location.lng,
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "upstream_failed", detail: String(err.message || err) });
  }
});

app.get("/api/places", rateLimit, async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({ error: "server_misconfigured", detail: "GOOGLE_PLACES_API_KEY is not set" });
  }
  const { category, lat, lng, radius = 6000 } = req.query;
  const query = CATEGORY_QUERIES[category];
  if (!query || !lat || !lng) {
    return res.status(400).json({ error: "invalid_params", detail: "category, lat, lng are required" });
  }

  const key = cacheKeyFor(category, lat, lng, radius);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return res.json(cached.data);
  }

  try {
    const results = await textSearch(query, lat, lng, radius);
    const top = results.slice(0, 8);
    const enriched = await Promise.all(
      top.map(async (p, idx) => {
        try {
          const details = await placeDetails(p.place_id);
          return shapePlace(p, details, category, idx);
        } catch {
          return shapePlace(p, {}, category, idx); // fall back to text-search fields only
        }
      })
    );
    cache.set(key, { ts: Date.now(), data: enriched });
    res.json(enriched);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "upstream_failed", detail: String(err.message || err) });
  }
});

// ---- generic key/value storage --------------------------------------------
// Backs the app's community features (ratings, live open/closed reports,
// reported prices) once it's no longer running inside the Claude-artifact
// sandbox. Stored as one JSON file on disk — simple and correct at this
// scale, but note it lives on the server's local disk: on some free hosts
// (Render's free tier included) that disk is wiped on redeploy. For a
// production release with data you don't want to lose, swap this for a
// real database (Render/Supabase both offer a free Postgres tier) — every
// other route stays the same either way.

const DATA_FILE = "./data.json";

function loadDB() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  } catch {
    return {};
  }
}
function saveDB(db) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db));
  } catch (e) {
    console.error("kv write failed", e);
  }
}
let db = loadDB();

app.get("/api/kv", (req, res) => {
  const { key } = req.query;
  if (!key) return res.status(400).json({ error: "key_required" });
  const value = db[key];
  res.json({ key, value: value === undefined ? null : value });
});

app.post("/api/kv", rateLimit, (req, res) => {
  const { key, value } = req.body || {};
  if (!key) return res.status(400).json({ error: "key_required" });
  db[key] = value;
  saveDB(db);
  res.json({ key, value });
});

app.listen(PORT, () => {
  console.log(`Nöbetçi proxy listening on port ${PORT}`);
  if (!API_KEY) console.warn("WARNING: GOOGLE_PLACES_API_KEY is not set — /api/places will fail");
});
