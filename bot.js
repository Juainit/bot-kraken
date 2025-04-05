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
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL) || 600000; // 10 minutos
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

// Crear tabla para guardar los trades
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

// Middlewares
app.use(express.json());
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Helper Functions
function validateTradingPair(pair) {
  if (typeof pair !== 'string') throw new Error('El par debe ser un string');

  const cleanPair = pair.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const validCurrencies = ['USD', 'EUR', 'GBP', 'CAD', 'USDT'];

  const endsWithValidCurrency = validCurrencies.some(currency =>
    cleanPair.endsWith(currency)
  );

  if (!endsWithValidCurrency) {
    throw new Error(`El par debe terminar con ${validCurrencies.join(', ')} (ej: SOLEUR, ETHGBP)`);
  }

  if (cleanPair.length < 5 || cleanPair.length > 8) {
    throw new Error('El par debe tener entre 5-8 caracteres (ej: SOLEUR)');
  }

  return cleanPair;
}

function calculateQuantity(amount, price) {
  const quantity = amount / price;
  return Math.floor(quantity * 100000000) / 100000000;
}

// API Endpoints
app.post('/alerta', async (req, res) => {
  try {
    const { par, cantidad, trailingStopPercent } = req.body;

    if (!par || !cantidad || !trailingStopPercent) {
      return res.status(400).json({
        error: 'Parámetros faltantes',
        required: ['par', 'cantidad', 'trailingStopPercent']
      });
    }

    const cleanPair = validateTradingPair(par);
    const currency = cleanPair.slice(-3);
    const amount = parseFloat(cantidad);

    if (isNaN(amount) || amount <= 0) {
      throw new Error('"cantidad" debe ser un número positivo');
    }

    if (isNaN(trailingStopPercent) || trailingStopPercent <= 0 || trailingStopPercent >= 100) {
      throw new Error('"trailingStopPercent" debe ser entre 0 y 100');
    }

    const ticker = await axios.get(`https://api.kraken.com/0/public/Ticker?pair=${cleanPair}`);
    const currentPrice = parseFloat(ticker.data.result[cleanPair].c[0]);
    const quantity = calculateQuantity(amount, currentPrice);

    const order = await kraken.api('AddOrder', {
      pair: cleanPair,
      type: 'buy',
      ordertype: 'market',
      volume: quantity.toString()
    });

    db.run(
      `INSERT INTO trades (pair, quantity, stopPercent, highestPrice, buyPrice, buyOrderId) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [cleanPair, quantity, trailingStopPercent, currentPrice, currentPrice, order.result.txid[0]],
      function(err) {
        if (err) console.error('Error al guardar trade:', err);
      }
    );

    console.log(`✅ [${new Date().toISOString()}] COMPRA: ${quantity} ${cleanPair} @ ${currentPrice} ${currency}`);

    return res.status(200).json({
      status: 'success',
      orderId: order.result.txid[0],
      pair: cleanPair,
      quantity,
      price: currentPrice,
      currency
    });

  } catch (error) {
    console.error(`❌ [${new Date().toISOString()}] Error: ${error.message}`);
    return res.status(500).json({ error: error.message });
  }
});

setInterval(() => {
  db.all("SELECT * FROM trades WHERE status = 'active'", (err, trades) => {
    if (err) return console.error('Error al leer trades:', err);

    trades.forEach(trade => {
      checkTrade(trade);
    });
  });
}, CHECK_INTERVAL);

async function checkTrade(trade) {
  try {
    const ticker = await axios.get(`https://api.kraken.com/0/public/Ticker?pair=${trade.pair}`);
    const currentPrice = parseFloat(ticker.data.result[trade.pair].c[0]);

    const newHighestPrice = Math.max(trade.highestPrice, currentPrice);
    if (newHighestPrice > trade.highestPrice) {
      db.run("UPDATE trades SET highestPrice = ? WHERE id = ?", [newHighestPrice, trade.id]);
    }

    const stopPrice = newHighestPrice * (1 - trade.stopPercent / 100);

    if (currentPrice <= stopPrice) {
      const sellOrder = await kraken.api('AddOrder', {
        pair: trade.pair,
        type: 'sell',
        ordertype: 'market',
        volume: trade.quantity.toString()
      });

      const profitPercent = ((currentPrice - trade.buyPrice) / trade.buyPrice) * 100;

      db.run(
        "UPDATE trades SET status = 'completed', sellPrice = ?, profitPercent = ? WHERE id = ?",
        [currentPrice, profitPercent, trade.id]
      );

      console.log(`💰 [${new Date().toISOString()}] VENTA: ${trade.quantity} ${trade.pair} @ ${currentPrice}`);
    }
  } catch (error) {
    console.error(`⚠️ [${new Date().toISOString()}] Error verificando trade: ${error.message}`);
  }
}

app.get('/status', (req, res) => {
  db.get("SELECT COUNT(*) as active FROM trades WHERE status = 'active'", (err, row) => {
    res.status(200).json({
      status: 'running',
      activeTrades: row ? row.active : 0,
      uptime: process.uptime()
    });
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

    if (!par || !cantidad) {
      return res.status(400).json({
        error: 'Parámetros faltantes',
        required: ['par', 'cantidad (% del saldo disponible)']
      });
    }

    const cleanPair = validateTradingPair(par);
    const percent = parseFloat(cantidad);

    if (isNaN(percent) || percent <= 0 || percent > 100) {
      throw new Error('"cantidad" debe ser un porcentaje entre 0 y 100');
    }

    const balance = await kraken.api('Balance');
    const baseAsset = cleanPair.slice(0, cleanPair.length - 3);
    const available = parseFloat(balance.result[baseAsset] || '0');

    if (available === 0) {
      throw new Error(`No tienes saldo disponible de ${baseAsset}`);
    }

    const amountToSell = (available * percent) / 100;
    const volume = Math.floor(amountToSell * 100000000) / 100000000;

    if (volume <= 0) {
      throw new Error(`La cantidad a vender es demasiado baja`);
    }

    const ticker = await axios.get(`https://api.kraken.com/0/public/Ticker?pair=${cleanPair}`);
    const currentPrice = parseFloat(ticker.data.result[cleanPair].c[0]);

    const order = await kraken.api('AddOrder', {
      pair: cleanPair,
      type: 'sell',
      ordertype: 'market',
      volume: volume.toString()
    });

    const orderId = order.result.txid[0];

    db.run(
      `INSERT INTO trades (
        pair, quantity, stopPercent, highestPrice, buyPrice, buyOrderId, sellPrice, profitPercent, status
      ) VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?, 'manual')`,
      [cleanPair, volume, orderId, currentPrice, 0],
      function (err) {
        if (err) console.error('Error al guardar venta manual en BD:', err);
      }
    );

    console.log(`💥 [${new Date().toISOString()}] VENTA MANUAL: ${volume} ${baseAsset} (${percent}%) en ${cleanPair}`);

    res.status(200).json({
      status: 'venta ejecutada',
      orderId,
      pair: cleanPair,
      baseAsset,
      cantidadVendida: volume,
      porcentaje: percent
    });

  } catch (error) {
    console.error(`❌ [${new Date().toISOString()}] Error al vender: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.get('/trades/all', (req, res) => {
  db.all("SELECT * FROM trades ORDER BY createdAt DESC", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.status(200).json(rows);
  });
});

app.listen(PORT, () => {
  console.log(`🚀 [${new Date().toISOString()}] Server running on port ${PORT}`);

  db.get("SELECT COUNT(*) as count FROM trades WHERE status = 'active'", (err, row) => {
    if (row && row.count > 0) {
      console.log(`🔍 [${new Date().toISOString()}] ${row.count} trades activos encontrados`);
    }
  });
});
