import io
import re
import math
import json
import threading
import pandas as pd
from flask import Flask, jsonify, request, render_template
import db
import prices

try:
    import pdfplumber
    import anthropic
    _PDF_AVAILABLE = True
except ImportError:
    _PDF_AVAILABLE = False

app = Flask(__name__)
db.init_db()

# ─────────────────────────────────────────────────────────────────────────────
# CSV import — robust pandas-based parser
# ─────────────────────────────────────────────────────────────────────────────

# A line counts as a header only if it contains one of these "critical" words.
_CRITICAL_HEADER_WORDS = {
    'symbol', 'ticker', 'stock', 'security',
    'shares', 'quantity', 'qty', 'units', 'cusip',
}

# Maps normalised column names to a semantic role.
_COL_ALIASES = {
    # symbol
    'ticker': 'symbol', 'stock': 'symbol', 'security': 'symbol',
    'symbol': 'symbol',
    # shares
    'qty': 'shares', 'quantity': 'shares', 'units': 'shares',
    'shares': 'shares',
    # per-share cost
    'cost': 'cost',
    'avg cost': 'cost', 'avg_cost': 'cost',
    'cost per share': 'cost', 'cost_per_share': 'cost',
    'average cost': 'cost', 'average cost basis': 'cost',
    'price paid': 'cost', 'purchase price': 'cost',
    'unit cost': 'cost', 'book cost per share': 'cost',
    # total cost (will be divided by shares)
    'cost basis': 'cost_total', 'cost_basis': 'cost_total',
    'total cost': 'cost_total', 'total cost basis': 'cost_total',
    'cost basis total': 'cost_total',
    'book value': 'cost_total', 'book cost': 'cost_total',
    'amount paid': 'cost_total',
}

# Strict ticker symbol: 1-10 chars, uppercase letters/digits, optional . or -
# This filters out junk like "Account Total", "Cash & Money Market", "--"
_SYMBOL_RE = re.compile(r'^[A-Z][A-Z0-9.\-]{0,9}$')


def _norm(s) -> str:
    return str(s or '').strip().lower()


def _parse_num(s) -> float:
    """Parse a numeric cell, tolerating $, commas, %, parens for negatives.
    Returns 0.0 for anything unparseable, blank, or non-finite (NaN/Inf)."""
    if s is None:
        return 0.0
    cleaned = (
        str(s).strip()
              .replace(',', '').replace('$', '')
              .replace('%', '').replace(' ', '')
    )
    if not cleaned or cleaned.upper() in {'-', '--', 'N/A', 'NA', 'NAN', 'NONE', 'NULL'}:
        return 0.0
    if cleaned.startswith('(') and cleaned.endswith(')'):
        cleaned = '-' + cleaned[1:-1]
    try:
        v = float(cleaned)
    except (ValueError, TypeError):
        return 0.0
    if not math.isfinite(v):
        return 0.0
    return v


def _find_header_row_index(text: str) -> int:
    """Find the line index of the actual data header (skipping preamble)."""
    lines = text.splitlines()
    for i, line in enumerate(lines):
        cells = [c.strip().strip('"').lower() for c in line.split(',')]
        for cell in cells:
            for word in _CRITICAL_HEADER_WORDS:
                # exact match, or word followed by space/underscore (e.g. "symbol description")
                if cell == word or cell.startswith(word + ' ') or cell.startswith(word + '_'):
                    return i
    return 0


def _read_csv(file_bytes: bytes) -> pd.DataFrame:
    """Decode and parse the file into a DataFrame, auto-skipping any preamble."""
    text = file_bytes.decode('utf-8-sig', errors='replace')
    skip = _find_header_row_index(text)
    df = pd.read_csv(
        io.StringIO(text),
        skiprows=skip,
        dtype=str,
        keep_default_na=False,
        on_bad_lines='skip',
        engine='python',
    )
    df.columns = [str(c).strip() for c in df.columns]
    df = df.loc[:, [c for c in df.columns if c]]  # drop blank-named columns
    return df


