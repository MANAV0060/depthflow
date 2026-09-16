/**
 * ChartPanel.js
 * Encapsulates an isolated, high-performance chart panel in the Depthflow workspace.
 * 
 * Features:
 * - Dedicated ChartEngine instance & isolated analytical pipeline
 * - Compact trading terminal header (Symbol, Timeframe, Chart Mode, Footprint Style, Focus, Close)
 * - Subscribes to central MarketDataManager for underlying 1m and display-timeframe streams
 * - Clean lifecycle disposal with zero zombie listeners or memory leaks
 */

import { ChartEngine } from '../chart/ChartEngine.js?v=orderflow_v5';
import { FootprintAggregator } from '../analytics/FootprintAggregator.js?v=orderflow_v5';
import { TPOEngine } from '../analytics/TPOEngine.js?v=orderflow_v5';
import { DeltaEngine } from '../analytics/DeltaEngine.js?v=orderflow_v5';
import { AdaptiveClassifier } from '../analytics/AdaptiveClassifier.js?v=orderflow_v5';
import { BigTradesEngine } from '../analytics/BigTradesEngine.js?v=orderflow_v5';
import { VolumeProfileEngine } from '../analytics/VolumeProfileEngine.js?v=orderflow_v5';
import { defaultConfig } from '../analytics/OrderFlowConfig.js';

export const SUPPORTED_SYMBOLS = [
  'EUR/USD',
  'GBP/USD',
  'USD/JPY',
  'XAU/USD',
  'BTC/USD',
  'ETH/USD'
];

export const TIMEFRAME_MAP = {
  '1m': 60000,
  '5m': 300000,
  '15m': 900000,
  '30m': 1800000,
  '1h': 3600000,
  '4h': 14400000,
  'D': 86400000
};

