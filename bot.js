const express = require('express');
const KrakenClient = require('kraken-api');
const axios = require('axios');
const dotenv = require('dotenv');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Configuración inicial
dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL) || 180000;
const DB_PATH = '/data/trades.db';

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

  db.all("PRAGMA table_info(trades)", (err, columns) => {
    if (err) return console.error('❌ Error al leer columnas:', err);
    const columnNames = columns.map(col => col.name);

    if (!columnNames.includes('sellPrice')) {
      db.run("ALTER TABLE trades ADD COLUMN sellPrice REAL");
    }
    if (!columnNames.includes('profitPercent')) {
      db.run("ALTER TABLE trades ADD COLUMN profitPercent REAL");
    }

    db.all("SELECT * FROM trades WHERE status = 'completed' AND profitPercent IS NULL AND sellPrice IS NOT NULL AND buyPrice IS NOT NULL", (err, rows) => {
      if (err) return console.error('❌ Error al actualizar profitPercent:', err);
      rows.forEach(row => {
        const profit = ((row.sellPrice - row.buyPrice) / row.buyPrice) * 100;
        db.run("UPDATE trades SET profitPercent = ? WHERE id = ?", [profit, row.id]);
        console.log(`📈 Trade ID ${row.id} actualizado con profitPercent: ${profit.toFixed(2)}%`);
      });
    });
  });
});

app.use(express.json());
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

function validateTradingPair(pair) {
  if (typeof pair !== 'string') throw new Error('El par debe ser un string');
  const cleanPair = pair.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const validCurrencies = ['USD', 'EUR', 'GBP', 'CAD', 'USDT'];
  const endsWithValidCurrency = validCurrencies.some(currency => cleanPair.endsWith(currency));
  if (!endsWithValidCurrency) throw new Error(`El par debe terminar con ${validCurrencies.join(', ')}`);
  if (cleanPair.length < 5) throw new Error('El par debe tener al menos 5 caracteres');
  return cleanPair;
}

function calculateQuantity(amount, price) {
  const quantity = amount / price;
  return Math.floor(quantity * 100000000) / 100000000;
}

app.post('/alerta', async (req, res) => {
  try {
    const { par, cantidad, trailingStopPercent } = req.body;
    if (!par || !cantidad || !trailingStopPercent) return res.status(400).json({ error: 'Parámetros faltantes' });
    const cleanPair = validateTradingPair(par);

    // Verificar si ya hay un trade activo para este par
const existingTrade = await new Promise((resolve, reject) => {
  db.get("SELECT * FROM trades WHERE pair = ? AND status = 'active' LIMIT 1", [cleanPair], (err, row) => {
    if (err) return reject(err);
    resolve(row);
  });
});

if (existingTrade) {
  console.log(`⚠️ Trade activo ya existente para ${cleanPair}. Se omite la compra.`);
  return res.status(200).json({ status: 'skip', message: `Trade ya activo para ${cleanPair}` });
}
    const currency = cleanPair.slice(-3);
    const amount = parseFloat(cantidad);
    if (isNaN(amount) || amount <= 0) throw new Error('"cantidad" debe ser un número positivo');
    if (isNaN(trailingStopPercent) || trailingStopPercent <= 0 || trailingStopPercent >= 100) throw new Error('"trailingStopPercent" debe ser entre 0 y 100');
    const ticker = await axios.get(`https://api.kraken.com/0/public/Ticker?pair=${cleanPair}`);
    const currentPrice = parseFloat(ticker.data.result[cleanPair].c[0]);
    const quantity = calculateQuantity(amount, currentPrice);
    const order = await kraken.api('AddOrder', { pair: cleanPair, type: 'buy', ordertype: 'market', volume: quantity.toString() });
    db.run(`INSERT INTO trades (pair, quantity, stopPercent, highestPrice, buyPrice, buyOrderId) VALUES (?, ?, ?, ?, ?, ?)`, [cleanPair, quantity, trailingStopPercent, currentPrice, currentPrice, order.result.txid[0]]);
    console.log(`✅ COMPRA: ${quantity} ${cleanPair} @ ${currentPrice} ${currency}`);
    return res.status(200).json({ status: 'success', orderId: order.result.txid[0], pair: cleanPair, quantity, price: currentPrice, currency });
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    return res.status(500).json({ error: error.message });
  }
});

