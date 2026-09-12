/**
 * app.js
 * Main Application Orchestrator for Depthflow Platform.
 */

import { ProviderRegistry } from './data/ProviderRegistry.js';
import { ChartEngine } from './chart/ChartEngine.js?v=tv2';
import { VolumeProfileEngine } from './analytics/VolumeProfileEngine.js';
import { VolumeProfileRenderer } from './chart/VolumeProfileRenderer.js?v=tv1';
import { DeltaEngine } from './analytics/DeltaEngine.js';
import { AdaptiveClassifier } from './analytics/AdaptiveClassifier.js';
import { FootprintAggregator } from './analytics/FootprintAggregator.js';
import { PatternDetector } from './analytics/PatternDetector.js';
import { BigTradesEngine, DetectionMethod, BigTradeEventType } from './analytics/BigTradesEngine.js';
import { TPOEngine } from './analytics/TPOEngine.js';
import { ReplayEngine } from './data/ReplayEngine.js';
import { DiagnosticsDrawer } from './ui/DiagnosticsDrawer.js';
import { defaultConfig } from './analytics/OrderFlowConfig.js';

class DepthflowApp {
  constructor() {
    this.registry = new ProviderRegistry();
    this.chartEngine = null;
    this.profileEngine = new VolumeProfileEngine();
    this.profileRenderer = null;
    this.deltaEngine = new DeltaEngine();
    this.classifier = new AdaptiveClassifier();
    this.bigTradesEngine = new BigTradesEngine();
    this.bigTradesVisible = true;
    this.tpoEngine = new TPOEngine();
    this._lastTpoUpdate = 0;

    const symSelect = document.getElementById('symbolSelect');
    this.currentSymbol = (symSelect && symSelect.value) ? symSelect.value : 'EUR/USD';
    this.currentTimeframeMs = 60000;
    this.currentTimeframeStr = '1m';

    this.watchlistBaseline = {
      'EUR/USD': 1.08500,
      'GBP/USD': 1.28400,
      'USD/JPY': 154.200,
      'XAU/USD': 2340.50,
      'BTC/USD': 64250.0,
      'ETH/USD': 3450.20
    };

    this.aggregator = new FootprintAggregator({ timeframeMs: 60000, symbol: this.currentSymbol });
    this.patternDetector = new PatternDetector(defaultConfig);
    this.replayEngine = null;
    this.diagnosticsDrawer = new DiagnosticsDrawer();

    this._initUI();
  }

  async _initUI() {
    console.log('[DepthflowApp] Initializing MT5 Live Footprint Engine...');

    // Init Canvas Chart Engine
    this.chartEngine = new ChartEngine('mainChartArea', 'cvdChartArea');
    this.chartEngine.setSymbol(this.currentSymbol);
    this.chartEngine.setTimeframe(this.currentTimeframeMs, this.currentTimeframeStr);

    // Init Volume Profile Renderer
    const vpCanvas = document.getElementById('volumeProfileCanvas');
    if (vpCanvas) {
      this.profileRenderer = new VolumeProfileRenderer(vpCanvas);
    }

    // Init Replay Engine
    this.replayEngine = new ReplayEngine({
      onTick: (event) => this._processMarketEvent(event),
      onStateChange: (state) => this._updateReplayUI(state)
    });

    // Bind Event Listeners
    this._bindControls();

    // Register Data Event Stream
    this.registry.onEvent((event) => this._processMarketEvent(event));
    this.registry.onCandles((candles) => this._processInitialCandles(candles));
    this.registry.onHistoricalChunk((candles) => this._processHistoricalChunk(candles));
    this.registry.onLiquidationHeatmap((data) => {
      if (this.chartEngine) this.chartEngine.setLiquidationData(data);
    });
    this.registry.onLiquidationSweep((data) => {
      if (this.chartEngine) this.chartEngine.triggerLiquidationSweep(data);
    });
    this.registry.onStatusChange((statusInfo) => this._updateStatusUI(statusInfo));

    // Setup backward scroll pagination listener
    this._setupScrollPagination();

    // Activate MT5 Bridge as Default Feed Provider
    await this.registry.setActiveProvider('MT5Adapter', this.currentSymbol);

    // Window Resize Handler
    window.addEventListener('resize', () => {
      if (this.chartEngine) this.chartEngine.resize();
    });

    console.log('[DepthflowApp] MT5 live bridge active.');
  }

