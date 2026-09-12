/**
 * TPOSeriesPlugin.js
 * Official TradingView Lightweight Charts Custom Series Plugin for Time Price Opportunity (TPO) & Market Profile.
 *
 * Implements ICustomSeriesPaneView & ICustomSeriesPaneRenderer.
 * Renders:
 * - Dual-pane session profile: TPO Letter Blocks (left) + Volume Profile with exact volume text (right)
 * - Rainbow period color spectrum (Heatmap: Red -> Orange -> Yellow -> Green -> Cyan -> Blue -> Purple)
 * - Initial Balance (IB: Periods A & B) vertical bracket
 * - TPO Point of Control (POC) golden highlight bar
 * - Extending Naked POC (nPOC) rays across future sessions until tested
 * - Value Area High (VAH) & Value Area Low (VAL) 70% boundary lines
 * - Single Prints highlight markers
 * - Companion session price action candlesticks
 * - Session statistics footer
 */

import { TPO_LETTERS, getTpoColor } from '../analytics/TPOEngine.js';

export class TPOSeriesPaneRenderer {
  constructor() {
    this._data = null;
    this._options = null;
    this._sessions = [];
  }

  update(data, options) {
    this._data = data;
    this._options = options;
    if (options && options.sessions) {
      this._sessions = options.sessions;
    }
  }

  setSessions(sessions) {
    this._sessions = sessions || [];
  }