def _detect_mapping(columns: list[str]) -> dict:
    """Pick the best symbol/shares/cost columns from a list of column names.

    Prefers per-share cost columns over total-cost columns when both exist.
    """
    sym, shr, ps_cost, total_cost = [], [], [], []
    for col in columns:
        role = _COL_ALIASES.get(_norm(col))
        if role == 'symbol':
            sym.append(col)
        elif role == 'shares':
            shr.append(col)
        elif role == 'cost':
            ps_cost.append(col)
        elif role == 'cost_total':
            total_cost.append(col)

    mapping = {'symbol': None, 'shares': None, 'cost': None, 'cost_is_total': False}
    if sym:
        mapping['symbol'] = sym[0]
    if shr:
        mapping['shares'] = shr[0]
    if ps_cost:
        mapping['cost'] = ps_cost[0]
        mapping['cost_is_total'] = False
    elif total_cost:
        mapping['cost'] = total_cost[0]
        mapping['cost_is_total'] = True
    return mapping


def _parse_with_mapping(file_bytes: bytes, mapping: dict) -> list[dict]:
    """Parse a CSV using an explicit column mapping. Returns valid holdings.

    If mapping['account'] is set, each returned row carries its own 'account'
    pulled from that column (per-row). Otherwise rows have no account key
    and the caller decides what account to assign.
    """
    df = _read_csv(file_bytes)
    columns = list(df.columns)

    sym_col = mapping.get('symbol')
    shr_col = mapping.get('shares')
    cost_col = mapping.get('cost')
    acct_col = mapping.get('account') or None
    cost_is_total = bool(mapping.get('cost_is_total'))

    if not (sym_col and shr_col and cost_col):
        raise ValueError("Symbol, shares, and cost columns must all be selected.")

    required = [sym_col, shr_col, cost_col]
    if acct_col:
        required.append(acct_col)
    missing = [c for c in required if c not in columns]
    if missing:
        raise ValueError(
            f"Column(s) not in file: {', '.join(missing)}. "
            f"Available columns: {', '.join(columns)}"
        )

    rows = []
    for _, r in df.iterrows():
        raw_sym = r.get(sym_col)
        sym = str(raw_sym if raw_sym is not None else '').strip().upper()
        if not _SYMBOL_RE.match(sym):
            continue  # skip cash, totals, blank rows, non-ticker symbols
        shares = _parse_num(r.get(shr_col))
        cost_raw = _parse_num(r.get(cost_col))
        if not (math.isfinite(shares) and shares > 0):
            continue
        if not (math.isfinite(cost_raw) and cost_raw > 0):
            continue
        cost_per_share = (cost_raw / shares) if cost_is_total else cost_raw
        if not math.isfinite(cost_per_share) or cost_per_share <= 0 or cost_per_share > 1e7:
            continue
        row = {
            'symbol': sym,
            'shares': float(shares),
            'cost_per_share': float(cost_per_share),
        }
        if acct_col:
            raw_acct = r.get(acct_col)
            row['account'] = str(raw_acct if raw_acct is not None else '').strip()
        rows.append(row)

    if not rows:
        raise ValueError(
            "No valid holdings found. Check the column mapping and the "
            "'cost is total' setting. (Cash positions, summary rows, and "
            "non-ticker symbols are skipped automatically.)"
        )
    return rows


def enrich_holdings(holdings):
    if not holdings:
        return [], {"total_value": 0, "total_cost": 0, "total_gain": 0, "total_gain_pct": 0}

    symbols = list({h["symbol"] for h in holdings})
    current_prices = prices.get_prices(symbols)
    div_yields = prices.get_dividend_yields(symbols)

    enriched = []
    total_value = 0.0
    total_cost = 0.0

    for h in holdings:
        price = current_prices.get(h["symbol"])
        cost_basis = h["shares"] * h["cost_per_share"]
        market_value = h["shares"] * price if price is not None else None
        gain = (market_value - cost_basis) if market_value is not None else None
        gain_pct = (gain / cost_basis * 100) if gain is not None and cost_basis else None

        enriched.append({
            **h,
            "current_price": price,
            "market_value": market_value,
            "cost_basis": cost_basis,
            "gain": gain,
            "gain_pct": gain_pct,
            "dividend_yield": div_yields.get(h["symbol"]),
        })
        total_cost += cost_basis
        if market_value is not None:
            total_value += market_value

    total_gain = total_value - total_cost
    total_gain_pct = (total_gain / total_cost * 100) if total_cost else 0

    return enriched, {
        "total_value": total_value,
        "total_cost": total_cost,
        "total_gain": total_gain,
        "total_gain_pct": total_gain_pct,
    }


