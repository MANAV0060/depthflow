/**
 * TPOSeriesPlugin.js
 * Professional TradingView Lightweight Charts Custom Series Plugin for Time Price Opportunity (TPO) & Market Profile.
 *
 * Implements ICustomSeriesPaneView & ICustomSeriesPaneRenderer.
 * 
 * Core Architectural Principles & Adaptive Information Density:
 * 1. Candlesticks remain the PRIMARY visual layer (100% visible, no giant opaque bounding boxes).
 * 2. Adaptive Information Density (LOD):
 *    - Micro / 1m Timeframe (or dense zoom): Compact contextual session profile with essential auction
 *      reference levels (POC, VAH, VAL, IB) + optional subtle margin strip, keeping candles, footprint,
 *      Big Trades, and delta primary.
 *    - Intermediate / 5m–15m: Clean sculpted profile silhouette without historical label collisions.
 *    - Macro / 30m+ or high zoom: Full distribution with crisp letter glyphs and adjacent volume profile.
 * 3. Historical Session Culling: Crowded historical sessions suppress colliding text tags and raw volume numbers.
 * 4. Naked POC Rays Hygiene: Limits active rays to the N most recent relevant untested levels (default: 3).
 * 5. Strict Price/Time Coordinate Anchoring: All lines and profiles remain 100% anchored to chart coordinates.
 * 6. Non-Destructive LOD: Underlying TPO calculation data is preserved completely.
 */

import { TPO_LETTERS, getTpoColor } from '../analytics/TPOEngine.js?v=tpo_live_v4';

class LabelOcclusionManager {
  constructor() {
    this.boxes = [];
  }

  canPlace(x, y, w, h, padX = 4, padY = 3) {
    const l = x - padX;
    const t = y - padY;
    const r = x + w + padX;
    const b = y + h + padY;
    for (let i = 0; i < this.boxes.length; i++) {
      const o = this.boxes[i];
      if (l < o.r && r > o.l && t < o.b && b > o.t) {
        return false;
      }
    }
    return true;
  }

  add(x, y, w, h) {
    this.boxes.push({ l: x, t: y, r: x + w, b: y + h });
  }
}

export class TPOSeriesPaneRenderer {
  constructor() {
    this._data = null;
    this._options = {};
    this._sessions = [];
  }

  setData(data) {
    this._data = data;
    this._sessions = (data && data.sessions) ? data.sessions : [];
  }

  setOptions(options) {
    this._options = Object.assign(this._options, options);
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

    // Measure physical bar spacing (zoom density) directly from visible bars
    let currentBarSpacing = 20;
    if (this._data.bars && this._data.bars.length >= 2) {
      for (let i = 1; i < Math.min(12, this._data.bars.length); i++) {
        const dx = Math.abs(this._data.bars[i].x - this._data.bars[i - 1].x);
        if (dx > 1 && dx < 600) {
          currentBarSpacing = dx;
          break;
        }
      }
    }

    // Extract valid visible bars with timestamp and pixel X
    const validBars = [];
    const timeToXMap = new Map();
    this._data.bars.forEach(b => {
      if (b && b.x !== null && b.x !== undefined && !isNaN(b.x)) {
        const t = b.originalData ? (b.originalData.startTime || b.originalData.time * 1000) : b.time * 1000;
        validBars.push({ t, x: b.x });
        timeToXMap.set(t, b.x);
      }
    });

    if (validBars.length === 0) return;
    validBars.sort((a, b) => a.t - b.t);

    const firstBar = validBars[0];
    const lastBar = validBars[validBars.length - 1];
    const firstBarTime = firstBar.t;
    const lastBarTime = lastBar.t;

    let avgBarDurationMs = 60000;
    if (validBars.length >= 2) {
      avgBarDurationMs = Math.max(1000, (lastBarTime - firstBarTime) / (validBars.length - 1));
    }

    const getXForTime = (timeMs) => {
      if (timeToXMap.has(timeMs)) return timeToXMap.get(timeMs);

      // If timestamp is before the first visible bar:
      // Project linearly into negative coordinates so off-screen sessions cull naturally!
      if (timeMs < firstBarTime) {
        const barsDelta = (firstBarTime - timeMs) / avgBarDurationMs;
        return firstBar.x - (barsDelta * currentBarSpacing);
      }

      // If timestamp is after the last visible bar:
      if (timeMs > lastBarTime) {
        const barsDelta = (timeMs - lastBarTime) / avgBarDurationMs;
        return lastBar.x + (barsDelta * currentBarSpacing);
      }

      let closestX = null;
      let minDiff = Infinity;
      for (let i = 0; i < validBars.length; i++) {
        const diff = Math.abs(validBars[i].t - timeMs);
        if (diff < minDiff) {
          minDiff = diff;
          closestX = validBars[i].x;
        }
      }
      return closestX;
    };

    // Label collision manager: ensures zero overlapping text labels on historical sessions
    const labelManager = new LabelOcclusionManager();

    // Render active/latest session first so it has highest priority for labels and screen space
    for (let sessionIdx = this._sessions.length - 1; sessionIdx >= 0; sessionIdx--) {
      const session = this._sessions[sessionIdx];
      this._renderSession(ctx, session, sessionIdx, getXForTime, priceToCoordinate, mediaWidth, mediaHeight, isDark, opts, currentBarSpacing, labelManager, firstBarTime, lastBarTime, avgBarDurationMs);
    }

    // Render Naked POC Rays extending into future sessions (hygienic limit)
    if (opts.extendPocRays !== false) {
      this._renderNakedPocRays(ctx, getXForTime, priceToCoordinate, mediaWidth, mediaHeight, isDark, opts);
    }
  }

