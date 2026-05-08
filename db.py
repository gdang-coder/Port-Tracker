import sqlite3
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


def get_all_holdings():
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM holdings ORDER BY broker, symbol"
        ).fetchall()
    return [dict(r) for r in rows]


def upsert_holding(symbol, shares, cost_per_share, broker):
    """Add or update a holding (merges shares if same symbol+broker exists)."""
    with get_conn() as conn:
        existing = conn.execute(
            "SELECT id, shares, cost_per_share FROM holdings WHERE symbol=? AND broker=?",
            (symbol.upper(), broker),
        ).fetchone()
        if existing:
            old_shares = existing["shares"]
            old_cost = existing["cost_per_share"]
            new_shares = old_shares + shares
            # weighted average cost
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
    """Replace all holdings for a broker with the given rows."""
    with get_conn() as conn:
        conn.execute("DELETE FROM holdings WHERE broker=?", (broker,))
        conn.executemany(
            "INSERT INTO holdings (symbol, shares, cost_per_share, broker) VALUES (?,?,?,?)",
            [(r["symbol"].upper(), r["shares"], r["cost_per_share"], broker) for r in rows],
        )