# ── Routes ─────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/portfolio")
def portfolio():
    holdings = db.get_all_holdings()
    enriched, summary = enrich_holdings(holdings)
    return jsonify({"holdings": enriched, "summary": summary})


@app.route("/api/upload/preview", methods=["POST"])
def upload_preview():
    """Step 1: return columns found in the file + best-guess mapping."""
    broker = request.form.get("broker", "").strip()
    if not broker:
        return jsonify({"error": "Broker name is required"}), 400
    file = request.files.get("file")
    if not file:
        return jsonify({"error": "No file uploaded"}), 400

    file_bytes = file.read()
    try:
        df = _read_csv(file_bytes)
    except Exception as e:
        return jsonify({"error": f"Could not read CSV: {e}"}), 400
    columns = list(df.columns)

    if not columns:
        return jsonify({"error": "No columns found. Is this a valid CSV file?"}), 400

    # Use saved profile if one exists, otherwise auto-detect
    profile = db.get_broker_profile(broker)
    if profile:
        mapping = {
            "symbol": profile["symbol_col"],
            "shares": profile["shares_col"],
            "cost": profile["cost_col"],
            "account": profile.get("account_col") or None,
            "cost_is_total": bool(profile["cost_is_total"]),
        }
        source = "profile"
    else:
        mapping = _detect_mapping(columns)
        source = "auto"

    sample_rows = [
        [str(cell) if cell is not None else '' for cell in row]
        for row in df.head(6).values.tolist()
    ]

    return jsonify({
        "columns": columns,
        "rows": sample_rows,
        "mapping": mapping,
        "source": source,
        "has_profile": profile is not None,
    })


@app.route("/api/upload/confirm", methods=["POST"])
def upload_confirm():
    """Step 2: import with a confirmed column mapping, optionally save profile."""
    broker = request.form.get("broker", "").strip()
    account = request.form.get("account", "").strip()
    if not broker:
        return jsonify({"error": "Broker name is required"}), 400
    file = request.files.get("file")
    if not file:
        return jsonify({"error": "No file uploaded"}), 400

    mapping_str = request.form.get("mapping", "")
    try:
        mapping = json.loads(mapping_str)
    except (json.JSONDecodeError, TypeError):
        return jsonify({"error": "Invalid mapping data"}), 400

    save_profile = request.form.get("save_profile") == "true"

    try:
        rows = _parse_with_mapping(file.read(), mapping)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    if mapping.get("account"):
        # Each row has its own account — replace ALL holdings of this broker
        db.replace_broker_all_holdings(broker, rows)
        where = f"{broker} (multi-account)"
    else:
        db.replace_account_holdings(broker, account, rows)
        where = f"{broker} · {account}" if account else broker

    if save_profile:
        db.save_broker_profile(
            broker,
            mapping["symbol"],
            mapping["shares"],
            mapping["cost"],
            mapping.get("cost_is_total", False),
            mapping.get("account") or "",
        )

    label = f"{where} import · {len(rows)} holdings"
    threading.Thread(target=_snapshot_async, args=(label,), daemon=True).start()

    return jsonify({"imported": len(rows), "broker": broker, "account": account})


