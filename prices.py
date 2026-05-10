import time
import logging
import yfinance as yf
import pandas as pd

logging.getLogger("yfinance").setLevel(logging.CRITICAL)

# symbol -> (price_or_None, fetched_at)
_cache: dict[str, tuple[float | None, float]] = {}
SUCCESS_TTL = 300  # cache valid prices for 5 min
FAIL_TTL = 60      # only cache failures for 1 min so we retry quickly


def _is_stale(sym: str, now: float) -> bool:
    if sym not in _cache:
        return True
    price, ts = _cache[sym]
    ttl = SUCCESS_TTL if price is not None else FAIL_TTL
    return now - ts > ttl


def get_prices(symbols: list[str]) -> dict[str, float | None]:
    if not symbols:
        return {}

    now = time.time()
    stale = sorted({s for s in symbols if _is_stale(s, now)})

    if stale:
        try:
            data = yf.download(
                stale,
                period="5d",          # 5d so weekends/holidays still return data
                progress=False,
                threads=True,
                timeout=15,
                auto_adjust=True,
            )

            if data is None or data.empty:
                for sym in stale:
                    _cache[sym] = (None, now)
            elif isinstance(data.columns, pd.MultiIndex):
                # Multiple tickers — data['Close'] is a DataFrame keyed by symbol
                closes = data["Close"] if "Close" in data.columns.get_level_values(0) else None
                for sym in stale:
                    price = None
                    if closes is not None and sym in closes.columns:
                        series = closes[sym].dropna()
                        if len(series) > 0:
                            price = float(series.iloc[-1])
                    _cache[sym] = (price, now)
            else:
                # Single ticker — data['Close'] is a Series
                price = None
                if "Close" in data.columns:
                    series = data["Close"].dropna()
                    if len(series) > 0:
                        price = float(series.iloc[-1])
                _cache[stale[0]] = (price, now)

        except Exception as e:
            print(f"[prices] fetch error: {e}")
            for sym in stale:
                _cache[sym] = (None, now)

    return {sym: _cache.get(sym, (None, 0))[0] for sym in symbols}