  draw(target, priceToCoordinate) {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      this._drawImpl(ctx, priceToCoordinate, mediaSize);
    });
  }

  _drawImpl(ctx, priceToCoordinate, mediaSize) {
    if (!this._data || !this._data.bars || this._data.bars.length === 0) return;
    if (!this._sessions || this._sessions.length === 0) return;

    const theme = (this._options && this._options.theme) || 'DARK';
    const isDark = theme === 'DARK';

    const mediaWidth = (mediaSize && typeof mediaSize.width === 'number')
      ? mediaSize.width
      : (ctx.canvas ? ctx.canvas.width : 5000);
    const mediaHeight = (mediaSize && typeof mediaSize.height === 'number')
      ? mediaSize.height
      : (ctx.canvas ? ctx.canvas.height : 3000);

    // Build timestamp-to-X lookup from visible bars
    const timeToXMap = new Map();
    this._data.bars.forEach(b => {
      if (b && b.x !== null && b.x !== undefined && !isNaN(b.x)) {
        const t = b.originalData ? (b.originalData.startTime || b.originalData.time * 1000) : b.time * 1000;
        timeToXMap.set(t, b.x);
      }
    });

    const getXForTime = (timeMs) => {
      if (timeToXMap.has(timeMs)) return timeToXMap.get(timeMs);
      // Find closest bar
      let closestX = null;
      let minDiff = Infinity;
      this._data.bars.forEach(b => {
        if (b && b.x !== null && b.x !== undefined && !isNaN(b.x)) {
          const t = b.originalData ? (b.originalData.startTime || b.originalData.time * 1000) : b.time * 1000;
          const diff = Math.abs(t - timeMs);
          if (diff < minDiff) {
            minDiff = diff;
            closestX = b.x;
          }
        }
      });
      return closestX;
    };

    // Render each session
    this._sessions.forEach((session, sessionIdx) => {
      this._renderSession(ctx, session, sessionIdx, getXForTime, priceToCoordinate, mediaWidth, mediaHeight, isDark);
    });

    // Render Naked POC Rays extending into future sessions
    this._renderNakedPocRays(ctx, getXForTime, priceToCoordinate, mediaWidth, isDark);
  }

  _renderSession(ctx, session, sessionIdx, getXForTime, priceToCoordinate, mediaWidth, mediaHeight, isDark) {
    if (!session || !session.startTime || !session.endTime) return;

    const startX = getXForTime(session.startTime);
    const endX = getXForTime(session.endTime);
    if (startX === null && endX === null) return;

    const leftX = startX !== null ? startX : (endX - 250);
    const rightX = endX !== null ? endX : (startX + 250);
    const totalSessionSpan = Math.max(140, rightX - leftX);

    // TPO + Volume Profile sits neatly in the initial 45% of the session,
    // leaving the remaining session space for the chronological candlesticks
    const profileWidth = Math.max(160, Math.min(450, Math.floor(totalSessionSpan * 0.46)));

    // Viewport bounds culling
    if (leftX + profileWidth < -100 || leftX > mediaWidth + 100) return;

    const highY = priceToCoordinate(session.high);
    const lowY = priceToCoordinate(session.low);
    if (highY === null || lowY === null) return;

    const topY = Math.min(highY, lowY);
    const bottomY = Math.max(highY, lowY);
    const profileH = Math.max(20, bottomY - topY);

    const rows = Array.from(session.priceRows.values()).sort((a, b) => b.price - a.price);
    if (rows.length === 0) return;

    const rowHeight = Math.max(2, Math.floor(profileH / rows.length));

    // Layout partitioning:
    // Left 52%: TPO Letters / Mosaic Blocks
    // Right 48%: Volume Profile Histogram + Exact Volume Text
    const tpoAreaW = Math.floor(profileWidth * 0.52);
    const volAreaW = Math.floor(profileWidth * 0.44);
    const tpoLeft = leftX;
    const volLeft = leftX + tpoAreaW + 6;

    // Find max TPO letters and max volume for proportional scaling
    let maxLetters = 1;
    let maxVol = 1;
    rows.forEach(r => {
      if (r.letters.length > maxLetters) maxLetters = r.letters.length;
      if (r.volume > maxVol) maxVol = r.volume;
    });

    // 1. Session Background Box (Subtle institutional card)
    ctx.fillStyle = isDark ? 'rgba(19, 23, 34, 0.65)' : 'rgba(243, 244, 246, 0.65)';
    ctx.strokeStyle = isDark ? 'rgba(42, 46, 57, 0.50)' : 'rgba(229, 231, 235, 0.70)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(leftX - 4, topY - 8, profileWidth + 8, profileH + 16, 4);
    ctx.fill();
    ctx.stroke();

    // 2. Initial Balance (IB) Bracket on Far Left
    if (session.ibHigh !== null && session.ibLow !== null) {
      const ibTopY = priceToCoordinate(session.ibHigh);
      const ibBotY = priceToCoordinate(session.ibLow);
      if (ibTopY !== null && ibBotY !== null) {
        ctx.strokeStyle = '#38bdf8'; // Sky blue IB line
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(leftX - 8, ibTopY);
        ctx.lineTo(leftX - 8, ibBotY);
        // Top cap
        ctx.moveTo(leftX - 12, ibTopY);
        ctx.lineTo(leftX - 4, ibTopY);
        // Bottom cap
        ctx.moveTo(leftX - 12, ibBotY);
        ctx.lineTo(leftX - 4, ibBotY);
        ctx.stroke();

        ctx.font = '700 8px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
        ctx.fillStyle = '#38bdf8';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText('IB', leftX - 14, (ibTopY + ibBotY) / 2);
      }
    }

    // 3. Render TPO Rows & Volume Profile Rows
    const blockW = Math.max(4, Math.min(14, Math.floor((tpoAreaW - 10) / Math.max(1, maxLetters))));
    const showLetters = blockW >= 9 && rowHeight >= 9;

    rows.forEach((row, rowIdx) => {
      const rowY = topY + rowIdx * rowHeight;
      const isPoc = row.price === session.tpoPoc;
      const isSinglePrint = session.singlePrints && session.singlePrints.includes(row.price);

      // --- LEFT PANE: TPO Letter Blocks ---
      row.letters.forEach((letter, lIdx) => {
        const letterIdx = TPO_LETTERS.indexOf(letter);
        const color = getTpoColor(letterIdx >= 0 ? letterIdx : lIdx);
        const cellX = tpoLeft + lIdx * blockW;

        ctx.fillStyle = color;
        ctx.fillRect(cellX, rowY, blockW - 1, Math.max(1, rowHeight - 0.5));

        // Render letter if space permits
        if (showLetters) {
          ctx.font = `700 ${Math.min(9, rowHeight - 1)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace`;
          ctx.fillStyle = '#ffffff';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(letter, cellX + (blockW - 1) / 2, rowY + rowHeight / 2);
        }
      });

      // Single Print Highlight Outline
      if (isSinglePrint) {
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 1;
        ctx.strokeRect(tpoLeft - 1, rowY - 0.5, blockW + 1, rowHeight);
      }

      // --- RIGHT PANE: Volume Profile Bar + Volume Text ---
      if (row.volume > 0) {
        const volRatio = Math.min(1.0, row.volume / maxVol);
        const barW = Math.max(3, Math.round(volAreaW * volRatio));

        // Volume Profile Histogram Bar (Reference image cyan/blue style)
        ctx.fillStyle = isPoc ? 'rgba(255, 215, 0, 0.45)' : 'rgba(14, 165, 233, 0.40)';
        ctx.fillRect(volLeft, rowY, barW, Math.max(1, rowHeight - 0.5));

        // Border edge
        ctx.strokeStyle = isPoc ? '#FFD700' : 'rgba(14, 165, 233, 0.85)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(volLeft + barW, rowY);
        ctx.lineTo(volLeft + barW, rowY + rowHeight - 0.5);
        ctx.stroke();

        // Exact Volume Text Label printed on bar
        if (rowHeight >= 8 && barW >= 24) {
          ctx.font = `600 ${Math.min(8.5, rowHeight - 1)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace`;
          ctx.fillStyle = isDark ? '#f8fafc' : '#0f172a';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(this._formatVol(row.volume), volLeft + 4, rowY + rowHeight / 2);
        }
      }
    });

    // 4. Highlight POC (Point of Control) Bar
    if (session.tpoPoc !== null) {
      const pocY = priceToCoordinate(session.tpoPoc);
      if (pocY !== null) {
        // Bright golden/yellow highlight bar spanning the profile width
        ctx.fillStyle = 'rgba(255, 215, 0, 0.28)';
        ctx.fillRect(tpoLeft, pocY - Math.max(2, rowHeight / 2), profileWidth, Math.max(4, rowHeight));

        ctx.strokeStyle = '#FFD700';
        ctx.lineWidth = 2;
        ctx.strokeRect(tpoLeft, pocY - Math.max(2, rowHeight / 2), profileWidth, Math.max(4, rowHeight));

        // POC Label Tag
        ctx.fillStyle = '#FFD700';
        ctx.font = '700 9px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(`POC ${session.tpoPoc}`, leftX + profileWidth + 6, pocY);
      }
    }

    // 5. Value Area Bounds (VAH & VAL 70%)
    if (session.vah !== null) {
      const vahY = priceToCoordinate(session.vah);
      if (vahY !== null) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.40)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(tpoLeft, vahY);
        ctx.lineTo(leftX + profileWidth, vahY);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.font = '600 8px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
        ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`VAH ${session.vah}`, leftX + profileWidth, vahY - 2);
      }
    }

    if (session.val !== null) {
      const valY = priceToCoordinate(session.val);
      if (valY !== null) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.40)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(tpoLeft, valY);
        ctx.lineTo(leftX + profileWidth, valY);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.font = '600 8px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
        ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'top';
        ctx.fillText(`VAL ${session.val}`, leftX + profileWidth, valY + 2);
      }
    }

    // 6. Session Footer Stats Card Below Profile
    const footerY = bottomY + 12;
    const footerW = profileWidth;
    const footerH = 34;

    ctx.fillStyle = isDark ? 'rgba(15, 23, 42, 0.90)' : 'rgba(255, 255, 255, 0.90)';
    ctx.strokeStyle = isDark ? 'rgba(51, 65, 85, 0.60)' : 'rgba(203, 213, 225, 0.80)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(leftX, footerY, footerW, footerH, 3);
    ctx.fill();
    ctx.stroke();

    ctx.font = '700 9px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
    ctx.fillStyle = '#38bdf8';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`${session.sessionKey} (${session.totalTpos} TPOs)`, leftX + 8, footerY + 5);

    ctx.font = '500 8px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
    ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
    ctx.fillText(`Vol: ${this._formatVol(session.totalVolume)} | Range: ${(session.high - session.low).toFixed(4)}`, leftX + 8, footerY + 18);
  }

  _renderNakedPocRays(ctx, getXForTime, priceToCoordinate, mediaWidth, isDark) {
    this._sessions.forEach(session => {
      if (!session.tpoPoc) return;

      const pocY = priceToCoordinate(session.tpoPoc);
      if (pocY === null) return;

      const startX = getXForTime(session.startTime);
      if (startX === null) return;

      let rayEndX = mediaWidth + 50;
      if (session.isPocTested && session.pocTestedTime) {
        const testedX = getXForTime(session.pocTestedTime);
        if (testedX !== null) rayEndX = testedX;
      }

      if (rayEndX <= startX + 100) return;

      // Draw horizontal golden Naked POC Ray (matching reference image)
      ctx.strokeStyle = '#FFD700';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(startX + 120, pocY);
      ctx.lineTo(rayEndX, pocY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Ray label tag
      ctx.font = '700 8px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
      ctx.fillStyle = '#FFD700';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText('POC ray', startX + 130, pocY - 2);
    });
  }

  _formatVol(vol) {
    const v = Math.abs(vol || 0);
    if (v >= 1000000) return `${(v / 1000000).toFixed(1)}M`;
    if (v >= 1000) return `${Math.round(v / 1000)}K`;
    return Math.round(v).toString();
  }
}

export class TPOSeriesPaneView {
  constructor(options = {}) {
    this._renderer = new TPOSeriesPaneRenderer();
    this._customOptions = Object.assign({
      theme: 'DARK',
      visible: true,
      sessions: []
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

  setSessions(sessions) {
    this._customOptions.sessions = sessions;
    this._renderer.setSessions(sessions);
  }

  setTheme(theme) {
    this._customOptions.theme = theme;
  }

  setVisible(visible) {
    this._customOptions.visible = visible;
  }

  defaultOptions() {
    return this._customOptions;
  }
}
