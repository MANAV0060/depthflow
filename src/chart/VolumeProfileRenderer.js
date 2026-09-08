/**
 * VolumeProfileRenderer.js
 * Session & Intrabar Volume Profile Canvas Renderer.
 */

export class VolumeProfileRenderer {
  constructor(canvasElement) {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');
    this._setupResolution();
  }

  _setupResolution() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = (rect.width || 280) * dpr;
    this.canvas.height = (rect.height || 240) * dpr;
    this.ctx.scale(dpr, dpr);
  }

  clear() {
    if (!this.ctx || !this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const width = rect.width || 280;
    const height = rect.height || 240;
    this.ctx.clearRect(0, 0, width, height);
  }

  render(profileData) {
    const rect = this.canvas.getBoundingClientRect();
    const width = rect.width || 280;
    const height = rect.height || 240;

    this.ctx.clearRect(0, 0, width, height);

    if (!profileData || !profileData.bins || profileData.bins.length === 0) {
      this.ctx.fillStyle = '#808a9d';
      this.ctx.font = '11px sans-serif';
      this.ctx.textAlign = 'center';
      this.ctx.fillText('Awaiting profile ticks...', width / 2, height / 2);
      return;
    }

    const { poc, vah, val, bins } = profileData;
    const maxVol = Math.max(...bins.map(b => b.volume), 1);
    const rowHeight = Math.max(4, height / bins.length);

    bins.forEach((bin, idx) => {
      const y = idx * rowHeight;
      const barWidth = (bin.volume / maxVol) * (width - 60);

      const isPoc = bin.price === poc;
      const isValueArea = bin.price <= vah && bin.price >= val;

      if (isPoc) {
        this.ctx.fillStyle = '#FFD700'; // Gold POC
      } else if (isValueArea) {
        this.ctx.fillStyle = 'rgba(41, 98, 255, 0.4)'; // Value Area Blue
      } else {
        this.ctx.fillStyle = 'rgba(128, 138, 157, 0.2)'; // Out of Value Area
      }

      this.ctx.fillRect(0, y, barWidth, rowHeight - 1);

      // Price Label
      this.ctx.fillStyle = isPoc ? '#FFD700' : '#808a9d';
      this.ctx.font = '9px monospace';
      this.ctx.textAlign = 'left';
      this.ctx.fillText(`${bin.price.toFixed(5)}`, width - 55, y + rowHeight - 1);
    });
  }
}
