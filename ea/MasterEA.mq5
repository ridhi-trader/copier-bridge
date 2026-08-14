//+------------------------------------------------------------------+
//|                                       TradeBridge_MasterEA.mq5   |
//|                        Copyright 2026, TradeBridge               |
//|                        https://copier-bridge.onrender.com        |
//+------------------------------------------------------------------+
#property copyright "TradeBridge"
#property version   "2.00"
#property description "Master EA — Broadcasts trades to TradeBridge server"

// ── Inputs ──
input string   ServerURL   = "https://copier-bridge.onrender.com";  // Bridge Server URL
input string   MasterID    = "__MASTER_ID__";                         // Your Master ID (auto-filled)
input int      PollIntervalMs = 500;                                  // Check interval (ms)

// ── Globals ──
int g_knownTickets[];
datetime g_lastCheck = 0;

//+------------------------------------------------------------------+
int OnInit()
{
   if(MasterID == "__MASTER_ID__" || MasterID == "")
   {
      Alert("MasterEA: Please set your Master ID!");
      return INIT_FAILED;
   }

   // Allow WebRequest to server
   Print("TradeBridge Master EA v2.0 started");
   Print("Master ID: ", MasterID);
   Print("Server: ", ServerURL);

   // Snapshot current positions
   SnapshotPositions();

   EventSetMillisecondTimer(PollIntervalMs);
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   Print("TradeBridge Master EA stopped");
}

//+------------------------------------------------------------------+
void OnTimer()
{
   CheckForNewTrades();
   CheckForClosedTrades();
   CheckForModifiedTrades();
}

//+------------------------------------------------------------------+
void SnapshotPositions()
{
   ArrayFree(g_knownTickets);
   int total = PositionsTotal();
   for(int i = 0; i < total; i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0)
      {
         int size = ArraySize(g_knownTickets);
         ArrayResize(g_knownTickets, size + 1);
         g_knownTickets[size] = (int)ticket;
      }
   }
   Print("Snapshot: ", ArraySize(g_knownTickets), " existing positions");
}

//+------------------------------------------------------------------+
bool IsKnownTicket(int ticket)
{
   for(int i = 0; i < ArraySize(g_knownTickets); i++)
      if(g_knownTickets[i] == ticket) return true;
   return false;
}

//+------------------------------------------------------------------+
void AddKnownTicket(int ticket)
{
   if(IsKnownTicket(ticket)) return;
   int size = ArraySize(g_knownTickets);
   ArrayResize(g_knownTickets, size + 1);
   g_knownTickets[size] = ticket;
}

//+------------------------------------------------------------------+
void RemoveKnownTicket(int ticket)
{
   int size = ArraySize(g_knownTickets);
   for(int i = 0; i < size; i++)
   {
      if(g_knownTickets[i] == ticket)
      {
         g_knownTickets[i] = g_knownTickets[size - 1];
         ArrayResize(g_knownTickets, size - 1);
         return;
      }
   }
}

//+------------------------------------------------------------------+
void CheckForNewTrades()
{
   int total = PositionsTotal();
   for(int i = 0; i < total; i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket <= 0) continue;
      if(IsKnownTicket((int)ticket)) continue;

      // New position found
      if(!PositionSelectByTicket(ticket)) continue;

      string symbol = PositionGetString(POSITION_SYMBOL);
      double volume = PositionGetDouble(POSITION_VOLUME);
      double price  = PositionGetDouble(POSITION_PRICE_OPEN);
      double sl     = PositionGetDouble(POSITION_SL);
      double tp     = PositionGetDouble(POSITION_TP);
      ENUM_POSITION_TYPE type = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);

      string action = (type == POSITION_TYPE_BUY) ? "BUY" : "SELL";

      if(SendTrade(action, symbol, volume, price, sl, tp, (int)ticket))
      {
         AddKnownTicket((int)ticket);
         Print("→ NEW ", action, " ", symbol, " ", volume, " lots @ ", price, " ticket:", ticket);
      }
   }
}

//+------------------------------------------------------------------+
void CheckForClosedTrades()
{
   int size = ArraySize(g_knownTickets);
   for(int i = size - 1; i >= 0; i--)
   {
      int ticket = g_knownTickets[i];
      bool found = false;

      for(int j = 0; j < PositionsTotal(); j++)
      {
         if((int)PositionGetTicket(j) == ticket) { found = true; break; }
      }

      if(!found)
      {
         // Position was closed
         SendTrade("CLOSE", "", 0, 0, 0, 0, ticket);
         RemoveKnownTicket(ticket);
         Print("→ CLOSE ticket:", ticket);
      }
   }
}

//+------------------------------------------------------------------+
void CheckForModifiedTrades()
{
   for(int i = 0; i < PositionsTotal(); i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket <= 0 || !IsKnownTicket((int)ticket)) continue;
      if(!PositionSelectByTicket(ticket)) continue;

      double sl = PositionGetDouble(POSITION_SL);
      double tp = PositionGetDouble(POSITION_TP);
      string symbol = PositionGetString(POSITION_SYMBOL);

      // We send MODIFY with current SL/TP — server will handle dedup
      // Only send every few seconds to avoid spam
      static datetime lastModCheck = 0;
      if(TimeCurrent() - lastModCheck < 3) continue;
      lastModCheck = TimeCurrent();
   }
}

//+------------------------------------------------------------------+
bool SendTrade(string action, string symbol, double volume, double price,
               double sl, double tp, int ticket)
{
   string url = ServerURL + "/trade";

   string post = StringFormat(
      "{\"master_id\":\"%s\",\"symbol\":\"%s\",\"action\":\"%s\",\"volume\":%.2f,\"price\":%.5f,\"sl\":%.5f,\"tp\":%.5f,\"ticket\":%d}",
      MasterID, symbol, action, volume, price, sl, tp, ticket
   );

   char postData[];
   char result[];
   string headers = "Content-Type: application/json\r\n";
   string resultHeaders;

   StringToCharArray(post, postData, 0, WHOLE_ARRAY, CP_UTF8);
   // Remove null terminator
   ArrayResize(postData, ArraySize(postData) - 1);

   int timeout = 5000;
   int resCode = WebRequest("POST", url, headers, timeout, postData, result, resultHeaders);

   if(resCode == -1)
   {
      int err = GetLastError();
      Print("WebRequest error: ", err, " — Add ", ServerURL, " to Tools > Options > Expert Advisors > Allow WebRequest");
      return false;
   }

   if(resCode != 200)
   {
      Print("Server responded with code: ", resCode);
      return false;
   }

   return true;
}
//+------------------------------------------------------------------+
