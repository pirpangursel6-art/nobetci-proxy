// En Yakın — backend proxy
//
// Why this exists: the frontend can't safely hold API keys or make cross-
// origin calls to most place-data providers directly. This tiny server
// sits in between, holds any secrets, caches results briefly, and returns
// plain JSON shaped exactly like what the frontend expects.
//
// Data source: OpenStreetMap (via the Overpass API) for place search, and
// OpenStreetMap's Nominatim for the manual "search a location" feature.
// Both are free, keyless, and have no billing system to run up a
// surprise bill on — see OSM_TAG_CONFIG below for what that trades away
// (no ratings/reviews/photos, and opening-hours coverage varies).
//
// Run locally:   npm install && npm start
// Deploy:         see README.md (Render.com free tier, ~5 minutes)

import express from "express";
import cors from "cors";
import fs from "fs";

const app = express();
app.use(cors()); // the app runs on a different origin/webview, so this must stay open
app.use(express.json());

const PORT = process.env.PORT || 3000;


// Public institutions get different disclaimer wording on the frontend
// (kurumla iletişime geç, not işletmeyle) — kept in sync with the
// PUBLIC_CATEGORY_IDS list in the app.
const PUBLIC_CATEGORY_IDS = new Set(["hastane", "itfaiye", "polis", "belediye", "cami", "tuvalet"]);

// ---- tiny in-memory cache (resets on restart — fine for this scale) -------
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const cache = new Map();

function cacheKeyFor(category, lat, lng, radius, limit, enrichCount) {
  // round coordinates so nearby requests share a cache entry instead of
  // each pinging Overpass separately
  const rLat = Number(lat).toFixed(2);
  const rLng = Number(lng).toFixed(2);
  return `${category}:${rLat}:${rLng}:${radius}:${limit}:${enrichCount}`;
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

// ---- distance enforcement ---------------------------------------------------

// Used to enforce the search radius for real (Overpass's `around` filter
// already does this at query time, but keeping this shared helper since
// it's also used to sort results by actual distance).
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---- OpenStreetMap / Overpass API — the only data source now -------------
// Genuinely free forever (no billing system exists to run up a bill on),
// but with real trade-offs: no ratings, no reviews, no photos, and
// opening-hours coverage/format is too inconsistent to convert to the
// weekday_text shape the app parses — left blank rather than guessed.
// Two categories (see the bottom of this list) have no OSM tag at all and
// return an honest empty list rather than an error.
//
// Each entry is one or more OSM tag pairs (key=value), OR'd together.
const OSM_TAG_CONFIG = {
  eczane: [{ key: "amenity", value: "pharmacy" }],
  market: [{ key: "shop", value: "supermarket" }, { key: "shop", value: "convenience" }],
  manav: [{ key: "shop", value: "greengrocer" }],
  restoran: [{ key: "amenity", value: "restaurant" }],
  atm: [{ key: "amenity", value: "atm" }],
  banka: [{ key: "amenity", value: "bank" }],
  benzinlik: [{ key: "amenity", value: "fuel" }],
  kuafor: [{ key: "shop", value: "hairdresser" }, { key: "shop", value: "beauty" }],
  kahvehane: [{ key: "amenity", value: "cafe" }],
  avm: [{ key: "shop", value: "mall" }],
  firin: [{ key: "shop", value: "bakery" }],
  giyim: [{ key: "shop", value: "clothes" }],
  elektronik: [{ key: "shop", value: "electronics" }],
  tamirci: [{ key: "shop", value: "car_repair" }],
  cilingir: [{ key: "shop", value: "locksmith" }],
  doviz: [{ key: "amenity", value: "bureau_de_change" }],
  kozmetik: [{ key: "shop", value: "cosmetics" }, { key: "shop", value: "jewelry" }],
  cami: [{ key: "amenity", value: "place_of_worship" }],
  belediye: [{ key: "amenity", value: "townhall" }],
  tuvalet: [{ key: "amenity", value: "toilets" }],
  kasap: [{ key: "shop", value: "butcher" }, { key: "shop", value: "deli" }, { key: "shop", value: "seafood" }],
  kirtasiye: [{ key: "shop", value: "stationery" }],
  yedek_parca: [{ key: "shop", value: "car_parts" }],
  cicekci: [{ key: "shop", value: "florist" }],
  oto_yikama: [{ key: "amenity", value: "car_wash" }],
  otopark: [{ key: "amenity", value: "parking" }],
  bisikletci: [{ key: "shop", value: "bicycle" }],
  ptt: [{ key: "amenity", value: "post_office" }],
  emlakci: [{ key: "office", value: "estate_agent" }],
  okul: [{ key: "amenity", value: "school" }, { key: "amenity", value: "kindergarten" }],
  kutuphane: [{ key: "amenity", value: "library" }],
  sinema: [{ key: "amenity", value: "cinema" }],
  oyuncakci: [{ key: "shop", value: "toys" }],
  otel: [{ key: "tourism", value: "hotel" }],
  veteriner: [{ key: "amenity", value: "veterinary" }],
  optik: [{ key: "shop", value: "optician" }],
  dis_klinigi: [{ key: "amenity", value: "dentist" }],
  nalbur: [{ key: "shop", value: "hardware" }],
  kuru_temizleme: [{ key: "shop", value: "dry_cleaning" }],
  mobilyaci: [{ key: "shop", value: "furniture" }],
  spor_salonu: [{ key: "leisure", value: "fitness_centre" }],
  yuzme_havuzu: [{ key: "leisure", value: "swimming_pool" }],
  hastane: [{ key: "amenity", value: "hospital" }],
  itfaiye: [{ key: "amenity", value: "fire_station" }],
  polis: [{ key: "amenity", value: "police" }],
  metro_tramvay: [
    { key: "highway", value: "bus_stop" },
    { key: "railway", value: "station" },
    { key: "railway", value: "tram_stop" },
    { key: "amenity", value: "ferry_terminal" },
    { key: "amenity", value: "taxi" },
  ],
  burger: [{ key: "amenity", value: "fast_food" }],
  tursu_aktar: [{ key: "shop", value: "deli" }],
  kahvalti: [{ key: "amenity", value: "restaurant" }],
  tatlici: [{ key: "shop", value: "confectionery" }, { key: "amenity", value: "ice_cream" }, { key: "shop", value: "pastry" }],
  poliklinik: [{ key: "amenity", value: "clinic" }],
  bilardo: [{ key: "leisure", value: "amusement_arcade" }],
  terzi: [{ key: "shop", value: "tailor" }, { key: "shop", value: "shoe_repair" }],
  avukat: [{ key: "office", value: "lawyer" }],
  sigorta: [{ key: "office", value: "insurance" }],
  su_tup: [{ key: "shop", value: "gas" }],
  // No OSM tag reliably covers these two — they'll just return an empty
  // list rather than erroring, honestly reflecting that OSM has no
  // equivalent for them.
  hali_yikama: [],
  yolyardim: [],
};

// The public Overpass instance (overpass-api.de) is shared by everyone and
// occasionally too busy or briefly unreachable — this happened right when
// the server had just woken up from sleep, which is exactly when a single
// flaky attempt is most likely. Trying a couple of alternate public
// mirrors before giving up makes this dramatically more reliable without
// needing to run our own Overpass server.
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];