setInterval(() => {
  db.all("SELECT * FROM trades WHERE status = 'active'", (err, trades) => {
    if (err) return console.error('Error al leer trades:', err);
    trades.forEach(trade => checkTrade(trade));
  });
}, CHECK_INTERVAL);

async function checkTrade(trade) {
  try {
    const ticker = await axios.get(`https://api.kraken.com/0/public/Ticker?pair=${trade.pair}`);
    const currentPrice = parseFloat(ticker.data.result[trade.pair].c[0]);
    const newHighestPrice = Math.max(trade.highestPrice, currentPrice);
    if (newHighestPrice > trade.highestPrice) db.run("UPDATE trades SET highestPrice = ? WHERE id = ?", [newHighestPrice, trade.id]);
    const stopPrice = newHighestPrice * (1 - trade.stopPercent / 100);
    if (currentPrice <= stopPrice) {
      const sellOrder = await kraken.api('AddOrder', { pair: trade.pair, type: 'sell', ordertype: 'market', volume: trade.quantity.toString() });
      const profitPercent = ((currentPrice - trade.buyPrice) / trade.buyPrice) * 100;
      db.run("UPDATE trades SET status = 'completed', sellPrice = ?, profitPercent = ? WHERE id = ?", [currentPrice, profitPercent, trade.id]);
      console.log(`💰 VENTA: ${trade.quantity} ${trade.pair} @ ${currentPrice}`);
    }
  } catch (error) {
    console.error(`⚠️ Error verificando trade: ${error.message}`);
  }
}

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

