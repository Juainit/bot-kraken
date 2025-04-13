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
const DB_PATH = process.env.DB_PATH || '/data/trades.db';
const MIN_BALANCE = parseFloat(process.env.MIN_BALANCE) || 50; // Saldo mínimo requerido para operar

// Validación de variables de entorno
const requiredEnvVars = ['API_KEY', 'API_SECRET'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  console.error(`❌ [${new Date().toISOString()}] Missing required environment variables: ${missingVars.join(', ')}`);
  process.exit(1);
}

// Configuración mejorada de Kraken API con manejo de nonce
const krakenConfig = {
  apiKey: process.env.API_KEY,
  apiSecret: process.env.API_SECRET,
  nonceWindow: true // Habilita ventana de nonce para evitar errores
};

const kraken = new KrakenClient(krakenConfig.apiKey, krakenConfig.apiSecret, krakenConfig);
const db = new sqlite3.Database(DB_PATH);

// Manejo de cierre limpio
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function shutdown() {
  console.log('🛑 Recibió señal de apagado. Cerrando limpiamente...');
  db.close((err) => { 
    if (err) console.error('Error al cerrar DB:', err);
    process.exit(0);
  });
}

// Inicialización de la base de datos
async function initializeDB() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(`
        CREATE TABLE IF NOT EXISTS trades (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          pair TEXT NOT NULL,
          quantity REAL NOT NULL,
          stopPercent REAL,
          highestPrice REAL,
          buyPrice REAL,
          buyOrderId TEXT NOT NULL UNIQUE,
          sellPrice REAL,
          profitPercent REAL,
          status TEXT DEFAULT 'active',
          createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
          updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Índices para mejorar el rendimiento
      db.run("CREATE INDEX IF NOT EXISTS idx_trades_pair ON trades(pair)");
      db.run("CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status)");
      
      // Migraciones
      db.get("PRAGMA table_info(trades)", (err, columns) => {
        if (err) return reject(err);
        
        const columnNames = columns.map(col => col.name);
        const migrations = [];
        
        if (!columnNames.includes('sellPrice')) {
          migrations.push("ALTER TABLE trades ADD COLUMN sellPrice REAL");
        }
        if (!columnNames.includes('profitPercent')) {
          migrations.push("ALTER TABLE trades ADD COLUMN profitPercent REAL");
        }
        if (!columnNames.includes('updatedAt')) {
          migrations.push("ALTER TABLE trades ADD COLUMN updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP");
        }

        // Ejecutar migraciones en serie
        const runMigrations = () => {
          if (migrations.length === 0) return resolve();
          
          const migration = migrations.shift();
          db.run(migration, (err) => {
            if (err) return reject(err);
            console.log(`✅ Ejecutada migración: ${migration}`);
            runMigrations();
          });
        };
        
        runMigrations();
      });
    });
  });
}

// Middleware para log de requests
app.use(express.json());
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`, req.body || '');
  next();
});

// Función para verificar saldo disponible
async function checkBalance(currency, requiredAmount) {
  try {
    const balance = await kraken.api('Balance');
    const available = parseFloat(balance.result[currency] || 0);
    
    if (available < requiredAmount) {
      console.warn(`⚠️ Saldo insuficiente: ${available} ${currency} (Se necesitan ${requiredAmount})`);
      return false;
    }
    
    return true;
  } catch (error) {
    console.error(`❌ Error al verificar balance: ${error.message}`);
    return false;
  }
}

// Validación mejorada de pares de trading
function validateTradingPair(pair) {
  if (typeof pair !== 'string') throw new Error('El par debe ser un string');
  
  const cleanPair = pair.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const validCurrencies = ['USD', 'EUR', 'GBP', 'CAD', 'USDT'];
  const endsWithValidCurrency = validCurrencies.some(currency => cleanPair.endsWith(currency));
  
  if (!endsWithValidCurrency) throw new Error(`El par debe terminar con ${validCurrencies.join(', ')}`);
  if (cleanPair.length < 5) throw new Error('El par debe tener al menos 5 caracteres');
  
  return cleanPair;
}

