"""
Cryptocurrency Market Monitor – Athena MCP Server

Exposes two tools via FastMCP:
  1. get_crypto_ticker  – live price data from CoinPaprika
  2. get_crypto_ohlcv   – historical OHLCV data from CoinGecko

The widget HTML is served as a text/html+skybridge resource so Athena
renders it inline. Deployed on Railway via uvicorn.
"""

from __future__ import annotations

import os
from copy import deepcopy
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List

import httpx
import mcp.types as types
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
ROOT_DIR = Path(__file__).resolve().parent.parent
WIDGET_DIST = ROOT_DIR / "web" / "dist"

# ---------------------------------------------------------------------------
# Coin ID mapping: CoinPaprika <-> CoinGecko
# ---------------------------------------------------------------------------
COIN_MAP = {
    "btc-bitcoin":    "bitcoin",
    "eth-ethereum":   "ethereum",
    "sol-solana":     "solana",
    "ada-cardano":    "cardano",
    "xrp-xrp":       "ripple",
    "doge-dogecoin":  "dogecoin",
    "dot-polkadot":   "polkadot",
    "link-chainlink": "chainlink",
    "avax-avalanche": "avalanche-2",
    "matic-polygon":  "matic-network",
}

GECKO_TO_PAPRIKA = {v: k for k, v in COIN_MAP.items()}

# Default coins to fetch when showing the dashboard
DEFAULT_COINS = "btc-bitcoin,eth-ethereum,sol-solana,ada-cardano,xrp-xrp,doge-dogecoin,dot-polkadot,link-chainlink,avax-avalanche,matic-polygon"

# ---------------------------------------------------------------------------
# Widget HTML loader
# ---------------------------------------------------------------------------
@lru_cache(maxsize=None)
def _load_widget_html() -> str:
    html_path = WIDGET_DIST / "widget.html"
    if html_path.exists():
        return html_path.read_text(encoding="utf8")

    candidates = sorted(WIDGET_DIST.glob("*.html"))
    if candidates:
        return candidates[0].read_text(encoding="utf8")

    return """<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"/><title>Crypto Widget</title></head>
<body>
  <div id="root"></div>
  <script type="module">
    const data = window.openai?.toolOutput ?? {};
    document.getElementById('root').innerHTML =
      '<pre>' + JSON.stringify(data, null, 2) + '</pre>';
  </script>
</body>
</html>"""


# ---------------------------------------------------------------------------
# Transport security
# ---------------------------------------------------------------------------
def _transport_security() -> TransportSecuritySettings:
    allowed = os.getenv("MCP_ALLOWED_ORIGINS", "").split(",")
    allowed = [o.strip() for o in allowed if o.strip()]
    if not allowed:
        return TransportSecuritySettings(enable_dns_rebinding_protection=False)
    return TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_origins=allowed,
    )


# ---------------------------------------------------------------------------
# FastMCP instance
# ---------------------------------------------------------------------------
MIME_TYPE = "text/html+skybridge"
WIDGET_URI = "ui://widget/crypto-monitor.html"

mcp_server = FastMCP(
    name="crypto-monitor",
    stateless_http=True,
    transport_security=_transport_security(),
)

# ---------------------------------------------------------------------------
# Resource: widget template
# ---------------------------------------------------------------------------
RESOURCE_META: Dict[str, Any] = {
    "openai/widgetPrefersBorder": True,
}

TOOL_META_TICKER: Dict[str, Any] = {
    "openai/outputTemplate": WIDGET_URI,
    "openai/toolInvocation/invoking": "Fetching crypto prices…",
    "openai/toolInvocation/invoked": "Crypto prices loaded",
    "openai/widgetAccessible": True,
}

TOOL_META_OHLCV: Dict[str, Any] = {
    "openai/outputTemplate": WIDGET_URI,
    "openai/toolInvocation/invoking": "Loading chart data…",
    "openai/toolInvocation/invoked": "Chart data loaded",
    "openai/widgetAccessible": True,
}


@mcp_server._mcp_server.list_resources()
async def _list_resources() -> List[types.Resource]:
    return [
        types.Resource(
            name="Crypto Monitor Widget",
            title="Crypto Monitor Widget",
            uri=WIDGET_URI,
            description="Interactive cryptocurrency market monitor widget",
            mimeType=MIME_TYPE,
            _meta=RESOURCE_META,
        )
    ]