@app.route("/api/upload/parse-pdf", methods=["POST"])
def upload_parse_pdf():
    if not _PDF_AVAILABLE:
        return jsonify({"error": "PDF support not installed (pip install pdfplumber anthropic)"}), 500

    broker = request.form.get("broker", "").strip()
    account = request.form.get("account", "").strip()
    if not broker:
        return jsonify({"error": "Broker name is required"}), 400
    file = request.files.get("file")
    if not file:
        return jsonify({"error": "No file uploaded"}), 400

    # Extract text from PDF
    try:
        pdf_bytes = file.read()
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            pages_text = [page.extract_text() or "" for page in pdf.pages]
        text = "\n\n".join(t for t in pages_text if t.strip())
    except Exception as e:
        return jsonify({"error": f"Could not read PDF: {e}"}), 400

    if not text.strip():
        return jsonify({"error": "Could not extract text from PDF. The file may be scanned — try a text-based PDF export from your broker."}), 400

    # Send to Claude
    try:
        client = anthropic.Anthropic()
        msg = client.messages.create(
            model="claude-opus-4-7",
            max_tokens=4096,
            messages=[{
                "role": "user",
                "content": (
                    "Extract all stock/ETF/fund holdings from this brokerage statement.\n"
                    "Return ONLY a valid JSON array. Each element must have:\n"
                    '  "symbol": ticker symbol string (e.g. "AAPL")\n'
                    '  "shares": number of shares owned (decimal number)\n'
                    '  "cost_per_share": average cost per share in USD (decimal number)\n\n'
                    "Rules:\n"
                    "- Include only equity positions with valid ticker symbols\n"
                    "- Skip cash, money market, total rows, options, and bonds\n"
                    "- If cost is shown as a total, divide by shares to get per-share cost\n"
                    "- Return ONLY the JSON array, no markdown fences, no explanation\n\n"
                    f"Statement text:\n{text[:15000]}"
                ),
            }],
        )
        response_text = msg.content[0].text.strip()
        # Strip markdown code fences if present
        response_text = re.sub(r'^```(?:json)?\s*', '', response_text)
        response_text = re.sub(r'\s*```$', '', response_text)
        json_match = re.search(r'\[.*\]', response_text, re.DOTALL)
        if not json_match:
            return jsonify({"error": "AI could not identify any holdings in this document."}), 400
        raw_holdings = json.loads(json_match.group())
    except Exception as e:
        return jsonify({"error": f"AI parsing error: {e}"}), 500

    clean = []
    for h in raw_holdings:
        sym = str(h.get("symbol") or "").strip().upper()
        if not _SYMBOL_RE.match(sym):
            continue
        try:
            shares = float(h.get("shares") or 0)
            cost = float(h.get("cost_per_share") or 0)
        except (TypeError, ValueError):
            continue
        if not (math.isfinite(shares) and shares > 0 and math.isfinite(cost) and cost > 0):
            continue
        clean.append({"symbol": sym, "shares": shares, "cost_per_share": cost})

    if not clean:
        return jsonify({"error": "No valid holdings found. Ensure the PDF contains position data with symbols and cost basis."}), 400

    return jsonify({"holdings": clean, "count": len(clean)})


@app.route("/api/upload/pdf-confirm", methods=["POST"])
def upload_pdf_confirm():
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data provided"}), 400

    broker = (data.get("broker") or "").strip()
    account = (data.get("account") or "").strip()
    holdings = data.get("holdings", [])

    if not broker:
        return jsonify({"error": "Broker name is required"}), 400
    if not holdings:
        return jsonify({"error": "No holdings to import"}), 400

    rows = []
    for h in holdings:
        sym = str(h.get("symbol") or "").strip().upper()
        if not _SYMBOL_RE.match(sym):
            continue
        try:
            shares = float(h.get("shares") or 0)
            cost = float(h.get("cost_per_share") or 0)
        except (TypeError, ValueError):
            continue
        if shares <= 0 or cost <= 0:
            continue
        rows.append({"symbol": sym, "shares": shares, "cost_per_share": cost})

    if not rows:
        return jsonify({"error": "No valid holdings after validation"}), 400

    db.replace_account_holdings(broker, account, rows)

    label = f"{broker}{' · ' + account if account else ''} PDF import · {len(rows)} holdings"
    threading.Thread(target=_snapshot_async, args=(label,), daemon=True).start()

    return jsonify({"imported": len(rows), "broker": broker, "account": account})


