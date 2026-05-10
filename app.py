import io
import csv
import json
import threading
from flask import Flask, jsonify, request, render_template
import db
import prices

app = Flask(__name__)
db.init_db()

# At least one of these must appear for a row to be treated as a header
_CRITICAL_HEADER_WORDS = {'symbol', 'ticker', 'stock', 'security', 'shares', 'quantity', 'qty', 'units', 'cusip'}
# Supporting words that, combined with a critical word, confirm it's a header row
_HEADER_WORDS = _CRITICAL_HEADER_WORDS | {
    'cost', 'price', 'value', 'description', 'type',
    'gain', 'loss', 'percent', 'basis', 'average', 'market', 'current',
    'total', 'today', 'change', 'action',
}

# Maps normalised column names to semantic roles
_COL_ALIASES = {
    # symbol
    "ticker": "symbol",
    "stock": "symbol",
    "security": "symbol",
    # shares
    "qty": "shares",
    "quantity": "shares",
    "units": "shares",
    # per-share cost
    "avg cost": "cost",
    "avg_cost": "cost",
    "cost per share": "cost",
    "cost_per_share": "cost",
    "average cost": "cost",
    "average cost basis": "cost",
    "price paid": "cost",
    "purchase price": "cost",
    "unit cost": "cost",
    "book cost per share": "cost",
    # total cost (will be divided by shares)
    "cost basis": "cost_total",
    "cost_basis": "cost_total",
    "total cost": "cost_total",
    "total cost basis": "cost_total",
    "cost basis total": "cost_total",
    "book value": "cost_total",
    "book cost": "cost_total",
    "amount paid": "cost_total",
}


def _norm(s: str) -> str:
    return s.strip().lower()


def _parse_num(s: str) -> float:
    return float(
        s.strip().replace(",", "").replace("$", "")
          .replace("(", "-").replace(")", "").replace("%", "") or "0"
    )


def _find_header_row(text: str) -> str:
    """
    Scan lines top-to-bottom and return the CSV text starting from the
    first line that looks like a real data header. A valid header must:
    - contain at least one critical column word (symbol, shares, quantity…)
    - contain at least 2 total header-word matches across its cells
    Falls back to the full text if nothing found.
    """
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if not line.strip():
            continue
        cells = [c.strip().strip('"').lower() for c in line.split(',')]
        has_critical = any(
            any(crit == cell or cell.startswith(crit) for crit in _CRITICAL_HEADER_WORDS)
            for cell in cells
        )
        if not has_critical:
            continue
        total_matches = sum(1 for c in cells if any(w in c for w in _HEADER_WORDS))
        if total_matches >= 2:
            return "\n".join(lines[i:])
    return text


def _detect_mapping(columns: list[str]) -> dict:
    """Auto-detect column roles from actual column names in the file."""
    mapping = {"symbol": None, "shares": None, "cost": None, "cost_is_total": False}
    for col in columns:
        role = _COL_ALIASES.get(_norm(col), _norm(col))
        if role == "symbol" and not mapping["symbol"]:
            mapping["symbol"] = col
        elif role == "shares" and not mapping["shares"]:
            mapping["shares"] = col
        elif role == "cost" and not mapping["cost"]:
            mapping["cost"] = col
            mapping["cost_is_total"] = False
        elif role == "cost_total" and not mapping["cost"]:
            mapping["cost"] = col
            mapping["cost_is_total"] = True
        # Also catch plain "symbol", "shares", "cost" column names
        elif _norm(col) == "symbol" and not mapping["symbol"]:
            mapping["symbol"] = col
        elif _norm(col) == "shares" and not mapping["shares"]:
            mapping["shares"] = col
        elif _norm(col) == "cost" and not mapping["cost"]:
            mapping["cost"] = col
            mapping["cost_is_total"] = False
    return mapping


