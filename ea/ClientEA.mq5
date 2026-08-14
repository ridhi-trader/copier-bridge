//+------------------------------------------------------------------+
//|                                       TradeBridge_ClientEA.mq5   |
//|                        Copyright 2026, TradeBridge               |
//|                        https://copier-bridge.onrender.com        |
//+------------------------------------------------------------------+
#property copyright "TradeBridge"
#property version   "2.00"
#property description "Client EA — Copies trades from a TradeBridge master"

#include <Trade\Trade.mqh>

// ── Inputs ──
input string   ServerURL      = "https://copier-bridge.onrender.com";  // Bridge Server URL
input string   MasterID       = "__MASTER_ID__";                        // Master ID to copy
input double   LotMultiplier  = 1.0;                                    // Lot Multiplier (1.0 = same as master)
input double   FixedLot       = 0.0;                                    // Fixed Lot (0 = use multiplier)
input int      Slippage       = 20;                                     // Max Slippage (points)
input int      PollIntervalMs = 1000;                                   // Poll Interval (ms)
input string   SymbolSuffix   = "";                                     // Symbol Suffix (e.g. ".raw" or "m")

// ── Globals ──
CTrade g_trade;
int    g_lastTradeId = 0;

// Map master tickets to local tickets
int    g_masterTickets[];
int    g_localTickets[];

//+------------------------------------------------------------------+
int OnInit()
{
   if(MasterID == "__MASTER_ID__" || MasterID == "")
   {
      Alert("ClientEA: Please set the Master ID!");
      return INIT_FAILED;
   }

   g_trade.SetExpertMagicNumber(123456);
   g_trade.SetDeviationInPoints(Slippage);

   Print("TradeBridge Client EA v2.0 started");
   Print("Copying Master: ", MasterID);
   Print("Server: ", ServerURL);
   Print("Lot Mode: ", FixedLot > 0 ? StringFormat("Fixed %.2f", FixedLot) : StringFormat("Multiplier %.2fx", LotMultiplier));

   EventSetMillisecondTimer(PollIntervalMs);
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   Print("TradeBridge Client EA stopped");
}

//+------------------------------------------------------------------+
void OnTimer()
{
   PollAndCopy();
}

//+------------------------------------------------------------------+
void PollAndCopy()
{
   string url = StringFormat("%s/poll?master_id=%s&since=%d", ServerURL, MasterID, g_lastTradeId);

   char postData[];
   char result[];
   string headers = "";
   string resultHeaders;

   int resCode = WebRequest("GET", url, headers, 5000, postData, result, resultHeaders);

   if(resCode == -1)
   {
      static datetime lastWarn = 0;
      if(TimeCurrent() - lastWarn > 60)
      {
         Print("WebRequest error: Add ", ServerURL, " to Tools > Options > Expert Advisors > Allow WebRequest");
         lastWarn = TimeCurrent();
      }
      return;
   }

   if(resCode != 200)
   {
      Print("Server error code: ", resCode);
      return;
   }

   string response = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);

   // Parse trades from JSON response
   // Response format: {"trades":[{...},{...}]}
   ProcessTrades(response);
}

//+------------------------------------------------------------------+
void ProcessTrades(string json)
{
   // Find trades array
   int arrStart = StringFind(json, "[");
   int arrEnd   = StringFind(json, "]");
   if(arrStart < 0 || arrEnd < 0 || arrEnd <= arrStart + 1) return;

   string tradesStr = StringSubstr(json, arrStart + 1, arrEnd - arrStart - 1);

   // Split into individual trade objects
   int pos = 0;
   while(pos < StringLen(tradesStr))
   {
      int objStart = StringFind(tradesStr, "{", pos);
      int objEnd   = StringFind(tradesStr, "}", pos);
      if(objStart < 0 || objEnd < 0) break;

      string tradeJson = StringSubstr(tradesStr, objStart, objEnd - objStart + 1);
      pos = objEnd + 1;

      // Parse fields
      int    id     = (int)GetJsonInt(tradeJson, "id");
      string symbol = GetJsonString(tradeJson, "symbol");
      string action = GetJsonString(tradeJson, "action");
      double volume = GetJsonDouble(tradeJson, "volume");
      double price  = GetJsonDouble(tradeJson, "price");
      double sl     = GetJsonDouble(tradeJson, "sl");
      double tp     = GetJsonDouble(tradeJson, "tp");
      int    ticket = (int)GetJsonInt(tradeJson, "ticket");

      if(id <= g_lastTradeId) continue;
      g_lastTradeId = id;

      // Apply symbol suffix
      string localSymbol = symbol + SymbolSuffix;

      // Check symbol exists
      if(!SymbolSelect(localSymbol, true))
      {
         // Try without suffix
         localSymbol = symbol;
         if(!SymbolSelect(localSymbol, true))
         {
            Print("Symbol not found: ", symbol, " / ", symbol + SymbolSuffix);
            continue;
         }
      }

      // Calculate lot
      double lot = FixedLot > 0 ? FixedLot : NormalizeDouble(volume * LotMultiplier, 2);
      if(lot < SymbolInfoDouble(localSymbol, SYMBOL_VOLUME_MIN))
         lot = SymbolInfoDouble(localSymbol, SYMBOL_VOLUME_MIN);

      // Execute
      if(action == "BUY")
      {
         double ask = SymbolInfoDouble(localSymbol, SYMBOL_ASK);
         SetFilling(localSymbol);
         if(g_trade.Buy(lot, localSymbol, ask, sl, tp, StringFormat("TB_%d", ticket)))
         {
            MapTicket(ticket, (int)g_trade.ResultOrder());
            Print("✓ COPIED BUY ", localSymbol, " ", lot, " lots @ ", ask);
         }
         else
            Print("✗ BUY failed: ", localSymbol, " err:", GetLastError());
      }
      else if(action == "SELL")
      {
         double bid = SymbolInfoDouble(localSymbol, SYMBOL_BID);
         SetFilling(localSymbol);
         if(g_trade.Sell(lot, localSymbol, bid, sl, tp, StringFormat("TB_%d", ticket)))
         {
            MapTicket(ticket, (int)g_trade.ResultOrder());
            Print("✓ COPIED SELL ", localSymbol, " ", lot, " lots @ ", bid);
         }
         else
            Print("✗ SELL failed: ", localSymbol, " err:", GetLastError());
      }
      else if(action == "CLOSE")
      {
         CloseByMasterTicket(ticket);
      }
   }
}

