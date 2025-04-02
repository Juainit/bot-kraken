const express = require('express');
const KrakenClient = require('kraken-api');
const axios = require('axios');
const dotenv = require('dotenv');

// Configuración inicial
dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;
const CHECK_INTERVAL = process.env.CHECK_INTERVAL || 600000; // 10 minutos por defecto

// Validación de variables de entorno
const requiredEnvVars = ['API_KEY', 'API_SECRET'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  console.error(`❌ [${new Date().toISOString()}] Variables de entorno faltantes: ${missingVars.join(', ')}`);
  process.exit(1);
}

console.log(`✅ [${new Date().toISOString()}] Configuración inicial completada`);

const kraken = new KrakenClient(process.env.API_KEY, process.env.API_SECRET);

// Estado del trade
let activeTrade = null;

// Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Validación de seguridad básica
app.use((req, res, next) => {
  res.setHeader('X-Powered-By', 'Kraken Trading Bot');
  next();
});

/**
 * Verifica el saldo disponible para un par de trading
 */
async function checkBalance(pair) {
  try {
    const balance = await kraken.api('Balance');
    const currency = pair.replace('USD', '');
    const balanceKey = [`Z${currency}`, `X${currency}`].find(key => balance.result[key]);
    
    return parseFloat(balance.result[balanceKey] || 0);
  } catch (error) {
    console.error(`⚠️ [${new Date().toISOString()}] Error al verificar saldo: ${error.message}`);
    throw error;
  }
}

/**
 * Limpia caracteres inválidos del par de trading
 */
function validateTradingPair(pair) {
  const cleanPair = pair.replace(/[^a-zA-Z0-9]/g, '');
  if (cleanPair !== pair) {
    console.warn(`⚠️ [${new Date().toISOString()}] Par corregido: ${pair} → ${cleanPair}`);
  }
  return cleanPair;
}

/**
 * Calcula la cantidad basada en el precio actual
 */
function calculateQuantity(amount, price) {
  return (amount / price).toFixed(8);
}

/**
 * Ejecuta una orden de compra en Kraken
 */
async function executeBuyOrder(pair, amount) {
  try {
    const ticker = await axios.get(`https://api.kraken.com/0/public/Ticker?pair=${pair}`);
    
    if (!ticker.data.result?.[pair]) {
      throw new Error(`Par ${pair} no encontrado en Kraken`);
    }

    const currentPrice = parseFloat(ticker.data.result[pair].c[0]);
    const quantity = calculateQuantity(amount, currentPrice);

    console.log(`🛒 [${new Date().toISOString()}] Ejecutando orden de compra para ${pair}: ${quantity} @ ${currentPrice}`);

    return await kraken.api('AddOrder', {
      pair,
      type: 'buy',
      ordertype: 'market',
      volume: quantity.toString()
    });
  } catch (error) {
    console.error(`❌ [${new Date().toISOString()}] Error en executeBuyOrder: ${error.message}`);
    throw error;
  }
}

/**
 * Ejecuta una orden de venta en Kraken
 */
async function executeSellOrder(pair, quantity) {
  try {
    console.log(`🛒 [${new Date().toISOString()}] Ejecutando orden de venta para ${pair}: ${quantity}`);
    
    return await kraken.api('AddOrder', {
      pair,
      type: 'sell',
      ordertype: 'market',
      volume: quantity.toString()
    });
  } catch (error) {
    console.error(`❌ [${new Date().toISOString()}] Error en executeSellOrder: ${error.message}`);
    throw error;
  }
}

