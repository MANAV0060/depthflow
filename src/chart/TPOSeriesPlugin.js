/**
 * TPOSeriesPlugin.js
 * Professional TradingView Lightweight Charts Custom Series Plugin for Time Price Opportunity (TPO) & Market Profile.
 *
 * Implements ICustomSeriesPaneView & ICustomSeriesPaneRenderer.
 * 
 * Core Architectural Principles:
 * 1. Candlesticks remain the PRIMARY visual layer (100% visible, no giant opaque bounding boxes).
 * 2. True Sculpted Distribution Shape: Row length strictly equals letters.length * cellWidth.
 * 3. Restrained, institutional palettes (Classic Slate, Period Heatmap, Monochrome).
 * 4. Rigorous Auction Levels: TPO POC, Volume POC (vPOC), 70% Value Area (VAH & VAL), Initial Balance (IB).
 * 5. Developing vs Final level indicators (dPOC, dVAH, dVAL for active developing sessions).
 * 6. Optional Naked POC ray extensions.
 * 7. Modes: TPO, Volume, TPO + Volume (adjacent on shared price ladder).
 * 8. Positions: Right, Left, Overlay with configurable width and opacity sliders.
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

    const opts = this._options || {};
    const theme = opts.theme || 'DARK';
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

    // Render each session profile
    this._sessions.forEach((session, sessionIdx) => {
      this._renderSession(ctx, session, sessionIdx, getXForTime, priceToCoordinate, mediaWidth, mediaHeight, isDark, opts);
    });

    // Render Naked POC Rays extending into future sessions (if enabled)
    if (opts.extendPocRays !== false) {
      this._renderNakedPocRays(ctx, getXForTime, priceToCoordinate, mediaWidth, isDark);
    }
  }

  _renderSession(ctx, session, sessionIdx, getXForTime, priceToCoordinate, mediaWidth, mediaHeight, isDark, opts) {
    if (!session || !session.startTime || !session.endTime) return;

    const startX = getXForTime(session.startTime);
    const endX = getXForTime(session.endTime);
    if (startX === null && endX === null) return;

    const leftX = startX !== null ? startX : (endX - 250);
    const rightX = endX !== null ? endX : (startX + 250);
    const sessionSpan = Math.max(120, rightX - leftX);

    // Viewport bounds culling
    if (rightX < -150 || leftX > mediaWidth + 150) return;

    const highY = priceToCoordinate(session.high);
    const lowY = priceToCoordinate(session.low);
    if (highY === null || lowY === null) return;

    const topY = Math.min(highY, lowY);
    const bottomY = Math.max(highY, lowY);
    const profileH = Math.max(20, bottomY - topY);

    const rows = Array.from(session.priceRows.values()).sort((a, b) => b.price - a.price);
    if (rows.length === 0) return;

    // Row vertical height tied strictly to price scale
    let rowHeight = Math.max(2, Math.floor(profileH / rows.length));
    if (rows.length >= 2) {
      const p0Y = priceToCoordinate(rows[0].price);
      const p1Y = priceToCoordinate(rows[1].price);
      if (p0Y !== null && p1Y !== null) {
        rowHeight = Math.max(2, Math.abs(p1Y - p0Y));
      }
    }

    // Configurable Options
    const position = opts.profilePosition || 'RIGHT'; // 'RIGHT' | 'LEFT' | 'OVERLAY'
    const profileType = opts.profileType || 'TPO_VOLUME'; // 'TPO' | 'VOLUME' | 'TPO_VOLUME'
    const widthRatio = typeof opts.profileWidthRatio === 'number' ? opts.profileWidthRatio : 0.45;
    const opacity = typeof opts.profileOpacity === 'number' ? opts.profileOpacity : 0.85;
    const paletteName = opts.palette || 'CLASSIC';
    const isDeveloping = session.isDeveloping;

    // Total width allocated for the profile
    const allocatedWidth = Math.max(120, Math.min(500, Math.floor(sessionSpan * widthRatio)));

    // Determine horizontal profile placement (Left, Right, or Overlay)
    let profileOriginX = leftX;
    if (position === 'RIGHT') {
      profileOriginX = Math.max(leftX + 20, rightX - allocatedWidth - 10);
    } else if (position === 'OVERLAY') {
      profileOriginX = leftX + Math.floor((sessionSpan - allocatedWidth) / 2);
    } else {
      profileOriginX = leftX + 10;
    }

    // Proportional layout for TPO vs Volume Profile
    let tpoW = allocatedWidth;
    let volW = 0;
    let tpoLeft = profileOriginX;
    let volLeft = profileOriginX;

    if (profileType === 'TPO_VOLUME') {
      tpoW = Math.floor(allocatedWidth * 0.58);
      volW = Math.floor(allocatedWidth * 0.40);
      tpoLeft = profileOriginX;
      volLeft = profileOriginX + tpoW + 6;
    } else if (profileType === 'VOLUME') {
      tpoW = 0;
      volW = allocatedWidth;
      volLeft = profileOriginX;
    }

    // Find max TPO count and max volume for proportional scaling
    let maxLetters = 1;
    let maxVol = 1;
    rows.forEach(r => {
      if (r.letters.length > maxLetters) maxLetters = r.letters.length;
      if (r.volume > maxVol) maxVol = r.volume;
    });

    // Individual letter cell width (proportional, compact aspect ratio)
    const cellWidth = Math.max(6, Math.min(14, Math.floor((tpoW - 10) / Math.max(16, maxLetters))));
    const showLetters = cellWidth >= 7 && rowHeight >= 7 && (opts.showLetters !== false);

    ctx.save();
    ctx.globalAlpha = opacity;

    // 1. Session Boundary Separator (Zero opaque boxes: subtle vertical session boundary)
    ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.07)' : 'rgba(0, 0, 0, 0.08)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(leftX, topY - 20);
    ctx.lineTo(leftX, bottomY + 30);
    ctx.stroke();
    ctx.setLineDash([]);

    // Session Date Pill at top
    ctx.font = '600 9px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
    ctx.fillStyle = isDark ? '#64748b' : '#94a3b8';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${session.sessionKey}${isDeveloping ? ' (Developing)' : ''}`, leftX + 4, topY - 6);

    // 2. Initial Balance (IB) Bracket on Profile Margin
    if (opts.showIb !== false && session.ibHigh !== null && session.ibLow !== null) {
      const ibTopY = priceToCoordinate(session.ibHigh);
      const ibBotY = priceToCoordinate(session.ibLow);
      if (ibTopY !== null && ibBotY !== null) {
        const ibX = (position === 'RIGHT') ? (profileOriginX - 8) : (profileOriginX - 8);
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(ibX, ibTopY);
        ctx.lineTo(ibX, ibBotY);
        // High tick cap
        ctx.moveTo(ibX - 4, ibTopY);
        ctx.lineTo(ibX + 4, ibTopY);
        // Low tick cap
        ctx.moveTo(ibX - 4, ibBotY);
        ctx.lineTo(ibX + 4, ibBotY);
        ctx.stroke();

        ctx.font = '700 8px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
        ctx.fillStyle = '#38bdf8';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText('IB', ibX - 6, (ibTopY + ibBotY) / 2);
      }
    }

    // 3. Render Sculpted TPO Letter Rows & Adjacent Volume Bars
    rows.forEach((row) => {
      const rowY = priceToCoordinate(row.price);
      if (rowY === null) return;
      const drawY = rowY - rowHeight / 2;

      const isPoc = row.price === session.tpoPoc;
      const isSinglePrint = session.singlePrints && session.singlePrints.includes(row.price);

      // --- TPO Letters Distribution (Sculpted length = letters.length * cellWidth) ---
      if (tpoW > 0 && row.letters.length > 0) {
        row.letters.forEach((letter, lIdx) => {
          const letterIdx = TPO_LETTERS.indexOf(letter);
          const cellColor = getTpoColor(letterIdx >= 0 ? letterIdx : lIdx, paletteName);
          const cellX = tpoLeft + lIdx * cellWidth;

          // Individual letter cell block
          ctx.fillStyle = cellColor;
          ctx.fillRect(cellX, drawY, cellWidth - 0.5, Math.max(1, rowHeight - 0.5));

          // Draw letter glyph if zoomed in
          if (showLetters) {
            ctx.font = `700 ${Math.min(9, rowHeight - 1)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace`;
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(letter, cellX + (cellWidth - 0.5) / 2, drawY + rowHeight / 2);
          }
        });

        // Single Print outline marker
        if (isSinglePrint && opts.showSinglePrints !== false) {
          ctx.strokeStyle = '#f59e0b';
          ctx.lineWidth = 1;
          ctx.strokeRect(tpoLeft - 1, drawY, cellWidth + 1, Math.max(1, rowHeight - 0.5));
        }
      }

      // --- Adjacent Volume Profile Bar ---
      if (volW > 0 && row.volume > 0) {
        const volRatio = Math.min(1.0, row.volume / maxVol);
        const barW = Math.max(3, Math.round((volW - 10) * volRatio));
        const isVolPoc = row.price === session.volPoc;

        // Clean MotiveWave/Sierra cyan volume bar
        ctx.fillStyle = isVolPoc ? 'rgba(255, 215, 0, 0.40)' : (isDark ? 'rgba(14, 165, 233, 0.35)' : 'rgba(2, 132, 199, 0.30)');
        ctx.fillRect(volLeft, drawY, barW, Math.max(1, rowHeight - 0.5));

        // Subtle edge line
        ctx.strokeStyle = isVolPoc ? '#FFD700' : (isDark ? 'rgba(56, 189, 248, 0.70)' : 'rgba(2, 132, 199, 0.70)');
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(volLeft + barW, drawY);
        ctx.lineTo(volLeft + barW, drawY + rowHeight - 0.5);
        ctx.stroke();

        // Exact Volume text label
        if (rowHeight >= 8 && barW >= 24) {
          ctx.font = `600 ${Math.min(8, rowHeight - 1)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace`;
          ctx.fillStyle = isDark ? '#e2e8f0' : '#1e293b';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(this._formatVol(row.volume), volLeft + 3, drawY + rowHeight / 2);
        }
      }
    });

    ctx.restore(); // Restore opacity for crisp auction level overlays

    // 4. TPO Point of Control (POC / dPOC) - Crisp golden line (NO giant opaque yellow box!)
    if (opts.showPoc !== false && session.tpoPoc !== null) {
      const pocY = priceToCoordinate(session.tpoPoc);
      if (pocY !== null) {
        const pocLabel = isDeveloping ? `dPOC ${session.tpoPoc}` : `POC ${session.tpoPoc}`;
        const pocRow = session.priceRows.get(session.tpoPoc);
        const pocRowW = pocRow ? (pocRow.letters.length * cellWidth) : (allocatedWidth * 0.7);
        const lineEndX = tpoLeft + pocRowW + (volW > 0 ? (volW + 12) : 10);

        ctx.strokeStyle = '#FFD700';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(tpoLeft - 4, pocY);
        ctx.lineTo(lineEndX, pocY);
        ctx.stroke();

        // Elegant POC tag
        ctx.fillStyle = '#FFD700';
        ctx.font = '700 9px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(pocLabel, lineEndX + 4, pocY);
      }
    }

    // 5. Volume Point of Control (vPOC) - Crisp cyan line (if distinct from TPO POC)
    if (opts.showVolPoc !== false && session.volPoc !== null && session.volPoc !== session.tpoPoc && volW > 0) {
      const vPocY = priceToCoordinate(session.volPoc);
      if (vPocY !== null) {
        const vPocLabel = `vPOC ${session.volPoc}`;
        const lineEndX = volLeft + volW + 10;

        ctx.strokeStyle = '#06b6d4';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 2]);
        ctx.beginPath();
        ctx.moveTo(volLeft - 2, vPocY);
        ctx.lineTo(lineEndX, vPocY);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = '#06b6d4';
        ctx.font = '700 9px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(vPocLabel, lineEndX + 4, vPocY);
      }
    }

    // 6. Value Area Bounds (VAH & VAL 70%)
    if (opts.showValueArea !== false) {
      if (session.vah !== null) {
        const vahY = priceToCoordinate(session.vah);
        if (vahY !== null) {
          const vahLabel = isDeveloping ? `dVAH ${session.vah}` : `VAH ${session.vah}`;
          const lineEndX = profileOriginX + allocatedWidth;

          ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.45)' : 'rgba(0, 0, 0, 0.40)';
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.moveTo(profileOriginX, vahY);
          ctx.lineTo(lineEndX, vahY);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.font = '600 8.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
          ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
          ctx.textAlign = 'right';
          ctx.textBaseline = 'bottom';
          ctx.fillText(vahLabel, lineEndX, vahY - 2);
        }
      }

      if (session.val !== null) {
        const valY = priceToCoordinate(session.val);
        if (valY !== null) {
          const valLabel = isDeveloping ? `dVAL ${session.val}` : `VAL ${session.val}`;
          const lineEndX = profileOriginX + allocatedWidth;

          ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.45)' : 'rgba(0, 0, 0, 0.40)';
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.moveTo(profileOriginX, valY);
          ctx.lineTo(lineEndX, valY);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.font = '600 8.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
          ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
          ctx.textAlign = 'right';
          ctx.textBaseline = 'top';
          ctx.fillText(valLabel, lineEndX, valY + 2);
        }
      }
    }

    // 7. Poor High / Poor Low Heuristic Markers
    if (opts.showPoorExtremes !== false) {
      if (session.poorHigh) {
        const topYCoord = priceToCoordinate(session.high);
        if (topYCoord !== null) {
          ctx.font = '700 8.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
          ctx.fillStyle = '#ef4444';
          ctx.textAlign = 'left';
          ctx.fillText('⚡ Poor High', profileOriginX, topYCoord - 3);
        }
      }
      if (session.poorLow) {
        const botYCoord = priceToCoordinate(session.low);
        if (botYCoord !== null) {
          ctx.font = '700 8.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
          ctx.fillStyle = '#ef4444';
          ctx.textAlign = 'left';
          ctx.fillText('⚡ Poor Low', profileOriginX, botYCoord + 10);
        }
      }
    }
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

      // Draw horizontal golden Naked POC Ray
      ctx.strokeStyle = '#FFD700';
      ctx.lineWidth = 1.2;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(startX + 100, pocY);
      ctx.lineTo(rayEndX, pocY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Ray label tag
      ctx.font = '700 8px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
      ctx.fillStyle = '#FFD700';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText('nPOC ray', startX + 110, pocY - 2);
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
      profilePosition: 'RIGHT',   // 'RIGHT' | 'LEFT' | 'OVERLAY'
      profileType: 'TPO_VOLUME',  // 'TPO' | 'VOLUME' | 'TPO_VOLUME'
      profileWidthRatio: 0.45,
      profileOpacity: 0.85,
      palette: 'CLASSIC',
      showLetters: true,
      showPoc: true,
      showVolPoc: true,
      showValueArea: true,
      showIb: true,
      showSinglePrints: true,
      showPoorExtremes: true,
      extendPocRays: true,
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

  setOptions(options) {
    Object.assign(this._customOptions, options);
    this._renderer.update(null, this._customOptions);
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
