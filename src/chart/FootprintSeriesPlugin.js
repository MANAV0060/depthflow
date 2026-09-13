/**
 * FootprintSeriesPlugin.js
 * Official TradingView Lightweight Charts Custom Series Plugin for Footprint & Order Flow.
 * 
 * Implements ICustomSeriesPaneView & ICustomSeriesPaneRenderer.
 * Renders directly inside TradingView's native canvas render pipeline with zero desync,
 * native pan/zoom momentum, and 3-Tier Dynamic Level of Detail (LOD).
 */

export class FootprintSeriesPaneRenderer {
  constructor() {
    this._data = null;
    this._options = null;
  }

  update(data, options) {
    this._data = data;
    this._options = options;
  }

  draw(target, priceToCoordinate) {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      this._drawImpl(ctx, priceToCoordinate, mediaSize);
    });
  }

  _drawImpl(ctx, priceToCoordinate, mediaSize) {
    if (!this._data || !this._data.bars || this._data.bars.length === 0) return;

    const barSpacing = this._data.barSpacing || 75;
    const actualWidth = Math.max(1, Math.min(220, Math.floor(barSpacing * 0.88)));
    const lodMode = actualWidth < 18 ? 'MACRO' : (actualWidth < 34 ? 'PROFILE' : 'DETAILED');
    const imbalanceRatio = (this._options && this._options.imbalanceRatio) || 3.0;
    const theme = (this._options && this._options.theme) || 'DARK';
    const style = (this._options && this._options.style) || 'PROFILE';

    const mediaWidth = (mediaSize && typeof mediaSize.width === 'number')
      ? mediaSize.width
      : (ctx.canvas ? ctx.canvas.width : 5000);

    // Limit iteration strictly to visible bars (with safety margin)
    let startIndex = 0;
    let endIndex = this._data.bars.length;
    if (this._data.visibleRange) {
      startIndex = Math.max(0, this._data.visibleRange.from - 2);
      endIndex = Math.min(this._data.bars.length, this._data.visibleRange.to + 2);
    }

    const cullingMargin = actualWidth + 20;

    for (let i = startIndex; i < endIndex; i++) {
      const bar = this._data.bars[i];
      if (!bar) continue;

      const candle = bar.originalData;
      if (!candle) continue;

      const x = bar.x;
      // CRITICAL: bar.x is null for off-screen / unprojected bars.
      // In JS, isNaN(null) is false and null !== undefined, which caused offscreen candles
      // to draw at x=0, collapsing against the left chart panel when zooming.
      if (x === null || x === undefined || typeof x !== 'number' || isNaN(x)) continue;

      // Strict horizontal viewport bounds check: ignore any bar completely off-screen
      if (x + cullingMargin < 0 || x - cullingMargin > mediaWidth) continue;

      if (lodMode === 'MACRO') {
        this._renderMacroCandlestick(ctx, candle, x, actualWidth, priceToCoordinate);
      } else if (lodMode === 'PROFILE') {
        this._renderProfileSilhouette(ctx, candle, x, actualWidth, priceToCoordinate, imbalanceRatio);
      } else {
        this._renderDetailedFootprint(ctx, candle, x, actualWidth, priceToCoordinate, imbalanceRatio, theme, style);
      }
    }
  }

  _getSortedCells(candle) {
    if (!candle.cells) return [];
    let cellsList = [];
    if (typeof candle.cells.values === 'function') {
      cellsList = Array.from(candle.cells.values());
    } else if (Array.isArray(candle.cells)) {
      cellsList = candle.cells.slice();
    } else if (typeof candle.cells === 'object') {
      cellsList = Object.values(candle.cells);
    }
    return cellsList.sort((a, b) => b.price - a.price);
  }

  _formatVol(vol, width) {
    const v = Math.abs(vol || 0);
    if (width && width < 65) {
      if (v >= 1000000) return `${(v / 1000000).toFixed(1)}M`;
      if (v >= 1000) return `${Math.round(v / 1000)}K`;
      return Math.round(v).toString();
    }
    if (v >= 1000000) return `${(v / 1000000).toFixed(1)}M`;
    if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
    return Math.round(v).toString();
  }

  /**
   * LOD 1: Macro View (barWidth < 28px)
   * Clean TradingView candlesticks with micro-delta footer.
   * Zero overlapping text, 60fps pan/zoom.
   */
  _renderMacroCandlestick(ctx, candle, x, width, priceToCoordinate) {
    const highY = priceToCoordinate(candle.high);
    const lowY = priceToCoordinate(candle.low);
    const openY = priceToCoordinate(candle.open);
    const closeY = priceToCoordinate(candle.close);
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
    const bodyHeight = Math.max(1, bottomBodyY - topBodyY);
    const bodyWidth = Math.max(1, Math.min(width * 0.75, 18));
    const bodyX = Math.floor(x - bodyWidth / 2);

    ctx.fillStyle = color;
    ctx.fillRect(bodyX, topBodyY, bodyWidth, bodyHeight);

    // If zoomed out to dense macro view, skip heavy per-cell glow and dots for 60fps performance
    if (width < 8) return;

    // Delta Strength Glow / Absorption highlight
    const totalVol = candle.totalVolume || 0;
    const delta = candle.totalDelta !== undefined ? candle.totalDelta : 0;
    const deltaRatio = totalVol > 0 ? (delta / totalVol) : 0;

    if (deltaRatio >= 0.25) {
      // Strong aggressive buying glow
      ctx.strokeStyle = '#0ef2b8';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(bodyX - 0.5, topBodyY - 0.5, bodyWidth + 1, bodyHeight + 1);
    } else if (deltaRatio <= -0.25) {
      // Strong aggressive selling glow
      ctx.strokeStyle = '#ff2e5b';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(bodyX - 0.5, topBodyY - 0.5, bodyWidth + 1, bodyHeight + 1);
    }

    // POC marker line (Golden level of highest traded volume)
    if (candle.pocPrice) {
      const pocY = priceToCoordinate(candle.pocPrice);
      if (pocY !== null) {
        ctx.strokeStyle = '#FFD700';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(bodyX, pocY);
        ctx.lineTo(bodyX + bodyWidth, pocY);
        ctx.stroke();
      }
    }

    // Imbalance Dots (Cyan below for Buy Imbalance, Red above for Sell Imbalance)
    let hasBuyImb = false;
    let hasSellImb = false;
    if (candle.cells) {
      const cells = this._getSortedCells(candle);
      const imbRatio = 3.0;
      for (let i = 0; i < cells.length - 1; i++) {
        if (cells[i + 1].sellVolume > 0 && cells[i].buyVolume / cells[i + 1].sellVolume >= imbRatio) {
          hasBuyImb = true;
          break;
        }
      }
      for (let i = 1; i < cells.length; i++) {
        if (cells[i - 1].buyVolume > 0 && cells[i].sellVolume / cells[i - 1].buyVolume >= imbRatio) {
          hasSellImb = true;
          break;
        }
      }
    }

    if (hasBuyImb) {
      ctx.fillStyle = '#00e5ff';
      ctx.beginPath();
      ctx.arc(x, lowY + 7, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    if (hasSellImb) {
      ctx.fillStyle = '#ff3355';
      ctx.beginPath();
      ctx.arc(x, highY - 7, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Micro Delta Footer
    const isPosDelta = delta >= 0;
    const deltaY = lowY + (hasBuyImb ? 12 : 4);
    ctx.fillStyle = isPosDelta ? '#089981' : '#F23645';
    ctx.fillRect(Math.floor(x - 1.5), deltaY, 3, 3);
  }

  /**
   * LOD 2: Profile Silhouette (28px <= barWidth < 68px)
   * Intrabar volume profile distribution without text crowding.
   */
  _renderProfileSilhouette(ctx, candle, x, width, priceToCoordinate, imbalanceRatio) {
    const sortedCells = this._getSortedCells(candle);
    if (sortedCells.length === 0) {
      this._renderMacroCandlestick(ctx, candle, x, width, priceToCoordinate);
      return;
    }

    const highY = priceToCoordinate(candle.high);
    const lowY = priceToCoordinate(candle.low);
    const openY = priceToCoordinate(candle.open);
    const closeY = priceToCoordinate(candle.close);
    if (highY === null || lowY === null) return;

    const topY = Math.min(highY, lowY);
    const bottomY = Math.max(highY, lowY);
    const isBullish = candle.close >= candle.open;

    const candleWidth = Math.max(20, Math.floor(width * 0.88));
    const halfW = Math.floor(candleWidth / 2);
    const leftX = x - halfW;

    const rowCount = Math.max(1, sortedCells.length);
    const totalH = Math.max(12, bottomY - topY);
    const rowHeight = Math.max(2, Math.floor(totalH / rowCount));

    let maxVol = 1;
    sortedCells.forEach(c => {
      const v = Math.max(c.buyVolume, c.sellVolume);
      if (v > maxVol) maxVol = v;
    });

    const wickColor = isBullish ? '#089981' : '#F23645';

    // Center Wick (crisp 2px straight line extending High to Low)
    ctx.strokeStyle = wickColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, highY);
    ctx.lineTo(x, lowY);
    ctx.stroke();

    // Clean Candle Body in center
    if (openY !== null && closeY !== null) {
      const topBody = Math.min(openY, closeY);
      const bodyH = Math.max(3, Math.max(openY, closeY) - topBody);
      const centerBodyW = Math.max(8, Math.min(16, Math.floor(candleWidth * 0.22)));
      ctx.fillStyle = isBullish ? 'rgba(8, 153, 129, 0.70)' : 'rgba(242, 54, 69, 0.70)';
      ctx.fillRect(Math.floor(x - centerBodyW / 2), topBody, centerBodyW, bodyH);
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

    // Micro Delta indicator & text below
    const isPosDelta = (candle.totalDelta !== undefined ? candle.totalDelta : 0) >= 0;
    ctx.fillStyle = isPosDelta ? '#089981' : '#F23645';
    ctx.fillRect(x - 10, bottomY + 3, 20, 2.5);
    if (width >= 24) {
      ctx.font = '700 8.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const sign = isPosDelta ? '+' : '';
      ctx.fillText(`${sign}${this._formatVol(candle.totalDelta, width)}`, x, bottomY + 7);
    }
  }

  /**
   * LOD 3: Detailed View (barWidth >= 68px)
   * Institutional Unified 2-Sided Footprint Candle:
   * Bid on left, Ask on right, center hairline, golden POC outline, diagonal imbalances.
   */
  _renderDetailedFootprint(ctx, candle, x, width, priceToCoordinate, imbalanceRatio, theme, style) {
    const sortedCells = this._getSortedCells(candle);
    if (sortedCells.length === 0) {
      this._renderMacroCandlestick(ctx, candle, x, width, priceToCoordinate);
      return;
    }

    const highY = priceToCoordinate(candle.high);
    const lowY = priceToCoordinate(candle.low);
    const openY = priceToCoordinate(candle.open);
    const closeY = priceToCoordinate(candle.close);
    if (highY === null || lowY === null || openY === null || closeY === null) return;

    const isBullish = candle.close >= candle.open;
    const isDark = theme === 'DARK';
    const wickColor = isBullish ? '#089981' : '#F23645';

    const candleWidth = Math.max(36, Math.min(Math.floor(width * 0.90), 200));
    const halfW = Math.floor(candleWidth / 2);
    const leftX = x - halfW;

    const topBodyY = Math.min(openY, closeY);
    const bottomBodyY = Math.max(openY, closeY);
    const bodyHeight = Math.max(3, bottomBodyY - topBodyY);

    // Guaranteed prominent upper & lower wick lines extending above and below the body
    const upperWickTop = Math.min(highY, topBodyY - 8);
    const lowerWickBottom = Math.max(lowY, bottomBodyY + 8);

    // 1. UPPER WICK: Crisp straight line of the body upper side extending to High
    ctx.strokeStyle = wickColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, topBodyY);
    ctx.lineTo(x, upperWickTop);
    ctx.stroke();

    // Top cap tick (6px)
    ctx.beginPath();
    ctx.moveTo(x - 3, upperWickTop);
    ctx.lineTo(x + 3, upperWickTop);
    ctx.stroke();

    // 2. LOWER WICK: Crisp straight line of the body lower side extending to Low
    ctx.beginPath();
    ctx.moveTo(x, bottomBodyY);
    ctx.lineTo(x, lowerWickBottom);
    ctx.stroke();

    // Bottom cap tick (6px)
    ctx.beginPath();
    ctx.moveTo(x - 3, lowerWickBottom);
    ctx.lineTo(x + 3, lowerWickBottom);
    ctx.stroke();

    // 3. Central Candlestick Body Dimensions (Reference Image 2 style)
    const bodyWidth = Math.max(14, Math.min(24, Math.floor(candleWidth * 0.24)));
    const bodyLeft = Math.floor(x - bodyWidth / 2);
    const bodyRight = bodyLeft + bodyWidth;

    // 4. Position Footprint Ladder Rows neatly between the wick tips
    const rowCount = Math.max(1, sortedCells.length);
    const ladderTopY = upperWickTop + 4;
    const ladderBottomY = lowerWickBottom - 4;
    const totalH = Math.max(20, ladderBottomY - ladderTopY);
    const calculatedRowH = Math.floor(totalH / rowCount);
    const rowHeight = Math.max(11, Math.min(32, calculatedRowH));
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

    // Ensure analytical imbalances are computed
    if (typeof candle.computeImbalances === 'function') {
      if (!candle.stackedBuyImbalances || candle._lastImbalanceRatio !== imbalanceRatio) {
        candle.computeImbalances(imbalanceRatio);
        candle._lastImbalanceRatio = imbalanceRatio;
      }
    }

    // 5. Render Price Ladder Rows (Bid on Left, Ask on Right)
    const fontPx = Math.min(10, Math.max(7.5, Math.floor(Math.min(rowHeight * 0.55, candleWidth * 0.16))));
    ctx.font = `600 ${fontPx}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace`;

    sortedCells.forEach((cell, idx) => {
      const cellY = ladderTopY + idx * rowHeight;
      const isPoc = cell.price === candle.pocPrice;
      const inBody = (cellY + rowHeight >= topBodyY && cellY <= bottomBodyY);
      const rowOriginLeft = inBody ? bodyLeft : x;
      const rowOriginRight = inBody ? bodyRight : x;
      const availableW = Math.max(14, inBody ? (halfW - Math.floor(bodyWidth / 2)) : halfW);

      // Analytical Diagonal Imbalances from engine
      const hasBuyImbalance = Boolean(cell.hasBuyImbalance);
      const hasSellImbalance = Boolean(cell.hasSellImbalance);

      if (style === 'DELTA') {
        const delta = cell.delta !== undefined ? cell.delta : (cell.buyVolume - cell.sellVolume);
        const isBuyer = delta > 0;
        const isSeller = delta < 0;
        const absD = Math.abs(delta);
        const ratio = Math.min(1.0, absD / maxAbsDelta);
        const barW = Math.round(availableW * ratio);
        const textY = cellY + rowHeight / 2;

        if (isBuyer) {
          ctx.fillStyle = 'rgba(8, 153, 129, 0.55)';
          ctx.fillRect(rowOriginRight, cellY, barW, rowHeight - 1);
          ctx.textAlign = 'left';
          ctx.fillStyle = '#ffffff';
          ctx.fillText(`+${this._formatVol(delta, candleWidth)}`, rowOriginRight + 4, textY);
        } else if (isSeller) {
          ctx.fillStyle = 'rgba(242, 54, 69, 0.55)';
          ctx.fillRect(rowOriginLeft - barW, cellY, barW, rowHeight - 1);
          ctx.textAlign = 'right';
          ctx.fillStyle = '#ffffff';
          ctx.fillText(this._formatVol(delta, candleWidth), rowOriginLeft - 4, textY);
        } else {
          ctx.textAlign = 'center';
          ctx.fillStyle = isDark ? '#64748b' : '#94a3b8';
          ctx.fillText('0', x, textY);
        }

      } else {
        // Unified Bid x Ask Profile
        const sellRatio = Math.min(1.0, cell.sellVolume / maxSellInCandle);
        const buyRatio = Math.min(1.0, cell.buyVolume / maxBuyInCandle);

        const sellBarW = Math.max(2, Math.round(availableW * sellRatio));
        const buyBarW = Math.max(2, Math.round(availableW * buyRatio));

        // Left Side: Sell Volume Bar (extends leftward)
        ctx.fillStyle = isPoc ? 'rgba(0, 0, 0, 0.90)' : 'rgba(242, 54, 69, 0.45)';
        ctx.fillRect(rowOriginLeft - sellBarW, cellY, sellBarW, rowHeight - 1);

        // Right Side: Buy Volume Bar (extends rightward)
        ctx.fillStyle = isPoc ? 'rgba(0, 0, 0, 0.90)' : 'rgba(8, 153, 129, 0.45)';
        ctx.fillRect(rowOriginRight, cellY, buyBarW, rowHeight - 1);

        // Imbalance Highlights
        if (hasSellImbalance && !isPoc) {
          ctx.strokeStyle = '#ff3355';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(rowOriginLeft - sellBarW, cellY, sellBarW, rowHeight - 1);
        }
        if (hasBuyImbalance && !isPoc) {
          ctx.strokeStyle = '#00e5ff';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(rowOriginRight, cellY, buyBarW, rowHeight - 1);
        }

        // POC Highlight Outline
        if (isPoc) {
          ctx.strokeStyle = '#FFD700';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(leftX, cellY, candleWidth, rowHeight - 1);
        }

        // Numbers Text Rendering
        const textY = cellY + rowHeight / 2;
        ctx.textBaseline = 'middle';

        // Sell text (left half)
        ctx.textAlign = 'right';
        ctx.fillStyle = hasSellImbalance ? '#ff6688' : (isPoc ? '#FFD700' : (isDark ? '#f1f5f9' : '#0f172a'));
        ctx.fillText(this._formatVol(cell.sellVolume, candleWidth), rowOriginLeft - 4, textY);

        // Buy text (right half)
        ctx.textAlign = 'left';
        ctx.fillStyle = hasBuyImbalance ? '#00e5ff' : (isPoc ? '#FFD700' : (isDark ? '#f1f5f9' : '#0f172a'));
        ctx.fillText(this._formatVol(cell.buyVolume, candleWidth), rowOriginRight + 4, textY);
      }
    });

    // 6. SOLID 100% OPAQUE CANDLESTICK BODY (Reference Image 2 - Zero Transparency)
    ctx.fillStyle = isBullish ? '#089981' : '#F23645';
    ctx.fillRect(bodyLeft, topBodyY, bodyWidth, bodyHeight);
    ctx.strokeStyle = isBullish ? '#0ef2b8' : '#ff7380';
    ctx.lineWidth = 1;
    ctx.strokeRect(bodyLeft, topBodyY, bodyWidth, bodyHeight);

    // 7. Center Hairline Divider (subtle in wick zones)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, ladderTopY);
    ctx.lineTo(x, ladderTopY + totalLadderHeight);
    ctx.stroke();

    // 8. Stacked Imbalances Visual Zones
    if (candle.stackedBuyImbalances && candle.stackedBuyImbalances.length > 0) {
      candle.stackedBuyImbalances.forEach(stack => {
        const topCellIdx = sortedCells.findIndex(c => c.price === stack.startPrice);
        const botCellIdx = sortedCells.findIndex(c => c.price === stack.endPrice);
        if (topCellIdx !== -1 && botCellIdx !== -1) {
          const minY = ladderTopY + Math.min(topCellIdx, botCellIdx) * rowHeight;
          const maxY = ladderTopY + (Math.max(topCellIdx, botCellIdx) + 1) * rowHeight;
          const stackH = maxY - minY;
          // Clean cyan bracket / accent bar on right edge (Buy side)
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
          const minY = ladderTopY + Math.min(topCellIdx, botCellIdx) * rowHeight;
          const maxY = ladderTopY + (Math.max(topCellIdx, botCellIdx) + 1) * rowHeight;
          const stackH = maxY - minY;
          // Clean pink bracket / accent bar on left edge (Sell side)
          ctx.fillStyle = 'rgba(255, 51, 85, 0.28)';
          ctx.fillRect(leftX, minY, 3, stackH);
          ctx.strokeStyle = '#ff3355';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(leftX, minY, 3, stackH);
        }
      });
    }

    // 9. Subtle Footprint Container Outline
    ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.10)' : 'rgba(0, 0, 0, 0.10)';
    ctx.lineWidth = 1;
    ctx.strokeRect(leftX, ladderTopY, candleWidth, totalLadderHeight);

    // 7. Compact Floating Delta Card Below Candle
    const badgeY = Math.max(lowerWickBottom, ladderTopY + totalLadderHeight) + 6;
    const badgeW = Math.max(48, Math.min(candleWidth, 80));
    const badgeH = 22;
    const badgeX = Math.floor(x - badgeW / 2);

    ctx.fillStyle = isDark ? 'rgba(22, 28, 36, 0.94)' : 'rgba(255, 255, 255, 0.94)';
    ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 3);
    ctx.fill();
    ctx.stroke();

    const isPosDelta = (candle.totalDelta !== undefined ? candle.totalDelta : 0) >= 0;
    ctx.fillStyle = isPosDelta ? '#089981' : '#F23645';
    ctx.fillRect(badgeX + 2, badgeY + 2, 3, badgeH - 4);

    ctx.font = '700 9px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = isPosDelta ? '#089981' : '#F23645';
    const sign = isPosDelta ? '+' : '';
    ctx.fillText(`${sign}${this._formatVol(candle.totalDelta, candleWidth)}`, x, badgeY + 3);

    ctx.font = '500 8px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
    ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
    ctx.fillText(`Vol ${this._formatVol(candle.totalVolume, candleWidth)}`, x, badgeY + 12);
  }
}

