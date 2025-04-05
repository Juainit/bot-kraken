import React, { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableHead, TableRow, TableCell, TableBody } from "@/components/ui/table";

export default function TradesDashboard() {
  const [trades, setTrades] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("https://bot-kraken-production-ee86.up.railway.app/trades/all")
      .then(res => res.json())
      .then(data => {
        setTrades(data);
        setLoading(false);
      });
  }, []);

  return (
    <main className="p-6 space-y-6">
      <h1 className="text-3xl font-bold">📊 Kraken Bot - Historial de Trades</h1>
      <Card>
        <CardContent className="overflow-x-auto p-4">
          {loading ? (
            <p>Cargando...</p>
          ) : (
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>ID</TableCell>
                  <TableCell>Par</TableCell>
                  <TableCell>Buy</TableCell>
                  <TableCell>Sell</TableCell>
                  <TableCell className="text-right">% Profit</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Fecha</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {trades.map(trade => (
                  <TableRow key={trade.id} className={
                    trade.profitPercent > 0 ? "bg-green-100" :
                    trade.profitPercent < 0 ? "bg-red-100" :
                    trade.status === "active" ? "bg-gray-100" : ""
                  }>
                    <TableCell>{trade.id}</TableCell>
                    <TableCell>{trade.pair}</TableCell>
                    <TableCell>{trade.buyPrice ?? "-"}</TableCell>
                    <TableCell>{trade.sellPrice ?? "-"}</TableCell>
                    <TableCell className="text-right">
                      {trade.profitPercent != null ? `${trade.profitPercent.toFixed(2)}%` : "-"}
                    </TableCell>
                    <TableCell>{trade.status}</TableCell>
                    <TableCell>{new Date(trade.createdAt).toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
