/**
 * MarketDataManager.js
 * Centralized Market Data Cache & Router for Multi-Panel Depthflow Workspace.
 * 
 * Architectural Hierarchy:
 * Symbol
 *   -> Underlying persistent 1m stream/cache (for TPO & high-res calculations)
 *   -> Derived / Display timeframes (1m, 5m, 15m, 30m, 1h, 4h, D)
 *   -> Panels (subscribers receiving cached history & live broadcast ticks)
 * 
 * Prevents redundant provider subscriptions and ensures 15m/1h TPO panels
 * always have access to baseline 1m bars without cross-panel data corruption.
 */

export class MarketDataManager {
  constructor(providerRegistry) {
    this.registry = providerRegistry;
    this.symbols = new Map(); // normalizedSymbol -> SymbolData
    this.panelSubscriptions = new Map(); // panelId -> { symbol, timeframeStr, timeframeMs, callbacks }
    this._unsubscribers = [];

    this._bindRegistryEvents();
  }

  _normSymbol(sym) {
    if (!sym) return '';
    return sym.trim().toUpperCase();
  }

  _isSymbolMatch(s1, s2) {
    if (!s1 || !s2) return false;
    const a = s1.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    const b = s2.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    return a === b || a.startsWith(b) || b.startsWith(a);
  }

  _getOrCreateSymbolData(symbol) {
    const norm = this._normSymbol(symbol);
    if (!this.symbols.has(norm)) {
      this.symbols.set(norm, {
        symbol: symbol,
        raw1mCandles: [],
        timeframeCandles: new Map(), // timeframeStr -> Array<Candle>
        lastPrice: null,
        subscribers: new Set() // panelIds
      });
    }
    return this.symbols.get(norm);
  }

  _bindRegistryEvents() {
    if (!this.registry) return;

    // 1. Initial / Display Candles stream
    const unsubCandles = this.registry.onCandles((candles) => {
      this._handleIncomingCandles(candles);
    });
    this._unsubscribers.push(unsubCandles);

    // 2. Dedicated 1m TPO baseline candles stream
    const unsubTpo = this.registry.onTpoCandles((candles) => {
      this._handleIncomingTpoCandles(candles);
    });
    this._unsubscribers.push(unsubTpo);

    // 3. Historical pagination chunk stream
    const unsubHist = this.registry.onHistoricalChunk((candles) => {
      this._handleIncomingHistoricalChunk(candles);
    });
    this._unsubscribers.push(unsubHist);

    // 4. Real-time tick stream
    const unsubEvents = this.registry.onEvent((event) => {
      this._handleIncomingMarketEvent(event);
    });
    this._unsubscribers.push(unsubEvents);

    // 5. Liquidation Heatmap & Sweeps
    const unsubHeatmap = this.registry.onLiquidationHeatmap((data) => {
      this._handleIncomingHeatmap(data);
    });
    this._unsubscribers.push(unsubHeatmap);

    const unsubSweep = this.registry.onLiquidationSweep((data) => {
      this._handleIncomingSweep(data);
    });
    this._unsubscribers.push(unsubSweep);
  }

  subscribe(panelId, symbol, timeframeStr = '1m', timeframeMs = 60000, callbacks = {}) {
    if (!panelId || !symbol) return;

    // Clean up previous subscription for this panel if any
    this.unsubscribe(panelId);

    const norm = this._normSymbol(symbol);
    const symData = this._getOrCreateSymbolData(symbol);
    symData.subscribers.add(panelId);

    this.panelSubscriptions.set(panelId, {
      symbol: symbol,
      normSymbol: norm,
      timeframeStr: timeframeStr,
      timeframeMs: timeframeMs,
      callbacks: callbacks
    });

    console.log(`[MarketDataManager] Panel '${panelId}' subscribed to ${symbol} (${timeframeStr})`);

    // Check if we already have fresh cached display candles for this symbol + timeframe
    const cachedDisplay = symData.timeframeCandles.get(timeframeStr);
    const hasCachedDisplay = Array.isArray(cachedDisplay) && cachedDisplay.length > 0;
    const nowTs = Date.now();
    const lastDisplayBarEnd = hasCachedDisplay
      ? (cachedDisplay[cachedDisplay.length - 1].endTime || cachedDisplay[cachedDisplay.length - 1].startTime + timeframeMs)
      : 0;
    const isDisplayCacheFresh = hasCachedDisplay && (nowTs - lastDisplayBarEnd <= timeframeMs * 1.5);
    const hasCached1m = Array.isArray(symData.raw1mCandles) && symData.raw1mCandles.length > 0;

    if (isDisplayCacheFresh) {
      console.log(`[MarketDataManager] Hydrating panel '${panelId}' instantly from fresh cache (${cachedDisplay.length} bars)`);
      if (typeof callbacks.onCandles === 'function') {
        callbacks.onCandles(cachedDisplay);
      }
    } else if (hasCachedDisplay) {
      symData.timeframeCandles.delete(timeframeStr);
    }

    if (hasCached1m) {
      if (typeof callbacks.onTpoCandles === 'function') {
        callbacks.onTpoCandles(symData.raw1mCandles);
      }
    }

    // Always notify active provider of the subscription so live stream or missing history is fetched
    const activeProvider = this.registry.getActiveProvider();
    if (activeProvider && typeof activeProvider.subscribe === 'function') {
      activeProvider.subscribe(symbol, timeframeStr);
    }
  }

