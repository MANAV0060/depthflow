/**
 * ChartEngine.js
 * Professional TradingView Lightweight Charts + Footprint Canvas Orchestrator.
 * Fully synchronized camera transformation pipeline:
 * Derived X from timeScale.timeToCoordinate(t)
 * Derived Y from candlestickSeries.priceToCoordinate(p)
 * Synchronous pan/zoom with viewport culling.
 */

import { FootprintRenderer } from './FootprintRenderer.js';
import { FootprintSeriesPaneView } from './FootprintSeriesPlugin.js?v=tv2';
import { BigTradesPaneView } from './BigTradesPlugin.js?v=tv2';
import { LiquidationHeatmapRenderer } from './LiquidationHeatmapRenderer.js';

export class ChartEngine {
  constructor(mainContainerId, cvdContainerId) {
    this.container = document.getElementById(mainContainerId);
    this.overviewContainer = document.getElementById('overviewChartArea');
    this.overviewChart = null;
    this.overviewSeries = null;
    this.layoutMode = 'SINGLE'; // 'SINGLE' | 'SPLIT'
    this.splitRatio = 0.5; // Resizable split proportion (0.15 to 0.85)
    this.cvdContainer = document.getElementById(cvdContainerId);
    this.tableDataContainer = document.getElementById('tvTableData');

    this.chart = null;
    this.candlestickSeries = null;
    this.footprintSeries = null;
    this.footprintSeriesView = null;
    this.bigTradesSeries = null;
    this.bigTradesSeriesView = null;
    this.bigTradesVisible = true;
    this.footprintStyle = 'PROFILE';
    this.theme = 'DARK';
    this.cvdChart = null;
    this.cvdSeries = null;
    this.footprintRenderer = null;
    this.liquidationRenderer = null;
    this.candles = [];
    this.chartMode = 'FOOTPRINT'; // 'FOOTPRINT' vs 'CANDLESTICK'
    this._hasInitiallyFocused = false;

    // Active Symbol & Timeframe Context
    this.currentSymbol = 'EUR/USD';
    this.currentTimeframeMs = 60000;
    this.currentTimeframeStr = '1m';
    this.currentPrice = null;
    this.prevPrice = null;
    this.activeCandle = null;
    this._countdownInterval = null;

    // Live Price Tracker DOM Element References
    this.liveTrackerOverlay = null;
    this.livePriceLine = null;
    this.liveSymbolPill = null;
    this.livePriceBadge = null;
    this.livePriceNum = null;
    this.livePriceTimer = null;

    const canvasEl = document.getElementById('footprintCanvas');
    if (canvasEl) {
      this.footprintRenderer = new FootprintRenderer(canvasEl);
    }

    const liqCanvasEl = document.getElementById('liquidationCanvas');
    if (liqCanvasEl) {
      this.liquidationRenderer = new LiquidationHeatmapRenderer(liqCanvasEl);
    }

    this._initCharts();
    this._bindInteractionEvents();
    this._initSplitResizer();
  }

  _initCharts() {
    if (typeof window.LightweightCharts === 'undefined') {
      setTimeout(() => this._initCharts(), 100);
      return;
    }

    if (this.chart) return;

    try {
      const { createChart } = window.LightweightCharts;

      const rect = this.container ? this.container.getBoundingClientRect() : null;
      const initialW = (rect && rect.width > 0) ? rect.width : (this.container ? this.container.clientWidth || 800 : 800);
      const initialH = (rect && rect.height > 0) ? rect.height : (this.container ? this.container.clientHeight || 500 : 500);

      // Main Candlestick Chart
      this.chart = createChart(this.container, {
        width: initialW,
        height: initialH,
        layout: {
          background: { color: '#131722' },
          textColor: '#787b86'
        },
        grid: {
          vertLines: { color: '#1e222d' },
          horzLines: { color: '#1e222d' }
        },
        crosshair: {
          mode: 0
        },
        rightPriceScale: {
          borderColor: '#2a2e39',
          autoScale: true,
          scaleMargins: {
            top: 0.10,
            bottom: 0.22
          }
        },
        timeScale: {
          borderColor: '#2a2e39',
          timeVisible: true,
          secondsVisible: false,
          barSpacing: 105,
          minBarSpacing: 4
        }
      });

      const defaultPriceFormat = {
        type: 'price',
        precision: 5,
        minMove: 0.00001
      };

      // Native TradingView Custom Series: Footprint Engine
      this.footprintSeriesView = new FootprintSeriesPaneView({
        theme: this.theme,
        style: this.footprintStyle
      });
      this.footprintSeries = this.chart.addCustomSeries(this.footprintSeriesView, {
        priceLineVisible: false,
        lastValueVisible: false,
        priceFormat: defaultPriceFormat
      });

      // Native TradingView Custom Series: Big Trades & Large Activity Bubbles
      this.bigTradesSeriesView = new BigTradesPaneView({
        theme: this.theme,
        visible: this.bigTradesVisible
      });
      this.bigTradesSeries = this.chart.addCustomSeries(this.bigTradesSeriesView, {
        priceLineVisible: false,
        lastValueVisible: false,
        priceFormat: defaultPriceFormat
      });

      // Standard Candlestick Series (used when user switches to Candlestick mode)
      this.candlestickSeries = this.chart.addCandlestickSeries({
        upColor: '#089981',
        downColor: '#F23645',
        borderUpColor: '#089981',
        borderDownColor: '#F23645',
        wickUpColor: '#089981',
        wickDownColor: '#F23645',
        priceLineVisible: false,
        lastValueVisible: false,
        priceFormat: defaultPriceFormat,
        visible: this.chartMode === 'CANDLESTICK'
      });

      // Lower Sub-Pane: CVD Chart
      if (this.cvdContainer) {
        this.cvdChart = createChart(this.cvdContainer, {
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
          lineWidth: 2
        });
      }

      // Synchronize Pan / Zoom with Footprint Canvas & Live Price Tracker
      let summaryTableRaf = null;
      this.chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
        this._renderCanvasOverlay();
        this._updateLiveTracker();
        if (!summaryTableRaf) {
          summaryTableRaf = requestAnimationFrame(() => {
            summaryTableRaf = null;
            this._renderSummaryTable();
          });
        }
      });

