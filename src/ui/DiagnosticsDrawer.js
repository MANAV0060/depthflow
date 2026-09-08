/**
 * DiagnosticsDrawer.js
 * Observability & Feed Quality Diagnostics Drawer.
 */

export class DiagnosticsDrawer {
  constructor() {
    this.drawer = document.getElementById('diagnosticsDrawer');
    this.toggleBtn = document.getElementById('toggleDiagnosticsBtn');
    this.closeBtn = document.getElementById('closeDiagnosticsBtn');

    this.diagProvider = document.getElementById('diagProvider');
    this.diagStatus = document.getElementById('diagStatus');
    this.diagThroughput = document.getElementById('diagThroughput');
    this.diagFidelity = document.getElementById('diagFidelity');
    this.diagAggressorMode = document.getElementById('diagAggressorMode');
    this.diagDropped = document.getElementById('diagDropped');

    this.ticksLastSecond = 0;
    this.throughputTimer = null;

    this._bindEvents();
    this._startThroughputMonitor();
  }

  _bindEvents() {
    if (this.toggleBtn) {
      this.toggleBtn.addEventListener('click', () => this.toggle());
    }
    if (this.closeBtn) {
      this.closeBtn.addEventListener('click', () => this.hide());
    }
  }

  toggle() {
    if (this.drawer) {
      this.drawer.classList.toggle('hidden');
    }
  }

  hide() {
    if (this.drawer) {
      this.drawer.classList.add('hidden');
    }
  }

  recordTick() {
    this.ticksLastSecond++;
  }

  _startThroughputMonitor() {
    this.throughputTimer = setInterval(() => {
      if (this.diagThroughput) {
        this.diagThroughput.textContent = `${this.ticksLastSecond} ticks/sec`;
      }
      this.ticksLastSecond = 0;
    }, 1000);
  }

  updateDiagnostics(diagnostics) {
    if (!diagnostics) return;
    if (this.diagProvider) this.diagProvider.textContent = diagnostics.name || 'SimulatedFeed';
    if (this.diagStatus) this.diagStatus.textContent = diagnostics.status || 'CONNECTED';
    if (this.diagFidelity && diagnostics.capabilities) {
      this.diagFidelity.textContent = diagnostics.capabilities.volumeFidelity || 'EXCHANGE_VOLUME';
    }
    if (this.diagDropped) this.diagDropped.textContent = diagnostics.droppedEvents || '0';
  }

  updateAggressorMode(mode) {
    if (this.diagAggressorMode) {
      this.diagAggressorMode.textContent = mode;
    }
  }
}
