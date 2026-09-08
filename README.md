<div align="center">

# ⚡ DEPTHFLOW
### Real-Time Institutional Order Flow & Footprint Platform

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Platform: Web](https://img.shields.io/badge/Platform-Web%20%7C%20HTML5%20%7C%20Canvas-green.svg)]()
[![Backend: Python](https://img.shields.io/badge/Backend-Python%203.10%2B%20%7C%20WebSockets-yellow.svg)]()
[![Integration: MetaTrader 5](https://img.shields.io/badge/Integration-MetaTrader%205%20%28MT5%29-blue.svg)]()
[![Performance: 60 FPS](https://img.shields.io/badge/Performance-60%20FPS%20Native%20Canvas-brightgreen.svg)]()

**Depthflow** is a high-performance, institutional-grade order flow and footprint analysis workstation designed to bring institutional-level market transparency to everyday retail traders. Built on native HTML5 Canvas, TradingView Lightweight Charts, and a direct MetaTrader 5 (MT5) bridge, Depthflow delivers real-time market depth with zero subscription paywalls.

</div>

---

## 🌟 Key Features

### 🔬 1. Native Bid × Ask Footprint Engine
- **Micro Order Flow Inside Candles**: View precise executed volume at every individual price tick.
- **3 Analytical Footprint Modes**:
  - **Bid × Ask Profile**: Diagonal bid/ask volume comparison.
  - **Net Delta**: Colored bar delta per tick level.
  - **Cluster Volume**: Volume distribution histogram within candle bodies.
- **Point of Control (POC)**: Golden POC bands highlighting maximum transacted volume at each price level.

### ⚖️ 2. Diagonal Imbalance & Absorption Detection
- Automatic real-time calculation of buy/sell aggressive volume imbalances (300%+ ratio).
- Visual absorption markers highlighting where institutional liquidity stopped market momentum.

### 🐋 3. Big Trades & Whale Activity Radar
- Dynamic execution bubbles identifying unusually large block orders hitting the tape.
- Interactive hover and click inspection cards showing execution price, aggressor side, total volume, and timestamp.

### 🚀 4. 3-Tier Dynamic Level-of-Detail (LOD)
- **Zoomed In**: Rich footprint ladder with micro-volume numbers and POC.
- **Mid Zoom**: Streamlined volume silhouette profile.
- **Zoomed Out (Macro)**: Fluid, ultra-fast TradingView candlesticks with POC dots and delta glow. Zero text collage or stutter at 60 FPS.

### ◫ 5. Interactive Dual Split-Screen with Draggable Divider
- View the macro candlestick trend on the left and the detailed footprint ladder on the right.
- **Custom Area Resizing**: Drag the vertical divider bar left or right to allocate as much area to either view as you need.
- **Double-Click Reset**: Double-click the splitter handle to restore a balanced 50/50 view.
- **Single Mode Toggle**: One-click toggle back to 100% full-screen footprint view.

### 📊 6. Institutional Analytics Suite
- **Cumulative Volume Delta (CVD)**: Live sub-pane tracking net buyer vs. seller commitment.
- **Sierra Chart / ATAS Summary Footer**: Aligned tabular metrics (Delta, Max Delta, Min Delta, Total Volume, Delta %, Session CVD, POC, HL Range).
- **Session Volume Profile**: Right-side panel with Value Area High (VAH), Value Area Low (VAL), and developing POC.
- **TradingView Red-List Watchlist**: Live price ticks for Forex majors, Gold (XAU/USD), and Crypto (BTC/USD, ETH/USD).

---

## 🏗️ Architecture & Technology Stack

| Layer | Technology | Purpose |
| :--- | :--- | :--- |
| **Front-End UI** | HTML5, CSS3, ES6 Modules | Modern TradingView-inspired dark/light theme |
| **Chart Core** | Lightweight Charts (v4.2.1) | Native GPU-accelerated canvas chart camera |
| **Custom Plugins** | Native Canvas Series Plugin | Custom Footprint & Big Trades rendering |
| **Market Data Bridge** | Python 3, `websockets`, `asyncio` | Real-time tick streaming & chunk pagination |
| **Broker Gateway** | MetaTrader 5 Python API | Direct connection to live MT5 broker terminal |
| **Persistence** | SQLite with WAL mode | Historical candlestick & footprint persistence |

---

## 🚀 Quick Start Guide

### Prerequisites
1. **Python 3.10+** installed on your system.
2. **MetaTrader 5 (MT5)** desktop terminal installed and logged into your broker account.
3. Modern Web Browser (Chrome, Brave, Edge, or Firefox).

---

### Step 1: Clone the Repository
```bash
git clone https://github.com/MANAV0060/depthflow.git
cd depthflow
```

---

### Step 2: Install Python Bridge Dependencies
```bash
pip install websockets MetaTrader5
```

---

### Step 3: Start the MT5 WebSocket Bridge
Ensure your MetaTrader 5 terminal is running and logged in, then launch the bridge:

```bash
python tools/mt5_bridge.py
```

*The bridge will connect to MT5, initialize `data/depthflow_history.db` in SQLite WAL mode, and start streaming live broker ticks on `ws://localhost:5555`.*

---

### Step 4: Launch the Web Application
Open a new terminal in the `depthflow` directory and serve the static files:

**Using Python:**
```bash
python -m http.server 8080
```

*Or using Node.js / npx:*
```bash
npx serve . -p 8080
```

---

### Step 5: Open Depthflow in Your Browser
Navigate to:
```
http://localhost:8080/
```

You will see the green **🟢 CONNECTED** status badge in the top right header, streaming live institutional order flow!

---

## 📖 How to Use Depthflow

### 1. Navigation & Quick Switcher
- **Symbol Dropdown**: Select between `EUR/USD`, `GBP/USD`, `USD/JPY`, `XAU/USD`, `BTC/USD`, and `ETH/USD`.
- **Timeframe Pills**: Instantly toggle between `1m`, `5m`, `15m`, `30m`, `1h`, `4h`, and `D`.
- **Theme Toggle**: Switch between sleek institutional Dark Mode (`🌙 Theme`) and crisp Light Mode.

### 2. Footprint Modes
Use the dropdown in the HUD bar:
- `Bid × Ask`: Traditional footprint showing buying volume vs selling volume diagonally.
- `Net Delta`: Highlights whether buyers or sellers dominated that tick level.
- `Cluster Vol`: Shows total transacted volume per price cell.

### 3. Big Trades Bubbles
- Click the **`● Big Trades`** toggle in the header to display or hide whale execution bubbles.
- Hover or click on any bubble to inspect institutional execution details.

### 4. Resizable Dual Split View
- Click **`◫ Split`** in the top navigation to open the Macro Overview on the left and Footprint on the right.
- Hover over the divider between the two charts and **drag left or right** to allocate as much space as you need.
- **Double-click** the divider bar to reset the split ratio to 50/50.
- Click **`⬛ Single`** to return to full-screen footprint mode.

---

## 📂 Project Directory Structure

```
depthflow/
├── data/                       # Local historical SQLite database (WAL mode)
├── lib/
│   └── lightweight-charts...   # TradingView Lightweight Charts library
├── mql5/
│   └── Odeerflow_Footprint.mq5 # Optional native MQL5 custom indicator
├── src/
│   ├── analytics/              # Order flow, delta, absorption, and pattern engines
│   ├── chart/                  # ChartEngine, Footprint & Volume Profile renderers
│   ├── data/                   # WebSocket feeds, MT5 adapter, and provider registry
│   ├── ui/                     # UI components, modals, and diagnostics drawer
│   └── app.js                  # Main application orchestrator
├── tools/
│   ├── mt5_bridge.py           # Production MT5 WebSocket bridge server
│   ├── storage.py              # SQLite persistent WAL storage engine
│   └── liquidation_engine.py   # Heatmap and sweep liquidation tracking
├── index.html                  # Main application interface
├── styles.css                  # Institutional dark/light styling system
├── .gitignore                  # Git exclusions
└── README.md                   # Project documentation
```

---

## 🤝 Contributing

Contributions from the trading and quantitative development community are welcome!
1. Fork the repository (`https://github.com/MANAV0060/depthflow`).
2. Create your feature branch (`git checkout -b feature/awesome-feature`).
3. Commit your changes (`git commit -m 'Add awesome order flow feature'`).
4. Push to the branch (`git push origin feature/awesome-feature`).
5. Open a Pull Request.

---

## 📄 License

This project is licensed under the **MIT License** — free for personal and commercial use.

---

<div align="center">
  <sub>Built with ❤️ for the global trading community. Empowering every trader with institutional depth.</sub>
</div>
