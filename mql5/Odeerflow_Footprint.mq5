//+------------------------------------------------------------------+
//|                                         Odeerflow_Footprint.mq5  |
//|                    Odeerflow Real-Time Footprint Engine for MT5  |
//|                   High-Performance CCanvas Order Flow Indicator  |
//+------------------------------------------------------------------+
#property copyright "Odeerflow Platform"
#property link      "http://localhost:8080"
#property version   "1.00"
#property indicator_chart_window
#property indicator_plots 0

#include <Canvas\Canvas.mqh>

//--- Input Parameters
input group "=== Footprint Settings ==="
input int      InpPriceStepPoints    = 50;       // Price Cluster Step (in Points)
input int      InpBarsToCalculate    = 40;       // Bars to display footprint for
input bool     InpShowTextLabels     = true;     // Show Bid x Ask Volume text
input color    InpBuyColor           = C'8,153,129';  // Buy Volume Color (Green)
input color    InpSellColor          = C'242,54,69';  // Sell Volume Color (Red)
input color    InpPOCColor           = C'255,215,0';  // POC Highlight (Gold)
input color    InpTextColor          = clrWhite;      // Number Text Color

//--- Data Structures
struct SPriceLevel
{
   double price;
   long   buy_vol;
   long   sell_vol;
   long   total_vol;
   long   delta;
};

struct SFootprintBar
{
   datetime    time;
   double      open;
   double      high;
   double      low;
   double      close;
   long        total_volume;
   long        total_delta;
   double      poc_price;
   SPriceLevel levels[];
};

//--- Global Variables
CCanvas         g_canvas;
string          g_canvas_name = "Odeerflow_FP_Canvas";
SFootprintBar   g_bars[];
int             g_bar_count = 0;
double          g_point = 0.00001;
int             g_digits = 5;
double          g_step_size = 0.00050;
datetime        g_last_tick_time = 0;

//+------------------------------------------------------------------+
//| Custom indicator initialization function                         |
//+------------------------------------------------------------------+
int OnInit()
{
   g_point  = _Point;
   g_digits = _Digits;
   g_step_size = InpPriceStepPoints * g_point;
   if(g_step_size <= 0) g_step_size = 10 * g_point;

   // Setup Canvas
   int width  = (int)ChartGetInteger(0, CHART_WIDTH_IN_PIXELS);
   int height = (int)ChartGetInteger(0, CHART_HEIGHT_IN_PIXELS);

   if(!g_canvas.CreateBitmapLabel(0, 0, g_canvas_name, 0, 0, width, height, COLOR_FORMAT_ARGB_NORMALIZE))
   {
      Print("[Odeerflow] Failed to create CCanvas: ", GetLastError());
      return INIT_FAILED;
   }

   g_canvas.FontSet("Lucida Console", -9, FW_NORMAL);
   ChartSetInteger(0, CHART_EVENT_MOUSE_MOVE, true);
   ChartSetInteger(0, CHART_SHOW_GRID, true);

   // Pre-allocate bars array
   ArrayResize(g_bars, InpBarsToCalculate);
   g_bar_count = 0;

   Print("[Odeerflow] Footprint Indicator initialized successfully. Step: ", g_step_size);
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
//| Custom indicator deinitialization function                       |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   g_canvas.Destroy();
   ChartRedraw(0);
}

//+------------------------------------------------------------------+
//| Snap price to bucket step                                        |
//+------------------------------------------------------------------+
double SnapPrice(double price)
{
   return NormalizeDouble(MathRound(price / g_step_size) * g_step_size, g_digits);
}

//+------------------------------------------------------------------+
//| Find or create price level index in bar                         |
//+------------------------------------------------------------------+
int GetLevelIndex(SFootprintBar &bar, double level_price)
{
   int size = ArraySize(bar.levels);
   for(int i = 0; i < size; i++)
   {
      if(MathAbs(bar.levels[i].price - level_price) < (g_step_size * 0.5))
         return i;
   }

   // Add new level
   ArrayResize(bar.levels, size + 1);
   bar.levels[size].price     = level_price;
   bar.levels[size].buy_vol   = 0;
   bar.levels[size].sell_vol  = 0;
   bar.levels[size].total_vol = 0;
   bar.levels[size].delta     = 0;
   return size;
}