  _renderSession(ctx, session, sessionIdx, getXForTime, priceToCoordinate, mediaWidth, mediaHeight, isDark, opts, currentBarSpacing, labelManager, firstBarTime, lastBarTime, avgBarDurationMs) {
    if (!session || !session.startTime || !session.endTime) return;

    // Strict temporal culling:
    // If session ended before the earliest data in the chart, it is 100% off-screen in the past!
    if (firstBarTime && session.endTime < firstBarTime - (avgBarDurationMs * 2)) return;
    if (lastBarTime && session.startTime > lastBarTime + (avgBarDurationMs * 10)) return;

    const startX = getXForTime(session.startTime);
    const endX = getXForTime(session.endTime);
    if (startX === null || endX === null) return;

    const leftX = startX;
    const rightX = endX;
    
    // sessionSpan = physical chart distance for this session (available chart space)
    const sessionSpan = rightX - leftX;

    // Viewport bounds culling:
    // If session has completely scrolled off the left or right of the screen
    if (rightX < -50 || leftX > mediaWidth + 50) return;

    // Discard degenerate sessions that have no horizontal space
    if (sessionSpan < 15) return;

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

    // Configurable User Options
    const position = opts.profilePosition || 'RIGHT'; // 'RIGHT' | 'LEFT' | 'OVERLAY'
    const profileType = opts.profileType || 'TPO_VOLUME'; // 'TPO' | 'VOLUME' | 'TPO_VOLUME'
    const widthRatio = typeof opts.profileWidthRatio === 'number' ? opts.profileWidthRatio : 0.45;
    const opacity = typeof opts.profileOpacity === 'number' ? opts.profileOpacity : 0.85;
    const paletteName = opts.palette || 'CLASSIC';
    const isDeveloping = session.isDeveloping;
    const isLatestSession = (sessionIdx === this._sessions.length - 1);

    // =========================================================================
    // Adaptive Information Density (Level of Detail - LOD)
    // Responds to screen density/zoom (currentBarSpacing) and sessionSpan, not rigid hiding
    // =========================================================================
    const densityMode = opts.densityMode || 'ADAPTIVE'; // 'ADAPTIVE' | 'COMPACT' | 'EXPANDED'
    const timeframeStr = opts.timeframeStr || '1m';
    const isMicroTf = (timeframeStr === '1m' || timeframeStr === '3m');
    const isTpoMode = (opts.chartMode === 'TPO') || (typeof window !== 'undefined' && window.depthflowApp?.chartEngine?.chartMode === 'TPO');

    let sessionLOD = 'FULL'; // 'FULL' | 'SILHOUETTE' | 'COMPACT' | 'HISTORICAL_COMPACT'

    // On 1m or in TPO Mode or EXPANDED density: always render FULL rich profile with letter blocks!
    if (timeframeStr === '1m' || isTpoMode || densityMode === 'EXPANDED') {
      sessionLOD = 'FULL';
    } else if (densityMode === 'COMPACT') {
      sessionLOD = 'COMPACT';
    } else {
      // 5m, 15m, 30m, 1h, 4h, Daily: untouched!
      if (isLatestSession) {
        sessionLOD = (sessionSpan >= 110 || currentBarSpacing >= 20) ? 'FULL' : 'SILHOUETTE';
      } else {
        // Historical sessions: detect available space and crowding
        if (sessionSpan < 95) {
          sessionLOD = 'HISTORICAL_COMPACT';
        } else if (sessionSpan < 190) {
          sessionLOD = 'SILHOUETTE';
        } else {
          sessionLOD = 'FULL';
        }
      }
    }

    // =========================================================================
    // Profile Width Allocation (distinct from sessionSpan!)
    // =========================================================================
    let allocatedWidth = 0;
    if (timeframeStr === '1m' || isTpoMode) {
      // For 1m institutional sessions or TPO mode: give generous readable width
      allocatedWidth = Math.max(180, Math.min(450, Math.floor(Math.max(sessionSpan * 0.65, sessionSpan * widthRatio))));
    } else if (sessionLOD === 'COMPACT') {
      // Sleek, compact margin strip (optional and lightweight)
      if (opts.showCompactMarginStrip === false) {
        allocatedWidth = 0;
      } else {
        allocatedWidth = Math.min(50, Math.max(25, Math.floor(sessionSpan * 0.16)));
      }
    } else if (sessionLOD === 'HISTORICAL_COMPACT') {
      // Narrow silhouette on crowded historical sessions
      allocatedWidth = Math.min(65, Math.max(25, Math.floor(sessionSpan * 0.35)));
    } else if (sessionLOD === 'SILHOUETTE') {
      allocatedWidth = Math.max(60, Math.min(220, Math.floor(sessionSpan * widthRatio * 0.85)));
    } else {
      // Full distribution
      allocatedWidth = Math.max(100, Math.min(460, Math.floor(sessionSpan * widthRatio)));
    }

    // Determine horizontal profile placement
    let profileOriginX = leftX;
    if (position === 'RIGHT') {
      profileOriginX = Math.max(leftX + 10, rightX - allocatedWidth - 8);
    } else if (position === 'OVERLAY') {
      profileOriginX = leftX + Math.floor((sessionSpan - allocatedWidth) / 2);
    } else {
      profileOriginX = leftX + 8;
    }

    // Proportional layout for TPO vs Volume Profile
    let tpoW = allocatedWidth;
    let volW = 0;
    let tpoLeft = profileOriginX;
    let volLeft = profileOriginX;

    if (sessionLOD === 'COMPACT') {
      // Compact mode: single distribution contour
      tpoW = allocatedWidth;
      volW = 0;
      tpoLeft = profileOriginX;
      volLeft = profileOriginX;
    } else if (profileType === 'TPO_VOLUME' && sessionLOD !== 'HISTORICAL_COMPACT') {
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

    // Individual letter cell width (scaled generously for readability)
    let cellWidth = Math.max(4, Math.min(20, Math.floor((tpoW - 8) / Math.max(12, maxLetters))));
    if (sessionLOD === 'COMPACT' || sessionLOD === 'HISTORICAL_COMPACT') {
      cellWidth = Math.max(2, Math.floor((tpoW - 4) / Math.max(1, maxLetters)));
    }

    // Zoom-adaptive letter glyphs: only render glyphs when cell is sufficiently large and in full mode
    const showLetterGlyphs = ((sessionLOD === 'FULL') || isTpoMode || timeframeStr === '1m') && cellWidth >= 6 && rowHeight >= 6 && (opts.showLetters !== false);

    // =========================================================================
    // 1. Session Boundary Separator (Subtle line & session date pill)
    // =========================================================================
    ctx.save();
    ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.07)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(leftX, topY - 16);
    ctx.lineTo(leftX, bottomY + 20);
    ctx.stroke();
    ctx.setLineDash([]);

    // Date pill: show date if session has >= 80px width, or if latest, or in TPO mode / 1m
    if (sessionSpan >= 80 || isLatestSession || isTpoMode || timeframeStr === '1m') {
      ctx.font = '600 8.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
      ctx.fillStyle = isDark ? '#64748b' : '#94a3b8';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      const labelText = isDeveloping ? `${session.sessionKey} (Active)` : session.sessionKey;
      ctx.fillText(labelText, leftX + 4, topY - 4);
    }
    ctx.restore();

    // =========================================================================
    // 2. Initial Balance (IB) Bracket on Profile Margin
    // =========================================================================
    if (opts.showIb !== false && session.ibHigh !== null && session.ibLow !== null) {
      const ibTopY = priceToCoordinate(session.ibHigh);
      const ibBotY = priceToCoordinate(session.ibLow);
      if (ibTopY !== null && ibBotY !== null) {
        ctx.save();
        const ibX = profileOriginX - 6;
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = (sessionLOD === 'COMPACT' || sessionLOD === 'HISTORICAL_COMPACT') ? 1.5 : 2;
        ctx.beginPath();
        ctx.moveTo(ibX, ibTopY);
        ctx.lineTo(ibX, ibBotY);
        // High tick cap
        ctx.moveTo(ibX - 3, ibTopY);
        ctx.lineTo(ibX + 3, ibTopY);
        // Low tick cap
        ctx.moveTo(ibX - 3, ibBotY);
        ctx.lineTo(ibX + 3, ibBotY);
        ctx.stroke();

        // IB tag only if not cramped
        if (sessionLOD !== 'HISTORICAL_COMPACT' || isTpoMode || timeframeStr === '1m') {
          ctx.font = '700 7.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
          ctx.fillStyle = '#38bdf8';
          ctx.textAlign = 'right';
          ctx.textBaseline = 'middle';
          ctx.fillText('IB', ibX - 4, (ibTopY + ibBotY) / 2);
        }
        ctx.restore();
      }
    }

    // =========================================================================
    // 3. Render Sculpted TPO Profile Rows & Adjacent Volume Bars
    // =========================================================================
    const profileOpacity = (timeframeStr === '1m' || isTpoMode) ? opacity : ((sessionLOD === 'COMPACT') ? Math.min(0.35, opacity * 0.40) : opacity);

    ctx.save();
    ctx.globalAlpha = profileOpacity;

    rows.forEach((row) => {
      const rowY = priceToCoordinate(row.price);
      if (rowY === null) return;
      const drawY = rowY - rowHeight / 2;

      const isSinglePrint = session.singlePrints && session.singlePrints.includes(row.price);

      // --- TPO Letters Distribution (Sculpted length = letters.length * cellWidth) ---
      if (tpoW > 0 && row.letters.length > 0) {
        row.letters.forEach((letter, lIdx) => {
          const letterIdx = TPO_LETTERS.indexOf(letter);
          const cellColor = getTpoColor(letterIdx >= 0 ? letterIdx : lIdx, paletteName);
          const cellX = tpoLeft + lIdx * cellWidth;

          ctx.fillStyle = cellColor;
          ctx.fillRect(cellX, drawY, Math.max(1, cellWidth - 0.5), Math.max(1, rowHeight - 0.5));

          // Draw letter glyph if in full LOD and zoomed in
          if (showLetterGlyphs) {
            ctx.font = `700 ${Math.min(9, rowHeight - 1)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace`;
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(letter, cellX + (cellWidth - 0.5) / 2, drawY + rowHeight / 2);
          }
        });

        // Single Print outline marker (only when not cramped)
        if (isSinglePrint && opts.showSinglePrints !== false && sessionLOD !== 'HISTORICAL_COMPACT') {
          ctx.strokeStyle = '#f59e0b';
          ctx.lineWidth = 1;
          ctx.strokeRect(tpoLeft - 1, drawY, cellWidth + 1, Math.max(1, rowHeight - 0.5));
        }
      }

      // --- Adjacent Volume Profile Bar ---
      if (volW > 0 && row.volume > 0 && sessionLOD !== 'COMPACT' && sessionLOD !== 'HISTORICAL_COMPACT') {
        const volRatio = Math.min(1.0, row.volume / maxVol);
        const barW = Math.max(2, Math.round((volW - 8) * volRatio));
        const isVolPoc = row.price === session.volPoc;

        ctx.fillStyle = isVolPoc ? 'rgba(255, 215, 0, 0.40)' : (isDark ? 'rgba(14, 165, 233, 0.35)' : 'rgba(2, 132, 199, 0.30)');
        ctx.fillRect(volLeft, drawY, barW, Math.max(1, rowHeight - 0.5));

        ctx.strokeStyle = isVolPoc ? '#FFD700' : (isDark ? 'rgba(56, 189, 248, 0.70)' : 'rgba(2, 132, 199, 0.70)');
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(volLeft + barW, drawY);
        ctx.lineTo(volLeft + barW, drawY + rowHeight - 0.5);
        ctx.stroke();

        // Exact Volume text label: ONLY in FULL LOD to prevent label collisions
        if (sessionLOD === 'FULL' && rowHeight >= 8 && barW >= 24) {
          ctx.font = `600 ${Math.min(8, rowHeight - 1)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace`;
          ctx.fillStyle = isDark ? '#e2e8f0' : '#1e293b';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(this._formatVol(row.volume), volLeft + 3, drawY + rowHeight / 2);
        }
      }
    });

    ctx.restore();

    // =========================================================================
    // 4. Point of Control (POC / dPOC) - Crisp golden line
    // Label collision hygiene: Suppress text tags on cramped historical sessions
    // =========================================================================
    if (opts.showPoc !== false && session.tpoPoc !== null) {
      const pocY = priceToCoordinate(session.tpoPoc);
      if (pocY !== null) {
        ctx.save();
        const isHistoricalCramped = (sessionLOD === 'HISTORICAL_COMPACT');
        
        let lineStartX = tpoLeft;
        let lineEndX = tpoLeft + allocatedWidth;

        if (sessionLOD === 'COMPACT') {
          // On 1m: POC spans the active session width cleanly
          lineStartX = leftX;
          lineEndX = rightX;
        } else {
          const pocRow = session.priceRows.get(session.tpoPoc);
          const pocRowW = pocRow ? (pocRow.letters.length * cellWidth) : (allocatedWidth * 0.7);
          lineEndX = tpoLeft + pocRowW + (volW > 0 ? (volW + 10) : 8);
        }

        // Active session gets vibrant solid line; historical sessions get subtle dashed line
        if (isLatestSession || isDeveloping) {
          ctx.strokeStyle = '#FFD700';
          ctx.lineWidth = 1.8;
          ctx.beginPath();
          ctx.moveTo(lineStartX, pocY);
          ctx.lineTo(lineEndX, pocY);
          ctx.stroke();
        } else {
          ctx.strokeStyle = isHistoricalCramped ? 'rgba(255, 215, 0, 0.35)' : 'rgba(255, 215, 0, 0.60)';
          ctx.lineWidth = 1.0;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(lineStartX, pocY);
          ctx.lineTo(lineEndX, pocY);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        // Label Tag: Only show text if collision manager permits and session has room
        const canShowPocText = isLatestSession || (!isHistoricalCramped && sessionSpan >= 110);
        if (canShowPocText) {
          const pocLabel = isDeveloping ? `dPOC ${session.tpoPoc}` : `POC ${session.tpoPoc}`;
          ctx.font = '700 8.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
          const textW = ctx.measureText(pocLabel).width;
          const textX = lineEndX + 3;
          const textY = pocY;

          if (labelManager.canPlace(textX, textY - 5, textW, 10)) {
            labelManager.add(textX, textY - 5, textW, 10);
            ctx.fillStyle = (isLatestSession || isDeveloping) ? '#FFD700' : 'rgba(255, 215, 0, 0.75)';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(pocLabel, textX, textY);
          }
        }
        ctx.restore();
      }
    }

    // =========================================================================
    // 5. Volume Point of Control (vPOC) - Cyan line
    // =========================================================================
    if (opts.showVolPoc !== false && session.volPoc !== null && session.volPoc !== session.tpoPoc && volW > 0) {
      if (sessionLOD !== 'COMPACT' && sessionLOD !== 'HISTORICAL_COMPACT') {
        const vPocY = priceToCoordinate(session.volPoc);
        if (vPocY !== null) {
          ctx.save();
          const lineEndX = volLeft + volW + 8;
          ctx.strokeStyle = isLatestSession ? '#06b6d4' : 'rgba(6, 182, 212, 0.65)';
          ctx.lineWidth = 1.2;
          ctx.setLineDash([3, 2]);
          ctx.beginPath();
          ctx.moveTo(volLeft, vPocY);
          ctx.lineTo(lineEndX, vPocY);
          ctx.stroke();
          ctx.setLineDash([]);

          if (sessionSpan >= 120 || isLatestSession) {
            const vPocLabel = `vPOC ${session.volPoc}`;
            ctx.font = '700 8px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
            const textW = ctx.measureText(vPocLabel).width;
            const textX = lineEndX + 3;
            const textY = vPocY;

            if (labelManager.canPlace(textX, textY - 5, textW, 10)) {
              labelManager.add(textX, textY - 5, textW, 10);
              ctx.fillStyle = '#06b6d4';
              ctx.textAlign = 'left';
              ctx.textBaseline = 'middle';
              ctx.fillText(vPocLabel, textX, textY);
            }
          }
          ctx.restore();
        }
      }
    }

    // =========================================================================
    // 6. Value Area Bounds (VAH & VAL 70%)
    // =========================================================================
    if (opts.showValueArea !== false) {
      ctx.save();
      const isHistoricalCramped = (sessionLOD === 'HISTORICAL_COMPACT');

      if (session.vah !== null) {
        const vahY = priceToCoordinate(session.vah);
        if (vahY !== null) {
          const lineStartX = (sessionLOD === 'COMPACT') ? leftX : profileOriginX;
          const lineEndX = (sessionLOD === 'COMPACT') ? rightX : (profileOriginX + allocatedWidth);

          ctx.strokeStyle = isLatestSession
            ? (isDark ? 'rgba(255, 255, 255, 0.45)' : 'rgba(0, 0, 0, 0.40)')
            : (isDark ? 'rgba(255, 255, 255, 0.20)' : 'rgba(0, 0, 0, 0.18)');
          ctx.lineWidth = isLatestSession ? 1.0 : 0.8;
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.moveTo(lineStartX, vahY);
          ctx.lineTo(lineEndX, vahY);
          ctx.stroke();
          ctx.setLineDash([]);

          if (!isHistoricalCramped && (sessionSpan >= 110 || isLatestSession)) {
            const vahLabel = isDeveloping ? `dVAH ${session.vah}` : `VAH ${session.vah}`;
            ctx.font = '600 8px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
            const textW = ctx.measureText(vahLabel).width;
            const textX = lineEndX;
            const textY = vahY - 8;

            if (labelManager.canPlace(textX - textW, textY, textW, 8)) {
              labelManager.add(textX - textW, textY, textW, 8);
              ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
              ctx.textAlign = 'right';
              ctx.textBaseline = 'bottom';
              ctx.fillText(vahLabel, textX, vahY - 2);
            }
          }
        }
      }

      if (session.val !== null) {
        const valY = priceToCoordinate(session.val);
        if (valY !== null) {
          const lineStartX = (sessionLOD === 'COMPACT') ? leftX : profileOriginX;
          const lineEndX = (sessionLOD === 'COMPACT') ? rightX : (profileOriginX + allocatedWidth);

          ctx.strokeStyle = isLatestSession
            ? (isDark ? 'rgba(255, 255, 255, 0.45)' : 'rgba(0, 0, 0, 0.40)')
            : (isDark ? 'rgba(255, 255, 255, 0.20)' : 'rgba(0, 0, 0, 0.18)');
          ctx.lineWidth = isLatestSession ? 1.0 : 0.8;
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.moveTo(lineStartX, valY);
          ctx.lineTo(lineEndX, valY);
          ctx.stroke();
          ctx.setLineDash([]);

          if (!isHistoricalCramped && (sessionSpan >= 110 || isLatestSession)) {
            const valLabel = isDeveloping ? `dVAL ${session.val}` : `VAL ${session.val}`;
            ctx.font = '600 8px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
            const textW = ctx.measureText(valLabel).width;
            const textX = lineEndX;
            const textY = valY + 1;

            if (labelManager.canPlace(textX - textW, textY, textW, 8)) {
              labelManager.add(textX - textW, textY, textW, 8);
              ctx.fillStyle = isDark ? '#94a3b8' : '#64748b';
              ctx.textAlign = 'right';
              ctx.textBaseline = 'top';
              ctx.fillText(valLabel, textX, valY + 2);
            }
          }
        }
      }
      ctx.restore();
    }

    // =========================================================================
    // 7. Poor High / Poor Low Heuristic Markers
    // =========================================================================
    if (opts.showPoorExtremes !== false && sessionLOD !== 'HISTORICAL_COMPACT' && sessionLOD !== 'COMPACT') {
      ctx.save();
      if (session.poorHigh) {
        const topYCoord = priceToCoordinate(session.high);
        if (topYCoord !== null) {
          ctx.font = '700 8px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
          ctx.fillStyle = '#ef4444';
          ctx.textAlign = 'left';
          ctx.fillText('⚡ Poor High', profileOriginX, topYCoord - 3);
        }
      }
      if (session.poorLow) {
        const botYCoord = priceToCoordinate(session.low);
        if (botYCoord !== null) {
          ctx.font = '700 8px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
          ctx.fillStyle = '#ef4444';
          ctx.textAlign = 'left';
          ctx.fillText('⚡ Poor Low', profileOriginX, botYCoord + 9);
        }
      }
      ctx.restore();
    }
  }

  /**
   * Render Naked POC Rays with hygienic filtering:
   * 1. Only truly UNTESTED sessions (!sess.isPocTested) project forward
   * 2. Only the N most recent relevant levels within/near visible chart window (default: 3)
   * 3. Prevents spiderweb clutter across the screen
   */
  _renderNakedPocRays(ctx, getXForTime, priceToCoordinate, mediaWidth, mediaHeight, isDark, opts) {
    if (!this._sessions || this._sessions.length === 0) return;

    const maxRays = typeof opts.maxNakedPocRays === 'number' ? opts.maxNakedPocRays : 3;

    // Filter sessions that have a valid POC and are strictly UNTESTED
    const untested = [];

    // Scan backwards from most recent historical session
    for (let i = this._sessions.length - 2; i >= 0; i--) {
      const sess = this._sessions[i];
      if (!sess || !sess.tpoPoc) continue;

      if (!sess.isPocTested) {
        const pocY = priceToCoordinate(sess.tpoPoc);
        // Only include if within or near visible price range
        if (pocY !== null && pocY >= -50 && pocY <= mediaHeight + 50) {
          untested.push(sess);
          if (untested.length >= maxRays) break;
        }
      }
    }

    untested.forEach(session => {
      const pocY = priceToCoordinate(session.tpoPoc);
      if (pocY === null) return;

      const startX = getXForTime(session.endTime || session.startTime);
      if (startX === null) return;

      const rayEndX = mediaWidth + 30;
      if (rayEndX <= startX + 20) return;

      ctx.save();
      ctx.strokeStyle = '#FFD700';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(startX, pocY);
      ctx.lineTo(rayEndX, pocY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Label ray cleanly near chart right margin
      ctx.font = '700 8px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
      ctx.fillStyle = '#FFD700';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`nPOC ${session.tpoPoc}`, rayEndX - 10, pocY - 2);
      ctx.restore();
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
      densityMode: 'ADAPTIVE',    // 'ADAPTIVE' | 'COMPACT' | 'EXPANDED'
      timeframeStr: '1m',
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
      maxNakedPocRays: 3,
      showCompactMarginStrip: true,
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