app.post('/vender', async (req, res) => {
  try {
    const { par, cantidad } = req.body;
    if (!par || !cantidad) return res.status(400).json({ error: 'Parámetros faltantes' });
    const cleanPair = validateTradingPair(par);
    const percent = parseFloat(cantidad);
    if (isNaN(percent) || percent <= 0 || percent > 100) throw new Error('"cantidad" debe ser un porcentaje entre 0 y 100');
    
    // 1. Busca el trade activo para este par
    const activeTrade = await db.get(
      "SELECT * FROM trades WHERE pair = ? AND status = 'active' LIMIT 1",
      [cleanPair]
    );
    if (!activeTrade) throw new Error(`No hay trades activos para ${cleanPair}`);

    // 2. Verifica balance y calcula volumen
    const balance = await kraken.api('Balance');
    const baseAsset = cleanPair.slice(0, -3); // "ACH" de "ACHEUR"
    const available = parseFloat(balance.result[baseAsset] || '0');
    const volume = Math.floor((available * percent / 100) * 100000000) / 100000000;
    if (volume <= 0) throw new Error('Cantidad a vender demasiado baja');

    // 3. Ejecuta venta en Kraken
    const ticker = await axios.get(`https://api.kraken.com/0/public/Ticker?pair=${cleanPair}`);
    const currentPrice = parseFloat(ticker.data.result[cleanPair].c[0]);
    const order = await kraken.api('AddOrder', {
      pair: cleanPair,
      type: 'sell',
      ordertype: 'market',
      volume: volume.toString()
    });

    // 4. Actualiza el trade existente (DIFERENCIA CLAVE)
    const profitPercent = ((currentPrice - activeTrade.buyPrice) / activeTrade.buyPrice) * 100;
    await db.run(
      `UPDATE trades 
       SET status = 'completed', 
           sellPrice = ?,
           profitPercent = ?
       WHERE id = ?`,
      [currentPrice, profitPercent, activeTrade.id]
    );

    console.log(`💥 VENTA MANUAL: ${volume} ${baseAsset} (${percent}%) en ${cleanPair}`);
    res.status(200).json({
      status: 'venta ejecutada',
      orderId: order.result.txid[0],
      pair: cleanPair,
      baseAsset,
      cantidadVendida: volume,
      porcentaje: percent
    });
  } catch (error) {
    console.error(`❌ Error al vender: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.get('/trades/all', (req, res) => {
  db.all("SELECT * FROM trades ORDER BY createdAt DESC", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.status(200).json(rows);
  });
});

app.get('/resumen', (req, res) => {
  db.all(`
    SELECT 
      pair,
      COUNT(*) AS total_trades,
      SUM(profitPercent) AS total_profit_percent,
      AVG(profitPercent) AS avg_profit_percent
    FROM trades
    WHERE status = 'completed' AND profitPercent IS NOT NULL
    GROUP BY pair
    ORDER BY total_profit_percent DESC
  `, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    
    db.get("SELECT COUNT(*) AS total FROM trades", (err2, countRow) => {
      if (err2) return res.status(500).json({ error: err2.message });

      res.json({
        totalTrades: countRow.total,
        resumenPorMoneda: rows
      });
    });
  });
});

app.get('/trades/detalle', (req, res) => {
  db.all(`
    SELECT 
      id,
      pair,
      buyPrice,
      sellPrice,
      profitPercent,
      datetime(createdAt) as buyTime,
      (SELECT datetime(createdAt) FROM trades AS t2 WHERE t2.id > trades.id AND t2.pair = trades.pair AND t2.status = 'completed' ORDER BY t2.id LIMIT 1) AS sellTime
    FROM trades
    WHERE status = 'completed' AND profitPercent IS NOT NULL
    ORDER BY id ASC
  `, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/sincronizar', async (req, res) => {
  try {
    const tradesHistory = await kraken.api('TradesHistory', {});
    const trades = tradesHistory.result.trades;
    let nuevos = 0;
    let actualizados = 0;

    for (const txid in trades) {
      const t = trades[txid];
      const pair = t.pair.toUpperCase();
      const type = t.type; // "buy" o "sell"
      const time = new Date(t.time * 1000).toISOString();
      const price = parseFloat(t.price);
      const volume = parseFloat(t.vol);

      // Verifica si este txid ya existe como buyOrderId
      const exists = await new Promise((resolve, reject) => {
        db.get("SELECT * FROM trades WHERE buyOrderId = ?", [txid], (err, row) => {
          if (err) return reject(err);
          resolve(row);
        });
      });

      if (!exists) {
        if (type === "buy") {
          // Inserta nueva compra
          await new Promise((resolve, reject) => {
            db.run(`
              INSERT INTO trades (pair, quantity, buyPrice, highestPrice, stopPercent, buyOrderId, createdAt)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [pair, volume, price, price, 2, txid, time],
              function (err) {
                if (err) return reject(err);
                nuevos++;
                resolve();
              });
          });
        } else if (type === "sell") {
          // Busca un trade activo con ese par y actualiza
          await new Promise((resolve, reject) => {
            db.get("SELECT * FROM trades WHERE pair = ? AND status = 'active' LIMIT 1", [pair], (err, row) => {
              if (err || !row) return resolve(); // no hay trade activo
              const profitPercent = ((price - row.buyPrice) / row.buyPrice) * 100;
              db.run(`
                UPDATE trades 
                SET sellPrice = ?, profitPercent = ?, status = 'completed', updatedAt = ?
                WHERE id = ?`,
                [price, profitPercent, time, row.id],
                (err2) => {
                  if (!err2) actualizados++;
                  resolve();
                });
            });
          });
        }
      }
    }

    res.json({
      status: 'ok',
      nuevos_insertados: nuevos,
      actualizados: actualizados
    });
  } catch (error) {
    console.error('❌ Error al sincronizar:', error.message);
    res.status(500).json({ error: error.message });
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
