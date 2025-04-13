const express = require('express');
const KrakenClient = require('kraken-api');
const axios = require('axios');
const dotenv = require('dotenv');
const sqlite3 = require('sqlite3').verbose();

// Configuración inicial
dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = '/data/trades.db';
const CHECK_INTERVAL = 540000; // 9 minutos en milisegundos

// Validación de variables de entorno
const requiredEnvVars = ['API_KEY', 'API_SECRET'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  console.error(`❌ [${new Date().toISOString()}] Missing required environment variables: ${missingVars.join(', ')}`);
  process.exit(1);
}

const kraken = new KrakenClient(process.env.API_KEY, process.env.API_SECRET);
const db = new sqlite3.Database(DB_PATH);

// Manejo de cierre limpio
process.on('SIGTERM', () => {
  console.log('🛑 Recibió SIGTERM. Cerrando limpiamente...');
  db.close((err) => { 
    if (err) console.error('Error al cerrar DB:', err);
  });
  server.close(() => {
    console.log('Servidor HTTP detenido');
    process.exit(0);
  });
});

// Crear tabla y migrar si es necesario
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pair TEXT NOT NULL,
      quantity REAL NOT NULL,
      stopPercent REAL,
      highestPrice REAL,
      buyPrice REAL,
      buyOrderId TEXT NOT NULL,
      sellPrice REAL,
      profitPercent REAL,
      status TEXT DEFAULT 'active',
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// Función para sincronizar la base de datos con Kraken
async function syncDatabaseWithKraken() {
  try {
    const tradesHistory = await kraken.api('TradesHistory');
    const trades = tradesHistory.result.trades || {};

    console.log(`📊 ${Object.keys(trades).length} trades encontrados en Kraken`);

    for (const txid in trades) {
      const trade = trades[txid];
      const pair = trade.pair.toUpperCase();
      const time = new Date(trade.time * 1000).toISOString();
      const price = parseFloat(trade.price);
      const volume = parseFloat(trade.vol);

      db.get("SELECT * FROM trades WHERE buyOrderId = ?", [txid], (err, row) => {
        if (err) {
          console.error('Error al verificar trade:', err);
          return;
        }

        if (!row) {
          db.run(
            `INSERT INTO trades (pair, quantity, stopPercent, highestPrice, buyPrice, buyOrderId, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [pair, volume, 2, price, price, txid, 'active', time],
            (err) => {
              if (err) console.error('Error al insertar trade:', err);
            }
          );
        } else {
          db.run(
            `UPDATE trades SET quantity = ?, buyPrice = ?, status = ?, createdAt = ? WHERE buyOrderId = ?`,
            [volume, price, 'active', time, txid],
            (err) => {
              if (err) console.error('Error al actualizar trade:', err);
            }
          );
        }
      });
    }

    console.log('✅ Base de datos sincronizada con Kraken');
  } catch (error) {
    console.error('❌ Error al sincronizar con Kraken:', error);
  }
}

// Endpoint para procesar mensajes de TradingView
app.post('/comprar', async (req, res) => {
  try {
    const { par, cantidad, trailingStopPercent } = req.body;
    if (!par || !cantidad || !trailingStopPercent) {
      return res.status(400).json({ error: 'Parámetros faltantes' });
    }

    const cleanPair = par.toUpperCase();

    db.get("SELECT * FROM trades WHERE pair = ? AND status = 'active'", [cleanPair], async (err, row) => {
      if (err) {
        console.error('Error al verificar trade:', err);
        return res.status(500).json({ error: 'Error al verificar trade' });
      }

      if (row) {
        return res.status(400).json({ error: `Ya existe un trade activo para ${cleanPair}` });
      }

      const balance = await kraken.api('Balance');
      const quoteAsset = cleanPair.slice(-3);
      const available = parseFloat(balance.result[quoteAsset] || '0');
      const volume = Math.min(cantidad, available);

      if (volume <= 0) {
        return res.status(400).json({ error: 'Cantidad a comprar demasiado baja' });
      }

      const order = await kraken.api('AddOrder', {
        pair: cleanPair,
        type: 'buy',
        ordertype: 'market',
        volume: volume.toString()
      });

      const buyPrice = parseFloat(order.result.price);
      db.run(
        `INSERT INTO trades (pair, quantity, stopPercent, highestPrice, buyPrice, buyOrderId, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [cleanPair, volume, trailingStopPercent, buyPrice, buyPrice, order.result.txid[0], 'active', new Date().toISOString()],
        (err) => {
          if (err) {
            console.error('Error al insertar trade:', err);
            return res.status(500).json({ error: 'Error al insertar trade' });
          }
          res.status(200).json({ status: 'compra ejecutada', orderId: order.result.txid[0], pair: cleanPair, cantidadComprada: volume });
        }
      );
    });
  } catch (error) {
    console.error(`❌ Error al comprar: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Función para monitorear y ajustar el trailing stop
async function monitorTrailingStop() {
  try {
    db.all("SELECT * FROM trades WHERE status = 'active'", async (err, rows) => {
      if (err) {
        console.error('Error al obtener trades activos:', err);
        return;
      }

      for (const trade of rows) {
        const cleanPair = trade.pair;
        const trailingStopPercent = trade.stopPercent;
        const highestPrice = trade.highestPrice;

        const ticker = await axios.get(`https://api.kraken.com/0/public/Ticker?pair=${cleanPair}`);
        const currentPrice = parseFloat(ticker.data.result[cleanPair].c[0]);

        const newHighestPrice = Math.max(highestPrice, currentPrice);
        const stopLossPrice = newHighestPrice * (1 - trailingStopPercent / 100);

        if (currentPrice < stopLossPrice) {
          const volume = trade.quantity;
          const order = await kraken.api('AddOrder', {
            pair: cleanPair,
            type: 'sell',
            ordertype: 'market',
            volume: volume.toString()
          });

          const profitPercent = ((currentPrice - trade.buyPrice) / trade.buyPrice) * 100;
          await db.run(
            `UPDATE trades 
             SET status = 'completed', 
                 sellPrice = ?,
                 profitPercent = ?
             WHERE id = ?`,
            [currentPrice, profitPercent, trade.id]
          );

          console.log(`💥 VENTA AUTOMÁTICA: ${volume} en ${cleanPair} debido a trailing stop`);
        } else {
          await db.run(
            `UPDATE trades SET highestPrice = ? WHERE id = ?`,
            [newHighestPrice, trade.id]
          );
        }
      }
    });
  } catch (error) {
    console.error('❌ Error en el monitoreo de trailing stop:', error);
  }
}

// Configurar el monitoreo para que ocurra cada 9 minutos
setInterval(monitorTrailingStop, CHECK_INTERVAL);

// Configuración del servidor
app.use(express.json());

app.get('/status', (req, res) => {
  db.get("SELECT COUNT(*) as active FROM trades WHERE status = 'active'", (err, row) => {
    res.status(200).json({ status: 'running', activeTrades: row ? row.active : 0, uptime: process.uptime() });
  });
});

app.get('/trades/active', (req, res) => {
  db.all("SELECT * FROM trades WHERE status = 'active'", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.status(200).json(rows);
  });
});

