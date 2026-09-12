/**
 * TPOSettingsModal.js
 * Dedicated Settings Modal & Preference Manager for Time Price Opportunity (TPO) & Market Profile.
 *
 * Provides institutional configuration for:
 * - Profile Mode (TPO, Volume, TPO + Volume)
 * - Profile Placement (Right, Left, Overlay)
 * - Width & Opacity sliders
 * - Color Palette (Classic Institutional, Period Heatmap, Clean Sierra Blue)
 * - Auction Levels (TPO POC, Volume POC, 70% Value Area, Initial Balance, Naked POC rays)
 * - Single Prints & Poor High / Poor Low Heuristics
 * - Bracket Duration (30m / 60m)
 */

export class TPOSettingsModal {
  constructor(options = {}) {
    this.onSettingsChange = options.onSettingsChange || null;
    this.storageKey = 'odeerflow_tpo_settings_v1';
    this.settings = this._loadSettings();
    this._initElements();
    this._bindEvents();
    this._applySettingsToUI();
  }

  _loadSettings() {
    const defaultSettings = {
      profileType: 'TPO_VOLUME',  // 'TPO' | 'VOLUME' | 'TPO_VOLUME'
      profilePosition: 'RIGHT',   // 'RIGHT' | 'LEFT' | 'OVERLAY'
      densityMode: 'ADAPTIVE',    // 'ADAPTIVE' | 'COMPACT' | 'EXPANDED'
      profileWidthRatio: 0.45,
      profileOpacity: 0.85,
      palette: 'CLASSIC',         // 'CLASSIC' | 'HEATMAP' | 'MONOCHROME'
      showLetters: true,
      showPoc: true,
      showVolPoc: true,
      showValueArea: true,
      valueAreaPercent: 0.70,
      showIb: true,
      ibDuration: 60,             // 60m (A & B) or 30m (A)
      extendPocRays: true,
      maxNakedPocRays: 3,
      showCompactMarginStrip: true,
      showHoverTooltip: false,
      showSinglePrints: true,
      showPoorExtremes: true,
      bracketMinutes: 30
    };

    try {
      const saved = localStorage.getItem(this.storageKey);
      if (saved) {
        return Object.assign({}, defaultSettings, JSON.parse(saved));
      }
    } catch (e) {
      console.warn('[TPOSettingsModal] Error loading stored settings:', e);
    }
    return defaultSettings;
  }

