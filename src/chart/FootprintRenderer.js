/**
 * FootprintRenderer.js
 * Institutional-Grade Order Flow Footprint Engine (Exocharts & ATAS standard).
 * 
 * Features:
 * - Unified 2-Sided Footprint: Contiguous single container divided down the center into Bid (Sell) and Ask (Buy)
 * - 3-Tier Dynamic Level of Detail (LOD) for glitch-free zooming:
 *     1. LOD_MACRO   (< 28px): Crisp TradingView candlesticks with micro-delta footers, zero text overlap
 *     2. LOD_PROFILE (28px - 68px): Intrabar volume profile silhouette without cluttered text
 *     3. LOD_DETAILED (>= 68px): Full granular Bid x Ask numbers, volume histogram shading, diagonal imbalances
 * - Sleek Gold POC Outline & Translucent Candle Body
 * - Fully synchronized with TradingView Lightweight Charts pan/zoom
 */

export class FootprintRenderer {
  constructor(canvasElement) {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');
    this.theme = 'DARK';
    this.style = 'PROFILE'; // 'PROFILE' (Bid x Ask) | 'DELTA' | 'CLUSTER'
    this._setupCanvasResolution();
  }

  _setupCanvasResolution() {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (rect.width > 0 && rect.height > 0) {
      this.canvas.width = Math.floor(rect.width * dpr);
      this.canvas.height = Math.floor(rect.height * dpr);
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.scale(dpr, dpr);
    }
  }

  resize() {
    this._setupCanvasResolution();
  }

  setTheme(theme) {
    this.theme = theme;
  }

  setStyle(style) {
    this.style = style;
  }

  render(candles, timeToX, priceToY, barWidth, imbalanceRatio = 3.0) {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;

    if (width === 0 || height === 0) return;

    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.floor(width * dpr) || this.canvas.height !== Math.floor(height * dpr)) {
      this.canvas.width = Math.floor(width * dpr);
      this.canvas.height = Math.floor(height * dpr);
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.scale(dpr, dpr);
    }

    this.ctx.clearRect(0, 0, width, height);

    if (!candles || candles.length === 0) return;

    const ctx = this.ctx;
    const actualWidth = Math.max(6, barWidth);

    // Dynamic Level of Detail (LOD)
    const lodMode = actualWidth < 28 ? 'MACRO' : (actualWidth < 68 ? 'PROFILE' : 'DETAILED');

    let maxSessionBuyVol = 1;
    let maxSessionSellVol = 1;

    if (lodMode !== 'MACRO') {
      candles.forEach((candle) => {
        if (candle.cells) {
          const cellsList = typeof candle.cells.values === 'function' ? Array.from(candle.cells.values()) : (Array.isArray(candle.cells) ? candle.cells : Object.values(candle.cells));
          cellsList.forEach((cell) => {
            if (cell.buyVolume > maxSessionBuyVol) maxSessionBuyVol = cell.buyVolume;
            if (cell.sellVolume > maxSessionSellVol) maxSessionSellVol = cell.sellVolume;
          });
        }
      });
    }