// ---- Open Places API — backup when OSM/Overpass has nothing or is
// unreachable (see the note above the /api/places route for why a pure-
// OSM approach alone isn't reliable enough right now). Overture-backed,
// requires a free account (https://app.openplacesapi.com/signup) but has
// a genuine hard cap — it stops answering instead of ever billing an
// overage, so there is no repeat of the Google situation here.
//
// Search text per category (Turkish terms) — this API's `q` does a
// fuzzy match, which plays nicely with how Turkish businesses commonly
// include the category word in their own name ("... Eczanesi", "...
// Market", etc.), the same reasoning that worked well for Google's Text
// Search earlier.
const OPEN_PLACES_QUERY = {
  eczane: "eczane", market: "market bakkal süpermarket A101 BİM", manav: "manav",
  restoran: "restoran lokanta", atm: "ATM", banka: "banka", benzinlik: "benzin istasyonu",
  kuafor: "kuaför berber güzellik", kahvehane: "kahvehane kıraathane nargile çay ocağı",
  avm: "alışveriş merkezi", firin: "fırın unlu mamül pastane", giyim: "giyim mağazası",
  elektronik: "elektronik teknoloji telefon", metro_tramvay: "metro tramvay otobüs vapur taksi durağı",
  tamirci: "oto tamirci lastikçi", cilingir: "çilingir", doviz: "döviz bürosu",
  kozmetik: "kozmetik kuyumcu takı", cami: "cami mescit", belediye: "belediye muhtarlık",
  tuvalet: "umumi tuvalet", kasap: "kasap şarküteri balıkçı", kirtasiye: "kırtasiye",
  su_tup: "su bayii tüp bayii", burger: "burger döner pide lahmacun", yedek_parca: "oto yedek parça",
  tursu_aktar: "turşucu aktar baharatçı çerezci", spor_salonu: "spor salonu fitness halı saha",
  kahvalti: "kahvaltı salonu", tatlici: "tatlıcı dondurmacı pastane baklava",
  cafe: "Starbucks Kahve Dünyası Kahve Diyarı cafe", veteriner: "veteriner", optik: "optik gözlükçü",
  dis_klinigi: "diş kliniği diş hekimi", poliklinik: "özel poliklinik muayenehane",
  nalbur: "nalbur hırdavatçı", kuru_temizleme: "kuru temizleme çamaşırhane", hali_yikama: "halı yıkama",
  mobilyaci: "mobilyacı beyaz eşya", cicekci: "çiçekçi", oto_yikama: "oto yıkama",
  otopark: "otopark", bisikletci: "bisikletçi", ptt: "PTT kargo", emlakci: "emlakçı",
  avukat: "avukat hukuk bürosu noter", sigorta: "sigorta acentesi", okul: "okul anaokulu kreş",
  kutuphane: "kütüphane", sinema: "sinema", yuzme_havuzu: "yüzme havuzu",
  bilardo: "bilardo oyun salonu", terzi: "terzi kunduracı", oyuncakci: "oyuncakçı",
  otel: "otel konaklama", hastane: "hastane", itfaiye: "itfaiye", polis: "polis merkezi",
  yolyardim: "oto yol yardım çekici",
};