export class FootprintSeriesPaneView {
  constructor(options = {}) {
    this._renderer = new FootprintSeriesPaneRenderer();
    this._customOptions = Object.assign({
      upColor: '#089981',
      downColor: '#f23645',
      pocColor: '#FFD700',
      imbalanceColor: '#00e5ff',
      style: 'PROFILE',
      imbalanceRatio: 3.0,
      theme: 'DARK'
    }, options);
  }

  priceValueBuilder(plotRow) {
    if (!plotRow) return [0, 0, 0];
    const low = plotRow.low !== undefined ? plotRow.low : plotRow.close;
    const high = plotRow.high !== undefined ? plotRow.high : plotRow.close;
    const close = plotRow.close !== undefined ? plotRow.close : plotRow.open;
    return [low, high, close];
  }

  isWhitespace(plotRow) {
    return !plotRow || plotRow.open === undefined || plotRow.close === undefined;
  }

  renderer() {
    return this._renderer;
  }

  update(seriesData, seriesOptions) {
    const mergedOptions = Object.assign({}, this._customOptions, seriesOptions);
    this._renderer.update(seriesData, mergedOptions);
  }

  setTheme(theme) {
    this._customOptions.theme = theme;
  }

  setStyle(style) {
    this._customOptions.style = style;
  }

  setImbalanceRatio(ratio) {
    this._customOptions.imbalanceRatio = ratio;
  }

  defaultOptions() {
    return this._customOptions;
  }
}