  _setupScrollPagination() {
    let isFetchingHistory = false;
    const checkScroll = () => {
      if (!this.chartEngine || !this.chartEngine.chart || isFetchingHistory) return;
      const logicalRange = this.chartEngine.chart.timeScale().getVisibleLogicalRange();
      if (logicalRange && logicalRange.from < 15) {
        const allCandles = this.aggregator.getAllCandles();
        if (allCandles.length > 0) {
          isFetchingHistory = true;
          const earliestTs = allCandles[0].startTime;
          this.registry.loadMoreHistory(earliestTs, 400);
          setTimeout(() => { isFetchingHistory = false; }, 800);
        }
      }
    };

    if (this.chartEngine && this.chartEngine.chart) {
      this.chartEngine.chart.timeScale().subscribeVisibleLogicalRangeChange(checkScroll);
    } else {
      setTimeout(() => this._setupScrollPagination(), 500);
    }
  }

  _bindControls() {
    // Symbol Select
    const symbolSelect = document.getElementById('symbolSelect');
    if (symbolSelect) {
      symbolSelect.addEventListener('change', async (e) => {
        await this.switchSymbol(e.target.value);
      });
    }

    // TradingView Watchlist Row Clicks
    const wlRows = document.querySelectorAll('.wl-row');
    wlRows.forEach(row => {
      row.addEventListener('click', async () => {
        const sym = row.getAttribute('data-symbol');
        if (sym && sym !== this.currentSymbol) {
          await this.switchSymbol(sym);
        }
      });
    });

    // Timeframe Buttons (1m, 5m, 15m, 30m, 1h, 4h, D)
    const tfBtns = document.querySelectorAll('.tf-btn');
    const tfMap = {
      '60000': '1m',
      '300000': '5m',
      '900000': '15m',
      '1800000': '30m',
      '3600000': '1h',
      '14400000': '4h',
      '86400000': 'D'
    };

    tfBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        tfBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tfMs = parseInt(btn.getAttribute('data-tf'));
        const tfStr = btn.getAttribute('data-label') || tfMap[tfMs.toString()] || '1m';
        this.setTimeframe(tfMs, tfStr);
      });
    });

    // Chart View Mode (Footprint vs TPO vs Normal Candlestick)
    const chartModeSelect = document.getElementById('chartModeSelect');
    const tpoQuickBtn = document.getElementById('tpoQuickBtn');
    const styleContainer = document.getElementById('footprintStyleContainer');

    const updateChartModeUI = (mode) => {
      if (styleContainer) {
        styleContainer.style.display = (mode === 'CANDLESTICK' || mode === 'TPO') ? 'none' : 'flex';
      }
      if (tpoQuickBtn) {
        tpoQuickBtn.classList.toggle('active', mode === 'TPO');
      }
      if (chartModeSelect && chartModeSelect.value !== mode) {
        chartModeSelect.value = mode;
      }
      if (this.chartEngine) {
        if (mode === 'TPO' && this.tpoEngine) {
          const sessions = this.tpoEngine.processCandles(this.aggregator.getAllCandles(), this.currentSymbol);
          this.chartEngine.setTpoSessions(sessions);
        }
        this.chartEngine.setChartMode(mode);
      }
    };

    if (chartModeSelect) {
      chartModeSelect.addEventListener('change', (e) => {
        updateChartModeUI(e.target.value);
      });
    }

    if (tpoQuickBtn) {
      tpoQuickBtn.addEventListener('click', () => {
        const currentMode = this.chartEngine ? this.chartEngine.chartMode : 'FOOTPRINT';
        const nextMode = currentMode === 'TPO' ? 'FOOTPRINT' : 'TPO';
        updateChartModeUI(nextMode);
      });
    }

    // Layout Mode Split Switcher
    const layoutSingleBtn = document.getElementById('layoutSingleBtn');
    const layoutSplitBtn = document.getElementById('layoutSplitBtn');
    if (layoutSingleBtn) {
      layoutSingleBtn.addEventListener('click', () => {
        if (this.chartEngine) this.chartEngine.setLayoutMode('SINGLE');
      });
    }
    if (layoutSplitBtn) {
      layoutSplitBtn.addEventListener('click', () => {
        if (this.chartEngine) this.chartEngine.setLayoutMode('SPLIT');
      });
    }

    // Footprint Style Selector (Profile Histogram vs Cluster)
    const styleSelect = document.getElementById('footprintStyleSelect');
    if (styleSelect) {
      styleSelect.addEventListener('change', (e) => {
        const style = e.target.value;
        if (this.chartEngine) {
          this.chartEngine.setFootprintStyle(style);
        }
      });
    }

    // Liquidation Heatmap Switcher
    const heatmapSelect = document.getElementById('heatmapSelect');
    if (heatmapSelect) {
      heatmapSelect.addEventListener('change', (e) => {
        const isVisible = e.target.value === 'ON';
        if (this.chartEngine) {
          this.chartEngine.setLiquidationVisible(isVisible);
        }
      });
    }

    // Unified Theme Switcher (Dark vs Light Sierra Mode)
    const applyTheme = (theme) => {
      const appBody = document.getElementById('appBody');
      const themeSelect = document.getElementById('themeSelect');
      const themeToggleBtn = document.getElementById('themeToggleBtn');

      if (theme === 'LIGHT') {
        appBody.classList.remove('dark-theme');
        appBody.classList.add('light-theme');
        if (themeToggleBtn) themeToggleBtn.textContent = '☀️ Theme';
      } else {
        appBody.classList.remove('light-theme');
        appBody.classList.add('dark-theme');
        if (themeToggleBtn) themeToggleBtn.textContent = '🌙 Theme';
      }
      if (themeSelect) themeSelect.value = theme;
      if (this.chartEngine) {
        this.chartEngine.setTheme(theme);
      }
    };

    // Quick Theme Toggle Button in Header
    const themeToggleBtn = document.getElementById('themeToggleBtn');
    if (themeToggleBtn) {
      themeToggleBtn.addEventListener('click', () => {
        const currentIsDark = document.getElementById('appBody').classList.contains('dark-theme');
        const nextTheme = currentIsDark ? 'LIGHT' : 'DARK';
        applyTheme(nextTheme);
      });
    }

    // Theme Switcher in Settings Modal
    const themeSelect = document.getElementById('themeSelect');
    if (themeSelect) {
      themeSelect.addEventListener('change', (e) => {
        applyTheme(e.target.value);
      });
    }

    // Feed Provider Select
    const providerSelect = document.getElementById('providerSelect');
    const scenarioContainer = document.getElementById('scenarioContainer');

    if (providerSelect) {
      providerSelect.addEventListener('change', async (e) => {
        const providerName = e.target.value;
        this._resetAnalytics();

        if (providerName === 'SimulatedFeed') {
          if (scenarioContainer) scenarioContainer.style.display = 'flex';
        } else {
          if (scenarioContainer) scenarioContainer.style.display = 'none';
        }

        if (providerName === 'DukascopyAdapter') {
          const dukascopy = this.registry.providers.get('DukascopyAdapter');
          const ticks = await dukascopy.loadHistoricalTicks('2026-09-01', '2026-09-02');
          this.replayEngine.loadTicks(ticks);
        } else {
          await this.registry.setActiveProvider(providerName, this.currentSymbol);
        }
      });
    }

    // Scenario Select
    const scenarioSelect = document.getElementById('scenarioSelect');
    if (scenarioSelect) {
      scenarioSelect.addEventListener('change', (e) => {
        const simFeed = this.registry.providers.get('SimulatedFeed');
        if (simFeed) {
          simFeed.setScenario(e.target.value);
        }
      });
    }

    // Replay Controls
    const playBtn = document.getElementById('replayPlayBtn');
    const pauseBtn = document.getElementById('replayPauseBtn');
    const stepBtn = document.getElementById('replayStepBtn');
    const speedSlider = document.getElementById('replaySpeedSlider');
    const progressSlider = document.getElementById('replayProgress');

    if (playBtn) playBtn.addEventListener('click', () => this.replayEngine.play());
    if (pauseBtn) pauseBtn.addEventListener('click', () => this.replayEngine.pause());
    if (stepBtn) stepBtn.addEventListener('click', () => this.replayEngine.step());

    if (speedSlider) {
      speedSlider.addEventListener('input', (e) => {
        const val = parseInt(e.target.value);
        this.replayEngine.setSpeed(val);
        document.getElementById('replaySpeedVal').textContent = `${val}x`;
      });
    }

    if (progressSlider) {
      progressSlider.addEventListener('input', (e) => {
        const pct = parseFloat(e.target.value);
        this.replayEngine.seekPercentage(pct);
      });
    }

    // Big Trades Header Toggle Button
    const btToggleBtn = document.getElementById('bigTradesToggleBtn');
    if (btToggleBtn) {
      btToggleBtn.addEventListener('click', () => {
        this.bigTradesVisible = !this.bigTradesVisible;
        if (this.bigTradesVisible) {
          btToggleBtn.classList.add('active');
        } else {
          btToggleBtn.classList.remove('active');
        }
        if (this.chartEngine) {
          this.chartEngine.setBigTradesVisible(this.bigTradesVisible);
        }
      });
    }

    // Settings Modal
    const openSettingsBtn = document.getElementById('openSettingsBtn');
    const closeSettingsBtn = document.getElementById('closeSettingsBtn');
    const saveSettingsBtn = document.getElementById('saveSettingsBtn');
    const settingsModal = document.getElementById('settingsModal');

    if (openSettingsBtn) openSettingsBtn.addEventListener('click', () => settingsModal.classList.remove('hidden'));
    if (closeSettingsBtn) closeSettingsBtn.addEventListener('click', () => settingsModal.classList.add('hidden'));

    if (saveSettingsBtn) {
      saveSettingsBtn.addEventListener('click', () => {
        const ratio = parseFloat(document.getElementById('cfgImbalanceRatio').value);
        const stacked = parseInt(document.getElementById('cfgStackedLevels').value);
        const va = parseFloat(document.getElementById('cfgValueArea').value);

        defaultConfig.update({
          imbalanceRatio: ratio,
          stackedImbalanceMinLevels: stacked,
          valueAreaPercent: va
        });

        this.profileEngine.valueAreaPercent = va;

        // Big Trades Configuration update
        const btMethodEl = document.getElementById('cfgBigTradesMethod');
        const btSensEl = document.getElementById('cfgBigTradesSensitivity');
        const btFloorEl = document.getElementById('cfgBigTradesMinFloor');
        const btFidelityEl = document.getElementById('cfgBigTradesFidelity');

        if (this.bigTradesEngine && btMethodEl) {
          const method = btMethodEl.value;
          const sens = parseFloat(btSensEl ? btSensEl.value : 2.5);
          const floor = parseFloat(btFloorEl ? btFloorEl.value : 25000);
          const fidelity = btFidelityEl ? btFidelityEl.value : 'BROKER_VOLUME';

          this.bigTradesEngine.setOptions({
            method: method,
            madMultiplier: sens,
            stdDevMultiplier: sens,
            percentileThreshold: Math.max(0.90, Math.min(0.999, 1 - (sens * 0.008))),
            minVolumeFloor: floor,
            fidelityMode: fidelity
          });

          // Re-evaluate on currently loaded candles and refresh chart series
          const allCandles = this.aggregator.getAllCandles();
          if (allCandles.length > 0) {
            this.bigTradesEngine.processCandles(allCandles);
            if (this.chartEngine) {
              this.chartEngine.setCandles(allCandles);
            }
          }
        }

        // Apply Theme on Save
        const theme = document.getElementById('themeSelect')?.value || 'DARK';
        applyTheme(theme);

        // Apply Liquidation Heatmap overlay on Save
        const heatmap = document.getElementById('heatmapSelect')?.value || 'ON';
        if (this.chartEngine) {
          this.chartEngine.setLiquidationVisible(heatmap === 'ON');
        }

        settingsModal.classList.add('hidden');
      });
    }
  }

  _isSymbolMatch(sym1, sym2) {
    if (!sym1 || !sym2) return false;
    const s1 = sym1.replace(/[^a-zA-Z]/g, '').toUpperCase();
    const s2 = sym2.replace(/[^a-zA-Z]/g, '').toUpperCase();
    return s1 === s2 || s1.startsWith(s2) || s2.startsWith(s1);
  }

  async switchSymbol(sym) {
    if (!sym) return;
    this.currentSymbol = sym;

    const symSelect = document.getElementById('symbolSelect');
    if (symSelect) symSelect.value = sym;

    document.querySelectorAll('.wl-row').forEach(r => {
      if (r.getAttribute('data-symbol') === sym) {
        r.classList.add('active');
      } else {
        r.classList.remove('active');
      }
    });

    const legSym = document.getElementById('legendSymbol');
    if (legSym) legSym.textContent = sym;

    console.log(`[OdeerflowApp] Switched active symbol to: ${sym}`);
    this._resetAnalytics();

    if (this.chartEngine) {
      this.chartEngine.setSymbol(this.currentSymbol);
    }

    const activeProvider = this.registry.getActiveProvider();
    if (activeProvider) {
      await this.registry.setActiveProvider(activeProvider.name, this.currentSymbol, this.currentTimeframeStr);
    }
  }

  setTimeframe(timeframeMs, timeframeStr) {
    this.currentTimeframeMs = timeframeMs;
    this.currentTimeframeStr = timeframeStr;
    console.log(`[OdeerflowApp] Switching timeframe to ${timeframeStr} (${timeframeMs}ms)`);

    if (this.bigTradesEngine) {
      this.bigTradesEngine.setTimeframe(timeframeStr, timeframeMs);
    }

    const legTf = document.getElementById('legendTf');
    if (legTf) legTf.textContent = timeframeStr;

    this._resetAnalytics();

    // Clear chart canvas & series immediately
    if (this.chartEngine) {
      this.chartEngine.setTimeframe(timeframeMs, timeframeStr);
      this.chartEngine.clear();
    }

    this.registry.setTimeframe(timeframeStr);
  }

  _processInitialCandles(candles) {
    if (!Array.isArray(candles) || candles.length === 0) return;
    if (candles[0].symbol && !this._isSymbolMatch(candles[0].symbol, this.currentSymbol)) {
      return;
    }
    console.log(`[OdeerflowApp] Hydrating ${candles.length} MT5 candles into chart and analytics for ${this.currentSymbol}`);

    this._resetAnalytics();
    this.aggregator.loadCandles(candles);
    this.profileEngine.loadFromCandles(candles);

    const profileData = this.profileEngine.calculateProfile();
    if (this.profileRenderer) {
      this.profileRenderer.render(profileData);
    }
    this._updateProfileStatsUI(profileData);

    const allCandles = this.aggregator.getAllCandles();
    if (this.bigTradesEngine) {
      this.bigTradesEngine.processCandles(allCandles);
    }
    if (this.chartEngine) {
      this.chartEngine.setCandles(allCandles);
    }

    if (this.tpoEngine) {
      const sessions = this.tpoEngine.processCandles(allCandles, this.currentSymbol);
      if (this.chartEngine) {
        this.chartEngine.setTpoSessions(sessions);
      }
    }

    if (allCandles.length > 0) {
      const lastC = allCandles[allCandles.length - 1];
      this._updateLegend(lastC);
      this._updateWatchlist(this.currentSymbol, lastC.close);
    }

    // Initialize Delta / CVD with the hydrated bars
    let cumulativeCvd = 0;
    allCandles.forEach((c) => {
      const cvdRecord = this.deltaEngine.processCandle(c);
      cumulativeCvd = cvdRecord.cvd;
      if (this.chartEngine) {
        this.chartEngine.updateCvd(c.startTime, cumulativeCvd);
      }
    });

    const cvdValEl = document.getElementById('cvdVal');
    if (cvdValEl) {
      cvdValEl.textContent = `${cumulativeCvd > 0 ? '+' : ''}${cumulativeCvd}`;
      cvdValEl.style.color = cumulativeCvd >= 0 ? '#089981' : '#F23645';
    }

    const signalsContainer = document.getElementById('signalsFeed');
    if (signalsContainer) {
      signalsContainer.innerHTML = `<div class="signal-item bullish">✓ MT5 Broker Live Feed Connected: ${candles.length} recent bars loaded. Streaming live market ticks...</div>`;
    }
  }

  _processHistoricalChunk(candles) {
    if (!Array.isArray(candles) || candles.length === 0) return;
    if (candles[0].symbol && !this._isSymbolMatch(candles[0].symbol, this.currentSymbol)) return;

    console.log(`[OdeerflowApp] Prepending ${candles.length} historical bars for ${this.currentSymbol}`);
    this.aggregator.prependCandles(candles);
    const allCandles = this.aggregator.getAllCandles();
    if (this.bigTradesEngine) {
      this.bigTradesEngine.processCandles(allCandles);
    }
    if (this.chartEngine) {
      this.chartEngine.prependCandles(allCandles);
    }
    if (this.tpoEngine) {
      const sessions = this.tpoEngine.processCandles(allCandles, this.currentSymbol);
      if (this.chartEngine) {
        this.chartEngine.setTpoSessions(sessions);
      }
    }
  }

  _isPriceReasonableForSymbol(symbol, price) {
    if (!price || price <= 0 || isNaN(price)) return false;
    const s = (symbol || '').toUpperCase();
    if (s.includes('BTC')) return price > 10000 && price < 500000;
    if (s.includes('ETH')) return price > 500 && price < 20000;
    if (s.includes('XAU') || s.includes('GOLD')) return price > 500 && price < 15000;
    if (s.includes('JPY')) return price > 50 && price < 500;
    // Standard Forex (EUR/USD, GBP/USD, etc.)
    return price > 0.1 && price < 10.0;
  }

  _updateWatchlist(rawSymbol, price) {
    if (!rawSymbol || !price || isNaN(price)) return;
    let matchSym = null;
    const norm = rawSymbol.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    for (const key of Object.keys(this.watchlistBaseline)) {
      const kNorm = key.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
      if (norm.includes(kNorm) || kNorm.includes(norm)) {
        matchSym = key;
        break;
      }
    }
    if (!matchSym) return;

    const cleanId = matchSym.replace(/[^a-zA-Z0-9]/g, '');
    const lastEl = document.getElementById(`wl-last-${cleanId}`);
    const chgEl = document.getElementById(`wl-chg-${cleanId}`);
    const pctEl = document.getElementById(`wl-pct-${cleanId}`);

    const decimals = matchSym.includes('JPY') ? 3 : (matchSym.includes('BTC') ? 1 : (matchSym.includes('ETH') || matchSym.includes('XAU') ? 2 : 5));
    const formattedPrice = price.toFixed(decimals);

    if (lastEl) lastEl.textContent = formattedPrice;

    const base = this.watchlistBaseline[matchSym] || price;
    const diff = price - base;
    const pct = (diff / base) * 100;
    const isPos = diff >= 0;

    if (chgEl) {
      chgEl.textContent = `${isPos ? '+' : ''}${diff.toFixed(decimals)}`;
    }
    if (pctEl) {
      pctEl.textContent = `${isPos ? '+' : ''}${pct.toFixed(2)}%`;
      pctEl.className = `col-pct ${isPos ? 'pos' : 'neg'}`;
    }

    if (matchSym === this.currentSymbol) {
      const headerPrice = document.getElementById('headerLivePrice');
      if (headerPrice) {
        headerPrice.textContent = formattedPrice;
        headerPrice.style.color = isPos ? 'var(--buy-green)' : 'var(--sell-red)';
      }
    }
  }

  _updateLegend(candle) {
    if (!candle) return;
    const decimals = this.currentSymbol.includes('JPY') ? 3 : (this.currentSymbol.includes('BTC') ? 1 : (this.currentSymbol.includes('ETH') || this.currentSymbol.includes('XAU') ? 2 : 5));
    const oEl = document.getElementById('legendO');
    const hEl = document.getElementById('legendH');
    const lEl = document.getElementById('legendL');
    const cEl = document.getElementById('legendC');
    const chgEl = document.getElementById('legendChg');

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

  _processMarketEvent(event) {
    if (!event) return;

    // Update real-time ticker in watchlist for any known symbol
    this._updateWatchlist(event.symbol, event.price);

    if (!this._isSymbolMatch(event.symbol, this.currentSymbol)) return;

    // Safety checks against in-flight cross-contamination
    if (!this._isPriceReasonableForSymbol(this.currentSymbol, event.price)) return;

    // Record Tick for Diagnostics
    this.diagnosticsDrawer.recordTick();

    // 1. Adaptive Classification
    const aggressorResult = this.classifier.classify(event);
    this.diagnosticsDrawer.updateAggressorMode(aggressorResult.method);

    // 2. Volume Profile Update
    this.profileEngine.addEvent(event.price, event.size);
    const profileData = this.profileEngine.calculateProfile();
    if (this.profileRenderer) {
      this.profileRenderer.render(profileData);
    }
    this._updateProfileStatsUI(profileData);

    // 3. Footprint Candle Aggregation & TV Rendering
    const activeCandle = this.aggregator.processEvent(event, aggressorResult);
    if (this.bigTradesEngine) {
      this.bigTradesEngine.processCandle(activeCandle);
    }
    if (this.chartEngine) {
      if (event.price) this.chartEngine.onLiveTick(event.price);
      this.chartEngine.updateCandle(activeCandle);
    }
    this._updateLegend(activeCandle);

    // Dynamic Live TPO Profile Refresh (Throttled every 3.5s)
    if (this.tpoEngine && (!this._lastTpoUpdate || Date.now() - this._lastTpoUpdate > 3500)) {
      this._lastTpoUpdate = Date.now();
      const sessions = this.tpoEngine.processCandles(this.aggregator.getAllCandles(), this.currentSymbol);
      if (this.chartEngine) {
        this.chartEngine.setTpoSessions(sessions);
      }
    }

    // 4. CVD & Delta Calculation
    const cvdRecord = this.deltaEngine.processCandle(activeCandle);
    if (this.chartEngine) {
      this.chartEngine.updateCvd(cvdRecord.timestamp, cvdRecord.cvd);
    }
    const cvdValEl = document.getElementById('cvdVal');
    if (cvdValEl) {
      cvdValEl.textContent = `${cvdRecord.cvd > 0 ? '+' : ''}${cvdRecord.cvd}`;
      cvdValEl.style.color = cvdRecord.cvd >= 0 ? '#089981' : '#F23645';
    }

    // 5. Pattern Detection & Order-Flow Signals
    const signals = this.patternDetector.detectPatterns(activeCandle);
    if (signals.length > 0) {
      this._appendSignalsUI(signals);
    }

    // 6. Update Diagnostics
    this.diagnosticsDrawer.updateDiagnostics(this.registry.getDiagnostics());
  }

  _resetAnalytics() {
    this.profileEngine.reset();
    if (this.profileRenderer) {
      this.profileRenderer.clear();
    }
    this.deltaEngine = new DeltaEngine();
    this.aggregator = new FootprintAggregator({ timeframeMs: this.currentTimeframeMs, symbol: this.currentSymbol });
    if (this.bigTradesEngine) {
      this.bigTradesEngine.clear();
    }
    if (this.chartEngine) {
      this.chartEngine.clear();
    }
  }

  _updateProfileStatsUI(profileData) {
    const pocEl = document.getElementById('pocDisplay');
    const vahEl = document.getElementById('vahDisplay');
    const valEl = document.getElementById('valDisplay');
    const totalVolEl = document.getElementById('totalVolDisplay');

    const s = (this.currentSymbol || '').toUpperCase();
    const isCrypto = s.includes('BTC') || s.includes('ETH');
    const isGold = s.includes('XAU') || s.includes('GOLD');
    const isJpy = s.includes('JPY');
    const decimals = isCrypto || isGold ? 2 : (isJpy ? 3 : 5);

    if (pocEl) pocEl.textContent = profileData.poc ? profileData.poc.toFixed(decimals) : '--';
    if (vahEl) vahEl.textContent = profileData.vah ? profileData.vah.toFixed(decimals) : '--';
    if (valEl) valEl.textContent = profileData.val ? profileData.val.toFixed(decimals) : '--';
    if (totalVolEl) totalVolEl.textContent = profileData.totalVolume || 0;
  }

  _updateStatusUI(statusInfo) {
    const statusBadge = document.getElementById('feedStatusBadge');
    const fidelityBadge = document.getElementById('fidelityBadge');

    if (statusBadge) {
      statusBadge.textContent = statusInfo.status;
      statusBadge.className = `status-badge ${statusInfo.status === 'CONNECTED' ? 'connected' : 'disconnected'}`;
    }

    if (fidelityBadge && statusInfo.capabilities) {
      fidelityBadge.textContent = statusInfo.capabilities.volumeFidelity;
    }
  }

  _updateReplayUI(state) {
    const playBtn = document.getElementById('replayPlayBtn');
    const pauseBtn = document.getElementById('replayPauseBtn');
    const counter = document.getElementById('replayCounter');
    const progress = document.getElementById('replayProgress');

    if (playBtn) playBtn.disabled = state.isPlaying;
    if (pauseBtn) pauseBtn.disabled = !state.isPlaying;
    if (counter) counter.textContent = `${state.currentIndex} / ${state.totalTicks} Ticks`;
    if (progress) progress.value = state.progressPercent;
  }

  _appendSignalsUI(signals) {
    const feed = document.getElementById('signalsFeed');
    if (!feed) return;

    signals.forEach(sig => {
      const item = document.createElement('div');
      item.className = 'signal-item';

      if (sig.type.includes('ABSORPTION')) {
        item.classList.add('absorption');
        item.innerHTML = `<strong>⚡ ABSORPTION:</strong> ${sig.type} at ${sig.price.toFixed(2)} (Vol: ${sig.volume})`;
      } else if (sig.type.includes('IMBALANCE')) {
        item.classList.add('imbalance');
        item.innerHTML = `<strong>⚖ IMBALANCE:</strong> ${sig.type} at ${sig.price ? sig.price.toFixed(2) : 'Multiple'}`;
      } else if (sig.type.includes('SWEEP')) {
        item.classList.add('sweep');
        item.innerHTML = `<strong>🎯 SWEEP:</strong> ${sig.type} at ${sig.price.toFixed(2)} (${sig.rejectionPips} pips rejection)`;
      } else {
        item.textContent = `${sig.type} detected`;
      }

      feed.insertBefore(item, feed.firstChild);
      if (feed.children.length > 20) feed.removeChild(feed.lastChild);
    });
  }
}

// Guaranteed App Bootstrap (resilient to DOMContentLoaded timing on refresh)
function startDepthflow() {
  if (!window.depthflowApp) {
    window.depthflowApp = new DepthflowApp();
    window.odeerflowApp = window.depthflowApp; // Backward compatibility alias
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startDepthflow);
} else {
  startDepthflow();
}
