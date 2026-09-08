/**
 * LiquidationHeatmapRenderer.js
 * Institutional-Grade Liquidation Heatmap Engine.
 * Visualizes 5-6 month accumulated leverage liquidation clusters (10x, 25x, 50x, 100x)
 * with real-time live sweep animations and multi-tiered glowing color bands.
 */

export class LiquidationHeatmapRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext('2d') : null;
    this.visible = true;
    this.heatmapData = null;
    this.sweepAnimations = []; // Array of active sweep ripple FX
    this.mousePos = null; // { x, y } for hover tooltip
    this.theme = 'DARK';

    this._bindEvents();
    this._startAnimationLoop();
  }

  _bindEvents() {
    if (!this.canvas) return;

    // Track mouse hover for depth tooltip
    this.canvas.addEventListener('mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.mousePos = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
      };
    });

    this.canvas.addEventListener('mouseleave', () => {
      this.mousePos = null;
    });
  }

  setVisible(visible) {
    this.visible = visible;
    if (!visible) {
      this.clear();
    }
  }

  setTheme(theme) {
    this.theme = theme;
  }

  setData(data) {
    if (!data || !Array.isArray(data.buckets)) return;
    this.heatmapData = data;
  }

  addSweepEvent(event) {
    if (!event || !Array.isArray(event.swept)) return;
    const now = performance.now();
    for (const item of event.swept) {
      this.sweepAnimations.push({
        price: item.price,
        type: item.type,
        volume: item.volume || 10000000,
        startTime: now,
        durationMs: 1400
      });
    }
  }

  clear() {
    if (!this.ctx || !this.canvas) return;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  _startAnimationLoop() {
    const loop = () => {
      if (this.sweepAnimations.length > 0) {
        const now = performance.now();
        this.sweepAnimations = this.sweepAnimations.filter(anim => (now - anim.startTime) < anim.durationMs);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  /**
   * Helper: Map normalized intensity (0.0 - 1.0) to glowing thermal gradient colors
   */
  _getColorForIntensity(intensity) {
    if (intensity < 0.12) {
      return { fill: 'rgba(38, 18, 74, 0.22)', glow: 'rgba(50, 20, 95, 0.1)' };
    }
    if (intensity < 0.28) {
      return { fill: 'rgba(15, 75, 140, 0.42)', glow: 'rgba(0, 140, 220, 0.25)' };
    }
    if (intensity < 0.52) {
      return { fill: 'rgba(0, 195, 235, 0.65)', glow: 'rgba(0, 225, 255, 0.45)' };
    }
    if (intensity < 0.78) {
      return { fill: 'rgba(255, 215, 0, 0.82)', glow: 'rgba(255, 235, 50, 0.65)' };
    }
    // White-hot fiery orange flame
    return { fill: 'rgba(255, 80, 0, 0.94)', glow: 'rgba(255, 255, 255, 0.9)' };
  }

  _formatVolume(val) {
    if (val >= 1e9) return (val / 1e9).toFixed(2) + 'B';
    if (val >= 1e6) return (val / 1e6).toFixed(1) + 'M';
    if (val >= 1e3) return (val / 1e3).toFixed(0) + 'K';
    return val.toLocaleString();
  }

  /**
   * Main Render Pipeline
   * Synchronized with ChartEngine priceToY transformation camera
   */
  render(width, height, priceToY, yToPrice) {
    if (!this.visible || !this.ctx || !this.heatmapData) return;

    const ctx = this.ctx;
    const buckets = this.heatmapData.buckets;
    const bucketSize = this.heatmapData.bucket_size || 25;
    const currentPrice = this.heatmapData.current_price || 0;
    const maxVol = this.heatmapData.max_vol || 1;

    ctx.save();
    ctx.clearRect(0, 0, width, height);

    let hoveredBucket = null;
    let hoveredBucketY = 0;

    // 1. Draw Liquidation Heatmap Depth Ribbons
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i];
      const y = priceToY(b.price);

      // Viewport culling: only draw buckets within visible Y canvas
      if (y === null || y < -30 || y > height + 30) continue;

      const yNext = priceToY(b.price - bucketSize);
      const bandHeight = Math.max(3, Math.min(24, Math.abs((yNext !== null ? yNext : y + 6) - y)));
      const topY = y - (bandHeight / 2);

      const { fill, glow } = this._getColorForIntensity(b.intensity);

      // Ribbon width spans from right scale towards the left
      // Stronger pools stretch deeper across the chart
      const ribbonWidth = Math.max(140, Math.floor(width * (0.28 + (b.intensity * 0.70))));
      const startX = width - ribbonWidth;

      // Draw horizontal heat gradient bar
      const grad = ctx.createLinearGradient(startX, 0, width, 0);
      grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
      grad.addColorStop(0.2, fill.replace(/[\d\.]+\)$/, '0.15)'));
      grad.addColorStop(0.7, fill);
      grad.addColorStop(1, fill);

      ctx.fillStyle = grad;
      ctx.fillRect(startX, topY, ribbonWidth, bandHeight - 0.5);

      // Top tier clusters (> 65% intensity): Add bright accent bar on right edge
      if (b.intensity > 0.65) {
        ctx.fillStyle = glow;
        ctx.fillRect(width - 70, topY, 66, bandHeight - 0.5);

        // Render micro-pool label for institutional whales
        if (bandHeight >= 9) {
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 8px monospace';
          ctx.textAlign = 'right';
          ctx.fillText(`$${this._formatVolume(b.totalVol)}`, width - 8, topY + (bandHeight / 2) + 3);
        }
      }

      // Check mouse hover
      if (this.mousePos) {
        if (this.mousePos.y >= topY && this.mousePos.y <= topY + bandHeight) {
          hoveredBucket = b;
          hoveredBucketY = y;
        }
      }
    }

    // 2. Render Live Sweep Animations (Dynamic real-time clearing FX)
    const now = performance.now();
    for (let i = 0; i < this.sweepAnimations.length; i++) {
      const anim = this.sweepAnimations[i];
      const animY = priceToY(anim.price);
      if (animY === null || animY < 0 || animY > height) continue;

      const progress = (now - anim.startTime) / anim.durationMs;
      const alpha = Math.max(0, 1.0 - progress);
      const expandX = progress * (width * 0.45);

      // Flash beam along the swept price line
      ctx.strokeStyle = anim.type.includes('SHORT') ? `rgba(255, 60, 60, ${alpha})` : `rgba(0, 240, 160, ${alpha})`;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(width - expandX, animY);
      ctx.lineTo(width, animY);
      ctx.stroke();

      // Liquidated sweep badge
      if (progress < 0.7) {
        ctx.fillStyle = anim.type.includes('SHORT') ? `rgba(220, 20, 60, ${alpha * 0.9})` : `rgba(0, 180, 100, ${alpha * 0.9})`;
        ctx.fillRect(width - 240, animY - 10, 230, 20);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 9px sans-serif';
        ctx.textAlign = 'center';
        const label = anim.type.includes('SHORT') ? '💥 SHORT LIQ SWEEP' : '💥 LONG LIQ SWEEP';
        ctx.fillText(`${label} ($${this._formatVolume(anim.volume)})`, width - 125, animY + 3);
      }
    }

    // 3. Render Top HUD Watermark Badge
    this._renderHudBadge(ctx, width, height, currentPrice, maxVol);

    // 4. Render Hover Tooltip
    if (hoveredBucket && this.mousePos) {
      this._renderTooltip(ctx, hoveredBucket, hoveredBucketY, currentPrice, width);
    }

    ctx.restore();
  }

  _renderHudBadge(ctx, width, height, currentPrice, maxVol) {
    const badgeX = 14;
    const badgeY = 14;
    const badgeW = 270;
    const badgeH = 46;

    ctx.fillStyle = 'rgba(15, 20, 28, 0.88)';
    ctx.strokeStyle = 'rgba(255, 170, 0, 0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 6);
    ctx.fill();
    ctx.stroke();

    // Fire Icon + Title
    ctx.fillStyle = '#ffaa00';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('🔥 LIQUIDATION HEATMAP', badgeX + 10, badgeY + 18);

    ctx.fillStyle = '#00e5ff';
    ctx.font = '10px monospace';
    ctx.fillText('5-6M HISTORY + LIVE STREAM', badgeX + 138, badgeY + 18);

    // Sub-info
    ctx.fillStyle = '#94a3b8';
    ctx.font = '9px sans-serif';
    ctx.fillText(`Peak Pool: $${this._formatVolume(maxVol)}  |  Granularity: ±${this.heatmapData.bucket_size}`, badgeX + 10, badgeY + 35);
  }

  _renderTooltip(ctx, bucket, bucketY, currentPrice, width) {
    const tipW = 210;
    const tipH = 75;
    const tipX = Math.max(10, width - tipW - 130);
    const tipY = Math.max(10, Math.min(bucketY - (tipH / 2), this.canvas.height - tipH - 10));

    ctx.fillStyle = 'rgba(10, 14, 22, 0.95)';
    ctx.strokeStyle = bucket.intensity > 0.6 ? '#ffd166' : '#00b4d8';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(tipX, tipY, tipW, tipH, 6);
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = 'left';
    // Price
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 11px sans-serif';
    const distPct = currentPrice > 0 ? (((bucket.price - currentPrice) / currentPrice) * 100).toFixed(2) : 0;
    const distSign = distPct > 0 ? `+${distPct}%` : `${distPct}%`;
    ctx.fillText(`Price: ${bucket.price} (${distSign})`, tipX + 10, tipY + 17);

    // Total Liquidation Volume
    ctx.fillStyle = '#ffd166';
    ctx.font = 'bold 10px monospace';
    ctx.fillText(`Pool Size: $${this._formatVolume(bucket.totalVol)}`, tipX + 10, tipY + 34);

    // Long vs Short breakdown
    ctx.font = '9px sans-serif';
    ctx.fillStyle = '#089981';
    ctx.fillText(`Long Liq: $${this._formatVolume(bucket.longVol)}`, tipX + 10, tipY + 50);

    ctx.fillStyle = '#f23645';
    ctx.fillText(`Short Liq: $${this._formatVolume(bucket.shortVol)}`, tipX + 110, tipY + 50);

    // Leverage Bracket Estimate
    ctx.fillStyle = '#94a3b8';
    const levText = Math.abs(distPct) < 1.2 ? '100x Leverage Pool' :
                   (Math.abs(distPct) < 2.5 ? '50x Leverage Pool' :
                   (Math.abs(distPct) < 4.8 ? '25x Leverage Pool' : '10x Swing Leverage Pool'));
    ctx.fillText(levText, tipX + 10, tipY + 66);
  }
}
