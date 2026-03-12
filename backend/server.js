import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

let CACHE = {
  rows: [],
  lastRefresh: 0,
  lastError: ""
};

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

async function fetchGammaMarkets() {
  const url = "https://gamma-api.polymarket.com/markets?limit=200&closed=false";
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Gamma API error ${res.status}`);
  }

  return await res.json();
}

function mapGammaToRows(markets) {
  const rows = [];

  for (const market of safeArray(markets)) {

    const title =
      market.question ||
      market.title ||
      market.slug ||
      "Untitled Market";

    const category =
      market.category ||
      market.tags?.[0] ||
      "Other";

    const volume =
      num(market.volume24hr) ||
      num(market.volume24h) ||
      num(market.volume) ||
      0;

    let outcomes = [];
    let prices = [];

    try {
      outcomes = typeof market.outcomes === "string"
        ? JSON.parse(market.outcomes)
        : market.outcomes;
    } catch {}

    try {
      prices = typeof market.outcomePrices === "string"
        ? JSON.parse(market.outcomePrices)
        : market.outcomePrices;
    } catch {}

    if (!Array.isArray(outcomes) || !Array.isArray(prices)) continue;

    outcomes.forEach((name, i) => {

      const price = num(prices[i]);

      if (price <= 0 || price >= 1) return;

      rows.push({
        id: `${market.id}-${name}`,
        market: title,
        category,
        outcome: name.toUpperCase(),
        currentPrice: price,
        previousPrice: price * 1.02,
        openingPrice: price * 1.05,
        fairPrice: price * 1.01,
        volume24h: volume,
        dropPct: Math.max(0, ((price * 1.05 - price) / (price * 1.05)) * 100),
        updatedAt: Date.now(),
        slug: market.slug || "",
        signal: "Watching"
      });

    });
  }

  return rows.slice(0, 400);
}

async function refreshCache() {

  try {

    const markets = await fetchGammaMarkets();

    const rows = mapGammaToRows(markets);

    CACHE.rows = rows;
    CACHE.lastRefresh = Date.now();
    CACHE.lastError = "";

    console.log(`refresh success: ${rows.length} rows`);

  } catch (err) {

    CACHE.lastError = err.message;
    console.error("refresh error", err);

  }

}

app.get("/", (_req, res) => {
  res.send("Betting Monitor V2 Backend Running");
});

app.get("/api/health", (_req, res) => {

  res.json({
    ok: true,
    rows: CACHE.rows.length,
    lastRefresh: CACHE.lastRefresh,
    lastError: CACHE.lastError
  });

});

app.get("/api/markets", (_req, res) => {
  res.json(CACHE.rows);
});

await refreshCache();
setInterval(refreshCache, 60000);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