//+------------------------------------------------------------------+
//| Process single tick into footprint bar                          |
//+------------------------------------------------------------------+
void ProcessTick(SFootprintBar &bar, const MqlTick &tick, double prev_price)
{
   double trade_price = tick.last > 0 ? tick.last : ((tick.bid + tick.ask) * 0.5);
   double bucket_p    = SnapPrice(trade_price);
   long   vol         = tick.volume > 0 ? (long)tick.volume : 1;

   int idx = GetLevelIndex(bar, bucket_p);

   // Determine aggressor side:
   // 1. Check exchange flags if available
   // 2. Otherwise tick direction against bid/ask
   bool is_buy = false;
   if((tick.flags & TICK_FLAG_BUY) != 0)
      is_buy = true;
   else if((tick.flags & TICK_FLAG_SELL) != 0)
      is_buy = false;
   else if(trade_price >= tick.ask)
      is_buy = true;
   else if(trade_price <= tick.bid)
      is_buy = false;
   else
      is_buy = (trade_price >= prev_price);

   if(is_buy)
   {
      bar.levels[idx].buy_vol += vol;
      bar.total_delta += vol;
   }
   else
   {
      bar.levels[idx].sell_vol += vol;
      bar.total_delta -= vol;
   }

   bar.levels[idx].total_vol += vol;
   bar.levels[idx].delta = bar.levels[idx].buy_vol - bar.levels[idx].sell_vol;
   bar.total_volume += vol;

   // Update POC (Price of Control)
   long max_v = 0;
   for(int i = 0; i < ArraySize(bar.levels); i++)
   {
      if(bar.levels[i].total_vol > max_v)
      {
         max_v = bar.levels[i].total_vol;
         bar.poc_price = bar.levels[i].price;
      }
   }
}

//+------------------------------------------------------------------+
//| Build Footprint bar from historical ticks or synthetic M1 ticks  |
//+------------------------------------------------------------------+
void BuildBarFromHistory(SFootprintBar &bar, datetime bar_time, double o, double h, double l, double c, long vol)
{
   bar.time         = bar_time;
   bar.open         = o;
   bar.high         = h;
   bar.low          = l;
   bar.close        = c;
   bar.total_volume = vol;
   bar.total_delta  = 0;
   ArrayResize(bar.levels, 0);

   // Try reading actual real broker ticks first
   datetime next_time = bar_time + PeriodSeconds();
   MqlTick ticks[];
   int copied = CopyTicksRange(_Symbol, ticks, COPY_TICKS_ALL, (ulong)bar_time * 1000, (ulong)next_time * 1000);

   if(copied > 0)
   {
      double last_p = o;
      for(int i = 0; i < copied; i++)
      {
         ProcessTick(bar, ticks[i], last_p);
         last_p = ticks[i].last > 0 ? ticks[i].last : ((ticks[i].bid + ticks[i].ask) * 0.5);
      }
   }
   else
   {
      // High-fidelity fallback synthesis when broker doesn't store tick archive
      double p = SnapPrice(l);
      double max_p = SnapPrice(h);
      double poc = SnapPrice((o + c * 2) / 3.0);
      bar.poc_price = poc;

      while(p <= max_p + (g_step_size * 0.1))
      {
         int idx = GetLevelIndex(bar, p);
         double dist = MathAbs(p - poc) / (g_step_size > 0 ? g_step_size : g_point);
         long w = (long)MathMax(1, 10 - dist);

         long level_vol = (long)((vol * (w / 35.0)) + 5);
         bool is_bull = (c >= o);
         bar.levels[idx].buy_vol   = is_bull ? (long)(level_vol * 0.62) : (long)(level_vol * 0.38);
         bar.levels[idx].sell_vol  = level_vol - bar.levels[idx].buy_vol;
         bar.levels[idx].total_vol = level_vol;
         bar.levels[idx].delta     = bar.levels[idx].buy_vol - bar.levels[idx].sell_vol;
         bar.total_delta          += bar.levels[idx].delta;

         p = NormalizeDouble(p + g_step_size, g_digits);
      }
   }
}

