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

await refreshCache();
setInterval(refreshCache, 60000);

app.listen(PORT, () => {
  console.log(`server listening on ${PORT}`);
});
