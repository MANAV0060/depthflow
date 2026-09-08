/**
 * ReplayEngine.js
 * Historical Tick Replay Controller for Backtesting & Practice Execution.
 */

export class ReplayEngine {
  constructor({ onTick, onStateChange } = {}) {
    this.onTick = onTick || (() => {});
    this.onStateChange = onStateChange || (() => {});
    this.ticks = [];
    this.currentIndex = 0;
    this.isPlaying = false;
    this.speedMultiplier = 1; // 1x to 100x
    this.timer = null;
    this.baseDelayMs = 250;
  }

  loadTicks(tickArray) {
    this.ticks = tickArray || [];
    this.currentIndex = 0;
    this.pause();
    this.onStateChange(this.getState());
  }

  play() {
    if (this.isPlaying || this.ticks.length === 0) return;
    this.isPlaying = true;
    this._scheduleNextTick();
    this.onStateChange(this.getState());
  }

  pause() {
    this.isPlaying = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.onStateChange(this.getState());
  }

  step() {
    this.pause();
    this._dispatchNext();
  }

  setSpeed(multiplier) {
    this.speedMultiplier = Math.max(1, Math.min(100, multiplier));
    if (this.isPlaying) {
      this.pause();
      this.play();
    }
    this.onStateChange(this.getState());
  }

  seekPercentage(percent) {
    this.pause();
    this.currentIndex = Math.floor((percent / 100) * (this.ticks.length - 1));
    this.currentIndex = Math.max(0, Math.min(this.ticks.length - 1, this.currentIndex));
    this.onStateChange(this.getState());
  }

  _scheduleNextTick() {
    if (!this.isPlaying) return;
    const delay = Math.max(10, Math.floor(this.baseDelayMs / this.speedMultiplier));
    this.timer = setTimeout(() => {
      this._dispatchNext();
      if (this.currentIndex < this.ticks.length - 1 && this.isPlaying) {
        this._scheduleNextTick();
      } else {
        this.pause();
      }
    }, delay);
  }

  _dispatchNext() {
    if (this.currentIndex >= this.ticks.length) return;
    const event = this.ticks[this.currentIndex];
    this.currentIndex++;
    this.onTick(event);
    this.onStateChange(this.getState());
  }

  getState() {
    return {
      isPlaying: this.isPlaying,
      currentIndex: this.currentIndex,
      totalTicks: this.ticks.length,
      progressPercent: this.ticks.length > 0 ? (this.currentIndex / this.ticks.length) * 100 : 0,
      speedMultiplier: this.speedMultiplier
    };
  }
}
