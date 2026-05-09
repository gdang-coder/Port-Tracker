import io
import csv
from flask import Flask, jsonify, request, render_template
import db
import prices

app = Flask(__name__)
db.init_db()

REQUIRED_COLS = {"symbol", "shares"}

# Maps header names to either "cost" (per-share) or "cost_total" (total paid)
COL_ALIASES = {
    "ticker": "symbol",
    "qty": "shares",
    "quantity": "shares",
    # per-share cost
    "avg cost": "cost",
    "avg_cost": "cost",
    "cost per share": "cost",
    "cost_per_share": "cost",
    "average cost": "cost",
    "price paid": "cost",
    "purchase price": "cost",
    "unit cost": "cost",
    # total cost basis (will be divided by shares)
    "cost basis": "cost_total",
    "cost_basis": "cost_total",
    "total cost": "cost_total",
    "total cost basis": "cost_total",
    "average cost basis": "cost_total",
    "book value": "cost_total",
}


def normalise_header(h: str) -> str:
    h = h.strip().lower()
    return COL_ALIASES.get(h, h)


def _parse_num(s: str) -> float:
    return float(s.strip().replace(",", "").replace("$", "").replace("(", "-").replace(")", ""))


def parse_csv(file_bytes: bytes) -> list[dict]:
    text = file_bytes.decode("utf-8-sig").strip()
    reader = csv.DictReader(io.StringIO(text))
    headers = {normalise_header(h): h for h in (reader.fieldnames or [])}

    missing = REQUIRED_COLS - set(headers.keys())
    if missing:
        raise ValueError(
            f"CSV is missing required columns: {', '.join(sorted(missing))}. "
            f"Need: symbol (or ticker), shares (or qty/quantity)"
        )
    has_cost = "cost" in headers
    has_cost_total = "cost_total" in headers
    if not has_cost and not has_cost_total:
        raise ValueError(
            "CSV is missing a cost column. "
            "Need one of: cost, avg_cost, cost_per_share, cost basis, total cost"
        )

    rows = []
    for i, row in enumerate(reader, start=2):
        sym = row[headers["symbol"]].strip().upper()
        if not sym:
            continue
        try:
            shares = _parse_num(row[headers["shares"]])
            if has_cost:
                cost_per_share = _parse_num(row[headers["cost"]])
            else:
                cost_total = _parse_num(row[headers["cost_total"]])
                if shares == 0:
                    raise ValueError(f"Row {i}: shares cannot be zero when computing cost per share from total")
                cost_per_share = cost_total / shares
        except ValueError as e:
            raise ValueError(f"Row {i}: {e}" if "Row" not in str(e) else str(e))
        if shares <= 0 or cost_per_share <= 0:
            raise ValueError(f"Row {i}: shares and cost must be positive")
        rows.append({"symbol": sym, "shares": shares, "cost_per_share": cost_per_share})
    if not rows:
        raise ValueError("CSV has no data rows")
    return rows


def enrich_holdings(holdings):
    """Attach live prices and compute P&L fields."""
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

    summary = {
        "total_value": total_value,
        "total_cost": total_cost,
        "total_gain": total_gain,
        "total_gain_pct": total_gain_pct,
    }
    return enriched, summary


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/portfolio")
def portfolio():
    holdings = db.get_all_holdings()
    enriched, summary = enrich_holdings(holdings)
    return jsonify({"holdings": enriched, "summary": summary})


@app.route("/api/upload", methods=["POST"])
def upload():
    broker = request.form.get("broker", "").strip()
    if not broker:
        return jsonify({"error": "Broker name is required"}), 400
    file = request.files.get("file")
    if not file:
        return jsonify({"error": "No file uploaded"}), 400
    try:
        rows = parse_csv(file.read())
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    db.replace_broker_holdings(broker, rows)

    # Snapshot the full portfolio after update
    all_holdings = db.get_all_holdings()
    enriched, _ = enrich_holdings(all_holdings)
    db.save_snapshot(f"{broker} import · {len(rows)} holdings", enriched)

    return jsonify({"imported": len(rows), "broker": broker})


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


if __name__ == "__main__":
    app.run(debug=True, port=5000)
