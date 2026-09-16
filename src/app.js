/**
 * app.js
 * Main Application Orchestrator for Depthflow Platform.
 * Multi-Panel Chart Workspace & MT5 Live Stream Architecture.
 */

import { ProviderRegistry } from './data/ProviderRegistry.js';
import { MarketDataManager } from './workspace/MarketDataManager.js';
import { WorkspaceManager, WorkspaceLayout } from './workspace/WorkspaceManager.js';
import { ChartEngine } from './chart/ChartEngine.js?v=orderflow_v5';
import { VolumeProfileEngine } from './analytics/VolumeProfileEngine.js?v=orderflow_v5';
import { VolumeProfileRenderer } from './chart/VolumeProfileRenderer.js?v=orderflow_v5';
import { DeltaEngine } from './analytics/DeltaEngine.js?v=orderflow_v5';
import { AdaptiveClassifier } from './analytics/AdaptiveClassifier.js?v=orderflow_v5';
import { FootprintAggregator } from './analytics/FootprintAggregator.js?v=orderflow_v5';
import { PatternDetector } from './analytics/PatternDetector.js?v=orderflow_v5';
import { BigTradesEngine } from './analytics/BigTradesEngine.js?v=orderflow_v5';
import { TPOEngine } from './analytics/TPOEngine.js?v=orderflow_v5';
import { ReplayEngine } from './data/ReplayEngine.js?v=orderflow_v5';
import { DiagnosticsDrawer } from './ui/DiagnosticsDrawer.js?v=orderflow_v5';
import { TPOSettingsModal } from './ui/TPOSettingsModal.js?v=orderflow_v5';
import { defaultConfig } from './analytics/OrderFlowConfig.js';

class DepthflowApp {
  constructor() {
    this.registry = new ProviderRegistry();
    this.marketDataManager = new MarketDataManager(this.registry);
    this.workspaceManager = null;
    this.tpoSettingsModal = null;
    this.diagnosticsDrawer = new DiagnosticsDrawer();
    this.replayEngine = null;
    this.patternDetector = new PatternDetector(defaultConfig);

    this.bigTradesVisible = true;
    this.theme = 'DARK';

    this.watchlistBaseline = {
      'EUR/USD': 1.08500,
      'GBP/USD': 1.28400,
      'USD/JPY': 154.200,
      'XAU/USD': 2340.50,
      'BTC/USD': 64250.0,
      'ETH/USD': 3450.20
    };

    this._initUI();
  }

  get chartEngine() {
    const p = this.workspaceManager ? this.workspaceManager.getActivePanel() : null;
    return p ? p.chartEngine : null;
  }

  get currentSymbol() {
    const p = this.workspaceManager ? this.workspaceManager.getActivePanel() : null;
    return p ? p.symbol : 'EUR/USD';
  }

  get currentTimeframeStr() {
    const p = this.workspaceManager ? this.workspaceManager.getActivePanel() : null;
    return p ? p.timeframeStr : '1m';
  }

  get currentTimeframeMs() {
    const p = this.workspaceManager ? this.workspaceManager.getActivePanel() : null;
    return p ? p.timeframeMs : 60000;
  }

  get aggregator() {
    const p = this.workspaceManager ? this.workspaceManager.getActivePanel() : null;
    return p ? p.aggregator : null;
  }

  get tpoEngine() {
    const p = this.workspaceManager ? this.workspaceManager.getActivePanel() : null;
    return p ? p.tpoEngine : null;
  }

  get bigTradesEngine() {
    const p = this.workspaceManager ? this.workspaceManager.getActivePanel() : null;
    return p ? p.bigTradesEngine : null;
  }

  get deltaEngine() {
    const p = this.workspaceManager ? this.workspaceManager.getActivePanel() : null;
    return p ? p.deltaEngine : null;
  }

  get profileEngine() {
    const p = this.workspaceManager ? this.workspaceManager.getActivePanel() : null;
    return p ? p.profileEngine : null;
  }

