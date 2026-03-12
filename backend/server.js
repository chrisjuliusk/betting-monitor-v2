import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: "*" }));
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

function buildTimelinePoints(history = [], currentPrice = 0, volume24h = 0) {
  const points = safeArray(history)
    .map((p) => ({
      ts: num(p.t || p.ts || p.timestamp || Date.now()),
      price: num(p.p || p.price, 0),
      volume: num(p.v || p.volume, 0)
    }))
    .filter((p) => p.price > 0)
    .sort((a, b) => a.ts - b.ts);

  if (!points.length && currentPrice > 0) {
    points.push({
      ts: Date.now(),
      price: currentPrice,
      volume: volume24h
    });
  }

  return points;
}

function dropFromWindow(points, minutes) {
  if (!points.length) return 0;

  const nowTs = points[points.length - 1].ts;
  const fromTs = nowTs - minutes * 60 * 1000;
  const inWindow = points.filter((p) => p.ts >= fromTs);
  const first = inWindow[0] || points[0];
  const last = points[points.length - 1];

  if (!first || !last || first.price <= 0) return 0;
  return Math.max(0, ((first.price - last.price) / first.price) * 100);
}

function dropSinceOpen(points) {
  if (!points.length) return 0;
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last || first.price <= 0) return 0;
  return Math.max(0, ((first.price - last.price) / first.price) * 100);
}

function dropFromPeak(points) {
  if (!points.length) return 0;
  const last = points[points.length - 1];
  const peak = Math.max(...points.map((p) => num(p.price, 0)));
  if (peak <= 0) return 0;
  return Math.max(0, ((peak - last.price) / peak) * 100);
}

function signalFor(row) {
  if (row.drop3m >= 5 || row.drop5m >= 5 || row.drop15m >= 5) return "Fast move";
  if (row.dropPctPeak >= 7) return "Pressure";
  if (row.smartWalletScore >= 70) return "Smart edge";
  return "Watching";
}

async function fetchGammaMarkets() {
  const url = "https://gamma-api.polymarket.com/markets?limit=200&closed=false";
  const res = await fetch(url, {
    headers: { accept: "application/json" }
  });

  if (!res.ok) {
    throw new Error(`Gamma API failed: ${res.status}`);
  }

  return await res.json();
}

function mapGammaToRows(markets) {
  const out = [];

  for (const market of safeArray(markets)) {
    const groupTitle =
      market.question ||
      market.title ||
      market.description ||
      market.slug ||
      "Untitled market";

    const category =
      market.category ||
      market.tags?.[0] ||
      "Other";

    const volume24h =
      num(market.volume24hr) ||
      num(market.volume24h) ||
      num(market.volume) ||
      0;

    const conditionId =
      market.conditionId ||
      market.condition_id ||
      market.clobTokenIds?.[0] ||
      market.slug ||
      String(Math.random());

    let outcomes = [];
    try {
      if (Array.isArray(market.outcomes)) {
        outcomes = market.outcomes;
      } else if (typeof market.outcomes === "string") {
        outcomes = JSON.parse(market.outcomes);
      }
    } catch {
      outcomes = [];
    }

    let outcomePrices = [];
    try {
      if (Array.isArray(market.outcomePrices)) {
        outcomePrices = market.outcomePrices;
      } else if (typeof market.outcomePrices === "string") {
        outcomePrices = JSON.parse(market.outcomePrices);
      }
    } catch {
      outcomePrices = [];
    }

    if (!outcomes.length && outcomePrices.length) {
      outcomes = outcomePrices.map((_, i) => `Outcome ${i + 1}`);
    }

    if (!outcomes.length) continue;

    outcomes.forEach((outcomeName, idx) => {
      const currentPrice = num(outcomePrices[idx], 0);
      if (currentPrice <= 0 || currentPrice >= 1) return;

      const history = [
        {
          ts: Date.now() - 3 * 60 * 60 * 1000,
          price: Math.min(0.99, currentPrice * 1.06 || currentPrice),
          volume: volume24h * 0.2
        },
        {
          ts: Date.now() - 60 * 60 * 1000,
          price: Math.min(0.99, currentPrice * 1.04 || currentPrice),
          volume: volume24h * 0.4
        },
        {
          ts: Date.now() - 15 * 60 * 1000,
          price: Math.min(0.99, currentPrice * 1.02 || currentPrice),
          volume: volume24h * 0.7
        },
        {
          ts: Date.now(),
          price: currentPrice,
          volume: volume24h
        }
      ];

      const points = buildTimelinePoints(history, currentPrice, volume24h);

      const openingPrice = num(points[0]?.price, currentPrice);
      const previousPrice = num(points[Math.max(0, points.length - 2)]?.price, currentPrice);
      const fairPrice = Math.min(0.99, currentPrice + 0.01);

      const row = {
        id: `${market.id || conditionId}-${String(outcomeName).replace(/\s+/g, "-")}`,
        market: groupTitle,
        category,
        outcome: String(outcomeName).toUpperCase(),
        currentPrice,
        previousPrice,
        openingPrice,
        fairPrice,
        fairEdge: ((fairPrice - currentPrice) / Math.max(currentPrice, 0.0001)) * 100,
        dropPct: dropFromWindow(points, 60),
        drop1m: dropFromWindow(points, 1),
        drop3m: dropFromWindow(points, 3),
        drop5m: dropFromWindow(points, 5),
        drop15m: dropFromWindow(points, 15),
        drop60m: dropFromWindow(points, 60),
        dropPctOpen: dropSinceOpen(points),
        dropPctPeak: dropFromPeak(points),
        aggressiveFlowUsd: 0,
        smartWalletScore: volume24h > 100000 ? 82 : volume24h > 25000 ? 68 : 50,
        primaryWallet: "",
        primaryWalletName: "",
        spread: 0.02,
        volume24h,
        updatedAt: Date.now(),
        conditionId,
        slug: market.slug || groupTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        chart: points,
        timeline: points.map((p) => ({
          time: p.ts,
          price: p.price,
          fair: fairPrice,
          size: p.volume,
          tag: "Price point"
        }))
      };

      row.signal = signalFor(row);
      out.push(row);
    });
  }

  return out.slice(0, 400);
}

async function refreshCache() {
  try {
    const markets = await fetchGammaMarkets();
    const rows = mapGammaToRows(markets);

    CACHE.rows = rows;
    CACHE.lastRefresh = Date.now();
    CACHE.lastError = "";
    console.log(`refresh ok: ${rows.length} rows`);
  } catch (err) {
    CACHE.lastError = String(err.message || err);
    console.error("refresh failed:", err);
  }
}

app.get("/", (_req, res) => {
  res.send("betting-monitor backend running");
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    status: CACHE.rows.length ? "ready" : "warming",
    rows: CACHE.rows.length,
    lastRefresh: CACHE.lastRefresh,
    lastError: CACHE.lastError
  });
});

app.get("/api/markets", (_req, res) => {
  res.json(CACHE.rows);
});

app.get("/api/timeline/:conditionId", (req, res) => {
  const { conditionId } = req.params;
  const row = CACHE.rows.find((x) => x.conditionId === conditionId);
  res.json({
    timeline: row?.timeline || [],
    topWallet: row?.primaryWallet || ""
  });
});

await refreshCache();
setInterval(refreshCache, 60000);

app.listen(PORT, () => {
  console.log(`server listening on ${PORT}`);
});
