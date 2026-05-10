import sqlite3
import json
import os

DB_PATH = os.environ.get("DB_PATH", "portfolio.db")


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with get_conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS holdings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT NOT NULL,
                shares REAL NOT NULL,
                cost_per_share REAL NOT NULL,
                broker TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                taken_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                label TEXT NOT NULL,
                num_holdings INTEGER NOT NULL,
                total_cost REAL NOT NULL,
                total_value REAL,
                holdings_json TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS broker_profiles (
                broker TEXT PRIMARY KEY,
                symbol_col TEXT NOT NULL,
                shares_col TEXT NOT NULL,
                cost_col TEXT NOT NULL,
                cost_is_total INTEGER NOT NULL DEFAULT 0
            )
        """)


def get_all_holdings():
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM holdings ORDER BY broker, symbol"
        ).fetchall()
    return [dict(r) for r in rows]


def upsert_holding(symbol, shares, cost_per_share, broker):
    with get_conn() as conn:
        existing = conn.execute(
            "SELECT id, shares, cost_per_share FROM holdings WHERE symbol=? AND broker=?",
            (symbol.upper(), broker),
        ).fetchone()
        if existing:
            old_shares = existing["shares"]
            old_cost = existing["cost_per_share"]
            new_shares = old_shares + shares
            new_cost = (old_shares * old_cost + shares * cost_per_share) / new_shares
            conn.execute(
                "UPDATE holdings SET shares=?, cost_per_share=? WHERE id=?",
                (new_shares, new_cost, existing["id"]),
            )
            return existing["id"]
        else:
            cur = conn.execute(
                "INSERT INTO holdings (symbol, shares, cost_per_share, broker) VALUES (?,?,?,?)",
                (symbol.upper(), shares, cost_per_share, broker),
            )
            return cur.lastrowid


def delete_holding(holding_id):
    with get_conn() as conn:
        conn.execute("DELETE FROM holdings WHERE id=?", (holding_id,))


def replace_broker_holdings(broker, rows):
    with get_conn() as conn:
        conn.execute("DELETE FROM holdings WHERE broker=?", (broker,))
        conn.executemany(
            "INSERT INTO holdings (symbol, shares, cost_per_share, broker) VALUES (?,?,?,?)",
            [(r["symbol"].upper(), r["shares"], r["cost_per_share"], broker) for r in rows],
        )


# --- Snapshots ---

def save_snapshot(label, enriched_holdings):
    total_cost = sum(h["cost_basis"] for h in enriched_holdings)
    valued = [h for h in enriched_holdings if h.get("market_value") is not None]
    total_value = sum(h["market_value"] for h in valued) if valued else None

    with get_conn() as conn:
        conn.execute(
            """INSERT INTO snapshots (label, num_holdings, total_cost, total_value, holdings_json)
               VALUES (?,?,?,?,?)""",
            (label, len(enriched_holdings), total_cost, total_value, json.dumps(enriched_holdings)),
        )


def get_snapshots():
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, taken_at, label, num_holdings, total_cost, total_value FROM snapshots ORDER BY taken_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def get_snapshot(snapshot_id):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM snapshots WHERE id=?", (snapshot_id,)
        ).fetchone()
    if not row:
        return None
    d = dict(row)
    d["holdings"] = json.loads(d.pop("holdings_json"))
    return d


def delete_snapshot(snapshot_id):
    with get_conn() as conn:
        conn.execute("DELETE FROM snapshots WHERE id=?", (snapshot_id,))


# --- Broker profiles ---

def get_all_broker_profiles():
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM broker_profiles ORDER BY broker"
        ).fetchall()
    return [dict(r) for r in rows]


def get_broker_profile(broker):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM broker_profiles WHERE broker=?", (broker,)
        ).fetchone()
    return dict(row) if row else None


def save_broker_profile(broker, symbol_col, shares_col, cost_col, cost_is_total):
    with get_conn() as conn:
        conn.execute("""
            INSERT INTO broker_profiles (broker, symbol_col, shares_col, cost_col, cost_is_total)
            VALUES (?,?,?,?,?)
            ON CONFLICT(broker) DO UPDATE SET
                symbol_col=excluded.symbol_col,
                shares_col=excluded.shares_col,
                cost_col=excluded.cost_col,
                cost_is_total=excluded.cost_is_total
        """, (broker, symbol_col, shares_col, cost_col, 1 if cost_is_total else 0))


def delete_broker_profile(broker):
    with get_conn() as conn:
        conn.execute("DELETE FROM broker_profiles WHERE broker=?", (broker,))