// Endpoint para recibir alertas
app.post('/alerta', async (req, res) => {
  try {
    const { par, cantidadUSD, trailingStopPercent } = req.body;

    // Validaciones
    if (activeTrade) {
      return res.status(400).json({ 
        error: 'Ya hay un trade activo', 
        suggestion: 'Vende el trade actual antes de abrir uno nuevo' 
      });
    }

    if (!par || !cantidadUSD || !trailingStopPercent) {
      return res.status(400).json({ 
        error: 'Parámetros faltantes',
        required: ['par', 'cantidadUSD', 'trailingStopPercent']
      });
    }

    const cleanPair = validateTradingPair(par);
    const amount = parseFloat(cantidadUSD);
    const stopPercent = parseFloat(trailingStopPercent);

    if (isNaN(amount)) throw new Error('cantidadUSD debe ser un número');
    if (isNaN(stopPercent)) throw new Error('trailingStopPercent debe ser un número');

    // Ejecutar compra
    const order = await executeBuyOrder(cleanPair, amount);
    
    // Configurar trailing stop
    const ticker = await axios.get(`https://api.kraken.com/0/public/Ticker?pair=${cleanPair}`);
    const currentPrice = parseFloat(ticker.data.result[cleanPair].c[0]);

    activeTrade = {
      par: cleanPair,
      quantity: calculateQuantity(amount, currentPrice),
      trailingStopPercent: stopPercent,
      highestPrice: currentPrice,
      checkInterval: setInterval(checkTrailingStop, CHECK_INTERVAL)
    };

    console.log(`✅ [${new Date().toISOString()}] COMPRA: $${amount} USD → ${activeTrade.quantity} ${cleanPair} | Stop: ${stopPercent}%`);

    res.status(200).json({ 
      status: 'success',
      message: 'Compra exitosa',
      orderId: order.result.txid[0],
      pair: cleanPair,
      amount,
      quantity: activeTrade.quantity
    });

  } catch (error) {
    console.error(`❌ [${new Date().toISOString()}] Error en /alerta: ${error.message}`);
    res.status(500).json({ 
      error: error.message,
      details: error.response?.data || null
    });
  }
});

/**
 * Verifica si se debe activar el trailing stop
 */
async function checkTrailingStop() {
  if (!activeTrade) return;

  try {
    const { par, quantity, trailingStopPercent, highestPrice } = activeTrade;
    
    // Verificar saldo primero
    const currentBalance = await checkBalance(par);
    if (currentBalance <= 0) {
      console.log(`⚠️ [${new Date().toISOString()}] Sin saldo de ${par}. Trade cancelado.`);
      clearTrade();
      return;
    }

    // Obtener precio actual
    const ticker = await axios.get(`https://api.kraken.com/0/public/Ticker?pair=${par}`);
    const currentPrice = parseFloat(ticker.data.result[par].c[0]);

    // Actualizar precio máximo
    activeTrade.highestPrice = Math.max(highestPrice, currentPrice);
    const stopPrice = activeTrade.highestPrice * (1 - (trailingStopPercent / 100));

    console.log(`📊 [${new Date().toISOString()}] ${par} | Precio: ${currentPrice} | Máx: ${activeTrade.highestPrice} | Stop: ${stopPrice}`);

    // Verificar si se debe vender
    if (currentPrice <= stopPrice) {
      const sellOrder = await executeSellOrder(par, quantity);
      clearTrade();
      
      console.log(`🚨 [${new Date().toISOString()}] VENTA: ${quantity} ${par} | Precio: ${currentPrice} | Orden ID: ${sellOrder.result.txid[0]}`);
    }
  } catch (error) {
    console.error(`⚠️ [${new Date().toISOString()}] Error en checkTrailingStop: ${error.message}`);
  }
}

/**
 * Limpia el trade activo
 */
function clearTrade() {
  if (activeTrade?.checkInterval) {
    clearInterval(activeTrade.checkInterval);
  }
  activeTrade = null;
}

// Endpoint para ver estado
app.get('/status', (req, res) => {
  res.status(200).json({
    status: 'active',
    activeTrade,
    lastChecked: new Date().toISOString()
  });
});

// Endpoint principal
app.get('/', (req, res) => {
  res.status(200).json({
    status: '🚀 Bot activo',
    endpoints: [
      { method: 'POST', path: '/alerta', description: 'Recibe alertas de trading' },
      { method: 'GET', path: '/status', description: 'Obtiene el estado actual del bot' }
    ],
    environment: process.env.NODE_ENV || 'development',
    uptime: process.uptime()
  });
});

// Manejo de errores global
process.on('unhandledRejection', (error) => {
  console.error(`⚠️ [${new Date().toISOString()}] Unhandled Rejection: ${error.message}`);
});

process.on('uncaughtException', (error) => {
  console.error(`⚠️ [${new Date().toISOString()}] Uncaught Exception: ${error.message}`);
  process.exit(1);
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`✅ [${new Date().toISOString()}] Bot activo en puerto ${PORT}`);
  console.log(`⏱️ [${new Date().toISOString()}] Intervalo de verificación: ${CHECK_INTERVAL/1000} segundos`);
});