    // Viewport Culling & Rendering
    candles.forEach((candle) => {
      const x = timeToX(candle.startTime);
      if (x === null || x + actualWidth < -40 || x - actualWidth > width + 40) return;

      if (lodMode === 'MACRO') {
        this._renderMacroCandlestick(ctx, candle, x, actualWidth, priceToY);
      } else if (lodMode === 'PROFILE') {
        this._renderProfileSilhouette(ctx, candle, x, actualWidth, priceToY, imbalanceRatio);
      } else {
        this._renderDetailedFootprint(ctx, candle, x, actualWidth, priceToY, imbalanceRatio);
      }
    });
  }

  /**
   * LOD 1: Macro View (barWidth < 28px)
   * Render ultra-clean TradingView candlesticks with micro-delta footers.
   * Zero overlapping text, instant 60fps pan/zoom.
   */
  _renderMacroCandlestick(ctx, candle, x, width, priceToY) {
    const highY = priceToY(candle.high);
    const lowY = priceToY(candle.low);
    const openY = priceToY(candle.open);
    const closeY = priceToY(candle.close);
    if (highY === null || lowY === null || openY === null || closeY === null) return;

    const isBullish = candle.close >= candle.open;
    const color = isBullish ? '#089981' : '#F23645';
    const wickColor = isBullish ? 'rgba(8, 153, 129, 0.7)' : 'rgba(242, 54, 69, 0.7)';

    // Center Wick
    ctx.strokeStyle = wickColor;
    ctx.lineWidth = Math.max(1, Math.min(2, width * 0.15));
    ctx.beginPath();
    ctx.moveTo(x, highY);
    ctx.lineTo(x, lowY);
    ctx.stroke();

    // Body
    const topBodyY = Math.min(openY, closeY);
    const bottomBodyY = Math.max(openY, closeY);
    const bodyHeight = Math.max(2, bottomBodyY - topBodyY);
    const bodyWidth = Math.max(3, Math.min(width * 0.75, 18));
    const bodyX = Math.floor(x - bodyWidth / 2);

    ctx.fillStyle = color;
    ctx.fillRect(bodyX, topBodyY, bodyWidth, bodyHeight);

    // POC marker line
    if (candle.pocPrice) {
      const pocY = priceToY(candle.pocPrice);
      if (pocY !== null) {
        ctx.strokeStyle = '#FFD700';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(bodyX, pocY);
        ctx.lineTo(bodyX + bodyWidth, pocY);
        ctx.stroke();
      }
    }

    // Micro Delta Footer Dot
    const isPosDelta = candle.totalDelta >= 0;
    const deltaY = lowY + 4;
    ctx.fillStyle = isPosDelta ? '#089981' : '#F23645';
    ctx.fillRect(Math.floor(x - 1.5), deltaY, 3, 3);
  }

  /**
   * LOD 2: Profile Silhouette (28px <= barWidth < 68px)
   * Render intrabar volume profile distribution without text crowding.
   */
  _renderProfileSilhouette(ctx, candle, x, width, priceToY, imbalanceRatio) {
    const sortedCells = this._getSortedCells(candle);
    if (sortedCells.length === 0) return;

    const highY = priceToY(candle.high);
    const lowY = priceToY(candle.low);
    const openY = priceToY(candle.open);
    const closeY = priceToY(candle.close);
    if (highY === null || lowY === null) return;

    const topY = Math.min(highY, lowY);
    const bottomY = Math.max(highY, lowY);
    const isBullish = candle.close >= candle.open;

    const candleWidth = Math.max(20, Math.floor(width * 0.88));
    const halfW = Math.floor(candleWidth / 2);
    const leftX = x - halfW;
    const rightX = x;

    const rowCount = Math.max(1, sortedCells.length);
    const totalH = Math.max(12, bottomY - topY);
    const rowHeight = Math.max(2, Math.floor(totalH / rowCount));

    let maxVol = 1;
    sortedCells.forEach(c => {
      const v = Math.max(c.buyVolume, c.sellVolume);
      if (v > maxVol) maxVol = v;
    });

    // Center Wick
    ctx.strokeStyle = isBullish ? 'rgba(8, 153, 129, 0.4)' : 'rgba(242, 54, 69, 0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, highY);
    ctx.lineTo(x, lowY);
    ctx.stroke();

    // Translucent Body Background
    if (openY !== null && closeY !== null) {
      const topBody = Math.min(openY, closeY);
      const bodyH = Math.max(2, Math.max(openY, closeY) - topBody);
      ctx.fillStyle = isBullish ? 'rgba(8, 153, 129, 0.12)' : 'rgba(242, 54, 69, 0.12)';
      ctx.fillRect(leftX, topBody, candleWidth, bodyH);
    }

    // Render Intrabar Profile Bars
    sortedCells.forEach((cell, idx) => {
      const cellY = topY + idx * rowHeight;
      const isPoc = cell.price === candle.pocPrice;

      const sellRatio = Math.min(1.0, cell.sellVolume / maxVol);
      const buyRatio = Math.min(1.0, cell.buyVolume / maxVol);

      const sellBarW = Math.round(halfW * sellRatio);
      const buyBarW = Math.round(halfW * buyRatio);

      // Sell fill (left from center)
      ctx.fillStyle = isPoc ? 'rgba(255, 215, 0, 0.35)' : 'rgba(242, 54, 69, 0.45)';
      ctx.fillRect(x - sellBarW, cellY, sellBarW, Math.max(1, rowHeight - 0.5));

      // Buy fill (right from center)
      ctx.fillStyle = isPoc ? 'rgba(255, 215, 0, 0.35)' : 'rgba(8, 153, 129, 0.45)';
      ctx.fillRect(x, cellY, buyBarW, Math.max(1, rowHeight - 0.5));

      // POC Highlight line
      if (isPoc) {
        ctx.strokeStyle = '#FFD700';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x - halfW, cellY, candleWidth, Math.max(2, rowHeight - 0.5));
      }
    });

    // Center divider hairline
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, topY);
    ctx.lineTo(x, topY + rowCount * rowHeight);
    ctx.stroke();

    // Micro Delta indicator below
    const isPosDelta = candle.totalDelta >= 0;
    ctx.fillStyle = isPosDelta ? '#089981' : '#F23645';
    ctx.fillRect(x - 8, bottomY + 3, 16, 2.5);
  }

  /**
   * LOD 3: Detailed View (barWidth >= 68px)
   * Unified 2-Sided Institutional Footprint (Exocharts / ATAS Standard):
   * Left side = Bid (Sell) | Right side = Ask (Buy)
   * Horizontal volume bars, POC highlight outline, diagonal imbalances, floating delta card.
   */
  _renderDetailedFootprint(ctx, candle, x, width, priceToY, imbalanceRatio) {
    const sortedCells = this._getSortedCells(candle);
    if (sortedCells.length === 0) return;

    const highY = priceToY(candle.high);
    const lowY = priceToY(candle.low);
    const openY = priceToY(candle.open);
    const closeY = priceToY(candle.close);
    if (highY === null || lowY === null) return;

    const topY = Math.min(highY, lowY);
    const bottomY = Math.max(highY, lowY);
    const isBullish = candle.close >= candle.open;
    const isDark = this.theme === 'DARK';

    // Proportional dimensions: single unified 2-sided container
    const candleWidth = Math.max(54, Math.min(Math.floor(width * 0.90), 200));
    const halfW = Math.floor(candleWidth / 2);
    const leftX = x - halfW;
    const rightX = x;

    const rowCount = Math.max(1, sortedCells.length);
    const totalH = Math.max(22, bottomY - topY);
    const rowHeight = Math.min(32, Math.max(14, Math.floor(totalH / rowCount)));
    const totalLadderHeight = rowCount * rowHeight;

    let maxSellInCandle = 1;
    let maxBuyInCandle = 1;
    let maxAbsDelta = 1;

    sortedCells.forEach(c => {
      if (c.sellVolume > maxSellInCandle) maxSellInCandle = c.sellVolume;
      if (c.buyVolume > maxBuyInCandle) maxBuyInCandle = c.buyVolume;
      const d = Math.abs(c.delta !== undefined ? c.delta : (c.buyVolume - c.sellVolume));
      if (d > maxAbsDelta) maxAbsDelta = d;
    });

    // 1. Center Wick
    ctx.strokeStyle = isBullish ? '#089981' : '#F23645';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, highY);
    ctx.lineTo(x, topY);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x, topY + totalLadderHeight);
    ctx.lineTo(x, lowY);
    ctx.stroke();

    // 2. Translucent Candle Body Silhouette in background
    if (openY !== null && closeY !== null) {
      const topBody = Math.min(openY, closeY);
      const bodyH = Math.max(4, Math.max(openY, closeY) - topBody);
      ctx.fillStyle = isBullish ? 'rgba(8, 153, 129, 0.08)' : 'rgba(242, 54, 69, 0.08)';
      ctx.fillRect(leftX, topBody, candleWidth, bodyH);
      ctx.strokeStyle = isBullish ? 'rgba(8, 153, 129, 0.25)' : 'rgba(242, 54, 69, 0.25)';
      ctx.lineWidth = 1;
      ctx.strokeRect(leftX, topBody, candleWidth, bodyH);
    }

    // Ensure analytical imbalances are computed
    if (typeof candle.computeImbalances === 'function') {
      if (!candle.stackedBuyImbalances || candle._lastImbalanceRatio !== imbalanceRatio) {
        candle.computeImbalances(imbalanceRatio);
        candle._lastImbalanceRatio = imbalanceRatio;
      }
    }

    // 3. Render Price Ladder Rows
    const fontPx = Math.min(10, Math.max(8, Math.floor(rowHeight * 0.55)));
    ctx.font = `600 ${fontPx}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace`;

    let totalSellVol = 0;
    let totalBuyVol = 0;

    sortedCells.forEach((cell, idx) => {
      const cellY = topY + idx * rowHeight;
      const isPoc = cell.price === candle.pocPrice;

      totalSellVol += cell.sellVolume;
      totalBuyVol += cell.buyVolume;

      // Analytical Diagonal Imbalances from engine
      const hasBuyImbalance = Boolean(cell.hasBuyImbalance);
      const hasSellImbalance = Boolean(cell.hasSellImbalance);

      if (this.style === 'DELTA') {
        // --- DELTA PROFILE MODE ---
        const delta = cell.delta !== undefined ? cell.delta : (cell.buyVolume - cell.sellVolume);
        const isBuyer = delta > 0;
        const isSeller = delta < 0;
        const absD = Math.abs(delta);
        const ratio = Math.min(1.0, absD / maxAbsDelta);
        const barW = Math.round(halfW * ratio);
        const textY = cellY + rowHeight / 2;

        if (isBuyer) {
          ctx.fillStyle = 'rgba(8, 153, 129, 0.55)';
          ctx.fillRect(x, cellY, barW, rowHeight - 1);
          ctx.textAlign = 'left';
          ctx.fillStyle = '#ffffff';
          ctx.fillText(`+${this._formatVol(delta)}`, x + 4, textY);
        } else if (isSeller) {
          ctx.fillStyle = 'rgba(242, 54, 69, 0.55)';
          ctx.fillRect(x - barW, cellY, barW, rowHeight - 1);
          ctx.textAlign = 'right';
          ctx.fillStyle = '#ffffff';
          ctx.fillText(this._formatVol(delta), x - 4, textY);
        } else {
          ctx.textAlign = 'center';
          ctx.fillStyle = isDark ? '#64748b' : '#94a3b8';
          ctx.fillText('0', x, textY);
        }

      } else {
        // --- UNIFIED BID x ASK PROFILE MODE ---
        const sellRatio = Math.min(1.0, cell.sellVolume / maxSellInCandle);
        const buyRatio = Math.min(1.0, cell.buyVolume / maxBuyInCandle);

        const sellBarW = Math.round(halfW * sellRatio);
        const buyBarW = Math.round(halfW * buyRatio);

        // Left Side: Sell Volume Bar (fills left from center line)
        ctx.fillStyle = isPoc ? 'rgba(71, 85, 105, 0.65)' : 'rgba(242, 54, 69, 0.38)';
        ctx.fillRect(x - sellBarW, cellY, sellBarW, rowHeight - 1);

        // Right Side: Buy Volume Bar (fills right from center line)
        ctx.fillStyle = isPoc ? 'rgba(71, 85, 105, 0.65)' : 'rgba(8, 153, 129, 0.38)';
        ctx.fillRect(x, cellY, buyBarW, rowHeight - 1);

        // Imbalance Highlights
        if (hasSellImbalance && !isPoc) {
          ctx.strokeStyle = '#ff3355';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(x - halfW, cellY, halfW, rowHeight - 1);
        }
        if (hasBuyImbalance && !isPoc) {
          ctx.strokeStyle = '#00e5ff';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(x, cellY, halfW, rowHeight - 1);
        }

        // POC Golden Outline
        if (isPoc) {
          ctx.strokeStyle = '#FFD700';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(leftX, cellY, candleWidth, rowHeight - 1);
        }

        // Numbers Text Rendering
        const textY = cellY + rowHeight / 2;
        ctx.textBaseline = 'middle';

        // Sell text (in left half, aligned near center line)
        ctx.textAlign = 'right';
        ctx.fillStyle = hasSellImbalance ? '#ff6688' : (isPoc ? '#FFD700' : (isDark ? '#e2e8f0' : '#0f172a'));
        ctx.fillText(this._formatVol(cell.sellVolume), x - 4, textY);

        // Buy text (in right half, aligned near center line)
        ctx.textAlign = 'left';
        ctx.fillStyle = hasBuyImbalance ? '#00e5ff' : (isPoc ? '#FFD700' : (isDark ? '#e2e8f0' : '#0f172a'));
        ctx.fillText(this._formatVol(cell.buyVolume), x + 4, textY);
      }
    });

    // 4. Center Hairline Divider
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, topY);
    ctx.lineTo(x, topY + totalLadderHeight);
    ctx.stroke();

    // 5. Stacked Imbalances Visual Zones
    if (candle.stackedBuyImbalances && candle.stackedBuyImbalances.length > 0) {
      candle.stackedBuyImbalances.forEach(stack => {
        const topCellIdx = sortedCells.findIndex(c => c.price === stack.startPrice);
        const botCellIdx = sortedCells.findIndex(c => c.price === stack.endPrice);
        if (topCellIdx !== -1 && botCellIdx !== -1) {
          const minY = topY + Math.min(topCellIdx, botCellIdx) * rowHeight;
          const maxY = topY + (Math.max(topCellIdx, botCellIdx) + 1) * rowHeight;
          const stackH = maxY - minY;
          ctx.fillStyle = 'rgba(0, 229, 255, 0.28)';
          ctx.fillRect(leftX + candleWidth - 3, minY, 3, stackH);
          ctx.strokeStyle = '#00e5ff';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(leftX + candleWidth - 3, minY, 3, stackH);
        }
      });
    }

    if (candle.stackedSellImbalances && candle.stackedSellImbalances.length > 0) {
      candle.stackedSellImbalances.forEach(stack => {
        const topCellIdx = sortedCells.findIndex(c => c.price === stack.startPrice);
        const botCellIdx = sortedCells.findIndex(c => c.price === stack.endPrice);
        if (topCellIdx !== -1 && botCellIdx !== -1) {
          const minY = topY + Math.min(topCellIdx, botCellIdx) * rowHeight;
          const maxY = topY + (Math.max(topCellIdx, botCellIdx) + 1) * rowHeight;
          const stackH = maxY - minY;
          ctx.fillStyle = 'rgba(255, 51, 85, 0.28)';
          ctx.fillRect(leftX, minY, 3, stackH);
          ctx.strokeStyle = '#ff3355';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(leftX, minY, 3, stackH);
        }
      });
    }

    // 6. Container Outline
    ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.08)';
    ctx.lineWidth = 1;
    ctx.strokeRect(leftX, topY, candleWidth, totalLadderHeight);

    // 6. Compact Floating Delta Card Below Candle
    const badgeY = topY + totalLadderHeight + 6;
    const badgeW = Math.max(48, Math.min(candleWidth, 80));
    const badgeH = 22;
    const badgeX = Math.floor(x - badgeW / 2);

    ctx.fillStyle = isDark ? 'rgba(22, 28, 36, 0.92)' : 'rgba(255, 255, 255, 0.92)';
    ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 3);
    ctx.fill();
    ctx.stroke();

    // Delta Value
    const isPosDelta = candle.totalDelta >= 0;
    ctx.font = '700 8.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = isPosDelta ? '#089981' : '#F23645';
    ctx.fillText(`${isPosDelta ? '+' : ''}${this._formatVol(candle.totalDelta)}`, x, badgeY + 7);

    // Total Vol
    ctx.font = '500 7.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
    ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
    ctx.fillText(`Vol ${this._formatVol(candle.totalVolume)}`, x, badgeY + 16);
  }

  _getSortedCells(candle) {
    if (!candle) return [];
    if (typeof candle.getSortedCells === 'function') {
      return candle.getSortedCells();
    }
    if (Array.isArray(candle.cells)) {
      return [...candle.cells].sort((a, b) => b.price - a.price);
    }
    if (candle.cells && typeof candle.cells.values === 'function') {
      return Array.from(candle.cells.values()).sort((a, b) => b.price - a.price);
    }
    return [];
  }

  _formatVol(num) {
    if (num === 0 || isNaN(num)) return '0';
    const abs = Math.abs(num);
    const sign = num < 0 ? '-' : '';
    if (abs >= 1000000) {
      return sign + (abs / 1000000).toFixed(2) + 'M';
    }
    if (abs >= 1000) {
      return sign + (abs / 1000).toFixed(1) + 'K';
    }
    return num.toString();
  }
}