  unsubscribe(panelId) {
    if (!this.panelSubscriptions.has(panelId)) return;
    const sub = this.panelSubscriptions.get(panelId);
    this.panelSubscriptions.delete(panelId);

    const symData = this.symbols.get(sub.normSymbol);
    if (symData) {
      symData.subscribers.delete(panelId);
      // If no panels remain subscribed to this symbol, we can notify provider
      if (symData.subscribers.size === 0) {
        const activeProvider = this.registry.getActiveProvider();
        if (activeProvider && typeof activeProvider.unsubscribe === 'function') {
          activeProvider.unsubscribe(sub.symbol);
        }
      }
    }
    console.log(`[MarketDataManager] Panel '${panelId}' unsubscribed from ${sub.symbol}`);
  }

  setTimeframe(panelId, timeframeMs, timeframeStr) {
    const sub = this.panelSubscriptions.get(panelId);
    if (!sub) return;

    sub.timeframeMs = timeframeMs;
    sub.timeframeStr = timeframeStr;

    const symData = this._getOrCreateSymbolData(sub.symbol);
    const cached = symData.timeframeCandles.get(timeframeStr);

    const now = Date.now();
    const lastBarEnd = (Array.isArray(cached) && cached.length > 0)
      ? (cached[cached.length - 1].endTime || cached[cached.length - 1].startTime + timeframeMs)
      : 0;
    // Only serve from cache if it is truly fresh (within 1.5 bars of current time)
    const isCacheFresh = Array.isArray(cached) && cached.length > 0 && (now - lastBarEnd <= timeframeMs * 1.5);

    if (isCacheFresh) {
      console.log(`[MarketDataManager] Switching panel '${panelId}' timeframe to ${timeframeStr} via fresh cache (${cached.length} bars)`);
      if (typeof sub.callbacks.onCandles === 'function') {
        sub.callbacks.onCandles(cached);
      }
      if (symData.raw1mCandles && symData.raw1mCandles.length > 0 && typeof sub.callbacks.onTpoCandles === 'function') {
        sub.callbacks.onTpoCandles(symData.raw1mCandles);
      }
    } else {
      // Evict stale cache so it never injects historical gaps or frozen bars
      symData.timeframeCandles.delete(timeframeStr);
    }

    // ALWAYS synchronize with active provider on timeframe switch to ensure gapless, up-to-date candles
    const activeProvider = this.registry.getActiveProvider();
    if (activeProvider && typeof activeProvider.subscribe === 'function') {
      activeProvider.subscribe(sub.symbol, timeframeStr);
    }
  }

  loadMoreHistory(panelId, earliestTs, count = 400) {
    const sub = this.panelSubscriptions.get(panelId);
    if (!sub) return;
    if (this.registry && typeof this.registry.loadMoreHistory === 'function') {
      this.registry.loadMoreHistory(earliestTs, count, sub.symbol, sub.timeframeStr);
    }
  }

  getRaw1mCandles(symbol) {
    const norm = this._normSymbol(symbol);
    const symData = this.symbols.get(norm);
    return (symData && symData.raw1mCandles) ? symData.raw1mCandles : [];
  }

  _handleIncomingCandles(candles) {
    if (!Array.isArray(candles) || candles.length === 0) return;
    const rawSym = candles[0].symbol;
    if (!rawSym) return;

    const symData = this._findMatchingSymbolData(rawSym);
    if (!symData) return;

    // Detect timeframe or default from active subscriber
    let detectedTf = '1m';
    if (candles.length >= 2) {
      const diffSec = Math.round((candles[1].startTime - candles[0].startTime) / 1000);
      if (diffSec >= 86400) detectedTf = 'D';
      else if (diffSec >= 14400) detectedTf = '4h';
      else if (diffSec >= 3600) detectedTf = '1h';
      else if (diffSec >= 1800) detectedTf = '30m';
      else if (diffSec >= 900) detectedTf = '15m';
      else if (diffSec >= 300) detectedTf = '5m';
      else detectedTf = '1m';
    }

    symData.timeframeCandles.set(detectedTf, [...candles]);

    // If 1m and no dedicated raw1m yet, initialize baseline
    if (detectedTf === '1m' && (!symData.raw1mCandles || symData.raw1mCandles.length === 0)) {
      symData.raw1mCandles = [...candles].sort((a, b) => a.startTime - b.startTime);
    }

    // Dispatch to all panels matching this symbol & timeframe
    for (const panelId of symData.subscribers) {
      const sub = this.panelSubscriptions.get(panelId);
      if (!sub) continue;

      if (sub.timeframeStr === detectedTf || (detectedTf === '1m' && !sub.timeframeStr)) {
        if (typeof sub.callbacks.onCandles === 'function') {
          sub.callbacks.onCandles(candles);
        }
      }
    }
  }