def _parse_with_mapping(file_bytes: bytes, mapping: dict) -> list[dict]:
    """Parse a CSV file using an explicit column mapping."""
    text = file_bytes.decode("utf-8-sig").strip()
    csv_text = _find_header_row(text)
    reader = csv.DictReader(io.StringIO(csv_text))
    columns = list(reader.fieldnames or [])

    symbol_col = mapping.get("symbol")
    shares_col = mapping.get("shares")
    cost_col = mapping.get("cost")
    cost_is_total = mapping.get("cost_is_total", False)

    missing = [name for name, col in [("symbol", symbol_col), ("shares", shares_col), ("cost", cost_col)] if not col]
    if missing:
        raise ValueError(f"Missing column mapping for: {', '.join(missing)}")

    # Validate the mapped columns actually exist
    col_set = set(columns)
    bad = [col for col in [symbol_col, shares_col, cost_col] if col not in col_set]
    if bad:
        raise ValueError(f"Columns not found in file: {', '.join(bad)}. Available: {', '.join(columns)}")

    rows = []
    for i, row in enumerate(reader, start=2):
        sym = row.get(symbol_col, "").strip().upper()
        if not sym or sym.startswith("--") or sym.lower() in {"pending", "n/a", ""}:
            continue
        try:
            shares = _parse_num(row[shares_col])
            cost_raw = _parse_num(row[cost_col])
        except ValueError:
            continue  # skip unparseable rows (totals rows, etc.)

        if shares <= 0 or cost_raw <= 0:
            continue  # skip zero/negative rows (cash positions, pending, etc.)

        cost_per_share = cost_raw / shares if cost_is_total else cost_raw
        if cost_per_share <= 0:
            continue

        rows.append({"symbol": sym, "shares": shares, "cost_per_share": cost_per_share})

    if not rows:
        raise ValueError("No valid holdings rows found with the selected columns. Check that the right columns are mapped.")
    return rows


def enrich_holdings(holdings):
    if not holdings:
        return [], {"total_value": 0, "total_cost": 0, "total_gain": 0, "total_gain_pct": 0}

    symbols = list({h["symbol"] for h in holdings})
    current_prices = prices.get_prices(symbols)

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
    text = file_bytes.decode("utf-8-sig").strip()
    csv_text = _find_header_row(text)

    reader = csv.DictReader(io.StringIO(csv_text))
    columns = [c for c in (reader.fieldnames or []) if c and c.strip()]

    if not columns:
        return jsonify({"error": "No columns found. Is this a valid CSV file?"}), 400

    # Use saved profile if one exists, otherwise auto-detect
    profile = db.get_broker_profile(broker)
    if profile:
        mapping = {
            "symbol": profile["symbol_col"],
            "shares": profile["shares_col"],
            "cost": profile["cost_col"],
            "cost_is_total": bool(profile["cost_is_total"]),
        }
        source = "profile"
    else:
        mapping = _detect_mapping(columns)
        source = "auto"

    return jsonify({
        "columns": columns,
        "mapping": mapping,
        "source": source,
        "has_profile": profile is not None,
    })


@app.route("/api/upload/confirm", methods=["POST"])
def upload_confirm():
    """Step 2: import with a confirmed column mapping, optionally save profile."""
    broker = request.form.get("broker", "").strip()
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

    db.replace_broker_holdings(broker, rows)

    if save_profile:
        db.save_broker_profile(
            broker,
            mapping["symbol"],
            mapping["shares"],
            mapping["cost"],
            mapping.get("cost_is_total", False),
        )

    # Snapshot the new state in the background so the request returns fast.
    # Live prices may take several seconds to fetch; we don't make the user wait.
    label = f"{broker} import · {len(rows)} holdings"
    threading.Thread(target=_snapshot_async, args=(label,), daemon=True).start()

    return jsonify({"imported": len(rows), "broker": broker})


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
    except (KeyError, TypeError, ValueError):
        return jsonify({"error": "Invalid data. Need symbol, shares, cost_per_share, broker"}), 400
    if not symbol or not broker or shares <= 0 or cost <= 0:
        return jsonify({"error": "All fields required; shares and cost must be positive"}), 400
    holding_id = db.upsert_holding(symbol, shares, cost, broker)
    return jsonify({"id": holding_id})


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


# --- Broker profile endpoints ---

@app.route("/api/broker-profiles", methods=["GET"])
def list_broker_profiles():
    return jsonify(db.get_all_broker_profiles())


@app.route("/api/broker-profiles/<broker>", methods=["DELETE"])
def delete_broker_profile(broker):
    db.delete_broker_profile(broker)
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(debug=True, port=5000)
