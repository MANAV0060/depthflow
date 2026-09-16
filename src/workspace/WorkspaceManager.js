/**
 * WorkspaceManager.js
 * High-Performance Multi-Panel Workspace Orchestrator for Depthflow.
 * 
 * Supports:
 * - Layouts: SINGLE (1 panel), DUAL_H (2 side-by-side), DUAL_V (2 stacked), TRIPLE (1 left + 2 right), QUAD (2x2 grid)
 * - Draggable vertical & horizontal boundary splitters with bounds clamping (min 15% / 150px)
 * - Add Panel, Remove Panel (with minimum 1 panel guard), Focus/Maximize panel
 * - Panel-specific configuration isolation (symbol, timeframe, chart mode)
 * - Layout state persistence to localStorage ('depthflow_workspace_state')
 */

import { ChartPanel } from './ChartPanel.js';

export const WorkspaceLayout = {
  SINGLE: 'SINGLE',
  DUAL_H: 'DUAL_H',
  DUAL_V: 'DUAL_V',
  TRIPLE: 'TRIPLE',
  QUAD: 'QUAD'
};

const STORAGE_KEY = 'depthflow_workspace_state';

export class WorkspaceManager {
  constructor({ container, marketDataManager, onActivePanelChange = null, onActivePanelCvdChange = null }) {
    this.container = (typeof container === 'string') ? document.getElementById(container) : container;
    this.marketDataManager = marketDataManager;
    this.onActivePanelChange = onActivePanelChange;
    this.onActivePanelCvdChange = onActivePanelCvdChange;

    this.panels = new Map(); // id -> ChartPanel
    this.activePanelId = null;
    this.maximizedPanelId = null;
    this.layout = WorkspaceLayout.SINGLE;
    this.splitRatios = {
      h: 0.5, // horizontal ratio (left column vs right column)
      v: 0.5, // vertical ratio (top row vs bottom row)
      vRight: 0.5 // for TRIPLE right-column split
    };

    this.tpoSettings = null;
    this.theme = 'DARK';

    this._resizeObserver = null;
    this._initContainer();
  }

  _initContainer() {
    if (!this.container) return;
    this.container.classList.add('workspace-container');

    // Resize observer to handle container size changes smoothly
    if (window.ResizeObserver) {
      this._resizeObserver = new ResizeObserver(() => {
        this.resize();
      });
      this._resizeObserver.observe(this.container);
    }
  }

  init(defaultConfig = null) {
    const saved = this._loadFromStorage();
    if (saved && saved.panels && saved.panels.length > 0) {
      this._restoreWorkspace(saved);
    } else {
      // Initialize with single default panel
      const cfg = defaultConfig || {
        id: 'panel-1',
        symbol: 'EUR/USD',
        timeframeStr: '1m',
        timeframeMs: 60000,
        chartMode: 'FOOTPRINT',
        footprintStyle: 'PROFILE'
      };
      this.addPanel(cfg, false);
      this.setLayout(WorkspaceLayout.SINGLE, false);
      this.saveState();
    }
  }