export class ChartPanel {
  constructor({
    id,
    symbol = 'EUR/USD',
    timeframeStr = '1m',
    timeframeMs = 60000,
    chartMode = 'FOOTPRINT',
    footprintStyle = 'PROFILE',
    theme = 'DARK',
    marketDataManager,
    tpoSettings = null,
    onAction = null,
    isMainPanel = false,
    subPanes = null
  }) {
    this.id = id || `panel-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
    this.isMainPanel = isMainPanel;
    this.symbol = symbol;
    this.timeframeStr = timeframeStr;
    this.timeframeMs = timeframeMs || (TIMEFRAME_MAP[timeframeStr] || 60000);
    this.chartMode = chartMode;
    this.footprintStyle = footprintStyle;
    this.theme = theme;
    this.marketDataManager = marketDataManager;
    this.tpoSettings = tpoSettings;
    this.onAction = onAction;

    // Modular Sub-Panes State (explicitly decoupled from chartMode)
    this.subPanes = {
      cvd: subPanes?.cvd !== undefined ? !!subPanes.cvd : false,
      deltaSummary: subPanes?.deltaSummary !== undefined 
        ? !!subPanes.deltaSummary 
        : (this.chartMode === 'FOOTPRINT')
    };

    this.isMaximized = false;
    this._lastTpoUpdate = 0;

    // Isolated analytical pipeline for THIS panel
    this.aggregator = new FootprintAggregator({ timeframeMs: this.timeframeMs, symbol: this.symbol });
    this.tpoEngine = new TPOEngine();
    if (this.tpoSettings) {
      this.tpoEngine.setOptions(this.tpoSettings);
    }
    this.deltaEngine = new DeltaEngine();
    this.classifier = new AdaptiveClassifier();
    this.bigTradesEngine = new BigTradesEngine();
    this.profileEngine = new VolumeProfileEngine();

    // DOM References
    this.el = null;
    this.headerEl = null;
    this.viewportEl = null;
    this.subPanesContainerEl = null;
    this.deltaSummaryPaneEl = null;
    this.tableDataContainerEl = null;
    this.cvdPaneEl = null;
    this.cvdChartAreaEl = null;
    this.cvdValBadgeEl = null;
    this.chartEngine = null;

    this._buildDOM();
    this._initChartEngine();
    this._subscribeData();
  }

  _buildDOM() {
    const panel = document.createElement('div');
    panel.className = 'chart-panel';
    panel.id = this.id;
    panel.setAttribute('data-panel-id', this.id);

    // Compact Header Bar
    const header = document.createElement('div');
    header.className = 'panel-header';
    header.innerHTML = `
      <div class="panel-header-left">
        <!-- Symbol Selector -->
        <div class="panel-control-box">
          <select class="panel-symbol-select" title="Select Symbol">
            ${SUPPORTED_SYMBOLS.map(s => `<option value="${s}" ${s === this.symbol ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </div>

        <div class="panel-divider-v"></div>

        <!-- Timeframe Quick Pills -->
        <div class="panel-tf-group">
          ${Object.keys(TIMEFRAME_MAP).map(tf => `
            <button class="panel-tf-btn ${tf === this.timeframeStr ? 'active' : ''}" data-tf="${tf}">${tf}</button>
          `).join('')}
        </div>

        <div class="panel-divider-v"></div>

        <!-- Chart Mode Selector -->
        <div class="panel-control-box">
          <select class="panel-mode-select" title="Chart Visualization Mode">
            <option value="FOOTPRINT" ${this.chartMode === 'FOOTPRINT' ? 'selected' : ''}>Footprint</option>
            <option value="TPO" ${this.chartMode === 'TPO' ? 'selected' : ''}>TPO Profile</option>
            <option value="CANDLESTICK" ${this.chartMode === 'CANDLESTICK' ? 'selected' : ''}>Candlestick</option>
          </select>
        </div>

        <!-- Footprint Sub-Style (Only visible in Footprint mode) -->
        <div class="panel-control-box panel-style-box" style="display: ${this.chartMode === 'FOOTPRINT' ? 'flex' : 'none'};">
          <select class="panel-style-select" title="Footprint Display Style">
            <option value="PROFILE" ${this.footprintStyle === 'PROFILE' ? 'selected' : ''}>Bid × Ask</option>
            <option value="DELTA" ${this.footprintStyle === 'DELTA' ? 'selected' : ''}>Net Delta</option>
            <option value="CLUSTER" ${this.footprintStyle === 'CLUSTER' ? 'selected' : ''}>Cluster Vol</option>
          </select>
        </div>

        <div class="panel-divider-v"></div>

        <!-- Analytics Sub-Panes Toggle Menu -->
        <div class="panel-analytics-group">
          <button class="panel-analytics-btn" title="Toggle Optional Sub-Panes (CVD, Delta Summary)">📊 Analytics ▾</button>
          <div class="panel-analytics-menu hidden">
            <div class="panel-analytics-title">Optional Sub-Panes</div>
            <label class="panel-checkbox-item">
              <input type="checkbox" class="cb-subpane-cvd" ${this.subPanes.cvd ? 'checked' : ''}>
              <span>CVD Graph</span>
            </label>
            <label class="panel-checkbox-item">
              <input type="checkbox" class="cb-subpane-delta" ${this.subPanes.deltaSummary ? 'checked' : ''}>
              <span>Delta Summary Table</span>
            </label>
            <label class="panel-checkbox-item disabled" title="Available in future update" style="opacity: 0.5; cursor: not-allowed;">
              <input type="checkbox" disabled>
              <span>Open Interest (Future)</span>
            </label>
          </div>
        </div>
      </div>

      <div class="panel-header-right">
        <!-- Panel Tag / Live Price -->
        <span class="panel-price-badge">--</span>
        <!-- Maximize / Focus Button -->
        <button class="panel-icon-btn panel-focus-btn" title="Focus / Maximize Panel">⛶</button>
        <!-- Close Panel Button -->
        <button class="panel-icon-btn panel-close-btn" title="Close Panel">✕</button>
      </div>
    `;

    // Chart Viewport Body
    const viewport = document.createElement('div');
    viewport.className = 'panel-viewport';
    viewport.id = `viewport-${this.id}`;

    // Floating TradingView Legend inside panel
    const legend = document.createElement('div');
    legend.className = 'tv-legend';
    legend.innerHTML = `
      <span class="legend-symbol">${this.symbol}</span>
      <span class="legend-tf">${this.timeframeStr}</span>
      <span class="legend-ohlc">
        O <span class="val legend-o">-</span>
        H <span class="val legend-h">-</span>
        L <span class="val legend-l">-</span>
        C <span class="val legend-c">-</span>
        <span class="legend-chg">+0.00%</span>
      </span>
    `;
    viewport.appendChild(legend);

    // Canvas Overlays
    const liqCanvas = document.createElement('canvas');
    liqCanvas.className = 'liquidationCanvas';
    liqCanvas.style.position = 'absolute';
    liqCanvas.style.top = '0';
    liqCanvas.style.left = '0';
    liqCanvas.style.width = '100%';
    liqCanvas.style.height = '100%';
    liqCanvas.style.pointerEvents = 'none';
    liqCanvas.style.zIndex = '5';
    viewport.appendChild(liqCanvas);

    // Optional Sub-Panes Container (Dynamic Layout Engine)
    const subPanesContainer = document.createElement('div');
    subPanesContainer.className = 'panel-sub-panes';

    // Sub-Pane 1: Delta Summary Table
    const deltaSummaryPane = document.createElement('div');
    deltaSummaryPane.className = 'panel-sub-pane sub-pane-delta-summary';
    deltaSummaryPane.innerHTML = `
      <div class="tv-row-header">
        <div class="tv-cell label-cell highlight-label">Delta</div>
        <div class="tv-cell label-cell">Max Delta</div>
        <div class="tv-cell label-cell">Min Delta</div>
        <div class="tv-cell label-cell">Total Vol</div>
        <div class="tv-cell label-cell">Delta %</div>
        <div class="tv-cell label-cell">Session CVD</div>
        <div class="tv-cell label-cell">POC</div>
        <div class="tv-cell label-cell">HL range</div>
      </div>
      <div class="tv-table-data"></div>
    `;

    // Sub-Pane 2: CVD Chart Area
    const cvdPane = document.createElement('div');
    cvdPane.className = 'panel-sub-pane sub-pane-cvd';
    cvdPane.innerHTML = `
      <div class="panel-sub-pane-header">
        <span>ASK / BID DELTA DIFFERENCE HISTOGRAM & CUMULATIVE VOLUME DELTA (CVD)</span>
        <span class="panel-cvd-val">+0</span>
      </div>
      <div class="panel-cvd-chart-area"></div>
    `;

    subPanesContainer.appendChild(deltaSummaryPane);
    subPanesContainer.appendChild(cvdPane);

    panel.appendChild(header);
    panel.appendChild(viewport);
    panel.appendChild(subPanesContainer);

    this.el = panel;
    this.headerEl = header;
    this.viewportEl = viewport;
    this.legendEl = legend;
    this.subPanesContainerEl = subPanesContainer;
    this.deltaSummaryPaneEl = deltaSummaryPane;
    this.tableDataContainerEl = deltaSummaryPane.querySelector('.tv-table-data');
    this.cvdPaneEl = cvdPane;
    this.cvdChartAreaEl = cvdPane.querySelector('.panel-cvd-chart-area');
    this.cvdValBadgeEl = cvdPane.querySelector('.panel-cvd-val');

    this._applySubPaneLayout();
    this._bindHeaderEvents();
  }

  _bindHeaderEvents() {
    // Click on panel to focus
    this.el.addEventListener('mousedown', () => {
      this._emitAction('select', { panelId: this.id });
    });

    // Symbol Change
    const symSelect = this.headerEl.querySelector('.panel-symbol-select');
    if (symSelect) {
      symSelect.addEventListener('change', (e) => {
        this.setSymbol(e.target.value);
        this._emitAction('symbolChange', { panelId: this.id, symbol: e.target.value });
      });
    }

    // Timeframe Pills
    const tfBtns = this.headerEl.querySelectorAll('.panel-tf-btn');
    tfBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tf = btn.getAttribute('data-tf');
        if (tf && tf !== this.timeframeStr) {
          tfBtns.forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          this.setTimeframe(tf);
          this._emitAction('timeframeChange', { panelId: this.id, timeframeStr: tf, timeframeMs: this.timeframeMs });
        }
      });
    });

    // Chart Mode Change
    const modeSelect = this.headerEl.querySelector('.panel-mode-select');
    const styleBox = this.headerEl.querySelector('.panel-style-box');
    if (modeSelect) {
      modeSelect.addEventListener('change', (e) => {
        const mode = e.target.value;
        this.setChartMode(mode);
        if (styleBox) {
          styleBox.style.display = (mode === 'FOOTPRINT') ? 'flex' : 'none';
        }
        this._emitAction('chartModeChange', { panelId: this.id, chartMode: mode });
      });
    }

    // Footprint Style Change
    const styleSelect = this.headerEl.querySelector('.panel-style-select');
    if (styleSelect) {
      styleSelect.addEventListener('change', (e) => {
        const style = e.target.value;
        this.setFootprintStyle(style);
        this._emitAction('footprintStyleChange', { panelId: this.id, footprintStyle: style });
      });
    }

    // Analytics Menu Toggle & Checkbox Controls
    const analyticsBtn = this.headerEl.querySelector('.panel-analytics-btn');
    const analyticsMenu = this.headerEl.querySelector('.panel-analytics-menu');
    if (analyticsBtn && analyticsMenu) {
      analyticsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        analyticsMenu.classList.toggle('hidden');
        analyticsBtn.classList.toggle('active', !analyticsMenu.classList.contains('hidden'));
      });

      document.addEventListener('click', (e) => {
        if (!analyticsMenu.contains(e.target) && !analyticsBtn.contains(e.target)) {
          analyticsMenu.classList.add('hidden');
          analyticsBtn.classList.remove('active');
        }
      });

      const cbCvd = analyticsMenu.querySelector('.cb-subpane-cvd');
      if (cbCvd) {
        cbCvd.addEventListener('change', (e) => {
          this.setSubPane('cvd', e.target.checked);
        });
      }

      const cbDelta = analyticsMenu.querySelector('.cb-subpane-delta');
      if (cbDelta) {
        cbDelta.addEventListener('change', (e) => {
          this.setSubPane('deltaSummary', e.target.checked);
        });
      }
    }

    // Focus / Maximize
    const focusBtn = this.headerEl.querySelector('.panel-focus-btn');
    if (focusBtn) {
      focusBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._emitAction('toggleMaximize', { panelId: this.id });
      });
    }

    // Close
    const closeBtn = this.headerEl.querySelector('.panel-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._emitAction('close', { panelId: this.id });
      });
    }
  }

  _initChartEngine() {
    this.chartEngine = new ChartEngine(this.viewportEl, {
      panelId: this.id,
      isMainPanel: this.isMainPanel,
      symbol: this.symbol,
      timeframeMs: this.timeframeMs,
      timeframeStr: this.timeframeStr,
      chartMode: this.chartMode,
      footprintStyle: this.footprintStyle,
      theme: this.theme,
      summaryTable: this.deltaSummaryPaneEl,
      tableDataContainer: this.tableDataContainerEl,
      cvdContainer: this.cvdChartAreaEl,
      subPanes: this.subPanes
    });

    if (this.tpoSettings) {
      this.chartEngine.setTpoOptions(this.tpoSettings);
    }

    if (this.subPanes.cvd && this.cvdRecords && this.cvdRecords.length > 0) {
      this.chartEngine.setCvdData(this.cvdRecords);
    }
  }

  _subscribeData() {
    if (!this.marketDataManager) return;

    this.marketDataManager.subscribe(this.id, this.symbol, this.timeframeStr, this.timeframeMs, {
      onCandles: (candles) => this._onInitialCandles(candles),
      onTpoCandles: (candles) => this._onTpo1mCandles(candles),
      onHistoricalChunk: (candles) => this._onHistoricalChunk(candles),
      onEvent: (event) => this._onMarketEvent(event),
      onHeatmap: (data) => {
        if (this.chartEngine) this.chartEngine.setLiquidationData(data);
      },
      onSweep: (data) => {
        if (this.chartEngine) this.chartEngine.triggerLiquidationSweep(data);
      }
    });
  }

  _onInitialCandles(candles) {
    if (!Array.isArray(candles) || candles.length === 0) return;
    this.aggregator.reset(this.symbol, this.timeframeMs);
    this.aggregator.loadCandles(candles);
    this.profileEngine.reset();
    this.profileEngine.loadFromCandles(candles);

    const allCandles = this.aggregator.getAllCandles();
    if (this.bigTradesEngine) {
      this.bigTradesEngine.processCandles(allCandles);
    }
    if (this.chartEngine) {
      this.chartEngine.setCandles(allCandles);
    }

    this._updateTpoSessions();

    // Compute CVD for this panel with strictly monotonic timestamps
    this.deltaEngine.clear();
    let cumulativeCvd = 0;
    const timeMap = new Map();
    allCandles.forEach(c => {
      const cvdRecord = this.deltaEngine.processCandle(c);
      if (cvdRecord) {
        cumulativeCvd = cvdRecord.cvd;
        const t = Math.floor(c.startTime / 1000);
        timeMap.set(t, cumulativeCvd);
      }
    });
    const cvdRecords = Array.from(timeMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([time, value]) => ({ time, value }));
    this.cvdRecords = cvdRecords;
    this.lastCvd = cumulativeCvd;

    if (this.cvdValBadgeEl) {
      const isPos = cumulativeCvd >= 0;
      this.cvdValBadgeEl.textContent = `${isPos ? '+' : ''}${Math.round(cumulativeCvd).toLocaleString()}`;
      this.cvdValBadgeEl.style.color = isPos ? 'var(--buy-green)' : 'var(--sell-red)';
    }
    if (this.chartEngine && this.subPanes.cvd) {
      this.chartEngine.setCvdData(cvdRecords);
    }

    this._emitAction('cvdLoaded', {
      panelId: this.id,
      records: cvdRecords,
      lastCvd: cumulativeCvd
    });

    if (allCandles.length > 0) {
      const lastC = allCandles[allCandles.length - 1];
      this._updateLegend(lastC);
      this._updatePriceBadge(lastC.close);
    }
  }

  _onTpo1mCandles(candles) {
    if (!Array.isArray(candles) || candles.length === 0) return;
    this._updateTpoSessions();
  }

  _onHistoricalChunk(candles) {
    if (!Array.isArray(candles) || candles.length === 0) return;
    this.aggregator.prependCandles(candles);
    const allCandles = this.aggregator.getAllCandles();
    if (this.deltaEngine) {
      this.deltaEngine.clear();
      let cumulativeCvd = 0;
      const timeMap = new Map();
      allCandles.forEach(c => {
        const cvdRecord = this.deltaEngine.processCandle(c);
        if (cvdRecord) {
          cumulativeCvd = cvdRecord.cvd;
          const t = Math.floor(c.startTime / 1000);
          timeMap.set(t, cumulativeCvd);
        }
      });
      const cvdRecords = Array.from(timeMap.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([time, value]) => ({ time, value }));
      this.cvdRecords = cvdRecords;
      this.lastCvd = cumulativeCvd;

      if (this.cvdValBadgeEl) {
        const isPos = cumulativeCvd >= 0;
        this.cvdValBadgeEl.textContent = `${isPos ? '+' : ''}${Math.round(cumulativeCvd).toLocaleString()}`;
        this.cvdValBadgeEl.style.color = isPos ? 'var(--buy-green)' : 'var(--sell-red)';
      }
      if (this.chartEngine && this.subPanes.cvd) {
        this.chartEngine.setCvdData(cvdRecords);
      }

      this._emitAction('cvdLoaded', {
        panelId: this.id,
        records: cvdRecords,
        lastCvd: cumulativeCvd
      });
    }
    if (this.bigTradesEngine) {
      this.bigTradesEngine.processCandles(allCandles);
    }
    if (this.chartEngine) {
      this.chartEngine.prependCandles(allCandles);
    }
    this._updateTpoSessions();
  }

  _onMarketEvent(event) {
    if (!event || !event.price) return;

    // 1. Classify aggressor
    const aggressorResult = this.classifier.classify(event);

    // 2. Add to Volume Profile
    this.profileEngine.addEvent(event.price, event.size);

    // 3. Live Large Trade Execution Detection
    if (this.bigTradesEngine) {
      this.bigTradesEngine.processLiveTick(event, aggressorResult);
    }

    // 4. Footprint Candle Aggregation & Chart update
    const activeCandle = this.aggregator.processEvent(event, aggressorResult);
    if (this.bigTradesEngine) {
      this.bigTradesEngine.processCandle(activeCandle);
    }
    if (this.chartEngine) {
      this.chartEngine.onLiveTick(event.price);
      this.chartEngine.updateCandle(activeCandle);
    }

    this._updateLegend(activeCandle);
    this._updatePriceBadge(event.price);

    // 5. Throttled TPO refresh in TPO mode
    if (this.chartMode === 'TPO' && (!this._lastTpoUpdate || Date.now() - this._lastTpoUpdate > 3000)) {
      this._lastTpoUpdate = Date.now();
      this._updateTpoSessions();
    }

    // 6. CVD & Delta Calculation
    const cvdRecord = this.deltaEngine.processCandle(activeCandle);
    if (cvdRecord) {
      this.lastCvd = cvdRecord.cvd;
      const t = Math.floor(activeCandle.startTime / 1000);
      if (this.cvdRecords && this.cvdRecords.length > 0) {
        const lastRec = this.cvdRecords[this.cvdRecords.length - 1];
        if (lastRec.time === t) {
          lastRec.value = cvdRecord.cvd;
        } else if (t > lastRec.time) {
          this.cvdRecords.push({ time: t, value: cvdRecord.cvd });
        }
      }

      if (this.cvdValBadgeEl) {
        const isPos = cvdRecord.cvd >= 0;
        this.cvdValBadgeEl.textContent = `${isPos ? '+' : ''}${Math.round(cvdRecord.cvd).toLocaleString()}`;
        this.cvdValBadgeEl.style.color = isPos ? 'var(--buy-green)' : 'var(--sell-red)';
      }
      if (this.chartEngine && this.subPanes.cvd) {
        this.chartEngine.updateCvd(activeCandle.startTime, cvdRecord.cvd);
      }

      this._emitAction('cvdUpdate', {
        panelId: this.id,
        time: t,
        value: cvdRecord.cvd
      });
    }
  }

  _updateTpoSessions() {
    if (!this.tpoEngine || !this.chartEngine) return;
    const baselineCandles = (this.marketDataManager) 
      ? this.marketDataManager.getRaw1mCandles(this.symbol)
      : [];
    const feed = (baselineCandles && baselineCandles.length >= 10) 
      ? baselineCandles 
      : this.aggregator.getAllCandles();

    if (feed && feed.length > 0) {
      const sessions = this.tpoEngine.processCandles(feed, this.symbol, this.timeframeStr);
      this.chartEngine.setTpoSessions(sessions);
    }
  }

  _updateLegend(candle) {
    if (!candle || !this.legendEl) return;
    const isCrypto = this.symbol.includes('BTC') || this.symbol.includes('ETH');
    const isGold = this.symbol.includes('XAU') || this.symbol.includes('GOLD');
    const isJpy = this.symbol.includes('JPY');
    const decimals = isCrypto || isGold ? 2 : (isJpy ? 3 : 5);

    const oEl = this.legendEl.querySelector('.legend-o');
    const hEl = this.legendEl.querySelector('.legend-h');
    const lEl = this.legendEl.querySelector('.legend-l');
    const cEl = this.legendEl.querySelector('.legend-c');
    const chgEl = this.legendEl.querySelector('.legend-chg');

    if (oEl) oEl.textContent = Number(candle.open).toFixed(decimals);
    if (hEl) hEl.textContent = Number(candle.high).toFixed(decimals);
    if (lEl) lEl.textContent = Number(candle.low).toFixed(decimals);
    if (cEl) cEl.textContent = Number(candle.close).toFixed(decimals);

    if (chgEl && candle.open > 0) {
      const diff = candle.close - candle.open;
      const pct = (diff / candle.open) * 100;
      const isPos = diff >= 0;
      chgEl.textContent = `${isPos ? '+' : ''}${pct.toFixed(2)}%`;
      chgEl.className = `legend-chg ${isPos ? 'pos' : 'neg'}`;
    }
  }

  _updatePriceBadge(price) {
    const badge = this.headerEl.querySelector('.panel-price-badge');
    if (!badge || !price) return;
    const isCrypto = this.symbol.includes('BTC') || this.symbol.includes('ETH');
    const isGold = this.symbol.includes('XAU') || this.symbol.includes('GOLD');
    const isJpy = this.symbol.includes('JPY');
    const decimals = isCrypto || isGold ? 2 : (isJpy ? 3 : 5);
    badge.textContent = Number(price).toFixed(decimals);
  }

  setSymbol(symbol) {
    if (!symbol || symbol === this.symbol) return;
    this.symbol = symbol;

    const symSelect = this.headerEl.querySelector('.panel-symbol-select');
    if (symSelect && symSelect.value !== symbol) {
      symSelect.value = symbol;
    }

    const legSym = this.legendEl.querySelector('.legend-symbol');
    if (legSym) legSym.textContent = symbol;

    if (this.chartEngine) {
      this.chartEngine.setSymbol(symbol);
      this.chartEngine.clear();
    }

    this._subscribeData();
  }

  setTimeframe(timeframeStr) {
    if (!timeframeStr || timeframeStr === this.timeframeStr) return;
    this.timeframeStr = timeframeStr;
    this.timeframeMs = TIMEFRAME_MAP[timeframeStr] || 60000;

    const legTf = this.legendEl.querySelector('.legend-tf');
    if (legTf) legTf.textContent = timeframeStr;

    if (this.aggregator) {
      this.aggregator.reset(this.symbol, this.timeframeMs);
    }
    if (this.profileEngine) {
      this.profileEngine.reset();
    }

    if (this.chartEngine) {
      this.chartEngine.setTimeframe(this.timeframeMs, this.timeframeStr);
      this.chartEngine.clear();
    }

    if (this.marketDataManager) {
      this.marketDataManager.setTimeframe(this.id, this.timeframeMs, this.timeframeStr);
    }
  }

  setMainPanel(isMain) {
    this.isMainPanel = isMain;
    if (this.chartEngine) {
      this.chartEngine.setMainPanel(isMain);
    }
  }

  setChartMode(mode) {
    if (!mode) return;
    this.chartMode = mode;

    const modeSelect = this.headerEl.querySelector('.panel-mode-select');
    if (modeSelect && modeSelect.value !== mode) {
      modeSelect.value = mode;
    }

    const styleBox = this.headerEl.querySelector('.panel-style-box');
    if (styleBox) {
      styleBox.style.display = (mode === 'FOOTPRINT') ? 'flex' : 'none';
    }

    if (this.chartEngine) {
      if (mode === 'TPO') {
        this._updateTpoSessions();
      }
      this.chartEngine.setChartMode(mode);
    }

    this._emitAction('chartModeChange', { panelId: this.id, mode });
  }

  setFootprintStyle(style) {
    this.footprintStyle = style;
    if (this.chartEngine) {
      this.chartEngine.setFootprintStyle(style);
    }
  }

  setTheme(theme) {
    this.theme = theme;
    if (this.chartEngine) {
      this.chartEngine.setTheme(theme);
    }
  }

  setTpoOptions(options) {
    this.tpoSettings = options;
    if (this.tpoEngine) {
      this.tpoEngine.setOptions({
        bracketMinutes: options.bracketMinutes,
        valueAreaPercent: options.valueAreaPercent,
        ibPeriods: options.ibDuration === 30 ? 1 : 2,
        sessionMode: options.sessionMode || 'INSTITUTIONAL',
        ticksPerBlock: options.ticksPerBlock || 1
      });
    }
    if (this.chartEngine) {
      this.chartEngine.setTpoOptions(options);
    }
    this._updateTpoSessions();
  }

  setBigTradesVisible(visible) {
    if (this.chartEngine) {
      this.chartEngine.setBigTradesVisible(visible);
    }
  }

  resize() {
    if (this.chartEngine) {
      this.chartEngine.resize();
    }
  }

  setActive(isActive) {
    if (this.el) {
      this.el.classList.toggle('active-panel', !!isActive);
    }
  }

  setMaximized(isMaximized) {
    this.isMaximized = isMaximized;
    const focusBtn = this.headerEl.querySelector('.panel-focus-btn');
    if (focusBtn) {
      focusBtn.classList.toggle('active', isMaximized);
      focusBtn.title = isMaximized ? 'Restore Workspace Layout' : 'Focus / Maximize Panel';
    }
  }

  setCloseDisabled(disabled) {
    const closeBtn = this.headerEl.querySelector('.panel-close-btn');
    if (closeBtn) {
      closeBtn.disabled = disabled;
      closeBtn.style.opacity = disabled ? '0.3' : '1.0';
      closeBtn.style.cursor = disabled ? 'not-allowed' : 'pointer';
    }
  }

  setSubPane(paneKey, isEnabled) {
    if (this.subPanes[paneKey] === isEnabled) return;
    this.subPanes[paneKey] = !!isEnabled;
    this._applySubPaneLayout();
    this._emitAction('subPaneChange', { panelId: this.id, subPanes: { ...this.subPanes } });
  }

  _applySubPaneLayout() {
    // 1. Delta Summary Sub-Pane
    if (this.deltaSummaryPaneEl) {
      const showSummary = !!this.subPanes.deltaSummary;
      this.deltaSummaryPaneEl.style.display = showSummary ? 'flex' : 'none';
      this.deltaSummaryPaneEl.style.height = showSummary ? '160px' : '0px';
    }

    // 2. CVD Sub-Pane
    if (this.cvdPaneEl) {
      const showCvd = !!this.subPanes.cvd;
      this.cvdPaneEl.style.display = showCvd ? 'flex' : 'none';
      this.cvdPaneEl.style.height = showCvd ? '100px' : '0px';
    }

    // 3. Sync checkboxes in Analytics menu if present
    if (this.headerEl) {
      const cbDelta = this.headerEl.querySelector('.cb-subpane-delta');
      if (cbDelta) cbDelta.checked = !!this.subPanes.deltaSummary;
      const cbCvd = this.headerEl.querySelector('.cb-subpane-cvd');
      if (cbCvd) cbCvd.checked = !!this.subPanes.cvd;
    }

    // 4. Trigger ChartEngine resize & update
    if (this.chartEngine) {
      this.chartEngine.setSubPanes(this.subPanes);
      this.chartEngine.resize();

      if (this.subPanes.cvd && this.cvdRecords && this.cvdRecords.length > 0) {
        this.chartEngine.setCvdData(this.cvdRecords);
      }
      if (this.subPanes.deltaSummary) {
        this.chartEngine.renderSummaryTable();
      }
    }
  }

  getConfig() {
    return {
      id: this.id,
      symbol: this.symbol,
      timeframeStr: this.timeframeStr,
      timeframeMs: this.timeframeMs,
      chartMode: this.chartMode,
      footprintStyle: this.footprintStyle,
      subPanes: { ...this.subPanes }
    };
  }

  _emitAction(action, payload) {
    if (typeof this.onAction === 'function') {
      this.onAction(action, payload);
    }
  }

  destroy() {
    if (this.marketDataManager) {
      this.marketDataManager.unsubscribe(this.id);
    }
    if (this.chartEngine) {
      this.chartEngine.destroy();
      this.chartEngine = null;
    }
    if (this.el && this.el.parentNode) {
      this.el.parentNode.removeChild(this.el);
    }
  }
}
