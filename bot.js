const express = require('express');
const KrakenClient = require('kraken-api');
const axios = require('axios');
const dotenv = require('dotenv');

// Configuración inicial
dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL) || 600000; // 10 minutos

// Validación de variables de entorno
const requiredEnvVars = ['API_KEY', 'API_SECRET'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  console.error(`❌ [${new Date().toISOString()}] Missing required environment variables: ${missingVars.join(', ')}`);
  process.exit(1);
}

const kraken = new KrakenClient(process.env.API_KEY, process.env.API_SECRET);
let activeTrade = null;

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
  const validCurrencies = ['USD', 'EUR', 'GBP', 'CAD']; // Añade más si necesitas
  
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
  return Math.floor(quantity * 100000000) / 100000000; // 8 decimales
}

// API Endpoints
app.post('/alerta', async (req, res) => {
  try {
    const { par, cantidad, trailingStopPercent } = req.body; // Cambiado de "cantidadUSD" a "cantidad"

    // Validación de parámetros
    if (!par || !cantidad || !trailingStopPercent) {
      return res.status(400).json({ 
        error: 'Parámetros faltantes',
        required: ['par', 'cantidad', 'trailingStopPercent'] // Actualizado
      });
    }

    // Validar el par y extraer moneda (EUR/USD/GBP/etc.)
    const cleanPair = validateTradingPair(par);
    const currency = cleanPair.slice(-3); // Extrae "EUR", "USD", etc.
    const amount = parseFloat(cantidad);

    // Validar cantidad y trailing stop
    if (isNaN(amount) || amount <= 0) {
      throw new Error('"cantidad" debe ser un número positivo');
    }

    if (isNaN(trailingStopPercent) || trailingStopPercent <= 0 || trailingStopPercent >= 100) {
      throw new Error('"trailingStopPercent" debe ser entre 0 y 100');
    }

    // Obtener precio actual
    const tickerResponse = await axios.get(`https://api.kraken.com/0/public/Ticker?pair=${cleanPair}`);
    if (!tickerResponse.data.result || !tickerResponse.data.result[cleanPair]) {
      throw new Error(`Par ${cleanPair} no válido`);
    }

    const currentPrice = parseFloat(tickerResponse.data.result[cleanPair].c[0]);
    const quantity = calculateQuantity(amount, currentPrice);

    // Ejecutar orden de compra
    const order = await kraken.api('AddOrder', {
      pair: cleanPair,
      type: 'buy',
      ordertype: 'market',
      volume: quantity.toString()
    });

    // Registrar la operación activa
    activeTrade = {
      pair: cleanPair,
      quantity,
      stopPercent: parseFloat(trailingStopPercent),
      highestPrice: currentPrice,
      checkInterval: setInterval(checkTrailingStop, CHECK_INTERVAL)
    };

    console.log(`✅ [${new Date().toISOString()}] COMPRA: ${quantity} ${cleanPair} @ ${currentPrice} ${currency}`);

    return res.status(200).json({
      status: 'success',
      orderId: order.result.txid[0],
      pair: cleanPair,
      quantity,
      price: currentPrice,
      currency // Añadido para claridad
    });

  } catch (error) {
    console.error(`❌ [${new Date().toISOString()}] Error: ${error.message}`);
    return res.status(500).json({ 
      error: error.message,
      details: error.response?.data || null
    });
  }
});

async function checkTrailingStop() {
  if (!activeTrade) return;

  try {
    const { pair, quantity, stopPercent, highestPrice } = activeTrade;
    const ticker = await axios.get(`https://api.kraken.com/0/public/Ticker?pair=${pair}`);
    const currentPrice = parseFloat(ticker.data.result[pair].c[0]);

    activeTrade.highestPrice = Math.max(highestPrice, currentPrice);
    const stopPrice = activeTrade.highestPrice * (1 - (stopPercent / 100));

    if (currentPrice <= stopPrice) {
      const sellOrder = await kraken.api('AddOrder', {
        pair,
        type: 'sell',
        ordertype: 'market',
        volume: quantity.toString()
      });

      clearInterval(activeTrade.checkInterval);
      activeTrade = null;
      console.log(`💰 [${new Date().toISOString()}] VENTA: ${quantity} ${pair} @ ${currentPrice}`);
    }
  } catch (error) {
    console.error(`⚠️ [${new Date().toISOString()}] Monitoring Error: ${error.message}`);
  }
}

// Health Check
app.get('/status', (req, res) => {
  res.status(200).json({
    status: 'running',
    activeTrade: !!activeTrade,
    uptime: process.uptime()
  });
});

// Error Handling
process.on('unhandledRejection', (error) => {
  console.error(`⚠️ [${new Date().toISOString()}] Unhandled Rejection: ${error.message}`);
});

process.on('uncaughtException', (error) => {
  console.error(`🚨 [${new Date().toISOString()}] Uncaught Exception: ${error.message}`);
  process.exit(1);
});

// Start Server
app.listen(PORT, () => {
  console.log(`🚀 [${new Date().toISOString()}] Server running on port ${PORT}`);
});
