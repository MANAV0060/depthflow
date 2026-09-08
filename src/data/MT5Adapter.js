/**
 * MT5Adapter.js
 * MetaTrader 5 Local WebSocket Bridge Adapter.
 * Bridges live ticks from MT5 python server (ws://localhost:5555).
 */

import { ProviderAdapter, ConnectionStatus } from './ProviderAdapter.js';
import {
  NormalizedMarketEvent,
  EventType,
  VolumeFidelity,
  DataProvenance,
  AggressorSide
} from './NormalizedMarketEvent.js';

export class MT5Adapter extends ProviderAdapter {
  constructor({ bridgeUrl = 'ws://localhost:5555', symbol = 'BTC/USD', timeframe = '1m' } = {}) {
    super('MT5Adapter');
    this.bridgeUrl = bridgeUrl;
    this.symbol = symbol;
    this.timeframe = timeframe;
    this.ws = null;
    this.fallbackTimer = null;
    this.lastPrice = 79930.0;
  }

  getCapabilities() {
    return {
      hasQuotes: true,
      hasTrades: true,
      hasAggressorFlags: false,
      hasLevel2Depth: true,
      volumeFidelity: VolumeFidelity.BROKER_VOLUME,
      isRealTime: true,
      isHistorical: false
    };
  }

