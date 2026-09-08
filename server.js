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
// This used to guard the paid Google API key against runaway costs — no
// longer relevant now that everything runs on OSM/Open Places (the latter
// has its own hard cap that can never bill an overage). But it was still
// set to 30/minute, which was actively breaking our own legitimate "Tümü"
// (all categories) feature: that single button press fires ~59 requests
// at once, so anything past the 30th was getting a 429 and silently
// showing up as "no results" for whichever categories happened to land
// last — that's why a category (like "Cami") could work fine on its own
// but go missing under "Tümü". Raised well above any real single-person
// usage pattern; still blocks genuine scripted abuse.
const RATE_LIMIT = 200; // requests
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
  cafe: [{ key: "amenity", value: "cafe" }],
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
  cicekci: [{ key: "shop", value: "florist" }],
  oto_yikama: [{ key: "amenity", value: "car_wash" }],
  otopark: [{ key: "amenity", value: "parking" }],
  ptt: [{ key: "amenity", value: "post_office" }],
  emlakci: [{ key: "office", value: "estate_agent" }],
  okul: [{ key: "amenity", value: "school" }, { key: "amenity", value: "kindergarten" }],
  otel: [{ key: "tourism", value: "hotel" }],
  veteriner: [{ key: "amenity", value: "veterinary" }],
  optik: [{ key: "shop", value: "optician" }],
  dis_klinigi: [{ key: "amenity", value: "dentist" }],
  nalbur: [{ key: "shop", value: "hardware" }],
  kuru_temizleme: [{ key: "shop", value: "dry_cleaning" }],
  mobilyaci: [{ key: "shop", value: "furniture" }],
  spor_salonu: [{ key: "leisure", value: "fitness_centre" }],
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
  kahvalti: [{ key: "amenity", value: "restaurant" }],
  tatlici: [{ key: "shop", value: "confectionery" }, { key: "amenity", value: "ice_cream" }, { key: "shop", value: "pastry" }],
  poliklinik: [{ key: "amenity", value: "clinic" }],
  terzi: [{ key: "shop", value: "tailor" }, { key: "shop", value: "shoe_repair" }],
  avukat: [{ key: "office", value: "lawyer" }],
  sigorta: [{ key: "office", value: "insurance" }],
  su_tup: [{ key: "shop", value: "gas" }],
  // No OSM tag reliably covers this one — it'll just return an empty
  // list rather than erroring, honestly reflecting that OSM has no
  // equivalent for it.
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
// One term per category, not several crammed together — Open Places API's
// text search appears to match more literally than Google's did, so a
// query like "market bakkal süpermarket A101 BİM" was actually hurting
// recall instead of helping it (confirmed via /api/debug-places: it
// returned zero raw results for "cafe" until simplified). Merged
// categories keep just their single most common Turkish term; brand
// names and synonyms were dropped for the same reason.
const OPEN_PLACES_QUERY = {
  eczane: "eczane", market: "market", manav: "manav",
  restoran: "restoran", atm: "ATM", banka: "banka", benzinlik: "benzin istasyonu",
  kuafor: "kuaför", kahvehane: "kahvehane",
  avm: "alışveriş merkezi", firin: "fırın", giyim: "giyim mağazası",
  elektronik: "elektronik", metro_tramvay: "durak",
  tamirci: "oto tamirci", cilingir: "çilingir anahtarcı", doviz: "döviz bürosu",
  kozmetik: "kozmetik", cami: "cami", belediye: "belediye",
  tuvalet: "tuvalet", kasap: "kasap", kirtasiye: "kırtasiye",
  su_tup: "su bayii", burger: "burger",
  spor_salonu: "spor salonu",
  kahvalti: "kahvaltı salonu", tatlici: "tatlıcı",
  cafe: "cafe", veteriner: "veteriner", optik: "optik",
  dis_klinigi: "diş kliniği", poliklinik: "poliklinik",
  nalbur: "nalbur", kuru_temizleme: "kuru temizleme",
  mobilyaci: "mobilyacı", cicekci: "çiçekçi", oto_yikama: "oto yıkama",
  otopark: "otopark", ptt: "PTT", emlakci: "emlakçı",
  avukat: "avukat", sigorta: "sigorta acentesi", okul: "okul",
  terzi: "terzi",
  otel: "otel", hastane: "hastane", itfaiye: "itfaiye", polis: "polis merkezi",
  yolyardim: "çekici",
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
  // No min_confidence filter — better to risk a slightly loose match than
  // to silently drop real results in a smaller town where Overture's own
  // confidence scores may run lower to begin with.
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
        4000 // 4s per mirror — failing fast matters more than a slow success now that this races against Open Places anyway
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

// Diagnostic-only route: runs both data sources independently for one
// category and reports exactly what happened with each — how many
// results, how long it took, and the real error message if one failed.
// Meant to be opened directly in a browser when something looks broken,
// so the actual cause shows up immediately instead of having to guess
// from the app's UI or dig through Render's logs.
app.get("/api/debug-places", rateLimit, async (req, res) => {
  const { category = "cafe", lat = "38.907", lng = "27.814", radius = "10000" } = req.query;
  const report = { category, lat, lng, radius, openPlacesKeyConfigured: !!process.env.OPEN_PLACES_API_KEY };

  const t1 = Date.now();
  try {
    const r = await runOsm(category, lat, lng, radius, 10);
    report.osm = { ok: true, count: r.length, ms: Date.now() - t1, sample: r[0]?.name };
  } catch (err) {
    report.osm = { ok: false, ms: Date.now() - t1, error: String(err.message || err), cause: err.cause ? String(err.cause.code || err.cause.message || err.cause) : undefined };
  }

  const t2 = Date.now();
  try {
    const query = OPEN_PLACES_QUERY[category];
    const raw = query ? await openPlacesSearch(query, lat, lng, radius, 10) : null;
    const r = await runOpenPlaces(category, lat, lng, radius, 10);
    report.openPlaces = {
      ok: true,
      query,
      rawCount: (raw || []).length, // straight from the API, before our own distance filter
      rawSample: raw && raw[0] ? { name: raw[0].name, lat: raw[0].lat, lon: raw[0].lon, distance_mi: raw[0].distance_mi, category: raw[0].category, categories: raw[0].categories } : undefined,
      allNamesAndCategories: (raw || []).map((r) => ({ name: r.name, category: r.category })),
      filteredCount: r.length, // after our hard-radius re-check
      ms: Date.now() - t2,
    };
  } catch (err) {
    report.openPlaces = { ok: false, ms: Date.now() - t2, error: String(err.message || err), cause: err.cause ? String(err.cause.code || err.cause.message || err.cause) : undefined };
  }

  res.json(report);
});

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

async function runOsm(category, lat, lng, radius, limit) {
  const osmTags = OSM_TAG_CONFIG[category];
  if (!osmTags || osmTags.length === 0) return [];
  const elements = await overpassSearch(osmTags, lat, lng, radius);
  const named = elements.filter((el) => el.tags?.name && (el.lat ?? el.center?.lat) != null && isCategoryRelevant(category, el.tags.name));
  // BUG DÜZELTMESİ: mesafe hesaplanıp sıralanıyordu ama gerçekten
  // yarıçap dışında kalanlar hiç ELENMİYORDU — runOpenPlaces'te olan
  // .filter() adımı burada eksikti. "Manisa'daki hastane Akhisar'da
  // görünüyor" sorununun tam sebebi buydu; Overpass'ın kendi around:
  // filtresi genelde doğru çalışsa da, way-tipi elemanlarda (center
  // koordinatı kullanılan) bazen isabetsiz olabiliyor — kendi kesin
  // kontrolümüz olmadan buna güvenmek riskliydi.
  return named
    .map((el, idx) => shapeOsmPlace(el, category, idx))
    .map((p) => applyKnownCoordinateCorrection(p))
    .filter((p) => p.lat != null && p.lng != null)
    .map((p) => ({ ...p, _distance: haversineMeters(Number(lat), Number(lng), p.lat, p.lng) }))
    .filter((p) => p._distance <= Number(radius))
    .sort((a, b) => a._distance - b._distance)
    // OSM aynı gerçek yeri (örn. bir hastane) hem bir "node" hem bir "way"
    // (bina taslağı) olarak, aynı isimle iki ayrı eleman şeklinde
    // barındırabiliyor — ikisi de sorgumuza aynı anda düşüyor ve aynı yer
    // iki kez listeleniyordu. İsme göre (küçük/büyük harf ve boşluk fark
    // etmeksizin) tekilleştiriyoruz; en yakın olan (zaten mesafeye göre
    // sıralı olduğu için ilk geçen) kalıyor.
    .filter((p, i, arr) => {
      const key = (p.name || "").trim().toLowerCase();
      return arr.findIndex((q) => (q.name || "").trim().toLowerCase() === key) === i;
    })
    .slice(0, Math.min(Number(limit) || 8, 20))
    .map(({ _distance, ...p }, idx) => ({ ...p, idx }));
}

// "Hastane Yolu" (bir cadde ismi) gibi kayıtlar, Overture'ın veri setinde
// gerçek bir işletme değil, sokak/adres unsuru olarak bulunup metin
// aramasına yanlışlıkla giriyor. Bir işletmenin kendi adı asla "... Yolu",
// "... Caddesi" gibi bitmez — bu kalıpları taşıyan sonuçları baştan elemek,
// Overture'ın kesin kategori alanına güvenmeden bile büyük ölçüde temizlik
// sağlıyor.
const NON_BUSINESS_NAME_PATTERN = /\b(yolu|caddesi|cadde|sokağı|sokak|bulvarı|mahallesi)\b/i;

function isLikelyRealBusiness(name) {
  return !!name && !NON_BUSINESS_NAME_PATTERN.test(name);
}

// Bazı kategorilerde, kaynağın (OSM ya da Open Places) döndürdüğü isim
// gerçek işletmeyle ilgili olsa da, kategorimize ait değil — örneğin
// "Elektronik" ararken "... Oto Elektrik ve Klima Servisi" gibi bir yer
// çıkabiliyor (adında "elektrik" geçtiği için metin araması yakalıyor,
// ama bu bir tüketici elektroniği mağazası değil, bir oto tamircisi).
// Kategoriye özel, isimde geçtiğinde diskalifiye eden kalıplar burada.
const CATEGORY_NAME_EXCLUSIONS = {
  elektronik: /\b(oto\s*elektrik|araç\s*elektrik|oto\s*klima|araç\s*klima|klima\s*servisi|klima\s*tamiri)\b/i,
  // "Temad Evi" gibi konut/inşaat projeleri, "alışveriş merkezi" metnine
  // hiç yakın olmasa da bazen AVM sonuçlarına karışıyor.
  avm: /\b(evi|evleri|konutları?|sitesi|rezidans)\b/i,
  // "Belediye Konutları" (belediyenin yaptırdığı konut projesi) gerçek
  // belediye binası/muhtarlık ile karıştırılmamalı.
  belediye: /\bkonut(ları|lar)?\b/i,
};

function isCategoryRelevant(catId, name) {
  const pattern = CATEGORY_NAME_EXCLUSIONS[catId];
  return !pattern || !pattern.test(name || "");
}

// Open Places API'nin metin araması, bir kelimeyi başka bir kelimenin
// TAM ORTASINDA bile olsa eşleştirebiliyor — "ATM" araması "Katmer"
// (k-ATM-er), "Fatma" (f-ATM-a) ya da "Atmalioğlu" gibi tamamen alakasız
// isimleri yakalıyordu. Bu, Türkçe'nin eklemeli yapısını (Eczanesi =
// eczane + "si") bozmadan, sadece gerçek bağımsız kelime eşleşmelerini
// kabul eden bir kontrol: aranan kelimeden hemen önce bir harf
// OLMAMALI (kelimenin başı ya da boşluk/noktalama), hemen sonrasında ise
// en fazla birkaç harflik bir Türkçe ek olabilir — daha fazlası, aranan
// kelimenin aslında başka, uzun bir kelimenin sadece bir parçası
// olduğunu gösterir.
function normalizeForMatch(s) {
  return (s || "")
    .toLowerCase()
    .replace(/ş/g, "s").replace(/ı/g, "i").replace(/ğ/g, "g")
    .replace(/ü/g, "u").replace(/ö/g, "o").replace(/ç/g, "c");
}

function nameMatchesQueryAsWord(name, query) {
  const normName = normalizeForMatch(name);
  const words = normalizeForMatch(query).split(/\s+/).filter((w) => w.length >= 3);
  if (words.length === 0) return true; // çok kısa/boş sorgular için kontrolü atla
  return words.some((w) => new RegExp(`(^|[^a-z])${w}([a-z]{0,3}(?:[^a-z]|$))`, "i").test(normName));
}

// Overture'ın kendi kategori alanı, açıkça alakasız bir sınıflandırma
// yaptığında ("Hastane Yolu" adlı market kaydı gibi) bunu yakalamamızı
// sağlıyor — isim kalıbı testinin yakalayamadığı durumlar için ikinci bir
// güvenlik katmanı. Bir "beyaz liste" değil, sadece "bunlar kesinlikle
// alakasız" diyebileceğimiz kategorileri eleyen bir kara liste — çünkü
// Overture'ın kendi kategorilendirmesi de zaman zaman hatalı olabiliyor
// (gerçek bir hastane "home_developer" olarak etiketlenmiş bulduk), o
// yüzden "sadece hospital kategorisini kabul et" gibi katı bir beyaz
// liste, gerçek sonuçları da kaybettirirdi.
const IRRELEVANT_CATEGORY_HINTS = ["grocery", "supermarket", "superstore", "store", "shop", "retail", "market"];

// Bazı kayıtların Overture'daki koordinatı gerçekten yanlış — isim/işletme
// doğru, sadece konumu hatalı girilmiş. Bunları isimden silmek yerine
// (ki bu, o işletmenin gerçekten yakınında olan birinden de kaydı
// tamamen gizlerdi), doğru koordinatla değiştiriyoruz. Bu sayede mesafe
// filtresi kendi işini doğru yapabiliyor: gerçekten yakın olan biri hâlâ
// görür, uzak olan biri artık görmez. Yeni böyle bir hata bulundukça bu
// listeye eklenebilir.
const KNOWN_COORDINATE_CORRECTIONS = {
  "alasehir devlet hastanesi": { lat: 38.341622, lng: 28.533382 }, // gerçek konumu Alaşehir/Manisa, Akhisar değil
  "manisa 8 eylul hastanesi": { lat: 38.618899, lng: 27.436402 }, // gerçek konumu Manisa Merkez (Sakarya Mah.), Akhisar değil
  "merkez efendi devlet hastanesi": { lat: 38.619460, lng: 27.436492 }, // gerçek konumu Manisa Merkez/Yunusemre, Akhisar değil
  "merkezefendi devlet hastanesi": { lat: 38.619460, lng: 27.436492 },
};

function normalizeNameForLookup(name) {
  return (name || "")
    .toLowerCase()
    .replace(/ş/g, "s").replace(/ı/g, "i").replace(/ğ/g, "g")
    .replace(/ü/g, "u").replace(/ö/g, "o").replace(/ç/g, "c")
    .trim();
}

function applyKnownCoordinateCorrection(place) {
  const fix = KNOWN_COORDINATE_CORRECTIONS[normalizeNameForLookup(place.name)];
  return fix ? { ...place, lat: fix.lat, lng: fix.lng } : place;
}

function hasIrrelevantCategory(rawResult) {
  const cats = [rawResult.category, ...(rawResult.categories || [])].filter(Boolean).map((c) => c.toLowerCase());
  return cats.some((c) => IRRELEVANT_CATEGORY_HINTS.some((hint) => c.includes(hint)));
}

async function runOpenPlaces(category, lat, lng, radius, limit) {
  const query = OPEN_PLACES_QUERY[category];
  if (!query) return [];
  const results = await openPlacesSearch(query, lat, lng, radius, Math.min(Number(limit) || 8, 20));
  // Same hard-radius enforcement as runOsm above — don't just trust the
  // provider's own radius filter. This is exactly the bug that let a
  // mall in İzmir show up while searching near Manisa: whatever the
  // cause on their end (a soft/best-effort radius, or a mismapped
  // coordinate in the open dataset for that one listing), checking the
  // real distance ourselves catches it regardless of which it was.
  return (results || [])
    .filter((r) => isLikelyRealBusiness(r.name))
    .filter((r) => !hasIrrelevantCategory(r))
    .filter((r) => isCategoryRelevant(category, r.name))
    .filter((r) => nameMatchesQueryAsWord(r.name, query))
    .map((r, idx) => shapeOpenPlace(r, category, idx))
    .map((p) => applyKnownCoordinateCorrection(p))
    .filter((p) => p.lat != null && p.lng != null)
    .map((p) => ({ ...p, _distance: haversineMeters(Number(lat), Number(lng), p.lat, p.lng) }))
    .filter((p) => p._distance <= Number(radius))
    .sort((a, b) => a._distance - b._distance)
    .slice(0, Math.min(Number(limit) || 8, 20))
    .map(({ _distance, ...p }, idx) => ({ ...p, idx }));
}

// Artık tek bir mantık var, tüm 50 kategoriye uygulanıyor — küçük özel bir
// liste tutmak yerine: OSM'de gerçek bir etiketi olan her kategori önce
// OSM'den deneniyor (yapılandırılmış kategoriye bakıyor, metne değil, bu
// yüzden "ATM" ararken "Katmer" ya da "Fatma" gibi alakasız isimler asla
// çıkmıyor). OSM gerçekten hiçbir şey bulamazsa (ya da o kategori için
// hiç OSM etiketi yoksa, örn. Yol Yardım), Open Places'ın metin
// aramasına düşülüyor — artık o da üstteki genel kelime-eşleşme ve
// kategori-dışlama kontrollerinden geçtiği için eskisi kadar gürültülü
// değil. "Kim önce cevap verirse" yarışı tamamen kaldırıldı: doğruluk,
// hızdan daha önemli.
function hasReliableOsmTag(category) {
  const tags = OSM_TAG_CONFIG[category];
  return !!tags && tags.length > 0;
}

// Aynı gerçek yer (bir hastane kampüsü, bir belediye binası, bir okul),
// Overture'ın ya da OSM'in veri setinde birden fazla kayıt olarak
// bulunabiliyor — resmi tam ismi ile halk arasındaki kısa ismi, ya da bir
// kurumun ayrı bir bölümü/servisi ayrı bir "yer" gibi kaydedilmiş
// olabiliyor. İsimler birbirinden farklı olduğu için isme göre
// tekilleştirme bunları yakalayamıyor. Bunun yerine: konumları birbirine
// çok yakınsa (150 metre içinde), muhtemelen aynı yerdir — isme
// bakmaksızın sadece en yakın (listede zaten mesafeye göre sıralı
// olduğu için ilk geçen) kayıt tutuluyor.
function dedupeByProximity(places, thresholdMeters = 150) {
  const kept = [];
  for (const p of places) {
    const isDuplicate = kept.some((k) => haversineMeters(k.lat, k.lng, p.lat, p.lng) <= thresholdMeters);
    if (!isDuplicate) kept.push(p);
  }
  return kept.map((p, idx) => ({ ...p, idx }));
}

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

  try {
    let shaped = [];
    if (hasReliableOsmTag(category)) {
      shaped = await runOsm(category, lat, lng, radius, limit).catch((err) => {
        console.error("Overpass lookup failed:", err.message || err);
        return [];
      });
    }
    if (shaped.length === 0) {
      shaped = await runOpenPlaces(category, lat, lng, radius, limit).catch((err) => {
        console.error("Open Places lookup failed:", err.message || err);
        return [];
      });
    }
    shaped = dedupeByProximity(shaped);
    cache.set(key, { ts: Date.now(), data: shaped });
    res.json(shaped);
  } catch (err) {
    console.error(err);
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