  addPanel(config = {}, save = true, render = true) {
    if (this.panels.size >= 4) {
      console.warn('[WorkspaceManager] Maximum 4 panels supported in V1');
      return null;
    }

    const panelId = config.id || `panel-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const isMain = config.isMainPanel !== undefined ? config.isMainPanel : (this.panels.size === 0 || panelId === 'panel-1');
    const panel = new ChartPanel({
      id: panelId,
      isMainPanel: isMain,
      symbol: config.symbol || (this.getActivePanel() ? this.getActivePanel().symbol : 'EUR/USD'),
      timeframeStr: config.timeframeStr || '1m',
      timeframeMs: config.timeframeMs || 60000,
      chartMode: config.chartMode || 'FOOTPRINT',
      footprintStyle: config.footprintStyle || 'PROFILE',
      theme: this.theme,
      subPanes: config.subPanes,
      marketDataManager: this.marketDataManager,
      tpoSettings: this.tpoSettings,
      onAction: (action, payload) => this._handlePanelAction(action, payload)
    });

    this.panels.set(panelId, panel);

    // Auto-adjust layout based on panel count if not explicitly set
    if (save) {
      if (this.panels.size === 1) this.layout = WorkspaceLayout.SINGLE;
      else if (this.panels.size === 2) this.layout = WorkspaceLayout.DUAL_H;
      else if (this.panels.size === 3) this.layout = WorkspaceLayout.TRIPLE;
      else if (this.panels.size === 4) this.layout = WorkspaceLayout.QUAD;
    }

    this.setActivePanel(panelId, false);
    if (render) {
      this._renderLayout();
    }

    if (save) {
      this.saveState();
    }

    return panel;
  }

  removePanel(panelId, save = true) {
    if (this.panels.size <= 1) {
      console.warn('[WorkspaceManager] Cannot remove the last remaining panel');
      return;
    }

    const panel = this.panels.get(panelId);
    if (!panel) return;

    panel.destroy();
    this.panels.delete(panelId);

    if (this.maximizedPanelId === panelId) {
      this.maximizedPanelId = null;
    }

    // Auto-adjust layout down
    if (this.panels.size === 1) this.layout = WorkspaceLayout.SINGLE;
    else if (this.panels.size === 2) this.layout = WorkspaceLayout.DUAL_H;
    else if (this.panels.size === 3) this.layout = WorkspaceLayout.TRIPLE;

    // Reassign active panel if needed
    if (this.activePanelId === panelId) {
      const firstId = this.panels.keys().next().value;
      this.setActivePanel(firstId, false);
    }

    this._renderLayout();

    if (save) {
      this.saveState();
    }
  }

  setLayout(layout, save = true) {
    if (!Object.values(WorkspaceLayout).includes(layout)) return;
    this.layout = layout;
    this.maximizedPanelId = null;

    // Ensure we have enough panels for the requested layout
    const required = (layout === WorkspaceLayout.SINGLE) ? 1 : ((layout === WorkspaceLayout.DUAL_H || layout === WorkspaceLayout.DUAL_V) ? 2 : ((layout === WorkspaceLayout.TRIPLE) ? 3 : 4));
    
    while (this.panels.size < required) {
      this.addPanel({}, false);
    }

    this._renderLayout();

    if (save) {
      this.saveState();
    }
  }

  setActivePanel(panelId, notify = true) {
    if (!this.panels.has(panelId)) return;
    this.activePanelId = panelId;

    for (const [id, panel] of this.panels) {
      panel.setActive(id === panelId);
    }

    this._syncMainPanel();

    if (notify && typeof this.onActivePanelChange === 'function') {
      const activePanel = this.panels.get(panelId);
      this.onActivePanelChange(activePanel);
    }
  }

  getActivePanel() {
    return this.panels.get(this.activePanelId) || this.panels.values().next().value || null;
  }

  getMainPanel() {
    // 1. Priority: If the currently active panel is in FOOTPRINT mode, it is the Main Chart
    const activePanel = this.panels.get(this.activePanelId);
    if (activePanel && activePanel.chartMode === 'FOOTPRINT') {
      return activePanel;
    }

    // 2. Otherwise, find any open panel that is in FOOTPRINT mode
    for (const panel of this.panels.values()) {
      if (panel.chartMode === 'FOOTPRINT') {
        return panel;
      }
    }

    // 3. Fallback: marked isMainPanel, or active panel, or first panel
    for (const panel of this.panels.values()) {
      if (panel.isMainPanel) return panel;
    }
    return activePanel || this.panels.values().next().value || null;
  }

  getMainPanelId() {
    const main = this.getMainPanel();
    return main ? main.id : null;
  }

  _syncMainPanel() {
    const mainPanel = this.getMainPanel();
    if (!mainPanel) return;

    for (const panel of this.panels.values()) {
      const isMain = (panel.id === mainPanel.id);
      if (typeof panel.setMainPanel === 'function') {
        panel.setMainPanel(isMain);
      }
    }

    if (typeof this.onActivePanelCvdChange === 'function' && mainPanel.cvdRecords) {
      this.onActivePanelCvdChange('cvdLoaded', {
        panelId: mainPanel.id,
        records: mainPanel.cvdRecords,
        lastCvd: mainPanel.lastCvd || 0
      });
    }
  }

  toggleMaximizePanel(panelId) {
    if (this.maximizedPanelId === panelId) {
      this.maximizedPanelId = null;
    } else {
      this.maximizedPanelId = panelId;
    }

    for (const [id, panel] of this.panels) {
      panel.setMaximized(id === this.maximizedPanelId);
    }

    this._renderLayout();
  }

  setTheme(theme) {
    this.theme = theme;
    for (const panel of this.panels.values()) {
      panel.setTheme(theme);
    }
  }

  setTpoSettings(settings) {
    this.tpoSettings = settings;
    for (const panel of this.panels.values()) {
      panel.setTpoOptions(settings);
    }
  }

  setBigTradesVisible(visible) {
    for (const panel of this.panels.values()) {
      panel.setBigTradesVisible(visible);
    }
  }

  _renderLayout() {
    if (!this.container) return;
    this.container.innerHTML = '';

    const panelList = Array.from(this.panels.values());
    if (panelList.length === 0) return;

    // Disable close button if only 1 panel remains
    const isOnlyOne = panelList.length === 1;
    panelList.forEach(p => p.setCloseDisabled(isOnlyOne));

    // Handle Maximized Mode
    if (this.maximizedPanelId && this.panels.has(this.maximizedPanelId)) {
      const maxPanel = this.panels.get(this.maximizedPanelId);
      maxPanel.el.style.flex = '1 1 100%';
      maxPanel.el.style.width = '100%';
      maxPanel.el.style.height = '100%';
      this.container.appendChild(maxPanel.el);
      this.resize();
      return;
    }

    // Guard: determine effective layout based on available panels
    let effectiveLayout = this.layout;
    if (effectiveLayout === WorkspaceLayout.QUAD && panelList.length < 4) {
      effectiveLayout = panelList.length === 3 ? WorkspaceLayout.TRIPLE : (panelList.length === 2 ? WorkspaceLayout.DUAL_H : WorkspaceLayout.SINGLE);
    } else if (effectiveLayout === WorkspaceLayout.TRIPLE && panelList.length < 3) {
      effectiveLayout = panelList.length === 2 ? WorkspaceLayout.DUAL_H : WorkspaceLayout.SINGLE;
    } else if ((effectiveLayout === WorkspaceLayout.DUAL_H || effectiveLayout === WorkspaceLayout.DUAL_V) && panelList.length < 2) {
      effectiveLayout = WorkspaceLayout.SINGLE;
    }

    // Normal Layout Renderers
    switch (effectiveLayout) {
      case WorkspaceLayout.SINGLE:
        this._renderSingle(panelList[0]);
        break;

      case WorkspaceLayout.DUAL_H:
        this._renderDualH(panelList[0], panelList[1]);
        break;

      case WorkspaceLayout.DUAL_V:
        this._renderDualV(panelList[0], panelList[1]);
        break;

      case WorkspaceLayout.TRIPLE:
        this._renderTriple(panelList[0], panelList[1], panelList[2]);
        break;

      case WorkspaceLayout.QUAD:
        this._renderQuad(panelList[0], panelList[1], panelList[2], panelList[3]);
        break;

      default:
        this._renderSingle(panelList[0]);
        break;
    }

    this.resize();
  }

  _renderSingle(p1) {
    p1.el.style.flex = '1 1 100%';
    p1.el.style.width = '100%';
    p1.el.style.height = '100%';
    this.container.style.flexDirection = 'row';
    this.container.appendChild(p1.el);
  }

  _renderDualH(p1, p2) {
    this.container.style.flexDirection = 'row';

    const ratio = Math.max(0.15, Math.min(0.85, this.splitRatios.h));
    p1.el.style.flex = `0 0 ${ratio * 100}%`;
    p1.el.style.height = '100%';

    const splitter = this._createSplitter('V', (newRatio) => {
      this.splitRatios.h = newRatio;
      p1.el.style.flex = `0 0 ${newRatio * 100}%`;
      this.resize();
    });

    p2.el.style.flex = '1 1 0';
    p2.el.style.height = '100%';

    this.container.appendChild(p1.el);
    this.container.appendChild(splitter);
    this.container.appendChild(p2.el);
  }

  _renderDualV(p1, p2) {
    this.container.style.flexDirection = 'column';

    const ratio = Math.max(0.15, Math.min(0.85, this.splitRatios.v));
    p1.el.style.flex = `0 0 ${ratio * 100}%`;
    p1.el.style.width = '100%';

    const splitter = this._createSplitter('H', (newRatio) => {
      this.splitRatios.v = newRatio;
      p1.el.style.flex = `0 0 ${newRatio * 100}%`;
      this.resize();
    });

    p2.el.style.flex = '1 1 0';
    p2.el.style.width = '100%';

    this.container.appendChild(p1.el);
    this.container.appendChild(splitter);
    this.container.appendChild(p2.el);
  }

  _renderTriple(p1, p2, p3) {
    this.container.style.flexDirection = 'row';

    const ratioH = Math.max(0.15, Math.min(0.85, this.splitRatios.h));
    p1.el.style.flex = `0 0 ${ratioH * 100}%`;
    p1.el.style.height = '100%';

    const splitterV = this._createSplitter('V', (newRatio) => {
      this.splitRatios.h = newRatio;
      p1.el.style.flex = `0 0 ${newRatio * 100}%`;
      this.resize();
    });

    const rightCol = document.createElement('div');
    rightCol.className = 'workspace-sub-col';
    rightCol.style.display = 'flex';
    rightCol.style.flexDirection = 'column';
    rightCol.style.flex = '1 1 0';
    rightCol.style.height = '100%';
    rightCol.style.overflow = 'hidden';

    const ratioVRight = Math.max(0.15, Math.min(0.85, this.splitRatios.vRight));
    p2.el.style.flex = `0 0 ${ratioVRight * 100}%`;
    p2.el.style.width = '100%';

    const splitterRightH = this._createSplitter('H', (newRatio) => {
      this.splitRatios.vRight = newRatio;
      p2.el.style.flex = `0 0 ${newRatio * 100}%`;
      this.resize();
    }, rightCol);

    p3.el.style.flex = '1 1 0';
    p3.el.style.width = '100%';

    rightCol.appendChild(p2.el);
    rightCol.appendChild(splitterRightH);
    rightCol.appendChild(p3.el);

    this.container.appendChild(p1.el);
    this.container.appendChild(splitterV);
    this.container.appendChild(rightCol);
  }

  _renderQuad(p1, p2, p3, p4) {
    this.container.style.flexDirection = 'column';

    const topRow = document.createElement('div');
    topRow.className = 'workspace-sub-row';
    topRow.style.display = 'flex';
    topRow.style.flexDirection = 'row';
    topRow.style.width = '100%';
    topRow.style.overflow = 'hidden';

    const ratioV = Math.max(0.15, Math.min(0.85, this.splitRatios.v));
    topRow.style.flex = `0 0 ${ratioV * 100}%`;

    const ratioH = Math.max(0.15, Math.min(0.85, this.splitRatios.h));
    p1.el.style.flex = `0 0 ${ratioH * 100}%`;
    p1.el.style.height = '100%';

    const topSplitter = this._createSplitter('V', (newRatio) => {
      this.splitRatios.h = newRatio;
      p1.el.style.flex = `0 0 ${newRatio * 100}%`;
      if (p3) p3.el.style.flex = `0 0 ${newRatio * 100}%`;
      this.resize();
    }, topRow);

    p2.el.style.flex = '1 1 0';
    p2.el.style.height = '100%';

    topRow.appendChild(p1.el);
    topRow.appendChild(topSplitter);
    topRow.appendChild(p2.el);

    const midSplitterH = this._createSplitter('H', (newRatio) => {
      this.splitRatios.v = newRatio;
      topRow.style.flex = `0 0 ${newRatio * 100}%`;
      this.resize();
    });

    const botRow = document.createElement('div');
    botRow.className = 'workspace-sub-row';
    botRow.style.display = 'flex';
    botRow.style.flexDirection = 'row';
    botRow.style.flex = '1 1 0';
    botRow.style.width = '100%';
    botRow.style.overflow = 'hidden';

    p3.el.style.flex = `0 0 ${ratioH * 100}%`;
    p3.el.style.height = '100%';

    const botSplitter = this._createSplitter('V', (newRatio) => {
      this.splitRatios.h = newRatio;
      p1.el.style.flex = `0 0 ${newRatio * 100}%`;
      p3.el.style.flex = `0 0 ${newRatio * 100}%`;
      this.resize();
    }, botRow);

    p4.el.style.flex = '1 1 0';
    p4.el.style.height = '100%';

    botRow.appendChild(p3.el);
    botRow.appendChild(botSplitter);
    botRow.appendChild(p4.el);

    this.container.appendChild(topRow);
    this.container.appendChild(midSplitterH);
    this.container.appendChild(botRow);
  }

  _createSplitter(orientation, onDragCallback, parentContainer = null) {
    const isV = orientation === 'V';
    const splitter = document.createElement('div');
    splitter.className = isV ? 'workspace-splitter-v' : 'workspace-splitter-h';
    splitter.title = `Drag to adjust ${isV ? 'column' : 'row'} split (Double click to reset 50/50)`;

    const handle = document.createElement('div');
    handle.className = isV ? 'workspace-splitter-handle-v' : 'workspace-splitter-handle-h';
    splitter.appendChild(handle);

    let isDragging = false;

    splitter.addEventListener('mousedown', (e) => {
      e.preventDefault();
      isDragging = true;
      splitter.classList.add('dragging');
      document.body.style.cursor = isV ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';

      const targetParent = parentContainer || this.container;

      const onMouseMove = (ev) => {
        if (!isDragging) return;
        const rect = targetParent.getBoundingClientRect();
        let ratio;
        if (isV) {
          const x = ev.clientX - rect.left;
          const minW = 150;
          const maxW = rect.width - 150;
          const clamped = Math.max(minW, Math.min(maxW, x));
          ratio = clamped / rect.width;
        } else {
          const y = ev.clientY - rect.top;
          const minH = 120;
          const maxH = rect.height - 120;
          const clamped = Math.max(minH, Math.min(maxH, y));
          ratio = clamped / rect.height;
        }

        if (typeof onDragCallback === 'function') {
          onDragCallback(ratio);
        }
      };

      const onMouseUp = () => {
        if (isDragging) {
          isDragging = false;
          splitter.classList.remove('dragging');
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
          window.removeEventListener('mousemove', onMouseMove);
          window.removeEventListener('mouseup', onMouseUp);
          this.saveState();
          this.resize();
        }
      };

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    });

    // Double-click reset 50/50
    splitter.addEventListener('dblclick', () => {
      if (typeof onDragCallback === 'function') {
        onDragCallback(0.5);
      }
      this.saveState();
      this.resize();
    });

    return splitter;
  }

  resize() {
    requestAnimationFrame(() => {
      for (const panel of this.panels.values()) {
        panel.resize();
      }
    });
  }

  _handlePanelAction(action, payload) {
    switch (action) {
      case 'select':
        this.setActivePanel(payload.panelId);
        break;

      case 'close':
        this.removePanel(payload.panelId);
        break;

      case 'toggleMaximize':
        this.toggleMaximizePanel(payload.panelId);
        break;

      case 'cvdLoaded':
      case 'cvdUpdate':
        const mainPanelId = this.getMainPanelId();
        if (payload.panelId === mainPanelId && typeof this.onActivePanelCvdChange === 'function') {
          this.onActivePanelCvdChange(action, payload);
        }
        break;

      case 'chartModeChange':
        this._syncMainPanel();
        this.saveState();
        if (payload.panelId === this.activePanelId && typeof this.onActivePanelChange === 'function') {
          const activePanel = this.panels.get(payload.panelId);
          this.onActivePanelChange(activePanel);
        }
        break;

      case 'symbolChange':
      case 'timeframeChange':
      case 'footprintStyleChange':
      case 'subPaneChange':
        this.saveState();
        if (payload.panelId === this.activePanelId && typeof this.onActivePanelChange === 'function') {
          const activePanel = this.panels.get(payload.panelId);
          this.onActivePanelChange(activePanel);
        }
        break;
    }
  }

  saveState() {
    try {
      const state = {
        layout: this.layout,
        splitRatios: this.splitRatios,
        activePanelId: this.activePanelId,
        panels: Array.from(this.panels.values()).map(p => p.getConfig())
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('[WorkspaceManager] Error saving workspace state:', e);
    }
  }

  _loadFromStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return null;
  }

  _restoreWorkspace(savedState) {
    this.layout = savedState.layout || WorkspaceLayout.SINGLE;
    if (savedState.splitRatios) {
      this.splitRatios = { ...this.splitRatios, ...savedState.splitRatios };
    }

    const savedPanels = savedState.panels || [];
    for (const pCfg of savedPanels) {
      this.addPanel(pCfg, false, false);
    }

    if (savedState.activePanelId && this.panels.has(savedState.activePanelId)) {
      this.setActivePanel(savedState.activePanelId, false);
    } else {
      const firstId = this.panels.keys().next().value;
      if (firstId) this.setActivePanel(firstId, false);
    }

    this._renderLayout();
  }

  destroy() {
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    for (const panel of this.panels.values()) {
      panel.destroy();
    }
    this.panels.clear();
  }
}
