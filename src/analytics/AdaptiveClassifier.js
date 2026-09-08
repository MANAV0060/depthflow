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
      return {
        aggressor: event.aggressor,
        provenance: DataProvenance.OBSERVED,
        method: 'EXCHANGE_FLAG'
      };
    }

    const { price, bid, ask, symbol } = event;
    const prevPrice = this.lastPriceMap.get(symbol) || price;
    const prevAggressor = this.lastAggressorMap.get(symbol) || AggressorSide.INFERRED_BUY;

    let classifiedSide = AggressorSide.UNKNOWN;
    let method = 'UNKNOWN';

    // Tier 2: Trade-at-Bid/Ask (Quote Test)
    if (bid > 0 && ask > 0) {
      if (price >= ask) {
        classifiedSide = AggressorSide.INFERRED_BUY;
        method = 'QUOTE_TEST_ASK';
      } else if (price <= bid) {
        classifiedSide = AggressorSide.INFERRED_SELL;
        method = 'QUOTE_TEST_BID';
      } else {
        // Tier 3: Lee-Ready Mid-Spread Test
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

    // Tier 4: Tick Direction Rule (Fallback when mid-price is identical)
    if (classifiedSide === AggressorSide.UNKNOWN) {
      if (price > prevPrice) {
        classifiedSide = AggressorSide.INFERRED_BUY;
        method = 'TICK_RULE_UP';
      } else if (price < prevPrice) {
        classifiedSide = AggressorSide.INFERRED_SELL;
        method = 'TICK_RULE_DOWN';
      } else {
        classifiedSide = prevAggressor; // Maintain previous direction
        method = 'TICK_RULE_ZERO';
      }
    }

    // Update state
    this.lastPriceMap.set(symbol, price);
    this.lastAggressorMap.set(symbol, classifiedSide);

    return {
      aggressor: classifiedSide,
      provenance: DataProvenance.INFERRED,
      method
    };
  }
}