@mcp_server._mcp_server.list_resource_templates()
async def _list_resource_templates() -> List[types.ResourceTemplate]:
    return [
        types.ResourceTemplate(
            name="Crypto Monitor Widget",
            title="Crypto Monitor Widget",
            uriTemplate=WIDGET_URI,
            description="Interactive cryptocurrency market monitor widget",
            mimeType=MIME_TYPE,
            _meta=RESOURCE_META,
        )
    ]


async def _handle_read_resource(req: types.ReadResourceRequest) -> types.ServerResult:
    if str(req.params.uri) != WIDGET_URI:
        return types.ServerResult(
            types.ReadResourceResult(
                contents=[],
                _meta={"error": f"Unknown resource: {req.params.uri}"},
            )
        )
    return types.ServerResult(
        types.ReadResourceResult(
            contents=[
                types.TextResourceContents(
                    uri=WIDGET_URI,
                    mimeType=MIME_TYPE,
                    text=_load_widget_html(),
                    _meta=RESOURCE_META,
                )
            ]
        )
    )


mcp_server._mcp_server.request_handlers[types.ReadResourceRequest] = _handle_read_resource

# ---------------------------------------------------------------------------
# Tool schemas
# ---------------------------------------------------------------------------
TICKER_INPUT_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "properties": {
        "coin_ids": {
            "type": "string",
            "description": (
                "Comma-separated CoinPaprika coin IDs "
                "(e.g. 'btc-bitcoin,eth-ethereum,sol-solana'). "
                "Defaults to top 10 coins if omitted."
            ),
        }
    },
    "required": ["coin_ids"],
    "additionalProperties": False,
}

OHLCV_INPUT_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "properties": {
        "coin_id": {
            "type": "string",
            "description": "CoinGecko coin ID (e.g. 'bitcoin', 'ethereum', 'solana')",
        },
        "days": {
            "type": "string",
            "description": "Timeframe: '1' (24h), '7' (7d), or '30' (30d). Defaults to '7'.",
            "default": "7",
        },
    },
    "required": ["coin_id"],
    "additionalProperties": False,
}


# ---------------------------------------------------------------------------
# Tool list
# ---------------------------------------------------------------------------
@mcp_server._mcp_server.list_tools()
async def _list_tools() -> List[types.Tool]:
    return [
        types.Tool(
            name="get_crypto_ticker",
            title="Get Crypto Ticker",
            description=(
                "Fetches live cryptocurrency price data including price, "
                "24h volume, market cap, and percent changes (24h/7d/30d) "
                "for one or more coins. Renders an interactive dashboard widget."
            ),
            inputSchema=deepcopy(TICKER_INPUT_SCHEMA),
            _meta=TOOL_META_TICKER,
            annotations={
                "readOnlyHint": True,
                "destructiveHint": False,
                "openWorldHint": False,
            },
        ),
        types.Tool(
            name="get_crypto_ohlcv",
            title="Get Crypto OHLCV",
            description=(
                "Fetches historical OHLCV (Open/High/Low/Close) candle data "
                "for a cryptocurrency over a selected timeframe (24h, 7d, 30d). "
                "Used for chart rendering in the widget."
            ),
            inputSchema=deepcopy(OHLCV_INPUT_SCHEMA),
            _meta=TOOL_META_OHLCV,
            annotations={
                "readOnlyHint": True,
                "destructiveHint": False,
                "openWorldHint": False,
            },
        ),
    ]


# ---------------------------------------------------------------------------
# Data fetching helpers
# ---------------------------------------------------------------------------
async def _fetch_ticker(client: httpx.AsyncClient, coin_id: str) -> Dict[str, Any] | None:
    """Fetch a single coin's ticker from CoinPaprika and extract only needed fields."""
    try:
        resp = await client.get(f"https://api.coinpaprika.com/v1/tickers/{coin_id}")
        resp.raise_for_status()
        data = resp.json()
        usd = data.get("quotes", {}).get("USD", {})
        return {
            "id": data.get("id", coin_id),
            "name": data.get("name", ""),
            "symbol": data.get("symbol", ""),
            "price": usd.get("price", 0),
            "volume_24h": usd.get("volume_24h", 0),
            "market_cap": usd.get("market_cap", 0),
            "percent_change_24h": usd.get("percent_change_24h", 0),
            "percent_change_7d": usd.get("percent_change_7d", 0),
            "percent_change_30d": usd.get("percent_change_30d", 0),
        }
    except Exception as exc:
        print(f"Error fetching ticker for {coin_id}: {exc}")
        return None