  async _initUI() {
    console.log('[DepthflowApp] Initializing Multi-Panel Workspace & MT5 Live Stream...');

    // 1. Initialize Workspace Manager
    this.workspaceManager = new WorkspaceManager({
      container: 'workspaceRoot',
      marketDataManager: this.marketDataManager,
      onActivePanelChange: (activePanel) => this._syncActivePanelToHUD(activePanel),
      onActivePanelCvdChange: (action, payload) => this._handleActivePanelCvd(action, payload)
    });

    // 2. Initialize CVD Chart in lower sub-pane
    this._initCvdChart();

    // 3. Initialize Replay Engine
    this.replayEngine = new ReplayEngine({
      onTick: (event) => this.marketDataManager._handleIncomingMarketEvent(event),
      onStateChange: (state) => this._updateReplayUI(state)
    });

    // 4. Initialize TPO Settings Modal
    this.tpoSettingsModal = new TPOSettingsModal({
      onSettingsChange: (settings) => {
        if (this.workspaceManager) {
          this.workspaceManager.setTpoSettings(settings);
        }
      }
    });

    // Apply initial TPO settings to workspace
    const initialTpoSettings = this.tpoSettingsModal.getSettings();
    this.workspaceManager.tpoSettings = initialTpoSettings;

    // 5. Initialize workspace panels from storage or default
    this.workspaceManager.init();

    // 6. Bind HUD Controls
    this._bindControls();

    // 7. Register data listeners for global widgets (watchlist, diagnostics, status)
    this.registry.onEvent((event) => {
      this._updateWatchlist(event.symbol, event.price);
      this.diagnosticsDrawer.recordTick();
    });

    this.registry.onStatusChange((statusInfo) => this._updateStatusUI(statusInfo));

    // 8. Activate MT5 Bridge as Default Feed Provider
    const activePanel = this.workspaceManager.getActivePanel();
    const initSymbol = activePanel ? activePanel.symbol : 'EUR/USD';
    const initTf = activePanel ? activePanel.timeframeStr : '1m';
    await this.registry.setActiveProvider('MT5Adapter', initSymbol, initTf);

    // Initial HUD sync
    this._syncActivePanelToHUD(activePanel);

    // Window Resize Handler
    window.addEventListener('resize', () => {
      if (this.workspaceManager) this.workspaceManager.resize();
      if (this.cvdChart) {
        const cvdContainer = document.getElementById('cvdChartArea');
        if (cvdContainer) {
          const rect = cvdContainer.getBoundingClientRect();
          this.cvdChart.applyOptions({
            width: rect.width || cvdContainer.clientWidth || 800,
            height: rect.height || cvdContainer.clientHeight || 90
          });
        }
      }
    });

    console.log('[DepthflowApp] Multi-Panel Workspace active.');
  }

  _initCvdChart() {
    const cvdContainer = document.getElementById('cvdChartArea');
    if (!cvdContainer || cvdContainer.offsetParent === null || typeof window.LightweightCharts === 'undefined') {
      return;
    }

    if (this.cvdChart) return;

    const { createChart } = window.LightweightCharts;
    const rect = cvdContainer.getBoundingClientRect();
    const w = rect.width > 0 ? rect.width : cvdContainer.clientWidth || 800;
    const h = rect.height > 0 ? rect.height : cvdContainer.clientHeight || 90;

    this.cvdChart = createChart(cvdContainer, {
      width: w,
      height: h,
      layout: {
        background: { color: '#161c24' },
        textColor: '#808a9d'
      },
      grid: {
        vertLines: { color: '#1e2632' },
        horzLines: { color: '#1e2632' }
      },
      rightPriceScale: {
        borderColor: '#2a3442',
        autoScale: true
      },
      timeScale: {
        visible: false
      }
    });

    this.cvdSeries = this.cvdChart.addLineSeries({
      color: '#00e5ff',
      lineWidth: 2,
      priceLineVisible: false
    });
  }

  _handleActivePanelCvd(action, payload) {
    if (!this.cvdSeries) return;
    const mainPanelId = this.workspaceManager ? this.workspaceManager.getMainPanelId() : null;
    if (payload.panelId && mainPanelId && payload.panelId !== mainPanelId) {
      return; // Strictly ignore secondary panel updates to keep CVD locked to Main Panel
    }

    if (action === 'cvdLoaded') {
      try {
        this.cvdSeries.setData(payload.records || []);
        if (this.cvdChart) this.cvdChart.timeScale().fitContent();
      } catch (e) {}
      this._updateCvdBadge(payload.lastCvd || 0);
    } else if (action === 'cvdUpdate') {
      try {
        this.cvdSeries.update({
          time: payload.time,
          value: payload.value
        });
      } catch (e) {}
      this._updateCvdBadge(payload.value);
    }
  }

