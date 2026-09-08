/**
 * VolumeProfileEngine.js
 * Session & Intrabar Volume Profile Analytics Engine.
 */

export class VolumeProfileEngine {
  constructor({ valueAreaPercent = 0.70 } = {}) {
    this.valueAreaPercent = valueAreaPercent;
    this.priceBins = new Map(); // priceBucket -> totalVolume
    this.totalVolume = 0;
  }

  reset() {
    this.priceBins.clear();
    this.totalVolume = 0;
  }

  addEvent(price, size = 1) {
    const step = price > 1000 ? 5.0 : (price > 100 ? 0.5 : 0.0001);
    const bucket = Math.round(price / step) * step;
    const norm = Math.round(bucket * 100000) / 100000;
    const current = this.priceBins.get(norm) || 0;
    this.priceBins.set(norm, current + size);
    this.totalVolume += size;
  }

  loadFromCandles(candles) {
    this.reset();
    if (!Array.isArray(candles)) return;
    candles.forEach((c) => {
      if (c.cells) {
        if (c.cells instanceof Map) {
          c.cells.forEach((cell) => {
            const step = cell.price > 1000 ? 5.0 : (cell.price > 100 ? 0.5 : 0.0001);
            const norm = Math.round((Math.round(cell.price / step) * step) * 100000) / 100000;
            const current = this.priceBins.get(norm) || 0;
            this.priceBins.set(norm, current + cell.totalVolume);
            this.totalVolume += cell.totalVolume;
          });
        } else if (Array.isArray(c.cells)) {
          c.cells.forEach((cell) => {
            const step = cell.price > 1000 ? 5.0 : (cell.price > 100 ? 0.5 : 0.0001);
            const norm = Math.round((Math.round(cell.price / step) * step) * 100000) / 100000;
            const current = this.priceBins.get(norm) || 0;
            this.priceBins.set(norm, current + cell.totalVolume);
            this.totalVolume += cell.totalVolume;
          });
        }
      }
    });
  }

  calculateProfile() {
    if (this.priceBins.size === 0) {
      return { poc: 0, vah: 0, val: 0, bins: [] };
    }

    const bins = Array.from(this.priceBins.entries())
      .map(([price, volume]) => ({ price, volume }))
      .sort((a, b) => b.price - a.price);

    // Identify POC
    let pocBin = bins[0];
    for (const bin of bins) {
      if (bin.volume > pocBin.volume) {
        pocBin = bin;
      }
    }

    // Calculate 70% Value Area
    const targetVolume = this.totalVolume * this.valueAreaPercent;
    let accumulatedVolume = pocBin.volume;
    const pocIndex = bins.findIndex(b => b.price === pocBin.price);

    let upIdx = pocIndex - 1;
    let downIdx = pocIndex + 1;

    while (accumulatedVolume < targetVolume && (upIdx >= 0 || downIdx < bins.length)) {
      const upVol = (upIdx >= 0 ? bins[upIdx].volume : 0) + (upIdx - 1 >= 0 ? bins[upIdx - 1].volume : 0);
      const downVol = (downIdx < bins.length ? bins[downIdx].volume : 0) + (downIdx + 1 < bins.length ? bins[downIdx + 1].volume : 0);

      if (upVol >= downVol && upIdx >= 0) {
        accumulatedVolume += bins[upIdx].volume;
        upIdx--;
      } else if (downIdx < bins.length) {
        accumulatedVolume += bins[downIdx].volume;
        downIdx++;
      } else if (upIdx >= 0) {
        accumulatedVolume += bins[upIdx].volume;
        upIdx--;
      } else {
        break;
      }
    }

    const vah = bins[Math.max(0, upIdx + 1)].price;
    const val = bins[Math.min(bins.length - 1, downIdx - 1)].price;

    return {
      poc: pocBin.price,
      vah,
      val,
      totalVolume: this.totalVolume,
      bins
    };
  }
}
