const express = require('express');
const KrakenClient = require('kraken-api');
const axios = require('axios');
const dotenv = require('dotenv');
const sqlite3 = require('sqlite3').verbose();

// Configuración inicial
dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;
const CHECK_INTERVAL = 180000; // 3 minutos en milisegundos
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
});

// Función para sincronizar la base de datos con Kraken
async function syncDatabaseWithKraken() {
  try {
    // Obtener historial de trades de Kraken
    const tradesHistory = await kraken.api('TradesHistory');
    const trades = tradesHistory.result.trades || {};

    console.log(`📊 ${Object.keys(trades).length} trades encontrados en Kraken`);

    // Procesar y actualizar la base de datos con los trades
    for (const txid in trades) {
      const trade = trades[txid];
      const pair = trade.pair.toUpperCase();
      const time = new Date(trade.time * 1000).toISOString();
      const price = parseFloat(trade.price);
      const volume = parseFloat(trade.vol);

      // Verificar si el trade ya existe en la base de datos
      db.get("SELECT * FROM trades WHERE buyOrderId = ?", [txid], (err, row) => {
        if (err) {
          console.error('Error al verificar trade:', err);
          return;
        }

        if (!row) {
          // Insertar nuevo trade si no existe
          db.run(
            `INSERT INTO trades (pair, quantity, buyPrice, buyOrderId, status, createdAt) VALUES (?, ?, ?, ?, ?, ?)`,
            [pair, volume, price, txid, 'active', time],
            (err) => {
              if (err) console.error('Error al insertar trade:', err);
            }
          );
        } else {
          // Actualizar trade existente si es necesario
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

// Configurar la sincronización para que ocurra cada 3 minutos
setInterval(syncDatabaseWithKraken, CHECK_INTERVAL);

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

    // 4. Actualiza el trade existente
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

app.get('/sincronizar-completo', async (req, res) => {
  try {
    // Paso 1: Limpiar la base de datos existente
    await new Promise((resolve, reject) => {
      db.run("DELETE FROM trades", (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    console.log('✅ Base de datos limpiada');

    // Paso 2: Obtener historial completo de Kraken
    const tradesHistory = await kraken.api('TradesHistory');
    const trades = tradesHistory.result.trades || {};
    
    console.log(`📊 ${Object.keys(trades).length} trades encontrados en Kraken`);

    // Paso 3: Reconstruir la base de datos según el historial real
    let compras = [];
    let ventas = [];
    
    // Separar compras y ventas
    for (const txid in trades) {
      const t = trades[txid];
      if (t.type === 'buy') {
        compras.push(t);
      } else if (t.type === 'sell') {
        ventas.push(t);
      }
    }

    // Procesar compras primero
    for (const compra of compras) {
      const pair = compra.pair.toUpperCase();
      const time = new Date(compra.time * 1000).toISOString();
      const price = parseFloat(compra.price);
      const volume = parseFloat(compra.vol);

      // Buscar si hay una venta correspondiente
      const ventaCorrespondiente = ventas.find(v => 
        v.pair.toUpperCase() === pair && 
        parseFloat(v.vol) === volume &&
        new Date(v.time * 1000) > new Date(compra.time * 1000)
      );

      if (ventaCorrespondiente) {
        // Trade completo (compra + venta)
        const sellPrice = parseFloat(ventaCorrespondiente.price);
        const profitPercent = ((sellPrice - price) / price) * 100;
        
        await new Promise((resolve, reject) => {
          db.run(
            `INSERT INTO trades (
              pair, quantity, stopPercent, highestPrice, buyPrice, 
              buyOrderId, sellPrice, profitPercent, status, createdAt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              pair, 
              volume, 
              2, // stopPercent por defecto
              sellPrice, // highestPrice
              price, 
              compra.ordertxid || txid,
              sellPrice,
              profitPercent,
              'completed',
              time
            ],
            (err) => {
              if (err) reject(err);
              else resolve();
            }
          );
        });
      } else {
        // Trade activo (solo compra)
        await new Promise((resolve, reject) => {
          db.run(
            `INSERT INTO trades (
              pair, quantity, stopPercent, highestPrice, buyPrice, 
              buyOrderId, status, createdAt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              pair, 
              volume, 
              2, // stopPercent por defecto
              price, // highestPrice inicial
              price, 
              compra.ordertxid || txid,
              'active',
              time
            ],
            (err) => {
              if (err) reject(err);
              else resolve();
            }
          );
        });
      }
    }

    console.log('✅ Base de datos reconstruida según historial de Kraken');
    res.json({
      status: 'success',
      message: 'Base de datos sincronizada completamente con Kraken',
      tradesActivos: compras.length - ventas.length,
      tradesCompletados: ventas.length
    });

  } catch (error) {
    console.error('❌ Error en sincronización completa:', error);
    res.status(500).json({ 
      error: error.message,
      stack: error.stack 
    });
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