def _snapshot_async(label: str):
    try:
        all_holdings = db.get_all_holdings()
        enriched, _ = enrich_holdings(all_holdings)
        db.save_snapshot(label, enriched)
    except Exception as e:
        print(f"Background snapshot failed: {e}")


@app.route("/api/holding", methods=["POST"])
def add_holding():
    data = request.get_json()
    try:
        symbol = data["symbol"].strip().upper()
        shares = float(data["shares"])
        cost = float(data["cost_per_share"])
        broker = data["broker"].strip()
        account = (data.get("account") or "").strip()
    except (KeyError, TypeError, ValueError):
        return jsonify({"error": "Invalid data. Need symbol, shares, cost_per_share, broker"}), 400
    if not symbol or not broker or shares <= 0 or cost <= 0:
        return jsonify({"error": "All fields required; shares and cost must be positive"}), 400
    holding_id = db.upsert_holding(symbol, shares, cost, broker, account)
    return jsonify({"id": holding_id})


@app.route("/api/holding/<int:holding_id>", methods=["PUT"])
def update_holding(holding_id):
    data = request.get_json()
    try:
        symbol = data["symbol"].strip().upper()
        shares = float(data["shares"])
        cost = float(data["cost_per_share"])
    except (KeyError, TypeError, ValueError):
        return jsonify({"error": "Invalid data. Need symbol, shares, cost_per_share"}), 400
    if not symbol or shares <= 0 or cost <= 0:
        return jsonify({"error": "Symbol required; shares and cost must be positive"}), 400
    if not _SYMBOL_RE.match(symbol):
        return jsonify({"error": f"Invalid ticker symbol: {symbol}"}), 400
    db.update_holding(holding_id, symbol, shares, cost)
    return jsonify({"ok": True})


@app.route("/api/holding/<int:holding_id>", methods=["DELETE"])
def delete_holding(holding_id):
    db.delete_holding(holding_id)
    return jsonify({"ok": True})


# --- Snapshot endpoints ---

@app.route("/api/snapshots", methods=["GET"])
def list_snapshots():
    return jsonify(db.get_snapshots())


@app.route("/api/snapshots", methods=["POST"])
def create_snapshot():
    label = (request.get_json() or {}).get("label", "Manual snapshot")
    label = label.strip() or "Manual snapshot"
    all_holdings = db.get_all_holdings()
    if not all_holdings:
        return jsonify({"error": "No holdings to snapshot"}), 400
    enriched, _ = enrich_holdings(all_holdings)
    db.save_snapshot(label, enriched)
    return jsonify({"ok": True})


@app.route("/api/snapshots/<int:snapshot_id>", methods=["GET"])
def get_snapshot(snapshot_id):
    snap = db.get_snapshot(snapshot_id)
    if not snap:
        return jsonify({"error": "Not found"}), 404
    return jsonify(snap)


@app.route("/api/snapshots/<int:snapshot_id>", methods=["DELETE"])
def delete_snapshot(snapshot_id):
    db.delete_snapshot(snapshot_id)
    return jsonify({"ok": True})


# --- Source (broker, account) management ---

@app.route("/api/sources", methods=["GET"])
def list_sources():
    return jsonify(db.get_sources())


@app.route("/api/sources", methods=["DELETE"])
def delete_source():
    broker = (request.args.get("broker") or "").strip()
    if not broker:
        return jsonify({"error": "broker required"}), 400
    if "account" in request.args:
        db.delete_account(broker, (request.args.get("account") or "").strip())
    else:
        db.delete_broker(broker)
    return jsonify({"ok": True})


# --- Broker profile endpoints ---

@app.route("/api/broker-profiles", methods=["GET"])
def list_broker_profiles():
    return jsonify(db.get_all_broker_profiles())


@app.route("/api/broker-profiles/<broker>", methods=["DELETE"])
def delete_broker_profile(broker):
    db.delete_broker_profile(broker)
    return jsonify({"ok": True})


