/**
 * NormalizedMarketEvent.js
 * Explicit Data Schema for Order Flow & Market Telemetry.
 */

export const EventType = {
  QUOTE_UPDATE: 'QUOTE_UPDATE',
  TRADE_EXECUTION: 'TRADE_EXECUTION',
  DEPTH_UPDATE: 'DEPTH_UPDATE'
};

export const VolumeFidelity = {
  TICK_COUNT: 'TICK_COUNT',             // Broker quote tick count
  BROKER_VOLUME: 'BROKER_VOLUME',         // Broker-specific volume (e.g. Dukascopy/cTrader)
  EXCHANGE_VOLUME: 'EXCHANGE_VOLUME'      // Centralized exchange contract volume (e.g. CME Futures)
};

export const DataProvenance = {
  OBSERVED: 'OBSERVED',         // Raw telemetry directly from feed
  INFERRED: 'INFERRED',         // Estimated aggressor or derived metric
  DERIVED: 'DERIVED',           // Mathematical profile calculation
  NEUTRAL: 'NEUTRAL',           // Neutral volume preservation (indeterminate aggressor)
  PROXY: 'PROXY',               // CME Futures proxy data for Spot FX
  SIMULATED: 'SIMULATED'        // Synthetic test telemetry
};

export const AggressorSide = {
  BUY: 'BUY',
  SELL: 'SELL',
  INFERRED_BUY: 'INFERRED_BUY',
  INFERRED_SELL: 'INFERRED_SELL',
  UNKNOWN: 'UNKNOWN'
};

export class NormalizedMarketEvent {
  constructor({
    id = null,
    symbol = 'EUR/USD',
    timestamp = Date.now(),
    eventType = EventType.QUOTE_UPDATE,
    price = 0,
    bid = 0,
    ask = 0,
    size = 1,
    volumeFidelity = VolumeFidelity.TICK_COUNT,
    dataProvenance = DataProvenance.OBSERVED,
    aggressor = AggressorSide.UNKNOWN,
    depthLevels = null,
    source = 'UNKNOWN'
  } = {}) {
    this.id = id || `${timestamp}_${Math.random().toString(36).substring(2, 9)}`;
    this.symbol = symbol;
    this.timestamp = timestamp;
    this.eventType = eventType;
    this.price = price || (bid && ask ? (bid + ask) / 2 : 0);
    this.bid = bid;
    this.ask = ask;
    this.size = size;
    this.volumeFidelity = volumeFidelity;
    this.dataProvenance = dataProvenance;
    this.aggressor = aggressor;
    this.depthLevels = depthLevels; // [{ bidPrice, bidSize, askPrice, askSize }]
    this.source = source;
  }
}
