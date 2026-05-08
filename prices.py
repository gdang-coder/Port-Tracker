import time
import yfinance as yf

_cache: dict[str, tuple[float, float]] = {}  # symbol -> (price, timestamp)
CACHE_TTL = 300  # 5 minutes


def get_prices(symbols: list[str]) -> dict[str, float | None]:
    now = time.time()
    result: dict[str, float | None] = {}
    stale = [s for s in symbols if s not in _cache or now - _cache[s][1] > CACHE_TTL]

    if stale:
        try:
            tickers = yf.Tickers(" ".join(stale))
            for sym in stale:
                try:
                    info = tickers.tickers[sym].fast_info
                    price = info.last_price
                    _cache[sym] = (float(price), now)
                except Exception:
                    _cache[sym] = (None, now)
        except Exception:
            for sym in stale:
                _cache[sym] = (None, now)

    for sym in symbols:
        result[sym] = _cache[sym][0] if sym in _cache else None
    return result
