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

// Validación de variables de entorno
const requiredEnvVars = ['API_KEY', 'API_SECRET'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  console.error(`❌ [${new Date().toISOString()}] Missing required environment variables: ${missingVars.join(', ')}`);
  process.exit(1);
}

// Configuración mejorada de Kraken API
const kraken = new KrakenClient(process.env.API_KEY, process.env.API_SECRET, {
  nonceWindow: true
});

// Conexión a la base de datos con manejo de errores
const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
  if (err) {
    console.error('❌ Error al abrir la base de datos:', err.message);
    process.exit(1);
  }
  console.log('✅ Conectado a la base de datos SQLite');
});

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

// Función mejorada para obtener información de columnas
async function getTableColumns(tableName) {
  return new Promise((resolve, reject) => {
    db.all(`PRAGMA table_info(${tableName})`, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

// Inicialización de la base de datos
async function initializeDB() {
  try {
    // Crear tabla si no existe
    await new Promise((resolve, reject) => {
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
      `, (err) => err ? reject(err) : resolve());
    });

    // Verificar y agregar columnas faltantes
    const columns = await getTableColumns('trades');
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

    // Ejecutar migraciones
    for (const migration of migrations) {
      await new Promise((resolve, reject) => {
        db.run(migration, (err) => err ? reject(err) : resolve());
      });
      console.log(`✅ Ejecutada migración: ${migration}`);
    }

    // Crear índices
    await new Promise((resolve, reject) => {
      db.run("CREATE INDEX IF NOT EXISTS idx_trades_pair ON trades(pair)", (err) => {
        if (err) console.error('⚠️ Error creando índice pair:', err.message);
        resolve();
      });
    });

    await new Promise((resolve, reject) => {
      db.run("CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status)", (err) => {
        if (err) console.error('⚠️ Error creando índice status:', err.message);
        resolve();
      });
    });

    // Actualizar profitPercent para trades completados
    const incompleteTrades = await new Promise((resolve, reject) => {
      db.all(
        "SELECT * FROM trades WHERE status = 'completed' AND profitPercent IS NULL AND sellPrice IS NOT NULL AND buyPrice IS NOT NULL",
        (err, rows) => err ? reject(err) : resolve(rows || [])
      );
    });

    for (const row of incompleteTrades) {
      const profit = ((row.sellPrice - row.buyPrice) / row.buyPrice) * 100;
      await new Promise((resolve, reject) => {
        db.run(
          "UPDATE trades SET profitPercent = ? WHERE id = ?",
          [profit, row.id],
          (err) => err ? reject(err) : resolve()
        );
      });
      console.log(`📈 Trade ID ${row.id} actualizado con profitPercent: ${profit.toFixed(2)}%`);
    }

  } catch (error) {
    console.error('❌ Error al inicializar la base de datos:', error.message);
    throw error;
  }
}

app.use(express.json());
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ... (resto de tus funciones y endpoints permanecen iguales, usa las versiones mejoradas del código anterior)

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
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });

  } catch (error) {
    console.error('❌ Error al iniciar el servidor:', error);
    process.exit(1);
  }
}

startServer();
