# mt5_bridge.py
# Production MetaTrader 5 (MT5) to Depthflow WebSocket Bridge
# Supports SQLite persistent historical storage with Write-Ahead Logging (WAL)
# Live tick streaming + Gap backfill + Backward scroll history.

import asyncio
import json
import random
import time
import websockets

try:
    import MetaTrader5 as mt5
    MT5_AVAILABLE = True
except ImportError:
    MT5_AVAILABLE = False
    print("[MT5 Bridge] Warning: MetaTrader5 Python library not installed.")

import os
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    from tools.storage import init_db, save_candles_bulk, load_candles, get_last_timestamp
except ImportError:
    from storage import init_db, save_candles_bulk, load_candles, get_last_timestamp

try:
    from tools.liquidation_engine import liquidation_engine
except ImportError:
    from liquidation_engine import liquidation_engine

PORT = 5555

def find_mt5_symbol(target_symbol):
    """
    Auto-detects broker-specific MT5 symbol names (e.g. EURUSDm, BTCUSDm, XAUUSDm)
    Prioritizes symbols that actually have rate history and active ticks in the terminal.
    """
    if not MT5_AVAILABLE:
        return target_symbol
    
    clean_target = target_symbol.replace("/", "").replace("_", "").upper()
    all_symbols = mt5.symbols_get()
    
    if not all_symbols:
        return clean_target
        
    candidates = []
    for sym in all_symbols:
        sym_name = sym.name.upper()
        if clean_target in sym_name or (clean_target == "XAUUSD" and "GOLD" in sym_name):
            candidates.append(sym.name)
            
    for cand in candidates:
        rates = mt5.copy_rates_from_pos(cand, mt5.TIMEFRAME_M1, 0, 1)
        if rates is not None and len(rates) > 0:
            mt5.symbol_select(cand, True)
            return cand
            
    if candidates:
        mt5.symbol_select(candidates[0], True)
        return candidates[0]
        
    return clean_target

import math

def get_tick_size_for_symbol(symbol):
    s = symbol.upper()
    if "BTC" in s:
        return 5.0
    if "ETH" in s:
        return 0.5
    if "XAU" in s or "GOLD" in s:
        return 0.2
    if "JPY" in s:
        return 0.005
    return 0.00005 # 0.5 pip for pristine Forex footprint ladders

def get_adaptive_tick_size(symbol, high_p, low_p, timeframe="1m"):
    s = (symbol or "").upper()
    candle_range = max(high_p - low_p, 0.00001)

    if "BTC" in s or high_p > 10000:
        allowed_steps = [1, 2, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 250, 500]
        decimals = 2
    elif "ETH" in s or high_p > 1000:
        allowed_steps = [0.1, 0.2, 0.5, 1.0, 2.0, 5.0, 10.0, 20.0]
        decimals = 2
    elif "XAU" in s or "GOLD" in s or high_p > 500:
        allowed_steps = [0.05, 0.10, 0.20, 0.25, 0.50, 1.0, 2.0, 5.0]
        decimals = 2
    elif "JPY" in s:
        allowed_steps = [0.001, 0.002, 0.003, 0.005, 0.010, 0.020, 0.050, 0.100]
        decimals = 3
    else:
        # Forex (EUR/USD, GBP/USD, etc.): 0.1 pip to 2 pips
        allowed_steps = [0.00001, 0.00002, 0.00003, 0.00004, 0.00005, 0.00008, 0.00010, 0.00015, 0.00020]
        decimals = 5

    target_levels = 7
    raw_step = candle_range / target_levels
    tick_size = min(allowed_steps, key=lambda x: abs(x - raw_step))
    return round(tick_size, decimals)

def get_volume_scale_for_symbol(symbol):
    s = symbol.upper()
    if "BTC" in s:
        return 18000 # BTC contracts/units in thousands e.g. 1.2M - 3M
    if "ETH" in s:
        return 12000
    if "XAU" in s or "GOLD" in s:
        return 15000
    return 25000 # Standard Forex lot scale e.g. 1.5M - 3.5M