// Without an explicit timeout, a hung connection attempt can sit for
// however long Node's/undici's own default is — which is exactly what
// turned into several minutes of waiting when Overpass mirrors were slow
// to respond: 3 mirrors, each with no set ceiling, plus this whole
// function's own caller retrying it. A short, explicit timeout per
// attempt means a bad mirror gets skipped in seconds, not tens of
// seconds.
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function openPlacesSearch(query, lat, lng, radiusMeters, limit) {
  const apiKey = process.env.OPEN_PLACES_API_KEY;
  if (!apiKey) return null; // not configured — caller just gets an empty result, no crash
  const radiusMi = Math.min(radiusMeters / 1609.34, 50);
  const url = new URL("https://api.openplacesapi.com/v1/places");
  url.searchParams.set("q", query);
  url.searchParams.set("lat", lat);
  url.searchParams.set("lon", lng);
  url.searchParams.set("radius_mi", radiusMi.toFixed(1));
  url.searchParams.set("limit", String(Math.min(limit, 20)));
  url.searchParams.set("min_confidence", "0.5");
  const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${apiKey}` } }, 8000);
  if (!res.ok) throw new Error(`Open Places API request failed: ${res.status}`);
  const data = await res.json();
  return data.results || [];
}

function shapeOpenPlace(r, catId, idx) {
  const addr = r.address || {};
  return {
    catId,
    idx,
    place_id: r.place_id,
    name: r.name,
    address: [addr.locality, addr.country_code].filter(Boolean).join(", "),
    lat: r.lat,
    lng: r.lon,
    phone: r.phone || null,
    rating: null,
    ratingCount: null,
    hours: [], // not part of this data source either
    photos: [],
  };
}

async function overpassSearch(tagPairs, lat, lng, radiusMeters) {
  const clauses = tagPairs
    .map(
      (t) =>
        `node["${t.key}"="${t.value}"](around:${radiusMeters},${lat},${lng});way["${t.key}"="${t.value}"](around:${radiusMeters},${lat},${lng});`
    )
    .join("");
  const query = `[out:json][timeout:20];(${clauses});out center tags;`;

  let lastError;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetchWithTimeout(
        endpoint,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            // Some public Overpass mirrors are stricter with requests that
            // don't identify themselves — this is a legitimate, well-behaved
            // app making occasional on-demand queries, not a scraper.
            "User-Agent": "EnYakinApp/1.0 (contact: nobetci-proxy operator)",
          },
          body: "data=" + encodeURIComponent(query),
        },
        6000 // 6s per mirror — 3 mirrors worst-case is ~18s, not minutes
      );
      if (!res.ok) throw new Error(`Overpass request failed: ${res.status}`);
      const data = await res.json();
      return data.elements || [];
    } catch (err) {
      lastError = err;
      // try the next mirror
    }
  }
  throw lastError;
}

function shapeOsmPlace(el, catId, idx) {
  const tags = el.tags || {};
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lng ?? el.center?.lon;
  const line1 = [tags["addr:street"], tags["addr:housenumber"]].filter(Boolean).join(" ");
  const line2 = [tags["addr:postcode"], tags["addr:city"] || tags["addr:district"]].filter(Boolean).join(" ");
  return {
    catId,
    idx,
    place_id: `osm:${el.type}/${el.id}`,
    name: tags.name,
    address: [line1, line2].filter(Boolean).join(", "),
    lat,
    lng,
    phone: tags.phone || tags["contact:phone"] || null,
    rating: null,
    ratingCount: null,
    // OSM's own opening_hours mini-language ("Mo-Fr 08:00-18:00; Su off")
    // isn't compatible with the weekday_text format the app parses —
    // left empty (shows "Saat bilgisi yok") rather than mis-parsed.
    hours: [],
    photos: [],
  };
}

// ---- routes -----------------------------------------------------------------

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// ---- location search (manual location entry) ------------------------------
// Lets the app offer "type your city/address instead" as an alternative to
// device GPS — useful when location permission is denied, unavailable, or
// the person just wants to check a different city. Uses OpenStreetMap's
// own free geocoder (Nominatim) — no key, no billing, ever. Nominatim's
// usage policy asks for a real contact-identifying User-Agent and no more
// than ~1 request/second, both easily satisfied by an on-demand, person-
// triggered search like this one.

app.get("/api/geocode", rateLimit, async (req, res) => {
  const { q } = req.query;
  if (!q || !q.trim()) {
    return res.status(400).json({ error: "invalid_params", detail: "q is required" });
  }
  try {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", q);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", "1");
    const r = await fetchWithTimeout(
      url,
      { headers: { "User-Agent": "EnYakinApp/1.0 (contact: nobetci-proxy operator)" } },
      8000
    );
    const data = await r.json();
    if (!Array.isArray(data) || data.length === 0) {
      return res.status(404).json({ error: "not_found", detail: "no results" });
    }
    const top = data[0];
    res.json({
      name: top.display_name?.split(",")[0] || q,
      address: top.display_name,
      lat: Number(top.lat),
      lng: Number(top.lon),
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "upstream_failed", detail: String(err.message || err) });
  }
});

app.get("/api/places", rateLimit, async (req, res) => {
  // 10km — a hard cutoff (see haversineMeters above).
  const { category, lat, lng, radius = 10000, limit = 8 } = req.query;
  if (!(category in OSM_TAG_CONFIG) || !lat || !lng) {
    return res.status(400).json({ error: "invalid_params", detail: "category, lat, lng are required" });
  }

  const key = cacheKeyFor(category, lat, lng, radius, limit, 0);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return res.json(cached.data);
  }

  // Step 1 — free first: OSM/Overpass, when this category has a tag for it.
  const osmTags = OSM_TAG_CONFIG[category];
  if (osmTags.length > 0) {
    try {
      const elements = await overpassSearch(osmTags, lat, lng, radius);
      const named = elements.filter((el) => el.tags?.name && (el.lat ?? el.center?.lat) != null);
      if (named.length > 0) {
        const shaped = named
          .map((el, idx) => shapeOsmPlace(el, category, idx))
          .map((p) => ({ ...p, _distance: haversineMeters(Number(lat), Number(lng), p.lat, p.lng) }))
          .sort((a, b) => a._distance - b._distance)
          .slice(0, Math.min(Number(limit) || 8, 20))
          .map(({ _distance, ...p }, idx) => ({ ...p, idx }));
        cache.set(key, { ts: Date.now(), data: shaped });
        return res.json(shaped);
      }
      // OSM reached fine but had nothing named nearby — fall through to
      // Open Places below rather than returning an empty list outright.
    } catch (err) {
      console.error("Overpass lookup failed, falling back to Open Places API:", err.message || err);
      // fall through — this is the case that was failing with
      // UND_ERR_CONNECT_TIMEOUT (public Overpass currently throttling
      // cloud-hosted IPs, see the chat notes)
    }
  }

  // Step 2 — backup: Open Places API, only reached if OSM was empty/unreachable.
  // Genuinely free up to a hard cap (no OPEN_PLACES_API_KEY set yet =
  // openPlacesSearch just returns null, same as "nothing found").
  try {
    const query = OPEN_PLACES_QUERY[category];
    const results = query ? await openPlacesSearch(query, lat, lng, radius, Math.min(Number(limit) || 8, 20)) : null;
    const shaped = (results || []).map((r, idx) => shapeOpenPlace(r, category, idx));
    cache.set(key, { ts: Date.now(), data: shaped });
    res.json(shaped);
  } catch (err) {
    console.error(err);
    // Include the underlying cause (DNS failure, connection refused,
    // timeout, etc.) — "fetch failed" alone doesn't say why, and this
    // makes it possible to diagnose straight from the browser response
    // instead of needing to dig through Render's logs.
    const causeDetail = err.cause ? ` (${err.cause.code || err.cause.message || err.cause})` : "";
    res.status(502).json({ error: "upstream_failed", detail: String(err.message || err) + causeDetail });
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
  console.log(`En Yakın proxy listening on port ${PORT} — no API key required (OpenStreetMap-only)`);
});
