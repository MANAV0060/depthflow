/**
 * AdaptiveClassifier.js
 * Multi-Tiered Aggressor Identification Engine (Lee-Ready + Quote Test + Tick Direction).
 */

import { AggressorSide, DataProvenance } from '../data/NormalizedMarketEvent.js';

export class AdaptiveClassifier {
  constructor() {
    this.lastPriceMap = new Map(); // symbol -> lastPrice
    this.lastAggressorMap = new Map(); // symbol -> lastAggressor
  }

  classify(event) {
    // Tier 1: Direct Exchange Aggressor Flag
    if (event.aggressor === AggressorSide.BUY || event.aggressor === AggressorSide.SELL) {
      if (event.price) this.lastPriceMap.set(event.symbol, event.price);
      this.lastAggressorMap.set(event.symbol, event.aggressor);
      return {
        aggressor: event.aggressor,
        provenance: DataProvenance.OBSERVED,
        method: 'EXCHANGE_FLAG'
      };
    }

    const { price, bid, ask, symbol } = event;
    const hasPrevPrice = this.lastPriceMap.has(symbol);
    const prevPrice = hasPrevPrice ? this.lastPriceMap.get(symbol) : price;
    const prevAggressor = this.lastAggressorMap.get(symbol);

    let classifiedSide = AggressorSide.UNKNOWN;
    let method = 'UNKNOWN';

    // Tier 2: Trade-at-Bid/Ask (Quote Test)
    // Conclusive when trade prints at or outside current spread
    const hasValidQuotes = typeof bid === 'number' && typeof ask === 'number' && bid > 0 && ask > 0 && ask >= bid;
    if (hasValidQuotes) {
      if (price >= ask) {
        classifiedSide = AggressorSide.INFERRED_BUY;
        method = 'QUOTE_TEST_ASK';
      } else if (price <= bid) {
        classifiedSide = AggressorSide.INFERRED_SELL;
        method = 'QUOTE_TEST_BID';
      } else {
        // Tier 3: Lee-Ready Mid-Spread Test (Trade inside the spread)
        const midPrice = (bid + ask) / 2;
        if (price > midPrice) {
          classifiedSide = AggressorSide.INFERRED_BUY;
          method = 'LEE_READY_MID_ABOVE';
        } else if (price < midPrice) {
          classifiedSide = AggressorSide.INFERRED_SELL;
          method = 'LEE_READY_MID_BELOW';
        }
      }
    }

    // Tier 4: Tick Direction Rule (Fallback when trade is exactly at mid-price or quotes are missing)
    if (classifiedSide === AggressorSide.UNKNOWN) {
      if (hasPrevPrice && price > prevPrice) {
        classifiedSide = AggressorSide.INFERRED_BUY;
        method = 'TICK_RULE_UP';
      } else if (hasPrevPrice && price < prevPrice) {
        classifiedSide = AggressorSide.INFERRED_SELL;
        method = 'TICK_RULE_DOWN';
      } else if (hasPrevPrice && price === prevPrice && prevAggressor && prevAggressor !== AggressorSide.UNKNOWN) {
        // Zero-tick rule: price unchanged from previous trade, retain previous known aggressor
        classifiedSide = prevAggressor;
        method = 'TICK_RULE_ZERO';
      } else {
        // Cold start with no price movement and no conclusive quotes
        classifiedSide = AggressorSide.UNKNOWN;
        method = 'INDETERMINATE';
      }
    }

    // Update state
    this.lastPriceMap.set(symbol, price);
    if (classifiedSide !== AggressorSide.UNKNOWN) {
      this.lastAggressorMap.set(symbol, classifiedSide);
    }

    return {
      aggressor: classifiedSide,
      provenance: classifiedSide === AggressorSide.UNKNOWN ? DataProvenance.NEUTRAL : DataProvenance.INFERRED,
      method
    };
  }
}