      this.chart.timeScale().subscribeVisibleTimeRangeChange(() => {
        this._renderCanvasOverlay();
        this._updateLiveTracker();
      });

      // Initialize Live Price Tracker Overlay with active symbol and countdown timer
      this._initLiveTrackerOverlay();

    } catch (e) {
      console.warn('[ChartEngine] Error initializing LightweightCharts', e);
    }
  }

  _bindInteractionEvents() {
    if (!this.container) return;

    // Track mouse dragging on chart / price scale to guarantee continuous 60fps canvas sync
    this.container.addEventListener('mousemove', (e) => {
      if (e.buttons === 1) {
        requestAnimationFrame(() => {
          this._renderCanvasOverlay();
          this._updateLiveTracker();
        });
      }
    });

    // Interactive Big Trades inspection tooltip on hover & click
    const tooltipEl = document.getElementById('bigTradeTooltip');
    if (tooltipEl) {
      const inspectBigTrade = (e, isClick = false) => {
        if (!this.bigTradesVisible || !this.candles || this.candles.length === 0 || !this.chart || !this.candlestickSeries) {
          if (!isClick) tooltipEl.classList.add('hidden');
          return;
        }

        const rect = this.container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const timeScale = this.chart.timeScale();
        const priceSeries = this.candlestickSeries;

        let hitTrade = null;
        let hitCandle = null;
        let hitX = 0;
        let hitY = 0;

        for (const candle of this.candles) {
          if (!candle.bigTrades || candle.bigTrades.length === 0) continue;
          const tvTime = Math.floor(candle.startTime / 1000);
          const cx = timeScale.timeToCoordinate(tvTime);
          if (cx === null || cx < -50 || cx > rect.width + 50) continue;

          for (const trade of candle.bigTrades) {
            const cy = priceSeries.priceToCoordinate(trade.price);
            if (cy === null) continue;

            const dist = Math.hypot(mouseX - cx, mouseY - cy);
            const hitDist = Math.max(15, (trade.radius || 12) + 4);
            if (dist <= hitDist) {
              hitTrade = trade;
              hitCandle = candle;
              hitX = cx;
              hitY = cy;
              break;
            }
          }
          if (hitTrade) break;
        }

        if (hitTrade) {
          const isBuy = hitTrade.side === 'BUY';
          const sideColor = isBuy ? '#089981' : '#F23645';
          const title = hitTrade.fidelityLabel || (isBuy ? 'Large Buy Activity' : 'Large Sell Activity');
          const volStr = hitTrade.volume ? Number(hitTrade.volume).toLocaleString() : '--';
          const priceStr = Number(hitTrade.price).toFixed(hitTrade.price > 100 ? 2 : 5);
          const candleTimeStr = new Date(hitCandle.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

          tooltipEl.innerHTML = `
            <div class="bt-tooltip-hdr" style="color: ${sideColor}">
              <span class="bt-badge-dot" style="background: ${sideColor}"></span>
              <span class="bt-title">${title}</span>
            </div>
            <div class="bt-row"><span class="bt-lbl">Volume:</span> <strong class="bt-val">${volStr} (${hitTrade.formattedVol || ''})</strong></div>
            <div class="bt-row"><span class="bt-lbl">Price:</span> <span class="bt-val">${priceStr}</span></div>
            <div class="bt-row"><span class="bt-lbl">Aggressor Side:</span> <span class="bt-val" style="color: ${sideColor}">${hitTrade.side}</span></div>
            <div class="bt-row"><span class="bt-lbl">Event Type:</span> <span class="bt-val">${hitTrade.eventType || 'EXECUTION'}</span></div>
            <div class="bt-row"><span class="bt-lbl">Data Source:</span> <span class="bt-val source">${hitTrade.fidelitySource || 'Broker Volume'}</span></div>
            <div class="bt-row"><span class="bt-lbl">Timeframe:</span> <span class="bt-val">${hitTrade.timeframe || '1m'} (${hitTrade.timeframeScale || 1.0}x scale)</span></div>
            <div class="bt-row"><span class="bt-lbl">Candle Time:</span> <span class="bt-val">${candleTimeStr}</span></div>
          `;

          let left = hitX + 16;
          let top = hitY - 30;
          if (left + 240 > rect.width) left = hitX - 250;
          if (top < 10) top = 10;
          if (top + 170 > rect.height) top = rect.height - 180;

          tooltipEl.style.left = `${left}px`;
          tooltipEl.style.top = `${top}px`;
          tooltipEl.classList.remove('hidden');
        } else {
          if (!isClick) {
            tooltipEl.classList.add('hidden');
          }
        }
      };

      this.container.addEventListener('mousemove', (e) => inspectBigTrade(e, false));
      this.container.addEventListener('click', (e) => inspectBigTrade(e, true));
      this.container.addEventListener('mouseleave', () => tooltipEl.classList.add('hidden'));
    }
  }

  setFootprintStyle(style) {
    this.footprintStyle = style;
    if (this.footprintSeriesView) {
      this.footprintSeriesView.setStyle(style);
    }
    if (this.footprintSeries) {
      this.footprintSeries.applyOptions({ style });
    }
    if (this.footprintRenderer) {
      this.footprintRenderer.setStyle(style);
      this._renderCanvasOverlay();
    }
  }

  setChartMode(mode) {
    this.chartMode = mode;
    const isCandle = mode === 'CANDLESTICK';
    const summaryTable = document.getElementById('tvSummaryTable');

    if (isCandle) {
      if (this.candlestickSeries) {
        this.candlestickSeries.applyOptions({ visible: true });
      }
      if (this.footprintSeries) {
        this.footprintSeries.applyOptions({ visible: false });
      }
      if (this.chart) {
        this.chart.timeScale().applyOptions({
          barSpacing: 14,
          minBarSpacing: 3
        });
      }
      if (summaryTable) summaryTable.style.display = 'none';
    } else {
      if (this.candlestickSeries) {
        this.candlestickSeries.applyOptions({ visible: false });
      }
      if (this.footprintSeries) {
        this.footprintSeries.applyOptions({ visible: true });
      }
      if (this.chart) {
        this.chart.timeScale().applyOptions({
          barSpacing: 85,
          minBarSpacing: 6
        });
        const total = this.candles.length;
        if (total > 0) {
          this.chart.timeScale().setVisibleLogicalRange({
            from: Math.max(0, total - 14),
            to: total + 1
          });
        }
      }
      if (summaryTable) summaryTable.style.display = 'flex';
      this._renderSummaryTable();
    }
  }

  setLayoutMode(mode) {
    if (!mode) return;
    this.layoutMode = mode;

    const overviewPane = document.getElementById('overviewPane');
    const splitResizer = document.getElementById('splitResizer');
    const footprintPaneTag = document.getElementById('footprintPaneTag');
    const singleBtn = document.getElementById('layoutSingleBtn');
    const splitBtn = document.getElementById('layoutSplitBtn');

    if (singleBtn && splitBtn) {
      singleBtn.classList.toggle('active', mode === 'SINGLE');
      splitBtn.classList.toggle('active', mode === 'SPLIT');
    }

    if (mode === 'SPLIT') {
      if (overviewPane) overviewPane.classList.remove('hidden');
      if (splitResizer) splitResizer.classList.remove('hidden');
      if (footprintPaneTag) footprintPaneTag.style.display = 'block';

      if (!this.overviewChart) {
        this._initOverviewChart();
      } else {
        this._syncOverviewData();
      }

      if (this.chart && this.chartMode === 'FOOTPRINT') {
        this.chart.timeScale().applyOptions({ barSpacing: 85, minBarSpacing: 4 });
      }
    } else {
      if (overviewPane) overviewPane.classList.add('hidden');
      if (splitResizer) splitResizer.classList.add('hidden');
      if (footprintPaneTag) footprintPaneTag.style.display = 'none';

      if (this.chart && this.chartMode === 'FOOTPRINT') {
        this.chart.timeScale().applyOptions({ minBarSpacing: 4 });
      }
    }

    const triggerResize = () => {
      this.resize();
      if (mode === 'SPLIT' && this.overviewChart) {
        this.overviewChart.timeScale().fitContent();
      }
    };
    triggerResize();
    requestAnimationFrame(triggerResize);
    setTimeout(triggerResize, 60);
    setTimeout(triggerResize, 180);
  }

  _getPriceFormat(symbol) {
    const s = (symbol || this.currentSymbol || '').toUpperCase();
    const isCrypto = s.includes('BTC') || s.includes('ETH');
    const isGold = s.includes('XAU') || s.includes('GOLD');
    const isJpy = s.includes('JPY');
    const precision = isCrypto ? 2 : (isGold ? 2 : (isJpy ? 3 : 5));
    const minMove = isCrypto ? (s.includes('BTC') ? 1.0 : 0.1) : (isGold ? 0.05 : (isJpy ? 0.001 : 0.00001));
    return { type: 'price', precision, minMove };
  }

  _initOverviewChart() {
    if (typeof window.LightweightCharts === 'undefined' || !this.overviewContainer) return;
    if (this.overviewChart) return;

    try {
      const { createChart } = window.LightweightCharts;
      const isDark = this.theme === 'DARK';

      const rect = this.overviewContainer.getBoundingClientRect();
      const w = rect.width > 0 ? rect.width : 500;
      const h = rect.height > 0 ? rect.height : 500;

      this.overviewChart = createChart(this.overviewContainer, {
        width: w,
        height: h,
        layout: {
          background: { color: isDark ? '#131722' : '#ffffff' },
          textColor: isDark ? '#787b86' : '#4b5563'
        },
        grid: {
          vertLines: { color: isDark ? '#1e222d' : '#e5e7eb' },
          horzLines: { color: isDark ? '#1e222d' : '#e5e7eb' }
        },
        crosshair: {
          mode: 0
        },
        rightPriceScale: {
          borderColor: isDark ? '#2a2e39' : '#e5e7eb',
          autoScale: true
        },
        timeScale: {
          borderColor: isDark ? '#2a2e39' : '#e5e7eb',
          timeVisible: true,
          secondsVisible: false,
          barSpacing: 6,
          minBarSpacing: 2
        }
      });

      this.overviewSeries = this.overviewChart.addCandlestickSeries({
        upColor: '#089981',
        downColor: '#f23645',
        borderUpColor: '#089981',
        borderDownColor: '#f23645',
        wickUpColor: '#089981',
        wickDownColor: '#f23645',
        priceLineVisible: true,
        lastValueVisible: true,
        priceFormat: this._getPriceFormat(this.currentSymbol)
      });

      this._syncOverviewData();
      this._setupCrosshairSync();
    } catch (e) {
      console.warn('[ChartEngine] Error creating overviewChart:', e);
    }
  }

  _syncOverviewData() {
    if (!this.overviewSeries || !this.candles || this.candles.length === 0) return;
    const seriesData = this.candles.map(c => ({
      time: Math.floor(c.startTime / 1000),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close
    }));
    try {
      this.overviewSeries.setData(seriesData);
      if (this.overviewChart) {
        this.overviewChart.timeScale().fitContent();
      }
    } catch (e) {}
  }

  _setupCrosshairSync() {
    if (!this.chart || !this.overviewChart) return;

    let isSyncing = false;

    this.chart.subscribeCrosshairMove((param) => {
      if (isSyncing || this.layoutMode !== 'SPLIT' || !this.overviewChart || !this.overviewSeries) return;
      isSyncing = true;
      try {
        if (param.time && param.point) {
          const series = this.candlestickSeries || this.footprintSeries;
          const price = series ? series.coordinateToPrice(param.point.y) : null;
          if (price !== null && !isNaN(price)) {
            this.overviewChart.setCrosshairPosition(price, param.time, this.overviewSeries);
          }
        } else {
          this.overviewChart.clearCrosshairPosition();
        }
      } catch (e) {
      } finally {
        isSyncing = false;
      }
    });

    this.overviewChart.subscribeCrosshairMove((param) => {
      if (isSyncing || this.layoutMode !== 'SPLIT' || !this.chart) return;
      isSyncing = true;
      try {
        const targetSeries = this.candlestickSeries || this.footprintSeries;
        if (param.time && param.point && targetSeries) {
          const price = this.overviewSeries ? this.overviewSeries.coordinateToPrice(param.point.y) : null;
          if (price !== null && !isNaN(price)) {
            this.chart.setCrosshairPosition(price, param.time, targetSeries);
          }
        } else if (targetSeries) {
          this.chart.clearCrosshairPosition();
        }
      } catch (e) {
      } finally {
        isSyncing = false;
      }
    });
  }

  setBigTradesVisible(visible) {
    this.bigTradesVisible = visible;
    if (this.bigTradesSeriesView) {
      this.bigTradesSeriesView.setVisible(visible);
    }
    if (this.bigTradesSeries) {
      this.bigTradesSeries.applyOptions({ visible });
    }
    const tooltipEl = document.getElementById('bigTradeTooltip');
    if (tooltipEl && !visible) {
      tooltipEl.classList.add('hidden');
    }
  }

  setTheme(theme) {
    this.theme = theme;
    if (this.footprintSeriesView) {
      this.footprintSeriesView.setTheme(theme);
    }
    if (this.footprintSeries) {
      this.footprintSeries.applyOptions({ theme });
    }
    if (this.bigTradesSeriesView) {
      this.bigTradesSeriesView.setTheme(theme);
    }
    if (this.bigTradesSeries) {
      this.bigTradesSeries.applyOptions({ theme });
    }
    if (this.footprintRenderer) {
      this.footprintRenderer.setTheme(theme);
    }
    if (this.liquidationRenderer) {
      this.liquidationRenderer.setTheme(theme);
    }
    if (this.chart) {
      this.chart.applyOptions({
        layout: {
          background: { color: theme === 'DARK' ? '#131722' : '#ffffff' },
          textColor: theme === 'DARK' ? '#787b86' : '#4b5563'
        },
        grid: {
          vertLines: { color: theme === 'DARK' ? '#1e222d' : '#e5e7eb' },
          horzLines: { color: theme === 'DARK' ? '#1e222d' : '#e5e7eb' }
        }
      });
    }
    if (this.overviewChart) {
      const isDark = theme === 'DARK';
      this.overviewChart.applyOptions({
        layout: {
          background: { color: isDark ? '#131722' : '#ffffff' },
          textColor: isDark ? '#787b86' : '#4b5563'
        },
        grid: {
          vertLines: { color: isDark ? '#1e222d' : '#e5e7eb' },
          horzLines: { color: isDark ? '#1e222d' : '#e5e7eb' }
        }
      });
    }
    this._renderCanvasOverlay();
  }

  renderFootprints() {
    this._renderCanvasOverlay();
  }

  setLiquidationData(data) {
    if (this.liquidationRenderer) {
      this.liquidationRenderer.setData(data);
      this._renderCanvasOverlay();
    }
  }

  triggerLiquidationSweep(event) {
    if (this.liquidationRenderer) {
      this.liquidationRenderer.addSweepEvent(event);
      if (event.matrix) {
        this.liquidationRenderer.setData(event.matrix);
      }
      this._renderCanvasOverlay();
    }
  }

  setLiquidationVisible(visible) {
    if (this.liquidationRenderer) {
      this.liquidationRenderer.setVisible(visible);
      const liqCanvasEl = document.getElementById('liquidationCanvas');
      if (liqCanvasEl) {
        liqCanvasEl.style.display = visible ? 'block' : 'none';
      }
      this._renderCanvasOverlay();
    }
  }

  setSymbol(symbol) {
    if (!symbol) return;
    this.currentSymbol = symbol;
    const s = symbol.toUpperCase();
    const isCrypto = s.includes('BTC') || s.includes('ETH');
    const isGold = s.includes('XAU') || s.includes('GOLD');
    const isJpy = s.includes('JPY');

    const precision = isCrypto ? 2 : (isGold ? 2 : (isJpy ? 3 : 5));
    const minMove = isCrypto ? (s.includes('BTC') ? 1.0 : 0.1) : (isGold ? 0.05 : (isJpy ? 0.001 : 0.00001));

    const priceFormat = {
      type: 'price',
      precision: precision,
      minMove: minMove
    };

    if (this.footprintSeries) {
      try {
        this.footprintSeries.applyOptions({ priceFormat });
      } catch (e) {}
    }

    if (this.candlestickSeries) {
      try {
        this.candlestickSeries.applyOptions({ priceFormat });
      } catch (e) {}
    }

    if (this.bigTradesSeries) {
      try {
        this.bigTradesSeries.applyOptions({ priceFormat });
      } catch (e) {}
    }

    if (this.chart) {
      try {
        this.chart.priceScale('right').applyOptions({
          autoScale: true
        });
      } catch (e) {}
    }

    if (this.overviewSeries) {
      try {
        this.overviewSeries.applyOptions({ priceFormat });
      } catch (e) {}
    }

    if (this.overviewChart) {
      try {
        this.overviewChart.priceScale('right').applyOptions({ autoScale: true });
      } catch (e) {}
    }

    if (this.liveSymbolPill) {
      this.liveSymbolPill.textContent = symbol.replace(/[^a-zA-Z0-9]/g, '');
    }

    this._updateLiveTracker();
  }

  setTimeframe(timeframeMs, timeframeStr) {
    this.currentTimeframeMs = timeframeMs;
    this.currentTimeframeStr = timeframeStr;
    this._updateCountdown();
  }

  onLiveTick(price) {
    if (!price || isNaN(price)) return;
    this.prevPrice = (this.currentPrice !== null) ? this.currentPrice : price;
    this.currentPrice = price;
    this._updateLiveTracker();
  }

  clear() {
    this.candles = [];
    if (this.footprintSeries) {
      try {
        this.footprintSeries.setData([]);
      } catch (e) {}
    }
    if (this.candlestickSeries) {
      try {
        this.candlestickSeries.setData([]);
      } catch (e) {}
    }
    if (this.bigTradesSeries) {
      try {
        this.bigTradesSeries.setData([]);
      } catch (e) {}
    }
    if (this.cvdSeries) {
      try {
        this.cvdSeries.setData([]);
      } catch (e) {}
    }
    const liqCanvas = document.getElementById('liquidationCanvas');
    if (liqCanvas) {
      const ctx = liqCanvas.getContext('2d');
      ctx.clearRect(0, 0, liqCanvas.width, liqCanvas.height);
    }
    if (this.chart) {
      try {
        this.chart.priceScale('right').applyOptions({ autoScale: true });
        this.chart.timeScale().resetTimeScale();
      } catch (e) {}
    }
    if (this.overviewSeries) {
      try {
        this.overviewSeries.setData([]);
      } catch (e) {}
    }
    if (this.overviewChart) {
      try {
        this.overviewChart.priceScale('right').applyOptions({ autoScale: true });
        this.overviewChart.timeScale().resetTimeScale();
      } catch (e) {}
    }
  }

  setCandles(candles) {
    if (!candles || candles.length === 0) return;
    this.candles = [...candles].sort((a, b) => a.startTime - b.startTime);

    if (this.candles.length > 0 && this.candles[0].symbol) {
      this.setSymbol(this.candles[0].symbol);
    }

    const seriesData = this.candles.map((c) => ({
      time: Math.floor(c.startTime / 1000),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      totalVolume: c.totalVolume,
      totalDelta: c.totalDelta,
      pocPrice: c.pocPrice,
      cells: c.cells,
      bigTrades: c.bigTrades || [],
      startTime: c.startTime
    }));

    if (this.footprintSeries) {
      try {
        this.footprintSeries.setData(seriesData);
      } catch (e) {
        console.warn('[ChartEngine] Error setting footprintSeries data:', e);
      }
    }

    if (this.candlestickSeries) {
      try {
        this.candlestickSeries.setData(seriesData);
      } catch (e) {
        console.warn('[ChartEngine] Error setting candlestick data:', e);
      }
    }

    if (this.bigTradesSeries) {
      try {
        this.bigTradesSeries.setData(seriesData);
      } catch (e) {
        console.warn('[ChartEngine] Error setting bigTradesSeries data:', e);
      }
    }

    if (this.overviewSeries) {
      this._syncOverviewData();
    }

    if (this.chart) {
      try {
        this.chart.priceScale('right').applyOptions({ autoScale: true });
        if (this.chartMode === 'FOOTPRINT') {
          this.chart.timeScale().applyOptions({ barSpacing: 85, minBarSpacing: 6 });
          const total = seriesData.length;
          if (total > 0 && !this._hasInitiallyFocused) {
            this._hasInitiallyFocused = true;
            // Automatically focus on latest candles so footprints are immediately in full view
            this.chart.timeScale().setVisibleLogicalRange({
              from: Math.max(0, total - 14),
              to: total + 1
            });
          }
        } else {
          if (!this._hasInitiallyFocused) {
            this._hasInitiallyFocused = true;
            this.chart.timeScale().fitContent();
          }
        }
      } catch (e) {}
    }

    if (this.candles.length > 0) {
      this.activeCandle = this.candles[this.candles.length - 1];
      this.currentPrice = this.activeCandle.close;
    }

    requestAnimationFrame(() => {
      this._renderCanvasOverlay();
      this._renderSummaryTable();
      this._updateLiveTracker();
    });
  }

  prependCandles(olderCandles) {
    if (!olderCandles || olderCandles.length === 0) return;
    const existingTimes = new Set(this.candles.map(c => c.startTime));
    const toAdd = olderCandles.filter(c => !existingTimes.has(c.startTime));
    if (toAdd.length === 0) return;

    this.candles = [...toAdd, ...this.candles].sort((a, b) => a.startTime - b.startTime);

    const seriesData = this.candles.map((c) => ({
      time: Math.floor(c.startTime / 1000),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      totalVolume: c.totalVolume,
      totalDelta: c.totalDelta,
      pocPrice: c.pocPrice,
      cells: c.cells,
      bigTrades: c.bigTrades || [],
      startTime: c.startTime
    }));

    if (this.footprintSeries) {
      try {
        this.footprintSeries.setData(seriesData);
      } catch (e) {}
    }

    if (this.candlestickSeries) {
      try {
        this.candlestickSeries.setData(seriesData);
      } catch (e) {}
    }

    if (this.bigTradesSeries) {
      try {
        this.bigTradesSeries.setData(seriesData);
      } catch (e) {}
    }

    if (this.layoutMode === 'SPLIT' && this.overviewSeries) {
      this._syncOverviewData();
    }

    requestAnimationFrame(() => {
      this._renderCanvasOverlay();
      this._renderSummaryTable();
      this._updateLiveTracker();
    });
  }

  updateCandle(candle) {
    if (!candle) return;

    this.prevPrice = (this.currentPrice !== null) ? this.currentPrice : candle.open;
    this.currentPrice = candle.close;
    this.activeCandle = candle;

    const bar = {
      time: Math.floor(candle.startTime / 1000),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      totalVolume: candle.totalVolume,
      totalDelta: candle.totalDelta,
      pocPrice: candle.pocPrice,
      cells: candle.cells,
      bigTrades: candle.bigTrades || [],
      startTime: candle.startTime
    };

    if (this.footprintSeries) {
      try {
        this.footprintSeries.update(bar);
      } catch (e) {}
    }

    if (this.candlestickSeries) {
      try {
        this.candlestickSeries.update(bar);
      } catch (e) {}
    }

    if (this.bigTradesSeries) {
      try {
        this.bigTradesSeries.update(bar);
      } catch (e) {}
    }

    if (this.layoutMode === 'SPLIT' && this.overviewSeries && candle) {
      try {
        this.overviewSeries.update({
          time: Math.floor(candle.startTime / 1000),
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close
        });
      } catch (e) {}
    }

    const existingIdx = this.candles.findIndex(c => c.startTime === candle.startTime);
    if (existingIdx >= 0) {
      this.candles[existingIdx] = candle;
    } else {
      this.candles.push(candle);
      this.candles.sort((a, b) => a.startTime - b.startTime);
    }

    requestAnimationFrame(() => {
      this._renderCanvasOverlay();
      this._renderSummaryTable();
      this._updateLiveTracker();
    });
  }

  updateCvd(timestamp, cvdValue) {
    if (this.cvdSeries) {
      try {
        this.cvdSeries.update({
          time: Math.floor(timestamp / 1000),
          value: cvdValue
        });
      } catch (e) {
        // Ignored
      }
    }
  }

  _renderCanvasOverlay() {
    if (!this.chart || !this.candlestickSeries) return;

    const timeScale = this.chart.timeScale();
    const series = this.candlestickSeries;

    const priceToY = (price) => {
      const coord = series.priceToCoordinate(price);
      return coord !== null ? Math.floor(coord) : null;
    };

    const yToPrice = (y) => {
      return series.coordinateToPrice ? series.coordinateToPrice(y) : null;
    };

    // 1. Render Liquidation Heatmap (Visible in both Candlestick and Footprint mode!)
    if (this.liquidationRenderer && this.liquidationRenderer.visible) {
      const liqCanvas = document.getElementById('liquidationCanvas');
      if (liqCanvas && liqCanvas.style.display !== 'none') {
        const dpr = window.devicePixelRatio || 1;
        const rect = liqCanvas.getBoundingClientRect();
        const width = rect.width || liqCanvas.offsetWidth || 800;
        const height = rect.height || liqCanvas.offsetHeight || 500;

        if (liqCanvas.width !== Math.floor(width * dpr) || liqCanvas.height !== Math.floor(height * dpr)) {
          liqCanvas.width = Math.floor(width * dpr);
          liqCanvas.height = Math.floor(height * dpr);
          const ctx = liqCanvas.getContext('2d');
          ctx.scale(dpr, dpr);
        }

        this.liquidationRenderer.render(width, height, priceToY, yToPrice);
      }
    }

    // 2. Render Footprint Overlay
    if (this.chartMode === 'CANDLESTICK') return;
    if (!this.footprintRenderer || this.candles.length === 0) return;

    const canvasEl = document.getElementById('footprintCanvas');
    if (!canvasEl) return;

    const rect = canvasEl.getBoundingClientRect();
    const width = rect.width || canvasEl.offsetWidth || 800;
    const height = rect.height || canvasEl.offsetHeight || 500;

    if (width === 0 || height === 0) return;

    // Dynamic bar width synced to Lightweight Charts barSpacing zoom level
    const barSpacing = timeScale.options().barSpacing || 105;
    const barWidth = Math.max(6, Math.min(220, Math.floor(barSpacing * 0.88)));

    // Exact coordinate mapping functions anchored to chart camera
    const timeToX = (timeMs) => {
      const tvTime = Math.floor(timeMs / 1000);
      const coord = timeScale.timeToCoordinate(tvTime);
      return coord !== null ? Math.floor(coord) : null;
    };

    // Viewport Culling: only render candles within visible horizontal screen bounds
    const visibleCandles = this.candles.filter((c) => {
      const x = timeToX(c.startTime);
      return x !== null && x >= -barWidth && x <= width + barWidth;
    });

    this.footprintRenderer.render(visibleCandles, timeToX, priceToY, barWidth);
  }

  _renderSummaryTable() {
    if (this.chartMode === 'CANDLESTICK') return;
    if (!this.tableDataContainer || this.candles.length === 0 || !this.chart) return;

    const timeScale = this.chart.timeScale();
    const width = this.container ? this.container.clientWidth : 800;

    // Only include visible candles in the summary table columns
    const visible = this.candles.filter((c) => {
      const tvTime = Math.floor(c.startTime / 1000);
      const x = timeScale.timeToCoordinate(tvTime);
      return x !== null && x >= -80 && x <= width + 80;
    }).slice(-12); // Limit to latest visible columns for table neatness

    if (visible.length === 0) return;

    let html = '';
    let cumulativeCvd = 0;

    visible.forEach((candle) => {
      cumulativeCvd += candle.totalDelta;

      const isPosDelta = candle.totalDelta >= 0;
      const deltaPct = candle.totalVolume > 0 ? ((candle.totalDelta / candle.totalVolume) * 100).toFixed(1) : '0.0';
      const s = (candle.symbol || this.currentSymbol || '').toUpperCase();
      const isCrypto = s.includes('BTC') || s.includes('ETH') || candle.open > 1000;
      const isGold = s.includes('XAU') || s.includes('GOLD');
      const isJpy = s.includes('JPY');
      const decimals = isCrypto || isGold ? 2 : (isJpy ? 3 : 5);
      const rangeVal = candle.high - candle.low;
      const hlRangeStr = isCrypto ? `${rangeVal.toFixed(1)} pts` : (isGold ? `$${rangeVal.toFixed(2)}` : (isJpy ? `${(rangeVal * 100).toFixed(1)} pips` : `${(rangeVal * 10000).toFixed(1)} pips`));

      html += `
        <div class="tv-col">
          <div class="tv-cell delta-row ${isPosDelta ? 'pos' : 'neg'}">${isPosDelta ? '+' : ''}${this._formatNum(candle.totalDelta)}</div>
          <div class="tv-cell">${this._formatNum(candle.maxDelta)}</div>
          <div class="tv-cell">${this._formatNum(candle.minDelta)}</div>
          <div class="tv-cell">${this._formatNum(candle.totalVolume)}</div>
          <div class="tv-cell">${deltaPct}%</div>
          <div class="tv-cell">${this._formatNum(cumulativeCvd)}</div>
          <div class="tv-cell">${candle.pocPrice ? candle.pocPrice.toFixed(decimals) : '--'}</div>
          <div class="tv-cell">${hlRangeStr}</div>
        </div>
      `;
    });

    this.tableDataContainer.innerHTML = html;
  }

  _formatNum(num) {
    if (Math.abs(num) >= 1000000) return (num / 1000000).toFixed(2) + 'M';
    if (Math.abs(num) >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
  }

  _initSplitResizer() {
    const resizer = document.getElementById('splitResizer');
    const rowWrapper = document.getElementById('chartRowWrapper');
    if (!resizer || !rowWrapper) return;

    let isDragging = false;

    resizer.addEventListener('mousedown', (e) => {
      if (this.layoutMode !== 'SPLIT') return;
      e.preventDefault();
      isDragging = true;
      resizer.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging || this.layoutMode !== 'SPLIT') return;
      const rect = rowWrapper.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const minW = 160;
      const maxW = rect.width - 160;
      const clampedW = Math.max(minW, Math.min(maxW, mouseX));
      this.splitRatio = clampedW / rect.width;
      this.resize();
    });

    window.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        resizer.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        this.resize();
      }
    });

    // Double click to reset split ratio to 50/50
    resizer.addEventListener('dblclick', () => {
      if (this.layoutMode !== 'SPLIT') return;
      this.splitRatio = 0.5;
      this.resize();
    });
  }

  resize() {
    const rowWrapper = document.getElementById('chartRowWrapper');
    const overviewPane = document.getElementById('overviewPane');
    const splitResizer = document.getElementById('splitResizer');
    const totalW = rowWrapper ? rowWrapper.clientWidth : (this.container ? this.container.clientWidth : 800);
    const totalH = rowWrapper ? rowWrapper.clientHeight : (this.container ? this.container.clientHeight : 500);

    if (this.layoutMode === 'SPLIT') {
      const resizerW = (splitResizer && !splitResizer.classList.contains('hidden')) ? (splitResizer.offsetWidth || 6) : 6;
      const availW = Math.max(320, totalW - resizerW);
      const overviewW = Math.max(160, Math.min(availW - 160, Math.floor(availW * this.splitRatio)));
      const mainW = Math.max(160, availW - overviewW);

      if (overviewPane) {
        overviewPane.style.flex = `0 0 ${overviewW}px`;
        overviewPane.style.width = `${overviewW}px`;
      }
      if (this.container) {
        this.container.style.flex = '1 1 0';
        this.container.style.width = `${mainW}px`;
      }

      if (this.overviewChart && overviewW > 0 && totalH > 0) {
        this.overviewChart.applyOptions({ width: overviewW, height: totalH });
      }
      if (this.chart && mainW > 0 && totalH > 0) {
        this.chart.applyOptions({ width: mainW, height: totalH });
      }
    } else {
      if (overviewPane) {
        overviewPane.style.flex = '';
        overviewPane.style.width = '';
      }
      if (this.container) {
        this.container.style.flex = '1 1 0';
        this.container.style.width = '100%';
      }
      if (this.chart && totalW > 0 && totalH > 0) {
        this.chart.applyOptions({ width: totalW, height: totalH });
      }
    }

    if (this.cvdChart && this.cvdContainer) {
      const rect = this.cvdContainer.getBoundingClientRect();
      const w = (rect && rect.width > 0) ? rect.width : (this.cvdContainer.clientWidth || totalW);
      const h = (rect && rect.height > 0) ? rect.height : (this.cvdContainer.clientHeight || 100);
      if (w > 0 && h > 0) {
        this.cvdChart.applyOptions({ width: w, height: h });
      }
    }
    if (this.footprintRenderer) {
      this.footprintRenderer.resize();
      this._renderCanvasOverlay();
    }
    this._updateLiveTracker();
  }

  _initLiveTrackerOverlay() {
    if (!this.container) return;
    let overlay = document.getElementById('livePriceTrackerOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'livePriceTrackerOverlay';
      overlay.className = 'tv-live-price-tracker-overlay';
      overlay.innerHTML = `
        <div class="tv-live-price-line" id="livePriceLine"></div>
        <div class="tv-live-symbol-pill" id="liveSymbolPill">EURUSD</div>
        <div class="tv-live-price-badge" id="livePriceBadge">
          <div class="live-price-num" id="livePriceNum">--</div>
          <div class="live-price-timer" id="livePriceTimer">00:00</div>
        </div>
      `;
      this.container.appendChild(overlay);
    }
    this.liveTrackerOverlay = overlay;
    this.livePriceLine = document.getElementById('livePriceLine');
    this.liveSymbolPill = document.getElementById('liveSymbolPill');
    this.livePriceBadge = document.getElementById('livePriceBadge');
    this.livePriceNum = document.getElementById('livePriceNum');
    this.livePriceTimer = document.getElementById('livePriceTimer');

    if (this._countdownInterval) clearInterval(this._countdownInterval);
    this._countdownInterval = setInterval(() => {
      this._updateCountdown();
    }, 1000);
  }

  _calculateRemainingSeconds() {
    const tfMs = this.currentTimeframeMs || 60000;
    const tfSec = Math.max(1, Math.round(tfMs / 1000));
    const now = Date.now();

    if (this.activeCandle && this.activeCandle.startTime) {
      const candleEnd = this.activeCandle.startTime + tfMs;
      const diffSec = Math.floor((candleEnd - now) / 1000);
      if (diffSec >= 0 && diffSec <= tfSec) {
        return diffSec;
      }
    }
    // Wall-clock boundary fallback for current timeframe
    const nowSec = Math.floor(now / 1000);
    const rem = tfSec - (nowSec % tfSec);
    return rem >= 0 ? rem : 0;
  }

  _formatCountdown(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m >= 60) {
      const h = Math.floor(m / 60);
      const remM = m % 60;
      return `${String(h).padStart(2, '0')}:${String(remM).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  _updateCountdown() {
    if (!this.livePriceTimer) return;
    const remSec = this._calculateRemainingSeconds();
    this.livePriceTimer.textContent = this._formatCountdown(remSec);
  }

  _updateLiveTracker() {
    if (!this.chart || !this.container) return;
    if (!this.liveTrackerOverlay) {
      this._initLiveTrackerOverlay();
    }
    if (!this.liveTrackerOverlay) return;

    if (this.currentPrice === null || this.currentPrice === undefined || isNaN(this.currentPrice)) {
      if (this.candles && this.candles.length > 0) {
        this.activeCandle = this.candles[this.candles.length - 1];
        this.currentPrice = this.activeCandle.close;
      } else {
        this.liveTrackerOverlay.style.display = 'none';
        return;
      }
    }

    let y = null;
    if (this.chartMode === 'FOOTPRINT' && this.footprintSeries) {
      try {
        y = this.footprintSeries.priceToCoordinate(this.currentPrice);
      } catch (e) {}
    }
    if ((y === null || y === undefined) && this.candlestickSeries) {
      try {
        y = this.candlestickSeries.priceToCoordinate(this.currentPrice);
      } catch (e) {}
    }

    if (y === null || y === undefined || isNaN(y)) {
      this.liveTrackerOverlay.style.display = 'none';
      return;
    }

    const containerRect = this.container.getBoundingClientRect();
    const height = containerRect.height;
    if (height <= 0) return;

    if (y < 0 || y > height) {
      this.liveTrackerOverlay.style.display = 'none';
      return;
    }

    this.liveTrackerOverlay.style.display = 'block';

    const psWidth = Math.max(42, (this.chart.priceScale('right') ? this.chart.priceScale('right').width() : 50));
    const containerWidth = containerRect.width;
    const lineWidth = Math.max(0, containerWidth - psWidth);

    let isBullish = true;
    if (this.activeCandle && this.activeCandle.open !== undefined) {
      isBullish = this.currentPrice >= this.activeCandle.open;
    } else if (this.prevPrice !== null && this.prevPrice !== undefined) {
      isBullish = this.currentPrice >= this.prevPrice;
    }

    const liveColor = isBullish ? '#089981' : '#F23645';

    if (this.livePriceLine) {
      this.livePriceLine.style.top = `${Math.round(y)}px`;
      this.livePriceLine.style.width = `${lineWidth}px`;
      this.livePriceLine.style.borderTopColor = liveColor;
    }

    if (this.liveSymbolPill) {
      const symClean = (this.currentSymbol || 'EUR/USD').replace(/[^a-zA-Z0-9]/g, '');
      this.liveSymbolPill.textContent = symClean;
      this.liveSymbolPill.style.top = `${Math.round(y - 9)}px`;
      this.liveSymbolPill.style.right = `${psWidth + 4}px`;
      this.liveSymbolPill.style.backgroundColor = liveColor;
    }

    if (this.livePriceBadge) {
      this.livePriceBadge.style.top = `${Math.round(y - 15)}px`;
      this.livePriceBadge.style.right = '0px';
      this.livePriceBadge.style.width = `${psWidth}px`;
      this.livePriceBadge.style.backgroundColor = liveColor;
    }

    if (this.livePriceNum) {
      const s = (this.currentSymbol || '').toUpperCase();
      const decimals = s.includes('JPY') ? 3 : (s.includes('BTC') ? 1 : (s.includes('ETH') || s.includes('XAU') ? 2 : 5));
      this.livePriceNum.textContent = Number(this.currentPrice).toFixed(decimals);
    }

    this._updateCountdown();
  }
}
