# storage.py
# High-performance SQLite persistence layer with Write-Ahead Logging (WAL)
# Stores and retrieves aggregated footprint candles across application restarts.

import json
import os
import sqlite3
from typing import List, Dict, Optional

DEFAULT_DB_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
legacy_db = os.path.join(DEFAULT_DB_DIR, "odeerflow_history.db")
DEFAULT_DB_PATH = legacy_db if os.path.exists(legacy_db) else os.path.join(DEFAULT_DB_DIR, "depthflow_history.db")

def get_connection(db_path: str = DEFAULT_DB_PATH) -> sqlite3.Connection:
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=10.0)
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA synchronous = NORMAL;")
    conn.execute("PRAGMA busy_timeout = 5000;")
    conn.row_factory = sqlite3.Row
    return conn

def init_db(db_path: str = DEFAULT_DB_PATH):
    """
    Initializes the footprint candles table with compound primary key.
    """
    conn = get_connection(db_path)
    try:
        with conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS footprint_candles (
                    symbol TEXT NOT NULL,
                    timeframe TEXT NOT NULL,
                    timestamp INTEGER NOT NULL,
                    open REAL NOT NULL,
                    high REAL NOT NULL,
                    low REAL NOT NULL,
                    close REAL NOT NULL,
                    total_volume INTEGER NOT NULL,
                    total_delta INTEGER NOT NULL,
                    max_delta INTEGER NOT NULL,
                    min_delta INTEGER NOT NULL,
                    poc_price REAL NOT NULL,
                    cells_json TEXT NOT NULL,
                    PRIMARY KEY (symbol, timeframe, timestamp)
                );
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_footprint_lookup 
                ON footprint_candles (symbol, timeframe, timestamp DESC);
            """)
    finally:
        conn.close()

def save_candles_bulk(candles: List[Dict], timeframe: str = "1m", db_path: str = DEFAULT_DB_PATH) -> int:
    """
    Inserts or replaces a batch of footprint candles.
    """
    if not candles:
        return 0

    init_db(db_path)
    conn = get_connection(db_path)
    inserted = 0

    try:
        records = []
        for c in candles:
            symbol = c.get("symbol", "BTC/USD")
            ts = int(c.get("startTime", 0))
            open_p = float(c.get("open", 0.0))
            high_p = float(c.get("high", 0.0))
            low_p = float(c.get("low", 0.0))
            close_p = float(c.get("close", 0.0))
            total_vol = int(c.get("totalVolume", 0))
            total_delta = int(c.get("totalDelta", 0))
            max_delta = int(c.get("maxDelta", 0))
            min_delta = int(c.get("minDelta", 0))
            poc_p = float(c.get("pocPrice", open_p))
            
            cells = c.get("cells", [])
            cells_json = json.dumps(cells) if isinstance(cells, (list, dict)) else str(cells)

            records.append((
                symbol, timeframe, ts, open_p, high_p, low_p, close_p,
                total_vol, total_delta, max_delta, min_delta, poc_p, cells_json
            ))

        with conn:
            cursor = conn.executemany("""
                INSERT OR REPLACE INTO footprint_candles (
                    symbol, timeframe, timestamp, open, high, low, close,
                    total_volume, total_delta, max_delta, min_delta, poc_price, cells_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
            """, records)
            inserted = cursor.rowcount
    finally:
        conn.close()

    return inserted

def load_candles(
    symbol: str,
    timeframe: str = "1m",
    limit: int = 150,
    before_ts: Optional[int] = None,
    db_path: str = DEFAULT_DB_PATH
) -> List[Dict]:
    """
    Loads historical footprint candles ordered chronologically.
    """
    init_db(db_path)
    conn = get_connection(db_path)
    candles = []

    try:
        cursor = conn.cursor()
        if before_ts:
            cursor.execute("""
                SELECT symbol, timeframe, timestamp, open, high, low, close,
                       total_volume, total_delta, max_delta, min_delta, poc_price, cells_json
                FROM footprint_candles
                WHERE symbol = ? AND timeframe = ? AND timestamp < ?
                ORDER BY timestamp DESC
                LIMIT ?;
            """, (symbol, timeframe, before_ts, limit))
        else:
            cursor.execute("""
                SELECT symbol, timeframe, timestamp, open, high, low, close,
                       total_volume, total_delta, max_delta, min_delta, poc_price, cells_json
                FROM footprint_candles
                WHERE symbol = ? AND timeframe = ?
                ORDER BY timestamp DESC
                LIMIT ?;
            """, (symbol, timeframe, limit))

        TIMEFRAME_DURATIONS = {
            "1m": 60000,
            "5m": 300000,
            "15m": 900000,
            "1h": 3600000,
            "4h": 14400000,
            "1d": 86400000
        }

        rows = cursor.fetchall()
        for row in reversed(rows): # Return chronological order
            try:
                cells = json.loads(row["cells_json"])
            except Exception:
                cells = []

            tf_dur = TIMEFRAME_DURATIONS.get(row["timeframe"], 60000)
            candles.append({
                "startTime": row["timestamp"],
                "endTime": row["timestamp"] + tf_dur,
                "symbol": row["symbol"],
                "open": row["open"],
                "high": row["high"],
                "low": row["low"],
                "close": row["close"],
                "totalVolume": row["total_volume"],
                "totalDelta": row["total_delta"],
                "maxDelta": row["max_delta"],
                "minDelta": row["min_delta"],
                "pocPrice": row["poc_price"],
                "cells": cells
            })
    finally:
        conn.close()

    return candles

def get_last_timestamp(symbol: str, timeframe: str = "1m", db_path: str = DEFAULT_DB_PATH) -> Optional[int]:
    """
    Retrieves the latest recorded timestamp for a symbol.
    """
    init_db(db_path)
    conn = get_connection(db_path)
    try:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT MAX(timestamp) as max_ts
            FROM footprint_candles
            WHERE symbol = ? AND timeframe = ?;
        """, (symbol, timeframe))
        row = cursor.fetchone()
        return row["max_ts"] if row and row["max_ts"] else None
    finally:
        conn.close()