def synthesize_footprint_cells(symbol, open_p, high_p, low_p, close_p, volume, timeframe="1m"):
    tick_size = get_adaptive_tick_size(symbol, high_p, low_p, timeframe)
    decimals = 5 if tick_size < 0.005 else (2 if tick_size >= 0.1 else 3)

    min_p = round(low_p / tick_size) * tick_size
    max_p = round(high_p / tick_size) * tick_size
    
    steps = max(1, int(round((max_p - min_p) / tick_size)))
    levels = [round(min_p + i * tick_size, decimals) for i in range(steps + 1)]
        
    if not levels:
        levels = [round(close_p, decimals)]
        
    poc_raw = ((open_p + close_p * 2) / 3)
    poc_p = round(round(poc_raw / tick_size) * tick_size, decimals)
    if poc_p not in levels:
        poc_p = levels[len(levels) // 2]
        
    # Analytical POC determination:
    # Volume-weighted center between open, close, and candle midpoint
    poc_raw = (open_p + close_p * 2.0 + (high_p + low_p) * 0.5) / 3.5
    poc_p = round(round(poc_raw / tick_size) * tick_size, decimals)
    if poc_p not in levels:
        poc_p = levels[len(levels) // 2]
        
    # Deterministic Gaussian bell curve centered on POC
    sigma = max(1.8, len(levels) / 3.2)
    total_weight = 0.0
    weights = {}
    for lvl in levels:
        dist = abs(lvl - poc_p) / (tick_size or 1)
        gaussian = math.exp(-0.5 * ((dist / sigma) ** 2))
        in_body = (min(open_p, close_p) - tick_size * 0.5) <= lvl <= (max(open_p, close_p) + tick_size * 0.5)
        body_boost = 1.15 if in_body else 0.85
        w = max(0.05, gaussian * body_boost)
        weights[lvl] = w
        total_weight += w
        
    scale = get_volume_scale_for_symbol(symbol)
    raw_vol = int(volume or 45)
    vol_pool = max(len(levels) * 1200, raw_vol * scale)
    
    sorted_levels = sorted(levels, reverse=True)
    num_lvls = len(sorted_levels)
    
    # Net directional pressure of the candle
    is_bull = close_p > open_p
    is_bear = close_p < open_p
    candle_range = max(high_p - low_p, tick_size)
    body_pct = abs(close_p - open_p) / candle_range
    
    # Base buy ratio reflects bar net delta
    if is_bull:
        base_buy_ratio = 0.50 + min(0.25, 0.10 + body_pct * 0.15)
    elif is_bear:
        base_buy_ratio = 0.50 - min(0.25, 0.10 + body_pct * 0.15)
    else:
        base_buy_ratio = 0.50
        
    cells = []
    for idx, lvl in enumerate(sorted_levels):
        lvl_vol = max(100, int((weights[lvl] / total_weight) * vol_pool))
        pos = idx / max(1, num_lvls - 1)
        
        # Deterministic ratio modulation across price levels
        if pos < 0.15:
            buy_ratio = base_buy_ratio - (0.08 if is_bull else 0.04)
        elif pos > 0.85:
            buy_ratio = base_buy_ratio + (0.08 if is_bear else 0.04)
        elif lvl == poc_p:
            buy_ratio = base_buy_ratio + (0.05 if is_bull else -0.05)
        else:
            ratio_offset = 0.04 * math.sin(idx * math.pi / max(1, num_lvls - 1))
            buy_ratio = base_buy_ratio + (ratio_offset if is_bull else -ratio_offset)
            
        buy_ratio = max(0.15, min(0.85, buy_ratio))
        buy_vol = max(10, int(lvl_vol * buy_ratio))
        sell_vol = max(10, lvl_vol - buy_vol)
        actual_cell_vol = buy_vol + sell_vol
        delta = buy_vol - sell_vol
        
        cells.append({
            "price": lvl,
            "buyVolume": buy_vol,
            "sellVolume": sell_vol,
            "totalVolume": actual_cell_vol,
            "delta": delta
        })
        
    # Enforce exact Bar Delta = sum(cell.delta)
    total_delta = sum(c["delta"] for c in cells)
    
    # Deterministic delta bounds
    if is_bull:
        min_delta = min(0, int(-abs(total_delta) * 0.15))
        max_delta = max(total_delta, int(total_delta * 1.1))
    elif is_bear:
        max_delta = max(0, int(abs(total_delta) * 0.15))
        min_delta = min(total_delta, int(total_delta * 1.1))
    else:
        half = abs(total_delta) or int(vol_pool * 0.05)
        max_delta = half
        min_delta = -half

    return cells, poc_p, total_delta, max_delta, min_delta

MT5_TIMEFRAMES = {
    "1m": (getattr(mt5, "TIMEFRAME_M1", 1), 60000),
    "5m": (getattr(mt5, "TIMEFRAME_M5", 5), 300000),
    "15m": (getattr(mt5, "TIMEFRAME_M15", 15), 900000),
    "30m": (getattr(mt5, "TIMEFRAME_M30", 30), 1800000),
    "1h": (getattr(mt5, "TIMEFRAME_H1", 16385), 3600000),
    "4h": (getattr(mt5, "TIMEFRAME_H4", 16388), 14400000),
    "1d": (getattr(mt5, "TIMEFRAME_D1", 16408), 86400000),
    "d": (getattr(mt5, "TIMEFRAME_D1", 16408), 86400000)
}

def sync_and_load_candles(mt5_symbol, ui_symbol, count=1000, timeframe="1m", before_ts=None):
    """
    Backfills missing candles from MT5 into SQLite, and returns persisted historical bars.
    Supports both initial load (most recent N bars) and backward scroll pagination (prior to before_ts).
    """
    init_db()
    tf_entry = MT5_TIMEFRAMES.get(timeframe, (getattr(mt5, "TIMEFRAME_M1", 1), 60000))
    tf_code, tf_duration = tf_entry

    if MT5_AVAILABLE:
        rates = None
        if before_ts:
            date_from = int(before_ts / 1000)
            rates = mt5.copy_rates_from(mt5_symbol, tf_code, date_from, count)
        else:
            rates = mt5.copy_rates_from_pos(mt5_symbol, tf_code, 0, count)

        if rates is not None and len(rates) > 0:
            batch = []
            for r in rates:
                start_time = int(r['time']) * 1000
                open_p = float(r['open'])
                high_p = float(r['high'])
                low_p = float(r['low'])
                close_p = float(r['close'])
                vol = int(r['tick_volume'])
                
                cells, poc_p, total_delta, max_delta, min_delta = synthesize_footprint_cells(
                    ui_symbol, open_p, high_p, low_p, close_p, vol, timeframe=timeframe
                )
                
                batch.append({
                    "startTime": start_time,
                    "endTime": start_time + tf_duration,
                    "symbol": ui_symbol,
                    "open": open_p,
                    "high": high_p,
                    "low": low_p,
                    "close": close_p,
                    "totalVolume": sum(c["totalVolume"] for c in cells),
                    "totalDelta": total_delta,
                    "maxDelta": max_delta,
                    "minDelta": min_delta,
                    "pocPrice": poc_p,
                    "cells": cells,
                    "fidelity": "RECONSTRUCTED_HISTORICAL_BARS",
                    "provenance": "RECONSTRUCTED_HISTORICAL_FOOTPRINT"
                })
            save_candles_bulk(batch, timeframe)
            if batch:
                return batch

    # Load from persistent SQLite database
    persisted = load_candles(ui_symbol, timeframe, limit=count, before_ts=before_ts)
    return persisted

async def send_candles_in_safe_chunks(websocket, symbol, timeframe, all_candles, chunk_size=350):
    if not all_candles:
        return
    # The most recent chunk is sent as initial_candles
    recent_chunk = all_candles[-chunk_size:] if len(all_candles) > chunk_size else all_candles
    await websocket.send(json.dumps({
        "type": "initial_candles",
        "symbol": symbol,
        "timeframe": timeframe,
        "candles": recent_chunk
    }))
    print(f"[MT5 Bridge] Sent {len(recent_chunk)} initial candles ({timeframe}) for {symbol}")

    # The older chunks are sent as history_candles (prepending seamlessly)
    if len(all_candles) > chunk_size:
        remaining = all_candles[:-chunk_size]
        while remaining:
            chunk = remaining[-chunk_size:]
            remaining = remaining[:-chunk_size]
            await websocket.send(json.dumps({
                "type": "history_candles",
                "symbol": symbol,
                "timeframe": timeframe,
                "candles": chunk
            }))
            print(f"[MT5 Bridge] Streamed {len(chunk)} older history candles ({timeframe}) for {symbol}")
            await asyncio.sleep(0.01)

async def handle_client(websocket, path=None):
    print(f"[MT5 Bridge] Client connected from {websocket.remote_address}")
    
    if not MT5_AVAILABLE:
        print("[MT5 Bridge] MT5 library unavailable.")
        await websocket.send(json.dumps({"error": "MetaTrader5 library not installed on host PC"}))
        return

    if not mt5.initialize():
        error_code = mt5.last_error()
        print(f"[MT5 Bridge] MT5 initialization failed. Error: {error_code}")
        await websocket.send(json.dumps({"error": f"MT5 terminal not running or failed to initialize (Error: {error_code})"}))
        return

    print("[MT5 Bridge] Connected to MT5 terminal successfully!")
    active_ui_symbol = "EUR/USD"
    active_timeframe = "1m"
    mt5_symbol = find_mt5_symbol(active_ui_symbol)
    print(f"[MT5 Bridge] Initial active symbol: '{active_ui_symbol}' -> MT5 symbol '{mt5_symbol}'")

    init_tick = mt5.symbol_info_tick(mt5_symbol)
    last_known_bid = init_tick.bid if init_tick else 0.0
    last_known_ask = init_tick.ask if init_tick else 0.0
    last_tick_time = init_tick.time_msc if init_tick else 0
    last_sim_tick_time = time.time()
    current_bar_minute = int(time.time()) // 60

    active_subscriptions = {
        active_ui_symbol: {
            "ui_symbol": active_ui_symbol,
            "mt5_symbol": mt5_symbol,
            "timeframe": active_timeframe,
            "last_tick_time": last_tick_time
        }
    }

    # Load 2000 persistent historical candles on connect for deep context
    initial_candles = sync_and_load_candles(mt5_symbol, active_ui_symbol, 2000, active_timeframe)
    if initial_candles:
        await send_candles_in_safe_chunks(websocket, active_ui_symbol, active_timeframe, initial_candles, chunk_size=350)

    # Dedicated persistent 1m candles for timeframe-independent TPO calculation
    tpo_1m_candles = sync_and_load_candles(mt5_symbol, active_ui_symbol, 2000, "1m")
    if tpo_1m_candles:
        await websocket.send(json.dumps({
            "type": "tpo_1m_candles",
            "symbol": active_ui_symbol,
            "candles": tpo_1m_candles
        }))
        print(f"[MT5 Bridge] Sent {len(tpo_1m_candles)} dedicated 1m candles for TPO analysis ({active_ui_symbol})")

    # Generate & send initial 5-6 month liquidation heatmap
    try:
        heatmap_matrix = liquidation_engine.compute_historical_heatmap(mt5_symbol, active_ui_symbol)
        if heatmap_matrix and heatmap_matrix.get("buckets"):
            await websocket.send(json.dumps({
                "type": "liquidation_heatmap",
                "symbol": active_ui_symbol,
                "data": heatmap_matrix
            }))
            print(f"[MT5 Bridge] Sent liquidation heatmap ({len(heatmap_matrix['buckets'])} active clusters) for {active_ui_symbol}")
    except Exception as e:
        print(f"[MT5 Bridge] Error generating initial liquidation heatmap: {e}")

    async def receive_messages():
        nonlocal active_ui_symbol, mt5_symbol, active_timeframe, last_tick_time, last_known_bid, last_known_ask, last_sim_tick_time, active_subscriptions
        try:
            async for message in websocket:
                try:
                    data = json.loads(message)
                    action = data.get("action")

                    if action == "subscribe" and data.get("symbol"):
                        new_ui_symbol = data.get("symbol")
                        new_mt5_symbol = find_mt5_symbol(new_ui_symbol)
                        new_tf = data.get("timeframe", active_timeframe)
                        active_ui_symbol = new_ui_symbol
                        mt5_symbol = new_mt5_symbol
                        active_timeframe = new_tf
                        
                        last_tick_time = 0
                        last_known_bid = 0.0
                        last_known_ask = 0.0
                        last_sim_tick_time = time.time()

                        fresh_tick = mt5.symbol_info_tick(mt5_symbol)
                        if fresh_tick and fresh_tick.bid > 0:
                            last_known_bid = fresh_tick.bid
                            last_known_ask = fresh_tick.ask
                            last_tick_time = fresh_tick.time_msc

                        active_subscriptions[new_ui_symbol] = {
                            "ui_symbol": new_ui_symbol,
                            "mt5_symbol": new_mt5_symbol,
                            "timeframe": new_tf,
                            "last_tick_time": last_tick_time
                        }

                        print(f"[MT5 Bridge] Added subscription to '{active_ui_symbol}' ({active_timeframe}) -> MT5 '{mt5_symbol}' (Total: {len(active_subscriptions)})")
                        
                        # Load 2000 persistent historical candles for switched symbol & timeframe
                        fresh_candles = sync_and_load_candles(mt5_symbol, active_ui_symbol, 2000, active_timeframe)
                        if fresh_candles:
                            await send_candles_in_safe_chunks(websocket, active_ui_symbol, active_timeframe, fresh_candles, chunk_size=350)

                        # Dedicated persistent 1m candles for timeframe-independent TPO calculation
                        fresh_tpo_1m = sync_and_load_candles(mt5_symbol, active_ui_symbol, 2000, "1m")
                        if fresh_tpo_1m:
                            await websocket.send(json.dumps({
                                "type": "tpo_1m_candles",
                                "symbol": active_ui_symbol,
                                "candles": fresh_tpo_1m
                            }))
                            print(f"[MT5 Bridge] Sent {len(fresh_tpo_1m)} dedicated 1m candles for TPO analysis ({active_ui_symbol})")

                        # Update liquidation heatmap for switched symbol
                        try:
                            fresh_heatmap = liquidation_engine.compute_historical_heatmap(mt5_symbol, active_ui_symbol)
                            if fresh_heatmap and fresh_heatmap.get("buckets"):
                                await websocket.send(json.dumps({
                                    "type": "liquidation_heatmap",
                                    "symbol": active_ui_symbol,
                                    "data": fresh_heatmap
                                }))
                        except Exception as ex:
                            print(f"[MT5 Bridge] Error generating heatmap for switched symbol: {ex}")

                    elif action == "unsubscribe" and data.get("symbol"):
                        unsub_sym = data.get("symbol")
                        active_subscriptions.pop(unsub_sym, None)
                        print(f"[MT5 Bridge] Unsubscribed from '{unsub_sym}' (Remaining: {len(active_subscriptions)})")

                    elif action == "set_timeframe":
                        new_tf = data.get("timeframe", "1m")
                        if new_tf in MT5_TIMEFRAMES:
                            active_timeframe = new_tf
                            if active_ui_symbol in active_subscriptions:
                                active_subscriptions[active_ui_symbol]["timeframe"] = new_tf
                            fresh_candles = sync_and_load_candles(mt5_symbol, active_ui_symbol, 2000, active_timeframe)
                            if fresh_candles:
                                await send_candles_in_safe_chunks(websocket, active_ui_symbol, active_timeframe, fresh_candles, chunk_size=350)

                    elif action == "load_history":
                        before_ts = data.get("before_ts")
                        count = int(data.get("count", 400))
                        tf = data.get("timeframe", active_timeframe)
                        older = sync_and_load_candles(mt5_symbol, active_ui_symbol, count=count, timeframe=tf, before_ts=before_ts)
                        if older:
                            chunk_size = 350
                            remaining = older
                            while remaining:
                                chunk = remaining[:chunk_size]
                                remaining = remaining[chunk_size:]
                                await websocket.send(json.dumps({
                                    "type": "history_candles",
                                    "symbol": active_ui_symbol,
                                    "timeframe": tf,
                                    "candles": chunk
                                }))
                                await asyncio.sleep(0.01)
                            print(f"[MT5 Bridge] Loaded {len(older)} older historical bars ({tf}) prior to {before_ts}")

                    elif action == "get_liquidation_heatmap":
                        try:
                            fresh_heatmap = liquidation_engine.compute_historical_heatmap(mt5_symbol, active_ui_symbol)
                            await websocket.send(json.dumps({
                                "type": "liquidation_heatmap",
                                "symbol": active_ui_symbol,
                                "data": fresh_heatmap
                            }))
                        except Exception as ex:
                            print(f"[MT5 Bridge] Error handling get_liquidation_heatmap: {ex}")

                except Exception as ex:
                    print(f"[MT5 Bridge] Message handler error: {ex}")
        except Exception:
            pass

    receiver_task = asyncio.create_task(receive_messages())

    try:
        while True:
            subs_list = list(active_subscriptions.values())
            if not subs_list and mt5_symbol:
                subs_list = [{
                    "ui_symbol": active_ui_symbol,
                    "mt5_symbol": mt5_symbol,
                    "timeframe": active_timeframe,
                    "last_tick_time": last_tick_time
                }]

            for sub in subs_list:
                s_sym = sub.get("mt5_symbol")
                u_sym = sub.get("ui_symbol")
                if not s_sym or not u_sym:
                    continue
                tick = mt5.symbol_info_tick(s_sym)
                if tick and tick.time_msc != sub.get("last_tick_time", 0) and tick.bid > 0:
                    sub["last_tick_time"] = tick.time_msc
                    if u_sym in active_subscriptions:
                        active_subscriptions[u_sym]["last_tick_time"] = tick.time_msc

                    scale = get_volume_scale_for_symbol(u_sym)
                    vol_mult = tick.volume if (tick.volume and tick.volume > 0) else 1
                    payload = {
                        "type": "tick",
                        "symbol": u_sym,
                        "timestamp": tick.time_msc,
                        "bid": tick.bid,
                        "ask": tick.ask,
                        "price": round((tick.bid + tick.ask) / 2, 5 if tick.bid < 500 else 2),
                        "volume": int(vol_mult * scale),
                        "source": "MT5_LIVE"
                    }
                    await websocket.send(json.dumps(payload))

                    sweep_evt = liquidation_engine.process_live_tick(u_sym, payload["price"], payload["volume"])
                    if sweep_evt:
                        await websocket.send(json.dumps(sweep_evt))

            # Check minute rollover to commit finalized bar to SQLite
            now_minute = int(time.time()) // 60
            if now_minute > current_bar_minute:
                current_bar_minute = now_minute
                for sub in subs_list:
                    s_sym = sub.get("mt5_symbol")
                    u_sym = sub.get("ui_symbol")
                    s_tf = sub.get("timeframe", "1m")
                    if s_sym and u_sym:
                        sync_and_load_candles(s_sym, u_sym, 2, s_tf)
                        if s_tf != "1m":
                            sync_and_load_candles(s_sym, u_sym, 2, "1m")

            await asyncio.sleep(0.05)

    except websockets.exceptions.ConnectionClosed:
        print("[MT5 Bridge] Client disconnected")
    except Exception as e:
        print(f"[MT5 Bridge] Client loop exception: {e}")
    finally:
        receiver_task.cancel()

async def main():
    print("=" * 65)
    print("  DEPTHFLOW — METATRADER 5 (MT5) LIVE & PERSISTENT BRIDGE SERVER")
    print("=" * 65)
    print(f"  WebSocket URL: ws://localhost:{PORT}")
    print("  Storage: SQLite WAL mode (data/depthflow_history.db)")
    print("=" * 65)
    
    init_db()
    async with websockets.serve(handle_client, "localhost", PORT, max_size=32 * 1024 * 1024):
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())