  _handleIncomingTpoCandles(candles) {
    if (!Array.isArray(candles) || candles.length === 0) return;
    const rawSym = candles[0].symbol;
    if (!rawSym) return;

    const symData = this._findMatchingSymbolData(rawSym);
    if (!symData) return;

    symData.raw1mCandles = [...candles].sort((a, b) => a.startTime - b.startTime);

    // Dispatch to all panels subscribed to this symbol
    for (const panelId of symData.subscribers) {
      const sub = this.panelSubscriptions.get(panelId);
      if (!sub) continue;
      if (typeof sub.callbacks.onTpoCandles === 'function') {
        sub.callbacks.onTpoCandles(symData.raw1mCandles);
      }
    }
  }

  _handleIncomingHistoricalChunk(candles) {
    if (!Array.isArray(candles) || candles.length === 0) return;
    const rawSym = candles[0].symbol;
    if (!rawSym) return;

    const symData = this._findMatchingSymbolData(rawSym);
    if (!symData) return;

    for (const panelId of symData.subscribers) {
      const sub = this.panelSubscriptions.get(panelId);
      if (!sub) continue;
      if (typeof sub.callbacks.onHistoricalChunk === 'function') {
        sub.callbacks.onHistoricalChunk(candles);
      }
    }
  }

  _handleIncomingMarketEvent(event) {
    if (!event || !event.symbol) return;
    const symData = this._findMatchingSymbolData(event.symbol);
    if (!symData) return;

    symData.lastPrice = event.price;

    // Roll into underlying 1m stream
    if (symData.raw1mCandles && event.price) {
      const m1Time = Math.floor((event.timestamp || Date.now()) / 60000) * 60000;
      let lastM1 = symData.raw1mCandles[symData.raw1mCandles.length - 1];
      if (!lastM1 || m1Time >= (lastM1.endTime || lastM1.startTime + 60000)) {
        lastM1 = {
          startTime: m1Time,
          endTime: m1Time + 60000,
          open: event.price,
          high: event.price,
          low: event.price,
          close: event.price,
          totalVolume: event.size || 1,
          cells: []
        };
        symData.raw1mCandles.push(lastM1);
      } else {
        if (event.price > lastM1.high) lastM1.high = event.price;
        if (event.price < lastM1.low) lastM1.low = event.price;
        lastM1.close = event.price;
        lastM1.totalVolume += (event.size || 1);
      }
    }

    // Dispatch live tick to all panels subscribed to this symbol
    for (const panelId of symData.subscribers) {
      const sub = this.panelSubscriptions.get(panelId);
      if (!sub) continue;
      if (typeof sub.callbacks.onEvent === 'function') {
        sub.callbacks.onEvent(event);
      }
    }
  }

  _handleIncomingHeatmap(data) {
    if (!data) return;
    for (const [panelId, sub] of this.panelSubscriptions) {
      if (typeof sub.callbacks.onHeatmap === 'function') {
        sub.callbacks.onHeatmap(data);
      }
    }
  }

  _handleIncomingSweep(data) {
    if (!data) return;
    for (const [panelId, sub] of this.panelSubscriptions) {
      if (typeof sub.callbacks.onSweep === 'function') {
        sub.callbacks.onSweep(data);
      }
    }
  }

  _findMatchingSymbolData(rawSymbol) {
    if (!rawSymbol) return null;
    const norm = this._normSymbol(rawSymbol);
    if (this.symbols.has(norm)) return this.symbols.get(norm);

    for (const [key, data] of this.symbols) {
      if (this._isSymbolMatch(key, rawSymbol)) {
        return data;
      }
    }
    return this._getOrCreateSymbolData(rawSymbol);
  }

  destroy() {
    this._unsubscribers.forEach(unsub => {
      if (typeof unsub === 'function') unsub();
    });
    this._unsubscribers = [];
    this.symbols.clear();
    this.panelSubscriptions.clear();
  }
}