  _updateCvdBadge(cvdVal) {
    const cvdEl = document.getElementById('cvdVal');
    if (cvdEl && cvdVal !== undefined && cvdVal !== null) {
      const isPos = cvdVal >= 0;
      cvdEl.textContent = `${isPos ? '+' : ''}${Math.round(cvdVal)}`;
      cvdEl.style.color = isPos ? '#089981' : '#F23645';
    }
  }

  _syncActivePanelToHUD(activePanel) {
    if (!activePanel) return;

    // Symbol dropdown
    const symSelect = document.getElementById('symbolSelect');
    if (symSelect && symSelect.value !== activePanel.symbol) {
      symSelect.value = activePanel.symbol;
    }

    // Watchlist row highlight
    document.querySelectorAll('.wl-row').forEach(r => {
      if (r.getAttribute('data-symbol') === activePanel.symbol) {
        r.classList.add('active');
      } else {
        r.classList.remove('active');
      }
    });

    // Timeframe buttons
    document.querySelectorAll('.tf-btn').forEach(btn => {
      const btnTf = btn.getAttribute('data-label') || btn.textContent.trim();
      btn.classList.toggle('active', btnTf === activePanel.timeframeStr);
    });

    // Chart Mode Select
    const chartModeSelect = document.getElementById('chartModeSelect');
    if (chartModeSelect && chartModeSelect.value !== activePanel.chartMode) {
      chartModeSelect.value = activePanel.chartMode;
    }

    // TPO Quick Button
    const tpoQuickBtn = document.getElementById('tpoQuickBtn');
    if (tpoQuickBtn) {
      tpoQuickBtn.classList.toggle('active', activePanel.chartMode === 'TPO');
    }

    // Footprint Style Container
    const styleContainer = document.getElementById('footprintStyleContainer');
    if (styleContainer) {
      styleContainer.style.display = (activePanel.chartMode === 'FOOTPRINT') ? 'flex' : 'none';
    }

    const styleSelect = document.getElementById('footprintStyleSelect');
    if (styleSelect && styleSelect.value !== activePanel.footprintStyle) {
      styleSelect.value = activePanel.footprintStyle;
    }

    // Layout buttons active state
    if (this.workspaceManager) {
      const layout = this.workspaceManager.layout;
      document.querySelectorAll('#workspaceLayoutGroup .layout-btn-pill').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-layout') === layout);
      });
    }

    // Live Price in Header
    if (activePanel.aggregator) {
      const candles = activePanel.aggregator.getAllCandles();
      if (candles.length > 0) {
        const lastC = candles[candles.length - 1];
        const headerPrice = document.getElementById('headerLivePrice');
        if (headerPrice) {
          const isCrypto = activePanel.symbol.includes('BTC') || activePanel.symbol.includes('ETH');
          const isGold = activePanel.symbol.includes('XAU') || activePanel.symbol.includes('GOLD');
          const isJpy = activePanel.symbol.includes('JPY');
          const decimals = isCrypto || isGold ? 2 : (isJpy ? 3 : 5);
          headerPrice.textContent = Number(lastC.close).toFixed(decimals);
        }
      }
    }

    // Sync CVD chart exclusively to Main Panel
    const mainPanel = this.workspaceManager ? this.workspaceManager.getMainPanel() : null;
    if (mainPanel && mainPanel.cvdRecords && this.cvdSeries) {
      try {
        this.cvdSeries.setData(mainPanel.cvdRecords);
        if (this.cvdChart) this.cvdChart.timeScale().fitContent();
      } catch (e) {}
      this._updateCvdBadge(mainPanel.lastCvd || 0);
    }
  }

  _bindControls() {
    // 1. Symbol Select in HUD
    const symbolSelect = document.getElementById('symbolSelect');
    if (symbolSelect) {
      symbolSelect.addEventListener('change', async (e) => {
        await this.switchSymbol(e.target.value);
      });
    }

    // 2. Watchlist Row Clicks
    const wlRows = document.querySelectorAll('.wl-row');
    wlRows.forEach(row => {
      row.addEventListener('click', async () => {
        const sym = row.getAttribute('data-symbol');
        if (sym) {
          await this.switchSymbol(sym);
        }
      });
    });

    // 3. Timeframe Buttons
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
      btn.addEventListener('click', () => {
        const tfMs = parseInt(btn.getAttribute('data-tf'));
        const tfStr = btn.getAttribute('data-label') || tfMap[tfMs.toString()] || '1m';
        this.setTimeframe(tfMs, tfStr);
      });
    });

    // 4. Chart View Mode
    const chartModeSelect = document.getElementById('chartModeSelect');
    const tpoQuickBtn = document.getElementById('tpoQuickBtn');

    if (chartModeSelect) {
      chartModeSelect.addEventListener('change', (e) => {
        this.setChartMode(e.target.value);
      });
    }

    if (tpoQuickBtn) {
      tpoQuickBtn.addEventListener('click', () => {
        const active = this.workspaceManager.getActivePanel();
        const cur = active ? active.chartMode : 'FOOTPRINT';
        const next = (cur === 'TPO') ? 'FOOTPRINT' : 'TPO';
        this.setChartMode(next);
      });
    }

    // 5. Footprint Style
    const styleSelect = document.getElementById('footprintStyleSelect');
    if (styleSelect) {
      styleSelect.addEventListener('change', (e) => {
        this.setFootprintStyle(e.target.value);
      });
    }

    // 6. Workspace Layout Presets (1, 2H, 2V, 3, 4)
    const layoutBtns = document.querySelectorAll('#workspaceLayoutGroup .layout-btn-pill');
    layoutBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const layout = btn.getAttribute('data-layout');
        if (layout && this.workspaceManager) {
          this.workspaceManager.setLayout(layout);
          layoutBtns.forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
        }
      });
    });

    // 7. Add Panel Button
    const addPanelBtn = document.getElementById('addPanelBtn');
    if (addPanelBtn) {
      addPanelBtn.addEventListener('click', () => {
        if (this.workspaceManager) {
          this.workspaceManager.addPanel();
        }
      });
    }

    // 8. Big Trades Header Toggle Button
    const btToggleBtn = document.getElementById('bigTradesToggleBtn');
    if (btToggleBtn) {
      btToggleBtn.addEventListener('click', () => {
        this.bigTradesVisible = !this.bigTradesVisible;
        btToggleBtn.classList.toggle('active', this.bigTradesVisible);
        if (this.workspaceManager) {
          this.workspaceManager.setBigTradesVisible(this.bigTradesVisible);
        }
      });
    }

    // 9. Theme Switcher
    const applyTheme = (theme) => {
      this.theme = theme;
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
      if (this.workspaceManager) {
        this.workspaceManager.setTheme(theme);
      }
    };

    const themeToggleBtn = document.getElementById('themeToggleBtn');
    if (themeToggleBtn) {
      themeToggleBtn.addEventListener('click', () => {
        const currentIsDark = document.getElementById('appBody').classList.contains('dark-theme');
        const nextTheme = currentIsDark ? 'LIGHT' : 'DARK';
        applyTheme(nextTheme);
      });
    }

    const themeSelect = document.getElementById('themeSelect');
    if (themeSelect) {
      themeSelect.addEventListener('change', (e) => {
        applyTheme(e.target.value);
      });
    }

    // 10. 12H / 24H Time Format Switcher
    const timeFormatToggleBtn = document.getElementById('timeFormatToggleBtn');
    if (timeFormatToggleBtn) {
      const currentFormat = localStorage.getItem('depthflow_time_format') || '12H';
      timeFormatToggleBtn.textContent = `🕒 ${currentFormat}`;
      timeFormatToggleBtn.addEventListener('click', () => {
        const next = (timeFormatToggleBtn.textContent.includes('12H')) ? '24H' : '12H';
        timeFormatToggleBtn.textContent = `🕒 ${next}`;
        localStorage.setItem('depthflow_time_format', next);
        if (this.workspaceManager) {
          for (const panel of this.workspaceManager.panels.values()) {
            if (panel.chartEngine) {
              panel.chartEngine.timeFormat = next;
              panel.chartEngine.resize();
            }
          }
        }
      });
    }

    // 11. Feed Provider Select
    const providerSelect = document.getElementById('providerSelect');
    const scenarioContainer = document.getElementById('scenarioContainer');

    if (providerSelect) {
      providerSelect.addEventListener('change', async (e) => {
        const providerName = e.target.value;
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
          const active = this.workspaceManager ? this.workspaceManager.getActivePanel() : null;
          const sym = active ? active.symbol : 'EUR/USD';
          await this.registry.setActiveProvider(providerName, sym);
        }
      });
    }

    // 12. Scenario Select
    const scenarioSelect = document.getElementById('scenarioSelect');
    if (scenarioSelect) {
      scenarioSelect.addEventListener('change', (e) => {
        const simFeed = this.registry.providers.get('SimulatedFeed');
        if (simFeed) {
          simFeed.setScenario(e.target.value);
        }
      });
    }

    // 13. Replay Controls
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

    // 14. Settings Modal
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

        // Apply Big Trades Options
        const btMethodEl = document.getElementById('cfgBigTradesMethod');
        const btSensEl = document.getElementById('cfgBigTradesSensitivity');
        const btFloorEl = document.getElementById('cfgBigTradesMinFloor');
        const btFidelityEl = document.getElementById('cfgBigTradesFidelity');

        if (btMethodEl && this.workspaceManager) {
          const method = btMethodEl.value;
          const sens = parseFloat(btSensEl ? btSensEl.value : 2.5);
          const floor = parseFloat(btFloorEl ? btFloorEl.value : 25000);
          const fidelity = btFidelityEl ? btFidelityEl.value : 'BROKER_VOLUME';

          for (const panel of this.workspaceManager.panels.values()) {
            if (panel.bigTradesEngine) {
              panel.bigTradesEngine.setOptions({
                method: method,
                madMultiplier: sens,
                stdDevMultiplier: sens,
                percentileThreshold: Math.max(0.90, Math.min(0.999, 1 - (sens * 0.008))),
                minVolumeFloor: floor,
                fidelityMode: fidelity
              });
              const allCandles = panel.aggregator.getAllCandles();
              if (allCandles.length > 0) {
                panel.bigTradesEngine.processCandles(allCandles);
                if (panel.chartEngine) panel.chartEngine.setCandles(allCandles);
              }
            }
          }
        }

        // Apply Theme on Save
        const theme = document.getElementById('themeSelect')?.value || 'DARK';
        applyTheme(theme);

        // Apply Liquidation Heatmap overlay on Save
        const heatmap = document.getElementById('heatmapSelect')?.value || 'ON';
        if (this.workspaceManager) {
          for (const panel of this.workspaceManager.panels.values()) {
            if (panel.chartEngine) {
              panel.chartEngine.setLiquidationVisible(heatmap === 'ON');
            }
          }
        }

        settingsModal.classList.add('hidden');
      });
    }
  }

  async switchSymbol(sym) {
    if (!sym || !this.workspaceManager) return;
    const active = this.workspaceManager.getActivePanel();
    if (active) {
      active.setSymbol(sym);
      this._syncActivePanelToHUD(active);
    }
  }

  setTimeframe(timeframeMs, timeframeStr) {
    if (!timeframeStr || !this.workspaceManager) return;
    const active = this.workspaceManager.getActivePanel();
    if (active) {
      active.setTimeframe(timeframeStr);
      this._syncActivePanelToHUD(active);
    }
  }

  setChartMode(mode) {
    if (!mode || !this.workspaceManager) return;
    const active = this.workspaceManager.getActivePanel();
    if (active) {
      active.setChartMode(mode);
      this._syncActivePanelToHUD(active);
    }
  }

  setFootprintStyle(style) {
    if (!style || !this.workspaceManager) return;
    const active = this.workspaceManager.getActivePanel();
    if (active) {
      active.setFootprintStyle(style);
      this._syncActivePanelToHUD(active);
    }
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

    const active = this.workspaceManager ? this.workspaceManager.getActivePanel() : null;
    if (active && matchSym === active.symbol) {
      const headerPrice = document.getElementById('headerLivePrice');
      if (headerPrice) {
        headerPrice.textContent = formattedPrice;
        headerPrice.style.color = isPos ? 'var(--buy-green)' : 'var(--sell-red)';
      }
    }
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
}

// Guaranteed App Bootstrap
function startDepthflow() {
  if (!window.depthflowApp) {
    window.depthflowApp = new DepthflowApp();
    window.odeerflowApp = window.depthflowApp; // Backward compatibility alias
    window.app = window.depthflowApp;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startDepthflow);
} else {
  startDepthflow();
}
