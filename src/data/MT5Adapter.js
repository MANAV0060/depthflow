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
    if (!this.subscribedSymbols) this.subscribedSymbols = new Set();
    this.subscribedSymbols.add(symbol);
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

  unsubscribe(symbol) {
    if (this.subscribedSymbols) this.subscribedSymbols.delete(symbol);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        action: 'unsubscribe',
        symbol: symbol
      }));
    }
  }

  isSubscribed(symbol) {
    if (!symbol) return false;
    if (this._isSymbolMatch(symbol, this.symbol)) return true;
    if (this.subscribedSymbols) {
      for (const s of this.subscribedSymbols) {
        if (this._isSymbolMatch(symbol, s)) return true;
      }
    }
    return false;
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
        const symbolsToSub = (this.subscribedSymbols && this.subscribedSymbols.size > 0)
          ? Array.from(this.subscribedSymbols)
          : [this.symbol];
        for (const sym of symbolsToSub) {
          this.ws.send(JSON.stringify({
            action: 'subscribe',
            symbol: sym,
            timeframe: this.timeframe
          }));
        }
      };

      this.ws.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data);
          if (data.error) {
            console.warn('[MT5Adapter] MT5 Notice:', data.error);
            return;
          }

          if (data.symbol && !this.isSubscribed(data.symbol)) {
            return; // Ignore data from unsubscribed symbols
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

          if (data.type === 'tpo_1m_candles' && Array.isArray(data.candles)) {
            console.log(`[MT5Adapter] Received ${data.candles.length} dedicated 1m TPO candles for ${data.symbol}`);
            this._emitTpoCandles(data.candles);
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
            symbol: data.symbol || this.symbol,
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

      this.ws.onerror = (e) => {
        console.warn('[MT5Adapter] WebSocket error, awaiting reconnection...');
      };

      this.ws.onclose = () => {
        // Retry socket connection every 3 seconds
        setTimeout(() => {
          if (this.status !== ConnectionStatus.DISCONNECTED) {
            this._connectSocket();
          }
        }, 3000);
      };

    } catch (e) {
      console.warn('[MT5Adapter] Socket initialization error', e);
    }
  }

  _startFallbackStream() {
    // Strictly no fake data: when market is closed or disconnected, do not simulate ticks
    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }
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
