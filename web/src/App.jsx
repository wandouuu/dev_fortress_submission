import React, { useState, useEffect, useCallback, useRef } from "react";
import { useOpenAiGlobal } from "./hooks/useOpenAiGlobal.js";

/* ──────────────────────────────────────────────
 *  Crypto Market Monitor – Athena Widget
 *
 *  Interactions:
 *   1. Sort by: price change, volume, market cap
 *   2. Timeframe toggle: 24h / 7d / 30d
 * ────────────────────────────────────────────── */

// ── Formatting helpers ──
const fmt = (n, decimals = 2) => {
  if (n == null) return "—";
  if (Math.abs(n) >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${Number(n).toFixed(decimals)}`;
};

const fmtPrice = (n) => {
  if (n == null) return "—";
  if (n >= 1) return `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `$${Number(n).toFixed(6)}`;
};

const fmtPct = (n) => {
  if (n == null) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${Number(n).toFixed(2)}%`;
};

// ── Timeframe config ──
const TIMEFRAMES = [
  { label: "24h", days: "1", changeKey: "percent_change_24h" },
  { label: "7d", days: "7", changeKey: "percent_change_7d" },
  { label: "30d", days: "30", changeKey: "percent_change_30d" },
];

// ── Sort options ──
const SORT_OPTIONS = [
  { label: "Price Δ", key: "change" },
  { label: "Volume", key: "volume_24h" },
  { label: "Mkt Cap", key: "market_cap" },
];

// CoinPaprika → CoinGecko mapping
const PAPRIKA_TO_GECKO = {
  "btc-bitcoin": "bitcoin",
  "eth-ethereum": "ethereum",
  "sol-solana": "solana",
  "ada-cardano": "cardano",
  "xrp-xrp": "ripple",
  "doge-dogecoin": "dogecoin",
  "dot-polkadot": "polkadot",
  "link-chainlink": "chainlink",
  "avax-avalanche": "avalanche-2",
  "matic-polygon": "matic-network",
};

// ── Mock data for local dev ──
const MOCK_COINS = [
  { id: "btc-bitcoin", name: "Bitcoin", symbol: "BTC", price: 70797, volume_24h: 46600786035, market_cap: 1416067798557, percent_change_24h: 0.56, percent_change_7d: 3.62, percent_change_30d: 8.12 },
  { id: "eth-ethereum", name: "Ethereum", symbol: "ETH", price: 3456, volume_24h: 18200000000, market_cap: 415000000000, percent_change_24h: -1.2, percent_change_7d: 2.1, percent_change_30d: 5.4 },
  { id: "sol-solana", name: "Solana", symbol: "SOL", price: 142, volume_24h: 3200000000, market_cap: 62000000000, percent_change_24h: 2.3, percent_change_7d: -1.5, percent_change_30d: 12.1 },
];

// ── Mini sparkline chart (canvas-based) ──
function MiniChart({ candles, width = 320, height = 120 }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !candles || candles.length === 0) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    const closes = candles.map((c) => c.close);
    const min = Math.min(...closes);
    const max = Math.max(...closes);
    const range = max - min || 1;
    const pad = 8;
    const w = width - pad * 2;
    const h = height - pad * 2;

    // Gradient fill
    const isUp = closes[closes.length - 1] >= closes[0];
    const color = isUp ? "#22c55e" : "#ef4444";

    ctx.clearRect(0, 0, width, height);

    // Draw area
    ctx.beginPath();
    closes.forEach((val, i) => {
      const x = pad + (i / (closes.length - 1)) * w;
      const y = pad + h - ((val - min) / range) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });

    // Stroke line
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.stroke();

    // Fill gradient
    const lastX = pad + w;
    ctx.lineTo(lastX, pad + h);
    ctx.lineTo(pad, pad + h);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, isUp ? "rgba(34,197,94,0.25)" : "rgba(239,68,68,0.25)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.fill();

    // Price labels
    ctx.fillStyle = "#6c768a";
    ctx.font = "11px Inter, system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(fmtPrice(max), width - 4, pad + 12);
    ctx.fillText(fmtPrice(min), width - 4, height - 4);
  }, [candles, width, height]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: `${width}px`, height: `${height}px`, display: "block", margin: "0 auto" }}
    />
  );
}

export default function App() {
  const toolOutput = useOpenAiGlobal("toolOutput");
  const [coins, setCoins] = useState([]);
  const [candles, setCandles] = useState([]);
  const [selectedCoin, setSelectedCoin] = useState(null);
  const [timeframe, setTimeframe] = useState(1); // index into TIMEFRAMES
  const [sortBy, setSortBy] = useState("change");
  const [sortAsc, setSortAsc] = useState(false);
  const [chartCoinId, setChartCoinId] = useState("");

  // ── Ingest data from Athena ──
  useEffect(() => {
    const data = toolOutput;
    if (!data) {
      setCoins(MOCK_COINS);
      return;
    }
    if (data.type === "ticker" && data.coins) {
      setCoins(data.coins);
    }
    if (data.type === "ohlcv" && data.candles) {
      setCandles(data.candles);
      setChartCoinId(data.coin_id || "");
    }
  }, [toolOutput]);

  // ── Report height ──
  useEffect(() => {
    const report = () => window.openai?.notifyIntrinsicHeight?.(document.documentElement.scrollHeight);
    report();
    const obs = new ResizeObserver(report);
    obs.observe(document.body);
    return () => obs.disconnect();
  }, [coins, candles]);

  // ── Sorting ──
  const changeKey = TIMEFRAMES[timeframe].changeKey;
  const sorted = [...coins].sort((a, b) => {
    let va, vb;
    if (sortBy === "change") {
      va = a[changeKey] ?? 0;
      vb = b[changeKey] ?? 0;
    } else {
      va = a[sortBy] ?? 0;
      vb = b[sortBy] ?? 0;
    }
    return sortAsc ? va - vb : vb - va;
  });

  // ── Load chart data ──
  const loadChart = useCallback(
    async (coinPaprikaId, tfIndex) => {
      const geckoId = PAPRIKA_TO_GECKO[coinPaprikaId] || coinPaprikaId;
      const tf = TIMEFRAMES[tfIndex ?? timeframe];
      setSelectedCoin(coinPaprikaId);
      setChartCoinId(geckoId);
      if (window.openai?.callTool) {
        await window.openai.callTool("get_crypto_ohlcv", {
          coin_id: geckoId,
          days: tf.days,
        });
      }
    },
    [timeframe]
  );

  // ── Timeframe change ──
  const handleTimeframeChange = (idx) => {
    setTimeframe(idx);
    if (selectedCoin) {
      loadChart(selectedCoin, idx);
    }
  };

  // ── Sort toggle ──
  const handleSort = (key) => {
    if (sortBy === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortBy(key);
      setSortAsc(false);
    }
  };

  const selectedCoinData = coins.find((c) => c.id === selectedCoin);

  return (
    <main className="widget-container">
      {/* ── Header ── */}
      <header className="widget-header">
        <h2 className="widget-title">📊 Crypto Market Monitor</h2>
      </header>

      {/* ── Controls ── */}
      <div className="controls-row">
        {/* Timeframe */}
        <div className="control-group">
          <span className="control-label">Timeframe</span>
          <div className="btn-group">
            {TIMEFRAMES.map((tf, i) => (
              <button
                key={tf.label}
                className={`btn-pill ${timeframe === i ? "btn-pill--active" : ""}`}
                onClick={() => handleTimeframeChange(i)}
              >
                {tf.label}
              </button>
            ))}
          </div>
        </div>

        {/* Sort */}
        <div className="control-group">
          <span className="control-label">Sort by</span>
          <div className="btn-group">
            {SORT_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                className={`btn-pill ${sortBy === opt.key ? "btn-pill--active" : ""}`}
                onClick={() => handleSort(opt.key)}
              >
                {opt.label} {sortBy === opt.key ? (sortAsc ? "↑" : "↓") : ""}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Chart ── */}
      {candles.length > 0 && (
        <div className="chart-card">
          <div className="chart-header">
            <span className="chart-coin-name">
              {selectedCoinData?.symbol || chartCoinId} — {TIMEFRAMES[timeframe].label}
            </span>
          </div>
          <MiniChart candles={candles} width={440} height={140} />
        </div>
      )}

      {/* ── Table ── */}
      <div className="table-wrapper">
        <table className="coin-table">
          <thead>
            <tr>
              <th className="th-name">Coin</th>
              <th className="th-num">Price</th>
              <th className="th-num">Volume (24h)</th>
              <th className="th-num">Market Cap</th>
              <th className="th-num">Change ({TIMEFRAMES[timeframe].label})</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((coin) => {
              const change = coin[changeKey] ?? 0;
              const isSelected = coin.id === selectedCoin;
              return (
                <tr
                  key={coin.id}
                  className={`coin-row ${isSelected ? "coin-row--selected" : ""}`}
                  onClick={() => loadChart(coin.id)}
                >
                  <td className="td-name">
                    <span className="coin-symbol">{coin.symbol}</span>
                    <span className="coin-name-sub">{coin.name}</span>
                  </td>
                  <td className="td-num">{fmtPrice(coin.price)}</td>
                  <td className="td-num">{fmt(coin.volume_24h)}</td>
                  <td className="td-num">{fmt(coin.market_cap)}</td>
                  <td className={`td-num ${change >= 0 ? "pct-up" : "pct-down"}`}>
                    {fmtPct(change)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {sorted.length === 0 && (
        <p className="empty-state">No data. Ask the agent to show crypto prices!</p>
      )}
    </main>
  );
}