async def _fetch_ohlcv(client: httpx.AsyncClient, coin_id: str, days: str) -> List[Dict[str, Any]]:
    """Fetch OHLCV candles from CoinGecko and transform into structured format."""
    resp = await client.get(
        f"https://api.coingecko.com/api/v3/coins/{coin_id}/ohlc",
        params={"vs_currency": "usd", "days": days},
    )
    resp.raise_for_status()
    raw = resp.json()
    candles = []
    for item in raw:
        if len(item) >= 5:
            ts = item[0]
            candles.append({
                "timestamp": ts,
                "date": datetime.fromtimestamp(ts / 1000, tz=timezone.utc).isoformat(),
                "open": item[1],
                "high": item[2],
                "low": item[3],
                "close": item[4],
            })
    return candles


# ---------------------------------------------------------------------------
# Tool handler
# ---------------------------------------------------------------------------
async def _call_tool(req: types.CallToolRequest) -> types.ServerResult:
    name = req.params.name
    arguments = req.params.arguments or {}

    # ── get_crypto_ticker ──
    if name == "get_crypto_ticker":
        coin_ids_str = arguments.get("coin_ids", DEFAULT_COINS)
        coin_ids = [cid.strip() for cid in coin_ids_str.split(",") if cid.strip()]

        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                coins = []
                for cid in coin_ids:
                    result = await _fetch_ticker(client, cid)
                    if result:
                        coins.append(result)
        except Exception as exc:
            return types.ServerResult(
                types.CallToolResult(
                    content=[types.TextContent(type="text", text=f"API error: {exc}")],
                    isError=True,
                )
            )

        structured = {
            "type": "ticker",
            "coins": coins,
        }

        summary_lines = [f"{c['symbol']}: ${c['price']:,.2f} ({c['percent_change_24h']:+.2f}%)" for c in coins[:5]]
        summary = "Crypto prices loaded.\n" + "\n".join(summary_lines)
        if len(coins) > 5:
            summary += f"\n...and {len(coins) - 5} more"

        return types.ServerResult(
            types.CallToolResult(
                content=[types.TextContent(type="text", text=summary)],
                structuredContent=structured,
                _meta={
                    "openai/toolInvocation/invoking": "Fetching crypto prices…",
                    "openai/toolInvocation/invoked": "Crypto prices loaded",
                },
            )
        )

    # ── get_crypto_ohlcv ──
    if name == "get_crypto_ohlcv":
        coin_id = arguments.get("coin_id", "bitcoin")
        days = arguments.get("days", "7")

        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                candles = await _fetch_ohlcv(client, coin_id, days)
        except Exception as exc:
            return types.ServerResult(
                types.CallToolResult(
                    content=[types.TextContent(type="text", text=f"OHLCV API error: {exc}")],
                    isError=True,
                )
            )

        structured = {
            "type": "ohlcv",
            "coin_id": coin_id,
            "days": days,
            "candles": candles,
        }

        return types.ServerResult(
            types.CallToolResult(
                content=[
                    types.TextContent(
                        type="text",
                        text=f"Loaded {len(candles)} candles for {coin_id} ({days}d timeframe).",
                    )
                ],
                structuredContent=structured,
                _meta={
                    "openai/toolInvocation/invoking": "Loading chart data…",
                    "openai/toolInvocation/invoked": "Chart data loaded",
                },
            )
        )

    # ── Unknown tool ──
    return types.ServerResult(
        types.CallToolResult(
            content=[types.TextContent(type="text", text=f"Unknown tool: {name}")],
            isError=True,
        )
    )


mcp_server._mcp_server.request_handlers[types.CallToolRequest] = _call_tool

# ---------------------------------------------------------------------------
# ASGI app with CORS
# ---------------------------------------------------------------------------
app = mcp_server.streamable_http_app()

try:
    from starlette.middleware.cors import CORSMiddleware

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
        allow_credentials=False,
    )
except Exception:
    pass

# ---------------------------------------------------------------------------
# Local dev entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8787"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
