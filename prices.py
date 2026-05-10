import time
import logging
import yfinance as yf

logging.getLogger("yfinance").setLevel(logging.CRITICAL)

_cache: dict[str, tuple[float | None, float]] = {}
CACHE_TTL = 300  # 5 minutes


def get_prices(symbols: list[str]) -> dict[str, float | None]:
    if not symbols:
        return {}

    now = time.time()
    stale = [s for s in symbols if s not in _cache or now - _cache[s][1] > CACHE_TTL]

    if stale:
        try:
            # Batch download — one HTTP call for all tickers
            data = yf.download(
                stale,
                period="1d",
                progress=False,
                threads=True,
                timeout=10,
                group_by="ticker",
                auto_adjust=True,
            )
            for sym in stale:
                price = None
                try:
                    if len(stale) == 1:
                        series = data["Close"].dropna()
                    else:
                        if sym in data.columns.get_level_values(0):
                            series = data[sym]["Close"].dropna()
                        else:
                            series = None
                    if series is not None and len(series) > 0:
                        price = float(series.iloc[-1])
                except Exception:
                    price = None
                _cache[sym] = (price, now)
        except Exception:
            for sym in stale:
                _cache[sym] = (None, now)

    return {sym: _cache.get(sym, (None, 0))[0] for sym in symbols}
