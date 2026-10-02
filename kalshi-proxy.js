/** Node 18+ proxy for Kalshi public market data. */
import express from "express";

const app = express();
const upstream = "https://external-api.kalshi.com/trade-api/v2";

app.get("/api/kalshi/*", async (req, res) => {
  const suffix = req.originalUrl.replace(/^\/api\/kalshi/, "");
  try {
    const response = await fetch(upstream + suffix, { headers: { Accept: "application/json" } });
    const body = await response.text();
    res.status(response.status);
    res.type(response.headers.get("content-type") || "application/json");
    res.set("Cache-Control", "public, max-age=10");
    res.send(body);
  } catch (error) {
    res.status(502).json({ error: "Falha ao consultar a Kalshi", detail: String(error.message || error) });
  }
});

app.use(express.static("public"));
app.listen(process.env.PORT || 3000, () => console.log("http://localhost:3000"));