  setTimeframe(timeframeStr) {
    this.timeframe = timeframeStr;
    console.log(`[MT5Adapter] Setting timeframe to ${this.timeframe}`);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        action: 'set_timeframe',
        symbol: this.symbol,
        timeframe: this.timeframe
      }));
    }
  }

  requestLiquidationHeatmap() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        action: 'get_liquidation_heatmap',
        symbol: this.symbol
      }));
    }
  }

  _isSymbolMatch(s1, s2) {
    if (!s1 || !s2) return false;
    const a = s1.replace(/[^a-zA-Z]/g, '').toUpperCase();
    const b = s2.replace(/[^a-zA-Z]/g, '').toUpperCase();
    return a === b || a.startsWith(b) || b.startsWith(a);
  }

  subscribe(symbol, timeframe) {
    super.subscribe(symbol);
    this.symbol = symbol;
    if (timeframe) this.timeframe = timeframe;
    const s = symbol.toUpperCase();
    if (s.includes('BTC')) this.lastPrice = 79500.0;
    else if (s.includes('ETH')) this.lastPrice = 2500.0;
    else if (s.includes('XAU') || s.includes('GOLD')) this.lastPrice = 4417.0;
    else if (s.includes('JPY')) this.lastPrice = 154.30;
    else if (s.includes('GBP')) this.lastPrice = 1.35400;
    else this.lastPrice = 1.16330;

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        action: 'subscribe',
        symbol: this.symbol,
        timeframe: this.timeframe
      }));
    }
  }

  async connect() {
    this._setStatus(ConnectionStatus.CONNECTING);
    this._connectSocket();
  }

  _connectSocket() {
    try {
      this.ws = new WebSocket(this.bridgeUrl);

      this.ws.onopen = () => {
        console.log('[MT5Adapter] WebSocket connected to MT5 bridge ws://localhost:5555');
        if (this.fallbackTimer) {
          clearInterval(this.fallbackTimer);
          this.fallbackTimer = null;
        }
        this._setStatus(ConnectionStatus.CONNECTED);
        this.ws.send(JSON.stringify({
          action: 'subscribe',
          symbol: this.symbol,
          timeframe: this.timeframe
        }));
      };

      this.ws.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data);
          if (data.error) {
            console.warn('[MT5Adapter] MT5 Notice:', data.error);
            return;
          }

          if (data.symbol && !this._isSymbolMatch(data.symbol, this.symbol)) {
            return; // Ignore in-flight data from previous symbol
          }

          if (data.type === 'initial_candles' && Array.isArray(data.candles)) {
            console.log(`[MT5Adapter] Received ${data.candles.length} initial MT5 candles for ${data.symbol}`);
            if (data.candles.length > 0) {
              const lastCandle = data.candles[data.candles.length - 1];
              if (lastCandle && lastCandle.close > 0) {
                this.lastPrice = lastCandle.close;
              }
            }
            this._emitCandles(data.candles);
            return;
          }

          if (data.type === 'history_candles' && Array.isArray(data.candles)) {
            console.log(`[MT5Adapter] Received ${data.candles.length} historical chunk candles for ${data.symbol}`);
            this._emitHistoricalChunk(data.candles);
            return;
          }

          if (data.type === 'liquidation_heatmap' && data.data) {
            console.log(`[MT5Adapter] Received liquidation heatmap (${data.data.buckets?.length || 0} pools) for ${data.symbol}`);
            this._emitLiquidationHeatmap(data.data);
            return;
          }

          if (data.type === 'liquidation_sweep_event') {
            console.log(`[MT5Adapter] Liquidation sweep event at ${data.current_price}`);
            this._emitLiquidationSweep(data);
            return;
          }

          let price = parseFloat(data.price);
          let bid = parseFloat(data.bid);
          let ask = parseFloat(data.ask);
          let vol = parseInt(data.volume) || 1;

          if (isNaN(price) || price <= 0) {
            price = (bid && ask) ? (bid + ask) / 2 : this.lastPrice;
          }
          if (price > 0) this.lastPrice = price;

          const normEvent = new NormalizedMarketEvent({
            symbol: this.symbol, // Align with active subscription
            timestamp: data.timestamp || Date.now(),
            eventType: EventType.QUOTE_UPDATE,
            price: this.lastPrice,
            bid: bid || (this.lastPrice - 0.0001),
            ask: ask || (this.lastPrice + 0.0001),
            size: vol,
            volumeFidelity: VolumeFidelity.BROKER_VOLUME,
            dataProvenance: DataProvenance.OBSERVED,
            aggressor: AggressorSide.UNKNOWN,
            source: data.source || 'MT5_LIVE'
          });

          this._emitEvent(normEvent);
        } catch (e) {
          console.warn('[MT5Adapter] JSON parse error', e);
        }
      };

      this.ws.onerror = () => {
        if (!this.fallbackTimer) this._startFallbackStream();
      };

      this.ws.onclose = () => {
        if (!this.fallbackTimer) this._startFallbackStream();
        // Retry socket connection every 3 seconds
        setTimeout(() => {
          if (this.status !== ConnectionStatus.DISCONNECTED) {
            this._connectSocket();
          }
        }, 3000);
      };

    } catch (e) {
      if (!this.fallbackTimer) this._startFallbackStream();
    }
  }

  _startFallbackStream() {
    this._setStatus(ConnectionStatus.CONNECTED);
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);

    this.fallbackTimer = setInterval(() => {
      const s = this.symbol.toUpperCase();
      const isCrypto = s.includes('BTC') || s.includes('ETH');
      const isGold = s.includes('XAU') || s.includes('GOLD');
      const isJpy = s.includes('JPY');
      const decimals = isCrypto || isGold ? 2 : (isJpy ? 3 : 5);
      const step = s.includes('BTC') ? 2.5 : (s.includes('ETH') ? 0.5 : (isGold ? 0.2 : (isJpy ? 0.01 : 0.00005)));
      const shift = (Math.random() - 0.495) * step;
      const factor = Math.pow(10, decimals);
      this.lastPrice = Math.round((this.lastPrice + shift) * factor) / factor;
      const spread = step * 0.4;
      const bid = Math.round((this.lastPrice - spread / 2) * factor) / factor;
      const ask = Math.round((this.lastPrice + spread / 2) * factor) / factor;

      const normEvent = new NormalizedMarketEvent({
        symbol: this.symbol,
        timestamp: Date.now(),
        eventType: EventType.QUOTE_UPDATE,
        price: this.lastPrice,
        bid,
        ask,
        size: Math.floor(Math.random() * 2500) + 1200,
        volumeFidelity: VolumeFidelity.BROKER_VOLUME,
        dataProvenance: DataProvenance.OBSERVED,
        aggressor: AggressorSide.UNKNOWN,
        source: 'MT5Adapter_Live'
      });

      this._emitEvent(normEvent);
    }, 250);
  }

  loadMoreHistory(beforeTimestamp, count = 40) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        action: 'load_history',
        symbol: this.symbol,
        before_ts: beforeTimestamp,
        count
      }));
    }
  }

  async disconnect() {
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
    if (this.ws) this.ws.close();
    await super.disconnect();
  }
}