//+------------------------------------------------------------------+
void SetFilling(string symbol)
{
   long fillType = SymbolInfoInteger(symbol, SYMBOL_FILLING_MODE);
   if((fillType & SYMBOL_FILLING_FOK) != 0)
      g_trade.SetTypeFilling(ORDER_FILLING_FOK);
   else if((fillType & SYMBOL_FILLING_IOC) != 0)
      g_trade.SetTypeFilling(ORDER_FILLING_IOC);
   else
      g_trade.SetTypeFilling(ORDER_FILLING_RETURN);
}

//+------------------------------------------------------------------+
void MapTicket(int masterTicket, int localTicket)
{
   int size = ArraySize(g_masterTickets);
   ArrayResize(g_masterTickets, size + 1);
   ArrayResize(g_localTickets, size + 1);
   g_masterTickets[size] = masterTicket;
   g_localTickets[size]  = localTicket;
}

//+------------------------------------------------------------------+
void CloseByMasterTicket(int masterTicket)
{
   for(int i = 0; i < ArraySize(g_masterTickets); i++)
   {
      if(g_masterTickets[i] == masterTicket)
      {
         ulong localTicket = (ulong)g_localTickets[i];

         // Find position by checking all positions for matching ticket
         for(int j = PositionsTotal() - 1; j >= 0; j--)
         {
            ulong posTicket = PositionGetTicket(j);
            if(posTicket > 0 && PositionSelectByTicket(posTicket))
            {
               string comment = PositionGetString(POSITION_COMMENT);
               if(StringFind(comment, StringFormat("TB_%d", masterTicket)) >= 0)
               {
                  g_trade.PositionClose(posTicket);
                  Print("✓ CLOSED ticket:", posTicket, " (master:", masterTicket, ")");
                  return;
               }
            }
         }

         // Try direct close
         if(PositionSelectByTicket(localTicket))
         {
            g_trade.PositionClose(localTicket);
            Print("✓ CLOSED local ticket:", localTicket);
         }
         return;
      }
   }

   // Fallback: search by comment
   for(int j = PositionsTotal() - 1; j >= 0; j--)
   {
      ulong posTicket = PositionGetTicket(j);
      if(posTicket > 0 && PositionSelectByTicket(posTicket))
      {
         string comment = PositionGetString(POSITION_COMMENT);
         if(StringFind(comment, StringFormat("TB_%d", masterTicket)) >= 0)
         {
            g_trade.PositionClose(posTicket);
            Print("✓ CLOSED by comment match, ticket:", posTicket);
            return;
         }
      }
   }

   Print("⚠ Could not find position to close for master ticket:", masterTicket);
}

//+------------------------------------------------------------------+
// Simple JSON parsers
//+------------------------------------------------------------------+
string GetJsonString(string json, string key)
{
   string search = "\"" + key + "\":\"";
   int start = StringFind(json, search);
   if(start < 0) return "";
   start += StringLen(search);
   int end = StringFind(json, "\"", start);
   if(end < 0) return "";
   return StringSubstr(json, start, end - start);
}

double GetJsonDouble(string json, string key)
{
   string search = "\"" + key + "\":";
   int start = StringFind(json, search);
   if(start < 0) return 0;
   start += StringLen(search);

   // Skip whitespace and quotes
   while(start < StringLen(json))
   {
      ushort ch = StringGetCharacter(json, start);
      if(ch != ' ' && ch != '"') break;
      start++;
   }

   string numStr = "";
   while(start < StringLen(json))
   {
      ushort ch = StringGetCharacter(json, start);
      if((ch >= '0' && ch <= '9') || ch == '.' || ch == '-')
         numStr += ShortToString(ch);
      else break;
      start++;
   }
   return StringToDouble(numStr);
}

long GetJsonInt(string json, string key)
{
   return (long)GetJsonDouble(json, key);
}
//+------------------------------------------------------------------+