  _saveSettings() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.settings));
    } catch (e) {
      console.warn('[TPOSettingsModal] Error saving settings to localStorage:', e);
    }
  }

  getSettings() {
    return Object.assign({}, this.settings);
  }

  _initElements() {
    this.modal = document.getElementById('tpoSettingsModal');
    this.closeBtn = document.getElementById('closeTpoSettingsBtn');
    this.saveBtn = document.getElementById('saveTpoSettingsBtn');
    this.gearBtn = document.getElementById('tpoSettingsGearBtn');

    // Form inputs
    this.profileTypeSelect = document.getElementById('cfgTpoProfileType');
    this.positionSelect = document.getElementById('cfgTpoPosition');
    this.densityModeSelect = document.getElementById('cfgTpoDensityMode');
    this.widthRange = document.getElementById('cfgTpoWidth');
    this.widthVal = document.getElementById('cfgTpoWidthVal');
    this.opacityRange = document.getElementById('cfgTpoOpacity');
    this.opacityVal = document.getElementById('cfgTpoOpacityVal');
    this.paletteSelect = document.getElementById('cfgTpoPalette');
    this.showLettersCheck = document.getElementById('cfgTpoShowLetters');
    this.showMarginStripCheck = document.getElementById('cfgTpoMarginStrip');
    this.showHoverTooltipCheck = document.getElementById('cfgTpoHoverTooltip');

    this.showPocCheck = document.getElementById('cfgTpoShowPoc');
    this.showVolPocCheck = document.getElementById('cfgTpoShowVolPoc');
    this.showVaCheck = document.getElementById('cfgTpoShowVa');
    this.vaPctRange = document.getElementById('cfgTpoVaPct');
    this.vaPctVal = document.getElementById('cfgTpoVaPctVal');
    this.showIbCheck = document.getElementById('cfgTpoShowIb');
    this.ibDurationSelect = document.getElementById('cfgTpoIbDuration');
    this.extendPocCheck = document.getElementById('cfgTpoExtendPoc');
    this.maxRaysInput = document.getElementById('cfgTpoMaxRays');
    this.singlePrintsCheck = document.getElementById('cfgTpoSinglePrints');
    this.poorExtremesCheck = document.getElementById('cfgTpoPoorExtremes');
    this.bracketMinSelect = document.getElementById('cfgTpoBracketMin');
  }

  _applySettingsToUI() {
    if (this.profileTypeSelect) this.profileTypeSelect.value = this.settings.profileType;
    if (this.positionSelect) this.positionSelect.value = this.settings.profilePosition;
    if (this.densityModeSelect) this.densityModeSelect.value = this.settings.densityMode || 'ADAPTIVE';

    if (this.widthRange) {
      const pct = Math.round(this.settings.profileWidthRatio * 100);
      this.widthRange.value = pct;
      if (this.widthVal) this.widthVal.textContent = `${pct}%`;
    }

    if (this.opacityRange) {
      const pct = Math.round(this.settings.profileOpacity * 100);
      this.opacityRange.value = pct;
      if (this.opacityVal) this.opacityVal.textContent = `${pct}%`;
    }

    if (this.paletteSelect) this.paletteSelect.value = this.settings.palette;
    if (this.showLettersCheck) this.showLettersCheck.checked = !!this.settings.showLetters;
    if (this.showMarginStripCheck) this.showMarginStripCheck.checked = !!this.settings.showCompactMarginStrip;
    if (this.showHoverTooltipCheck) this.showHoverTooltipCheck.checked = !!this.settings.showHoverTooltip;

    if (this.showPocCheck) this.showPocCheck.checked = !!this.settings.showPoc;
    if (this.showVolPocCheck) this.showVolPocCheck.checked = !!this.settings.showVolPoc;
    if (this.showVaCheck) this.showVaCheck.checked = !!this.settings.showValueArea;

    if (this.vaPctRange) {
      const pct = Math.round(this.settings.valueAreaPercent * 100);
      this.vaPctRange.value = pct;
      if (this.vaPctVal) this.vaPctVal.textContent = `${pct}%`;
    }

    if (this.showIbCheck) this.showIbCheck.checked = !!this.settings.showIb;
    if (this.ibDurationSelect) this.ibDurationSelect.value = String(this.settings.ibDuration);
    if (this.extendPocCheck) this.extendPocCheck.checked = !!this.settings.extendPocRays;
    if (this.maxRaysInput) this.maxRaysInput.value = String(this.settings.maxNakedPocRays || 3);
    if (this.singlePrintsCheck) this.singlePrintsCheck.checked = !!this.settings.showSinglePrints;
    if (this.poorExtremesCheck) this.poorExtremesCheck.checked = !!this.settings.showPoorExtremes;
    if (this.bracketMinSelect) this.bracketMinSelect.value = String(this.settings.bracketMinutes);
  }

  _readSettingsFromUI() {
    if (this.profileTypeSelect) this.settings.profileType = this.profileTypeSelect.value;
    if (this.positionSelect) this.settings.profilePosition = this.positionSelect.value;
    if (this.densityModeSelect) this.settings.densityMode = this.densityModeSelect.value;
    if (this.widthRange) this.settings.profileWidthRatio = parseInt(this.widthRange.value, 10) / 100;
    if (this.opacityRange) this.settings.profileOpacity = parseInt(this.opacityRange.value, 10) / 100;
    if (this.paletteSelect) this.settings.palette = this.paletteSelect.value;
    if (this.showLettersCheck) this.settings.showLetters = this.showLettersCheck.checked;
    if (this.showMarginStripCheck) this.settings.showCompactMarginStrip = this.showMarginStripCheck.checked;
    if (this.showHoverTooltipCheck) this.settings.showHoverTooltip = this.showHoverTooltipCheck.checked;

    if (this.showPocCheck) this.settings.showPoc = this.showPocCheck.checked;
    if (this.showVolPocCheck) this.settings.showVolPoc = this.showVolPocCheck.checked;
    if (this.showVaCheck) this.settings.showValueArea = this.showVaCheck.checked;
    if (this.vaPctRange) this.settings.valueAreaPercent = parseInt(this.vaPctRange.value, 10) / 100;

    if (this.showIbCheck) this.settings.showIb = this.showIbCheck.checked;
    if (this.ibDurationSelect) this.settings.ibDuration = parseInt(this.ibDurationSelect.value, 10);
    if (this.extendPocCheck) this.settings.extendPocRays = this.extendPocCheck.checked;
    if (this.maxRaysInput) this.settings.maxNakedPocRays = parseInt(this.maxRaysInput.value, 10) || 3;
    if (this.singlePrintsCheck) this.settings.showSinglePrints = this.singlePrintsCheck.checked;
    if (this.poorExtremesCheck) this.settings.showPoorExtremes = this.poorExtremesCheck.checked;
    if (this.bracketMinSelect) this.settings.bracketMinutes = parseInt(this.bracketMinSelect.value, 10);
  }

  _bindEvents() {
    if (this.gearBtn) {
      this.gearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.open();
      });
    }

    if (this.closeBtn) {
      this.closeBtn.addEventListener('click', () => this.close());
    }

    if (this.modal) {
      this.modal.addEventListener('click', (e) => {
        if (e.target === this.modal) this.close();
      });
    }

    // Dynamic slider preview labels
    if (this.widthRange && this.widthVal) {
      this.widthRange.addEventListener('input', () => {
        this.widthVal.textContent = `${this.widthRange.value}%`;
      });
    }

    if (this.opacityRange && this.opacityVal) {
      this.opacityRange.addEventListener('input', () => {
        this.opacityVal.textContent = `${this.opacityRange.value}%`;
      });
    }

    if (this.vaPctRange && this.vaPctVal) {
      this.vaPctRange.addEventListener('input', () => {
        this.vaPctVal.textContent = `${this.vaPctRange.value}%`;
      });
    }

    if (this.saveBtn) {
      this.saveBtn.addEventListener('click', () => {
        this._readSettingsFromUI();
        this._saveSettings();
        if (typeof this.onSettingsChange === 'function') {
          this.onSettingsChange(this.getSettings());
        }
        this.close();
      });
    }
  }

  open() {
    this._applySettingsToUI();
    if (this.modal) {
      this.modal.classList.remove('hidden');
    }
  }

  close() {
    if (this.modal) {
      this.modal.classList.add('hidden');
    }
  }
}
