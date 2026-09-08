# liquidation_engine.py
# Real-Time & Historical Liquidation Heatmap Engine
# Calculates accumulated leveraged liquidation pools (10x, 25x, 50x, 100x)
# from 5-6 months of MT5 historical bars, and updates dynamically with live ticks.

import time
import math
from typing import Dict, List, Optional, Tuple

try:
    import MetaTrader5 as mt5
    MT5_AVAILABLE = True
except ImportError:
    MT5_AVAILABLE = False

class LiquidationEngine:
    def __init__(self):
        # symbol -> { price_bucket: { "long_liq": float, "short_liq": float, "last_updated": int } }
        self.pools: Dict[str, Dict[float, Dict[str, float]]] = {}
        self.last_sync_time: Dict[str, float] = {}
        self.active_symbol: str = "BTC/USD"
        self.mt5_symbol: str = "BTCUSD"

    def get_bucket_size(self, symbol: str, current_price: float = 70000.0) -> float:
        """
        Determines the price granularity for liquidation clusters.
        """
        s = symbol.upper()
        if "BTC" in s or current_price > 10000:
            return 25.0  # $25 buckets for Bitcoin
        if "ETH" in s or current_price > 1000:
            return 5.0   # $5 buckets for Ethereum
        if "XAU" in s or "GOLD" in s or current_price > 500:
            return 1.0   # $1 buckets for Gold
        if "JPY" in s:
            return 0.05  # 5 pips for Yen pairs
        return 0.0005    # 5 pips for standard Forex (EUR/USD, GBP/USD)

    def snap_to_bucket(self, price: float, bucket_size: float) -> float:
        return round(round(price / bucket_size) * bucket_size, 5 if bucket_size < 0.01 else 2)

    def compute_historical_heatmap(self, mt5_symbol: str, ui_symbol: str, count: int = 35000) -> Dict:
        """
        Fast 5-6 month historical simulation:
        Pulls ~35,000 5-minute bars (equivalent to ~4-5 months) or ~25,000 15-minute bars (~8 months).
        Calculates entry leverage brackets and simulates sweeps chronologically.
        """
        self.active_symbol = ui_symbol
        self.mt5_symbol = mt5_symbol
        
        rates = None
        if MT5_AVAILABLE:
            # Try 5-minute bars first (35,000 bars = ~120 days)
            tf = getattr(mt5, "TIMEFRAME_M5", 5)
            rates = mt5.copy_rates_from_pos(mt5_symbol, tf, 0, count)
            if rates is None or len(rates) == 0:
                # Fallback to 15-minute bars if broker 5m is shorter
                tf = getattr(mt5, "TIMEFRAME_M15", 15)
                rates = mt5.copy_rates_from_pos(mt5_symbol, tf, 0, min(count, 20000))

        if rates is None or len(rates) == 0:
            print(f"[LiquidationEngine] No historical rates available from MT5 for {mt5_symbol}")
            return {"symbol": ui_symbol, "buckets": [], "max_vol": 1.0, "current_price": 0.0}

        latest_price = float(rates[-1]["close"])
        bucket_size = self.get_bucket_size(ui_symbol, latest_price)

        # Leverage tiers with maintenance margin allowances
        # (Leverage multiplier, liquidation distance %, allocation weight)
        LEVERAGE_BRACKETS = [
            (100, 0.009, 0.28),  # 100x: 0.9% distance, 28% of retail volume
            (50,  0.019, 0.35),  # 50x:  1.9% distance, 35% of retail volume
            (25,  0.038, 0.22),  # 25x:  3.8% distance, 22% of retail volume
            (10,  0.095, 0.15),  # 10x:  9.5% distance, 15% of swing volume
        ]

        # In-memory dictionary: bucket_price -> { 'long': float, 'short': float }
        pool: Dict[float, Dict[str, float]] = {}

        # Chronological pass through historical bars
        for r in rates:
            high_p = float(r["high"])
            low_p = float(r["low"])
            open_p = float(r["open"])
            close_p = float(r["close"])
            vol = float(r["tick_volume"])

            # 1. First, simulate LIQUIDATION SWEEPS by this bar's High and Low
            # Any existing short liquidations <= high_p are cleared/swept
            # Any existing long liquidations >= low_p are cleared/swept
            for b_price in list(pool.keys()):
                # If market surged up through short liquidation
                if pool[b_price]["short"] > 0 and high_p >= b_price:
                    # Cleared by high sweep (diminish or remove)
                    pool[b_price]["short"] *= 0.15 # 85% wiped out/swept
                    if pool[b_price]["short"] < 10.0:
                        pool[b_price]["short"] = 0.0

                # If market plunged down through long liquidation
                if pool[b_price]["long"] > 0 and low_p <= b_price:
                    pool[b_price]["long"] *= 0.15 # 85% wiped out/swept
                    if pool[b_price]["long"] < 10.0:
                        pool[b_price]["long"] = 0.0

            # 2. Add new liquidation pools created by this bar
            typical_price = (high_p + low_p + close_p) / 3.0
            is_bullish = close_p >= open_p
            # Bullish bars have more aggressive longs, bearish bars have more shorts
            long_vol_share = (vol * 0.62) if is_bullish else (vol * 0.38)
            short_vol_share = vol - long_vol_share

            # Scale to realistic dollar/contract amounts
            scale = 18000.0 if "BTC" in ui_symbol.upper() else 25000.0

            for lev, dist_pct, weight in LEVERAGE_BRACKETS:
                # Long liquidation is BELOW entry
                long_liq_p = self.snap_to_bucket(typical_price * (1.0 - dist_pct), bucket_size)
                # Short liquidation is ABOVE entry
                short_liq_p = self.snap_to_bucket(typical_price * (1.0 + dist_pct), bucket_size)

                # Estimated liquidation pool volume
                long_usd = long_vol_share * scale * weight
                short_usd = short_vol_share * scale * weight

                if long_liq_p not in pool:
                    pool[long_liq_p] = {"long": 0.0, "short": 0.0}
                pool[long_liq_p]["long"] += long_usd

                if short_liq_p not in pool:
                    pool[short_liq_p] = {"long": 0.0, "short": 0.0}
                pool[short_liq_p]["short"] += short_usd

        self.pools[ui_symbol] = pool
        self.last_sync_time[ui_symbol] = time.time()
        print(f"[LiquidationEngine] Built heatmap from {len(rates)} historical bars for {ui_symbol}. Active pools: {len(pool)}")

        return self.get_active_matrix(ui_symbol, latest_price)

    def process_live_tick(self, ui_symbol: str, price: float, volume: float = 1.0) -> Optional[Dict]:
        """
        Dynamically updates the heatmap with incoming live ticks:
        1. Sweeps any active liquidation pool touched by current price.
        2. Injects small incremental leverage exposure from new volume.
        """
        pool = self.pools.get(ui_symbol)
        if not pool or price <= 0:
            return None

        bucket_size = self.get_bucket_size(ui_symbol, price)
        current_bucket = self.snap_to_bucket(price, bucket_size)

        swept_levels = []
        last_p = self.last_sync_time.get(f"{ui_symbol}_last_p", price)
        self.last_sync_time[f"{ui_symbol}_last_p"] = price

        # Check sweeps:
        # If price moved up (or at current price), check short liquidations <= price
        if price >= last_p:
            for b_price in list(pool.keys()):
                if pool[b_price]["short"] > 0 and b_price <= price:
                    swept_levels.append({
                        "price": b_price,
                        "type": "SHORT_LIQUIDATED",
                        "volume": round(pool[b_price]["short"])
                    })
                    pool[b_price]["short"] = 0.0

        # If price moved down (or at current price), check long liquidations >= price
        if price <= last_p:
            for b_price in list(pool.keys()):
                if pool[b_price]["long"] > 0 and b_price >= price:
                    swept_levels.append({
                        "price": b_price,
                        "type": "LONG_LIQUIDATED",
                        "volume": round(pool[b_price]["long"])
                    })
                    pool[b_price]["long"] = 0.0

        # Incremental accumulation from live tick volume
        scale = 18000.0 if "BTC" in ui_symbol.upper() else 25000.0
        tick_vol = max(1.0, float(volume))
        is_bull = price >= last_p
        long_share = (tick_vol * 0.60) if is_bull else (tick_vol * 0.40)
        short_share = tick_vol - long_share

        LEVERAGE_BRACKETS = [
            (100, 0.009, 0.28),
            (50,  0.019, 0.35),
            (25,  0.038, 0.22),
            (10,  0.095, 0.15),
        ]

        for lev, dist_pct, weight in LEVERAGE_BRACKETS:
            long_liq_p = self.snap_to_bucket(price * (1.0 - dist_pct), bucket_size)
            short_liq_p = self.snap_to_bucket(price * (1.0 + dist_pct), bucket_size)

            l_usd = long_share * scale * weight * 0.02
            s_usd = short_share * scale * weight * 0.02

            if long_liq_p not in pool:
                pool[long_liq_p] = {"long": 0.0, "short": 0.0}
            pool[long_liq_p]["long"] += l_usd

            if short_liq_p not in pool:
                pool[short_liq_p] = {"long": 0.0, "short": 0.0}
            pool[short_liq_p]["short"] += s_usd

        # If any level was swept, emit event immediately
        if swept_levels:
            print(f"[LiquidationEngine] LIVE SWEEP: {len(swept_levels)} pools wiped at price {price}")
            return {
                "type": "liquidation_sweep_event",
                "symbol": ui_symbol,
                "current_price": price,
                "swept": swept_levels,
                "matrix": self.get_active_matrix(ui_symbol, price)
            }
        return None

    def get_active_matrix(self, ui_symbol: str, current_price: float, range_pct: float = 0.22) -> Dict:
        """
        Returns a compact price-density array around the current market price (+/- 22%)
        formatted for blazing-fast 60 FPS HTML5 canvas rendering.
        """
        pool = self.pools.get(ui_symbol, {})
        if not pool or current_price <= 0:
            return {"symbol": ui_symbol, "buckets": [], "max_vol": 1.0, "current_price": current_price}

        min_visible_p = current_price * (1.0 - range_pct)
        max_visible_p = current_price * (1.0 + range_pct)

        buckets = []
        max_total_vol = 1.0

        for p, data in pool.items():
            if min_visible_p <= p <= max_visible_p:
                total = data["long"] + data["short"]
                if total > 5000.0:  # Filter out trivial noise
                    if total > max_total_vol:
                        max_total_vol = total
                    buckets.append({
                        "price": p,
                        "longVol": round(data["long"]),
                        "shortVol": round(data["short"]),
                        "totalVol": round(total)
                    })

        # Sort by price descending
        buckets.sort(key=lambda b: b["price"], reverse=True)

        # Normalize intensities (0.0 to 1.0)
        for b in buckets:
            b["intensity"] = round(min(1.0, b["totalVol"] / (max_total_vol or 1.0)), 3)

        return {
            "symbol": ui_symbol,
            "current_price": current_price,
            "bucket_size": self.get_bucket_size(ui_symbol, current_price),
            "max_vol": round(max_total_vol),
            "buckets": buckets
        }

# Global singleton
liquidation_engine = LiquidationEngine()
