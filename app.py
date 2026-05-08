import io
import csv
from flask import Flask, jsonify, request, render_template
import db
import prices

app = Flask(__name__)
db.init_db()

REQUIRED_COLS = {"symbol", "shares", "cost"}
COL_ALIASES = {
    "ticker": "symbol",
    "qty": "shares",
    "quantity": "shares",
    "avg cost": "cost",
    "avg_cost": "cost",
    "cost per share": "cost",
    "cost_per_share": "cost",
    "average cost": "cost",
    "price paid": "cost",
    "purchase price": "cost",
}


def normalise_header(h: str) -> str:
    h = h.strip().lower()
    return COL_ALIASES.get(h, h)


def parse_csv(file_bytes: bytes) -> list[dict]:
    text = file_bytes.decode("utf-8-sig").strip()
    reader = csv.DictReader(io.StringIO(text))
    headers = {normalise_header(h): h for h in (reader.fieldnames or [])}
    missing = REQUIRED_COLS - set(headers.keys())
    if missing:
        raise ValueError(
            f"CSV is missing required columns: {', '.join(sorted(missing))}. "
            f"Need: symbol (or ticker), shares (or qty/quantity), cost (or avg_cost/cost_per_share)"
        )
    rows = []
    for i, row in enumerate(reader, start=2):
        sym = row[headers["symbol"]].strip().upper()
        if not sym:
            continue
        try:
            shares = float(row[headers["shares"]].replace(",", ""))
            cost = float(row[headers["cost"]].replace(",", "").replace("$", ""))
        except ValueError:
            raise ValueError(f"Row {i}: shares and cost must be numbers")
        if shares <= 0 or cost <= 0:
            raise ValueError(f"Row {i}: shares and cost must be positive")
        rows.append({"symbol": sym, "shares": shares, "cost_per_share": cost})
    if not rows:
        raise ValueError("CSV has no data rows")
    return rows


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/portfolio")
def portfolio():
    holdings = db.get_all_holdings()
    if not holdings:
        return jsonify({"holdings": [], "summary": {"total_value": 0, "total_cost": 0, "total_gain": 0, "total_gain_pct": 0}})

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

    return jsonify({
        "holdings": enriched,
        "summary": {
            "total_value": total_value,
            "total_cost": total_cost,
            "total_gain": total_gain,
            "total_gain_pct": total_gain_pct,
        },
    })


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


if __name__ == "__main__":
    app.run(debug=True, port=5000)