# ── Transactions ──────────────────────────────────────────────────────────────

# Column aliases for transaction CSVs
_TX_COL_ALIASES = {
    'date': 'date', 'trade date': 'date', 'transaction date': 'date',
    'settle date': 'date', 'run date': 'date', 'activity date': 'date',
    'posted date': 'date', 'settlement date': 'date',
    'action': 'action', 'transaction type': 'action', 'type': 'action',
    'description': 'description', 'transaction description': 'description',
    'symbol': 'symbol', 'ticker': 'symbol', 'security': 'symbol',
    'shares': 'shares', 'quantity': 'shares', 'qty': 'shares',
    'price': 'price', 'price ($)': 'price', 'price per share': 'price',
    'amount': 'amount', 'amount ($)': 'amount', 'net amount': 'amount',
    'total amount': 'amount', 'value': 'amount', 'net': 'amount',
    'fees': 'fees', 'commission': 'fees', 'fee': 'fees', 'charges': 'fees',
    'account': 'account', 'account number': 'account',
}

_ACTION_MAP = [
    (['reinvest', 'drip'], 'reinvest'),
    (['dividend', 'div ', 'divid', 'qual div', 'cash div', 'ord div', 'spec div'], 'dividend'),
    (['interest', 'int '], 'interest'),
    (['bought', 'buy', 'purchase', 'you bought'], 'buy'),
    (['sold', 'sell', 'sale', 'you sold'], 'sell'),
    (['fee', 'commission', 'charge', 'margin interest'], 'fee'),
    (['transfer', 'journaled', 'acat', 'internal transfer'], 'transfer'),
    (['deposit', 'contribution', 'journal'], 'deposit'),
    (['withdrawal', 'disbursement'], 'withdrawal'),
]

def _normalize_action(raw: str) -> str:
    s = str(raw or '').lower().strip()
    for keywords, action in _ACTION_MAP:
        if any(kw in s for kw in keywords):
            return action
    return 'other'

def _detect_tx_mapping(columns):
    m = {r: None for r in ('date', 'action', 'symbol', 'shares', 'price', 'amount', 'fees', 'description')}
    for col in columns:
        role = _TX_COL_ALIASES.get(_norm(col))
        if role and m.get(role) is None:
            m[role] = col
    return m

def _parse_date(raw: str) -> str | None:
    """Try to parse a date string to YYYY-MM-DD."""
    s = str(raw or '').strip()
    if not s or s in ('-', '--', 'n/a'):
        return None
    for fmt in ('%m/%d/%Y', '%Y-%m-%d', '%m/%d/%y', '%d/%m/%Y', '%B %d, %Y', '%b %d, %Y', '%Y%m%d'):
        try:
            from datetime import datetime
            return datetime.strptime(s, fmt).strftime('%Y-%m-%d')
        except ValueError:
            pass
    # Fall back: first 10 chars if they look like YYYY-MM-DD
    if len(s) >= 10 and s[4] == '-' and s[7] == '-':
        return s[:10]
    return None