app.get('/trades/history', (req, res) => {
  db.all("SELECT * FROM trades WHERE status = 'completed' ORDER BY createdAt DESC", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.status(200).json(rows);
  });
});

app.get('/trades/summary', (req, res) => {
  db.all("SELECT * FROM trades WHERE profitPercent IS NOT NULL", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const total = rows.length;
    const totalProfit = rows.reduce((acc, r) => acc + (r.profitPercent || 0), 0);
    const avgProfit = total > 0 ? totalProfit / total : 0;
    const winners = rows.filter(r => r.profitPercent > 0).length;
    const losers = rows.filter(r => r.profitPercent <= 0).length;
    res.status(200).json({ totalTrades: total, totalProfitPercent: totalProfit, averageProfitPercent: avgProfit, winners, losers });
  });
});

app.get('/balance', async (req, res) => {
  try {
    const balance = await kraken.api('Balance');
    console.log(`💰 Balance Kraken:`, balance.result);
    res.status(200).json(balance.result);
  } catch (error) {
    console.error(`❌ Error obteniendo balance: ${error.message}`);
    res.status(500).json({ error: 'Error obteniendo balance' });
  }
});

// Endpoint temporal para eliminar un trade por ID
app.delete('/trades/delete/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'ID inválido' });

  db.run("DELETE FROM trades WHERE id = ?", [id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: 'Trade no encontrado' });
    res.status(200).json({ status: 'Trade eliminado', id });
  });
});

const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  db.get("SELECT COUNT(*) as count FROM trades WHERE status = 'active'", (err, row) => {
    if (row && row.count > 0) console.log(`🔍 ${row.count} trades activos encontrados`);
  });
});