// Cálculo de cantidad con precisión mejorada
function calculateQuantity(amount, price, pair) {
  // Obtener información del par para conocer los decimales permitidos
  const pairInfo = getPairInfo(pair); // Implementar según los pares que uses
  const precision = pairInfo?.precision || 8;
  
  const quantity = amount / price;
  return parseFloat(quantity.toFixed(precision));
}

// Endpoint para alertas de compra
app.post('/alerta', async (req, res) => {
  try {
    const { par, cantidad, trailingStopPercent } = req.body;
    
    // Validación de parámetros
    if (!par || !cantidad || !trailingStopPercent) {
      return res.status(400).json({ error: 'Parámetros faltantes: se requieren par, cantidad y trailingStopPercent' });
    }
    
    const cleanPair = validateTradingPair(par);
    const currency = cleanPair.slice(-3); // Obtener la moneda de cotización (USD, EUR, etc.)
    const amount = parseFloat(cantidad);
    const stopPercent = parseFloat(trailingStopPercent);

    if (isNaN(amount) || amount <= 0) throw new Error('"cantidad" debe ser un número positivo');
    if (isNaN(stopPercent) || stopPercent <= 0 || stopPercent >= 100) {
      throw new Error('"trailingStopPercent" debe ser un porcentaje entre 0 y 100');
    }

    // Verificar saldo antes de proceder
    const hasBalance = await checkBalance(currency, amount);
    if (!hasBalance) {
      return res.status(400).json({ error: `Saldo insuficiente en ${currency} para esta operación` });
    }

    // Verificar trade activo existente
    const existingTrade = await new Promise((resolve, reject) => {
      db.get("SELECT * FROM trades WHERE pair = ? AND status = 'active' LIMIT 1", [cleanPair], (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });

    if (existingTrade) {
      console.log(`⚠️ Trade activo ya existente para ${cleanPair}. ID: ${existingTrade.id}`);
      return res.status(200).json({ 
        status: 'skip', 
        message: `Trade ya activo para ${cleanPair}`,
        tradeId: existingTrade.id
      });
    }

    // Obtener precio actual
    const ticker = await axios.get(`https://api.kraken.com/0/public/Ticker?pair=${cleanPair}`);
    const currentPrice = parseFloat(ticker.data.result[cleanPair]?.c?.[0]);
    
    if (!currentPrice) {
      throw new Error('No se pudo obtener el precio actual para el par');
    }

    // Calcular cantidad y ejecutar orden
    const quantity = calculateQuantity(amount, currentPrice, cleanPair);
    
    const order = await kraken.api('AddOrder', {
      pair: cleanPair,
      type: 'buy',
      ordertype: 'market',
      volume: quantity.toString(),
      validate: false // Cambiar a true para pruebas
    });

    // Registrar trade en la base de datos
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO trades (pair, quantity, stopPercent, highestPrice, buyPrice, buyOrderId) 
         VALUES (?, ?, ?, ?, ?, ?)`, 
        [cleanPair, quantity, stopPercent, currentPrice, currentPrice, order.result.txid[0]],
        function(err) {
          if (err) return reject(err);
          resolve(this.lastID);
        }
      );
    });

    console.log(`✅ COMPRA: ${quantity} ${cleanPair} @ ${currentPrice} ${currency}`);
    
    return res.status(200).json({ 
      status: 'success', 
      orderId: order.result.txid[0],
      pair: cleanPair,
      quantity,
      price: currentPrice,
      currency
    });

  } catch (error) {
    console.error(`❌ Error en /alerta [${req.body.par || 'N/A'}]: ${error.message}`);
    return res.status(500).json({ 
      error: error.message,
      details: error.response?.data || null
    });
  }
});

// Función mejorada para verificar y gestionar trades
async function checkTrade(trade) {
  try {
    console.log(`🔍 Verificando trade ID ${trade.id} (${trade.pair})`);
    
    // Obtener precio actual
    const ticker = await axios.get(`https://api.kraken.com/0/public/Ticker?pair=${trade.pair}`);
    const currentPrice = parseFloat(ticker.data.result[trade.pair]?.c?.[0]);
    
    if (!currentPrice) {
      throw new Error('No se pudo obtener el precio actual');
    }

    // Actualizar highestPrice si es necesario
    const newHighestPrice = Math.max(trade.highestPrice, currentPrice);
    if (newHighestPrice > trade.highestPrice) {
      await new Promise((resolve, reject) => {
        db.run(
          "UPDATE trades SET highestPrice = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?", 
          [newHighestPrice, trade.id],
          (err) => err ? reject(err) : resolve()
        );
      });
    }

    // Calcular precio de stop
    const stopPrice = newHighestPrice * (1 - trade.stopPercent / 100);
    
    // Verificar si debemos vender
    if (currentPrice <= stopPrice) {
      console.log(`⚠️ Activado trailing stop para ${trade.pair} (ID: ${trade.id})`);
      
      // Verificar balance antes de vender
      const baseAsset = trade.pair.slice(0, -3);
      const hasBalance = await checkBalance(baseAsset, trade.quantity);
      
      if (!hasBalance) {
        throw new Error(`Saldo insuficiente de ${baseAsset} para vender`);
      }

      // Ejecutar orden de venta
      const sellOrder = await kraken.api('AddOrder', {
        pair: trade.pair,
        type: 'sell',
        ordertype: 'market',
        volume: trade.quantity.toString(),
        validate: false
      });

      // Calcular ganancias
      const profitPercent = ((currentPrice - trade.buyPrice) / trade.buyPrice) * 100;
      
      // Actualizar trade en la base de datos
      await new Promise((resolve, reject) => {
        db.run(
          `UPDATE trades 
           SET status = 'completed', 
               sellPrice = ?, 
               profitPercent = ?,
               updatedAt = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [currentPrice, profitPercent, trade.id],
          (err) => err ? reject(err) : resolve()
        );
      });

      console.log(`💰 VENTA: ${trade.quantity} ${trade.pair} @ ${currentPrice} (Ganancia: ${profitPercent.toFixed(2)}%)`);
    }
  } catch (error) {
    console.error(`⚠️ Error verificando trade ID ${trade.id} (${trade.pair}): ${error.message}`);
    
    // Si el error es de saldo insuficiente, marcamos el trade como problemático
    if (error.message.includes('Insufficient funds')) {
      await new Promise((resolve) => {
        db.run(
          "UPDATE trades SET status = 'error', updatedAt = CURRENT_TIMESTAMP WHERE id = ?",
          [trade.id],
          () => resolve() // No manejamos el error para evitar bucles
        );
      });
    }
  }
}

// Endpoint para venta manual mejorado
app.post('/vender', async (req, res) => {
  try {
    const { par, cantidad } = req.body;
    
    if (!par || !cantidad) {
      return res.status(400).json({ error: 'Parámetros faltantes: se requieren par y cantidad' });
    }
    
    const cleanPair = validateTradingPair(par);
    const percent = parseFloat(cantidad);
    
    if (isNaN(percent) || percent <= 0 || percent > 100) {
      throw new Error('"cantidad" debe ser un porcentaje entre 0 y 100');
    }

    // Buscar trade activo
    const activeTrade = await new Promise((resolve, reject) => {
      db.get(
        "SELECT * FROM trades WHERE pair = ? AND status = 'active' LIMIT 1", 
        [cleanPair],
        (err, row) => err ? reject(err) : resolve(row)
      );
    });

    if (!activeTrade) {
      throw new Error(`No hay trades activos para ${cleanPair}`);
    }

    // Verificar balance
    const baseAsset = cleanPair.slice(0, -3);
    const balance = await kraken.api('Balance');
    const available = parseFloat(balance.result[baseAsset] || '0');
    const volume = Math.floor((available * percent / 100) * 100000000) / 100000000;
    
    if (volume <= 0) {
      throw new Error('Cantidad a vender demasiado baja');
    }

    // Obtener precio actual
    const ticker = await axios.get(`https://api.kraken.com/0/public/Ticker?pair=${cleanPair}`);
    const currentPrice = parseFloat(ticker.data.result[cleanPair]?.c?.[0]);
    
    if (!currentPrice) {
      throw new Error('No se pudo obtener el precio actual');
    }

    // Ejecutar venta
    const order = await kraken.api('AddOrder', {
      pair: cleanPair,
      type: 'sell',
      ordertype: 'market',
      volume: volume.toString(),
      validate: false
    });

    // Calcular ganancias
    const profitPercent = ((currentPrice - activeTrade.buyPrice) / activeTrade.buyPrice) * 100;
    
    // Actualizar trade
    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE trades 
         SET status = 'completed', 
             sellPrice = ?,
             profitPercent = ?,
             updatedAt = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [currentPrice, profitPercent, activeTrade.id],
        (err) => err ? reject(err) : resolve()
      );
    });

    console.log(`💥 VENTA MANUAL: ${volume} ${baseAsset} (${percent}%) en ${cleanPair} @ ${currentPrice}`);
    
    return res.status(200).json({
      status: 'venta ejecutada',
      orderId: order.result.txid[0],
      pair: cleanPair,
      baseAsset,
      cantidadVendida: volume,
      precioVenta: currentPrice,
      porcentaje: percent,
      gananciaPorcentual: profitPercent
    });

  } catch (error) {
    console.error(`❌ Error en /vender [${req.body.par || 'N/A'}]: ${error.message}`);
    return res.status(500).json({ 
      error: error.message,
      details: error.response?.data || null
    });
  }
});

// Endpoints adicionales (status, trades, etc.) - Similar a tu versión original
app.get('/status', async (req, res) => {
  try {
    const [activeTrades, balance] = await Promise.all([
      new Promise((resolve, reject) => {
        db.get("SELECT COUNT(*) as active FROM trades WHERE status = 'active'", (err, row) => {
          err ? reject(err) : resolve(row ? row.active : 0);
        });
      }),
      kraken.api('Balance').catch(() => ({ result: 'Error al obtener balance' }))
    ]);

    res.status(200).json({ 
      status: 'running', 
      activeTrades,
      balance: balance.result,
      uptime: process.uptime() 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Inicialización del servidor
async function startServer() {
  try {
    await initializeDB();
    
    // Verificar trades activos al iniciar
    const activeTrades = await new Promise((resolve, reject) => {
      db.all("SELECT * FROM trades WHERE status = 'active'", (err, rows) => {
        err ? reject(err) : resolve(rows || []);
      });
    });

    if (activeTrades.length > 0) {
      console.log(`🔍 ${activeTrades.length} trades activos encontrados al iniciar:`);
      activeTrades.forEach(trade => console.log(`- ${trade.pair} (ID: ${trade.id})`));
    }

    // Iniciar intervalo de verificación
    setInterval(() => {
      db.all("SELECT * FROM trades WHERE status = 'active'", (err, trades) => {
        if (err) return console.error('Error al leer trades:', err);
        trades.forEach(trade => checkTrade(trade));
      });
    }, CHECK_INTERVAL);

    // Iniciar servidor HTTP
    const server = app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });

    // Manejo de errores del servidor
    server.on('error', (error) => {
      console.error('❌ Error del servidor:', error);
      shutdown();
    });

  } catch (error) {
    console.error('❌ Error al iniciar el servidor:', error);
    process.exit(1);
  }
}

startServer();