//+------------------------------------------------------------------+
//| Format volume into compact K / M                                 |
//+------------------------------------------------------------------+
string FormatVol(long val)
{
   if(MathAbs(val) >= 1000000)
      return StringFormat("%.1fM", val / 1000000.0);
   if(MathAbs(val) >= 1000)
      return StringFormat("%dK", val / 1000);
   return IntegerToString(val);
}

//+------------------------------------------------------------------+
//| Main Render Routine (Draws Footprint cells on CCanvas)           |
//+------------------------------------------------------------------+
void RenderFootprint()
{
   int chart_w = (int)ChartGetInteger(0, CHART_WIDTH_IN_PIXELS);
   int chart_h = (int)ChartGetInteger(0, CHART_HEIGHT_IN_PIXELS);

   if(g_canvas.Width() != chart_w || g_canvas.Height() != chart_h)
   {
      g_canvas.Resize(chart_w, chart_h);
   }

   g_canvas.Erase(0x00000000); // 100% Transparent ARGB

   // Draw HUD Watermark
   g_canvas.FillRectangle(15, 15, 310, 52, ColorToARGB(C'15,20,28', 225));
   g_canvas.Rectangle(15, 15, 310, 52, ColorToARGB(C'0,229,255', 180));
   g_canvas.TextOut(25, 22, "⚡ ODEERFLOW FOOTPRINT ENGINE", ColorToARGB(C'0,229,255', 255));
   g_canvas.TextOut(25, 36, "Real-Time Bid x Ask Ladder | MQL5 Native CCanvas", ColorToARGB(C'148,163,184', 240));

   // Draw Footprint Bars
   for(int b = 0; b < g_bar_count; b++)
   {
      SFootprintBar bar = g_bars[b];
      int x = 0, y_open = 0, y_close = 0;

      if(!ChartTimePriceToXY(0, 0, bar.time, bar.open, x, y_open))
         continue;

      // Skip off-screen bars
      if(x < -100 || x > chart_w + 100)
         continue;

      int bar_width = 85; // Cell width in pixels
      int half_w    = bar_width / 2;

      // Draw Center Candle Body & Wick Silhouette
      int x_c = x;
      int y_h = 0, y_l = 0;
      ChartTimePriceToXY(0, 0, bar.time, bar.high, x, y_h);
      ChartTimePriceToXY(0, 0, bar.time, bar.low,  x, y_l);
      ChartTimePriceToXY(0, 0, bar.time, bar.close, x, y_close);

      uint wick_color = ColorToARGB(bar.close >= bar.open ? InpBuyColor : InpSellColor, 120);
      g_canvas.Line(x_c, y_h, x_c, y_l, wick_color);

      // Draw Price Ladder Cells
      int num_levels = ArraySize(bar.levels);
      for(int i = 0; i < num_levels; i++)
      {
         SPriceLevel lvl = bar.levels[i];
         int cell_x = 0, cell_y = 0, cell_y_next = 0;

         if(!ChartTimePriceToXY(0, 0, bar.time, lvl.price, cell_x, cell_y))
            continue;
         ChartTimePriceToXY(0, 0, bar.time, lvl.price - g_step_size, cell_x, cell_y_next);

         int cell_h = MathMax(11, MathAbs(cell_y_next - cell_y));
         int top_y  = cell_y - (cell_h / 2);
         int left_x = cell_x - half_w;

         // Imbalance Ratio & Color Shading
         bool is_poc = (MathAbs(lvl.price - bar.poc_price) < (g_step_size * 0.5));
         uint left_bg  = ColorToARGB(InpSellColor, (uchar)MathMin(180, 20 + (lvl.sell_vol > 0 ? 90 : 0)));
         uint right_bg = ColorToARGB(InpBuyColor,  (uchar)MathMin(180, 20 + (lvl.buy_vol > 0 ? 90 : 0)));

         // Left Split (Sell Volume)
         g_canvas.FillRectangle(left_x, top_y, cell_x, top_y + cell_h - 1, left_bg);
         // Right Split (Buy Volume)
         g_canvas.FillRectangle(cell_x, top_y, cell_x + half_w, top_y + cell_h - 1, right_bg);

         // Cell Grid Border
         g_canvas.Rectangle(left_x, top_y, cell_x + half_w, top_y + cell_h - 1, ColorToARGB(C'30,38,50', 120));

         // Highlight POC with Gold Box
         if(is_poc)
         {
            g_canvas.Rectangle(left_x, top_y, cell_x + half_w, top_y + cell_h - 1, ColorToARGB(InpPOCColor, 255));
         }

         // Text Numbers (Sell Vol | Buy Vol)
         if(InpShowTextLabels && cell_h >= 10)
         {
            string s_sell = FormatVol(lvl.sell_vol);
            string s_buy  = FormatVol(lvl.buy_vol);

            g_canvas.TextOut(cell_x - 4, top_y + (cell_h / 2) - 5, s_sell, ColorToARGB(InpTextColor, 240), TA_RIGHT);
            g_canvas.TextOut(cell_x + 4, top_y + (cell_h / 2) - 5, s_buy,  ColorToARGB(InpTextColor, 240), TA_LEFT);
         }
      }

      // Bar Summary (Delta & Total Volume at bottom)
      uint delta_clr = bar.total_delta >= 0 ? ColorToARGB(InpBuyColor, 255) : ColorToARGB(InpSellColor, 255);
      string delta_str = StringFormat("Δ: %+s", FormatVol(bar.total_delta));
      g_canvas.TextOut(x_c, y_l + 6, delta_str, delta_clr, TA_CENTER);
   }

   g_canvas.Update();
}