def _parse_tx_rows(file_bytes: bytes, mapping: dict, broker: str, account: str) -> list[dict]:
    df = _read_csv(file_bytes)
    columns = list(df.columns)

    date_col   = mapping.get('date')
    action_col = mapping.get('action') or mapping.get('description')
    sym_col    = mapping.get('symbol')
    shr_col    = mapping.get('shares')
    price_col  = mapping.get('price')
    amt_col    = mapping.get('amount')
    fees_col   = mapping.get('fees')
    desc_col   = mapping.get('description')
    acct_col   = mapping.get('account')

    if not date_col:
        raise ValueError("A Date column must be mapped.")
    if not action_col and not amt_col:
        raise ValueError("At least an Action or Amount column must be mapped.")
    missing = [c for c in [date_col, action_col, sym_col, shr_col, price_col, amt_col, fees_col, desc_col, acct_col]
               if c and c not in columns]
    if missing:
        raise ValueError(f"Column(s) not in file: {', '.join(missing)}")

    rows = []
    for _, r in df.iterrows():
        trade_date = _parse_date(r.get(date_col) if date_col else None)
        if not trade_date:
            continue

        raw_action = str(r.get(action_col) or r.get(desc_col) or '').strip()
        action = _normalize_action(raw_action)

        sym_raw = str(r.get(sym_col) or '' if sym_col else '').strip().upper()
        symbol = sym_raw if _SYMBOL_RE.match(sym_raw) else ''

        shares_raw = _parse_num(r.get(shr_col)) if shr_col else None
        shares = shares_raw if shares_raw and shares_raw != 0 else None

        price_raw = _parse_num(r.get(price_col)) if price_col else None
        price = price_raw if price_raw and price_raw != 0 else None

        amount_raw = _parse_num(r.get(amt_col)) if amt_col else None
        amount = amount_raw if amt_col else None

        fees_raw = _parse_num(r.get(fees_col)) if fees_col else None
        fees = fees_raw if fees_raw and fees_raw != 0 else 0.0

        desc = str(r.get(desc_col) or '').strip()[:200] if desc_col else ''
        row_account = str(r.get(acct_col) or account or '').strip() if acct_col else (account or '')

        rows.append({
            'trade_date': trade_date,
            'symbol': symbol,
            'action': action,
            'raw_action': raw_action[:100],
            'shares': shares,
            'price': price,
            'amount': amount,
            'fees': fees,
            'broker': broker,
            'account': row_account,
            'description': desc,
        })

    if not rows:
        raise ValueError("No valid transaction rows found. Check the Date column mapping.")
    return rows


@app.route("/api/transactions", methods=["GET"])
def list_transactions():
    start = request.args.get('start')
    end = request.args.get('end')
    broker = request.args.get('broker')
    return jsonify(db.get_transactions(start_date=start, end_date=end, broker=broker))


@app.route("/api/transactions/summary", methods=["GET"])
def transactions_summary():
    start = request.args.get('start')
    end = request.args.get('end')
    return jsonify(db.get_transaction_summary(start_date=start, end_date=end))


@app.route("/api/transactions/<int:tx_id>", methods=["DELETE"])
def delete_transaction(tx_id):
    db.delete_transaction(tx_id)
    return jsonify({"ok": True})


@app.route("/api/transactions/upload/preview", methods=["POST"])
def tx_upload_preview():
    broker = request.form.get("broker", "").strip()
    if not broker:
        return jsonify({"error": "Broker name is required"}), 400
    file = request.files.get("file")
    if not file:
        return jsonify({"error": "No file uploaded"}), 400
    file_bytes = file.read()
    try:
        df = _read_csv(file_bytes)
    except Exception as e:
        return jsonify({"error": f"Could not read CSV: {e}"}), 400
    columns = list(df.columns)
    if not columns:
        return jsonify({"error": "No columns found."}), 400
    mapping = _detect_tx_mapping(columns)
    sample_rows = [
        [str(cell) if cell is not None else '' for cell in row]
        for row in df.head(6).values.tolist()
    ]
    return jsonify({"columns": columns, "rows": sample_rows, "mapping": mapping})


@app.route("/api/transactions/upload/confirm", methods=["POST"])
def tx_upload_confirm():
    broker = request.form.get("broker", "").strip()
    account = request.form.get("account", "").strip()
    if not broker:
        return jsonify({"error": "Broker name is required"}), 400
    file = request.files.get("file")
    if not file:
        return jsonify({"error": "No file uploaded"}), 400
    mapping_str = request.form.get("mapping", "")
    try:
        mapping = json.loads(mapping_str)
    except (json.JSONDecodeError, TypeError):
        return jsonify({"error": "Invalid mapping data"}), 400
    replace = request.form.get("replace") == "true"
    try:
        rows = _parse_tx_rows(file.read(), mapping, broker, account)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    if replace:
        db.delete_transactions_by_broker_account(broker, account or None)
    count = db.insert_transactions(rows)
    return jsonify({"imported": count, "broker": broker, "account": account})


if __name__ == "__main__":
    app.run(debug=True, port=5000)