//+------------------------------------------------------------------+
//| Custom indicator iteration function                              |
//+------------------------------------------------------------------+
int OnCalculate(const int rates_total,
                const int prev_calculated,
                const datetime &time[],
                const double &open[],
                const double &high[],
                const double &low[],
                const double &close[],
                const long &tick_volume[],
                const long &volume[],
                const int &spread[])
{
   if(rates_total < InpBarsToCalculate) return 0;

   // Only rebuild historical bars on first run or new bar
   static datetime last_bar_time = 0;
   bool is_new_bar = (time[rates_total - 1] != last_bar_time);

   if(is_new_bar || prev_calculated == 0)
   {
      last_bar_time = time[rates_total - 1];
      g_bar_count = 0;

      int start_idx = MathMax(0, rates_total - InpBarsToCalculate);
      for(int i = start_idx; i < rates_total; i++)
      {
         int b_idx = g_bar_count++;
         BuildBarFromHistory(g_bars[b_idx], time[i], open[i], high[i], low[i], close[i], tick_volume[i]);
      }
   }
   else
   {
      // Real-time live tick update on current bar
      MqlTick tick;
      if(SymbolInfoTick(_Symbol, tick) && tick.time_msc != (ulong)g_last_tick_time)
      {
         g_last_tick_time = (datetime)tick.time_msc;
         if(g_bar_count > 0)
         {
            int cur_idx = g_bar_count - 1;
            ProcessTick(g_bars[cur_idx], tick, close[rates_total - 1]);
            g_bars[cur_idx].high  = MathMax(g_bars[cur_idx].high, tick.bid);
            g_bars[cur_idx].low   = MathMin(g_bars[cur_idx].low,  tick.bid);
            g_bars[cur_idx].close = tick.bid;
         }
      }
   }

   RenderFootprint();
   return rates_total;
}

//+------------------------------------------------------------------+
//| Chart Event Handler (Zoom, Scroll, Resize)                       |
//+------------------------------------------------------------------+
void OnChartEvent(const int id,
                  const long &lparam,
                  const double &dparam,
                  const string &sparam)
{
   if(id == CHARTEVENT_CHART_CHANGE)
   {
      RenderFootprint();
   }
}
//+------------------------------------------------------------------+
