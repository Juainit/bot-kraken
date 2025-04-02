const express = require('express');
const KrakenClient = require('kraken-api');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const CHECK_INTERVAL = 600000; // 10 minutos
const kraken = new KrakenClient(process.env.API_KEY, process.env.API_SECRET);

let activeTrade = null;

// ===== MIDDLEWARE UNIFICADO PARA PARSING =====
app.use((req, res, next) => {
  console.log("Content-Type recibido:", req.headers['content-type']);
  console.log("Método HTTP:", req.method);
  
  if (req.headers['content-type']?.includes('application/json')) {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
    });
    req.on('end', () => {
      try {
        req.body = JSON.parse(data);
        next();
      } catch (e) {
        console.error("Error al parsear JSON:", e.message);
        res.status(400).json({ error: 'JSON inválido' });
      }
    });
  } else {
    express.text({ type: '*/*' })(req, res, next);
  }
});
// ============================================

app.post('/alerta', async (req, res) => {
  console.log("Body recibido (objeto):", req.body); // <-- Verificamos el body ya parseado
  
  try {
    // Verificamos que req.body es un objeto válido
    if (!req.body || typeof req.body !== 'object') {
      throw new Error('El cuerpo de la solicitud no es un JSON válido');
    }

    // Extraemos parámetros directamente del body ya parseado
    const { par, cantidadUSD, trailingStopPercent } = req.body;

    // Validaciones básicas
    if (activeTrade) {
      return res.status(400).json({ error: 'Ya hay un trade activo. Vende antes de comprar.' });
    }
    if (!par || !cantidadUSD || !trailingStopPercent) {
      return res.status(400).json({ error: 'Faltan parámetros (par, cantidadUSD, trailingStopPercent)' });
    }

    // Limpiar y validar el par
    const cleanPair = par.replace(/[^a-zA-Z0-9]/g, '');
    if (cleanPair !== par) {
      console.warn(`⚠️ Par corregido: ${par} → ${cleanPair}`);
    }

    // Verificar si el par existe en Kraken
    const ticker = await axios.get(`https://api.kraken.com/0/public/Ticker?pair=${cleanPair}`).catch(e => {
      throw new Error(`Par ${cleanPair} no válido en Kraken. ¿Quizás es REQUSD o SOLUSD?`);
    });

    if (!ticker.data.result[cleanPair]) {
      throw new Error(`Par ${cleanPair} no encontrado en Kraken`);
    }

    // Lógica de compra
    const currentPrice = parseFloat(ticker.data.result[cleanPair].c[0]);
    const cantidadCrypto = (cantidadUSD / currentPrice).toFixed(8);

    const order = await kraken.api('AddOrder', {
      pair: cleanPair,
      type: 'buy',
      ordertype: 'market',
      volume: cantidadCrypto
    });

    activeTrade = {
      par: cleanPair,
      quantity: cantidadCrypto,
      trailingStopPercent: parseFloat(trailingStopPercent),
      highestPrice: parseFloat(order.result.price),
      checkInterval: setInterval(() => checkTrailingStop(), CHECK_INTERVAL)
    };

    console.log(`✅ COMPRA: $${cantidadUSD} USD → ${cantidadCrypto} ${cleanPair} | Stop: ${trailingStopPercent}%`);
    res.status(200).json({ message: 'Compra exitosa' });

  } catch (error) {
    console.error('❌ Error en endpoint /alerta:', error.message);
    res.status(500).json({ 
      error: error.message,
      suggestion: "Verifica el formato: {'par':'SOLUSD','cantidadUSD':12,'trailingStopPercent':5}"
    });
  }
});

// Función de trailing stop
async function checkTrailingStop() {
  if (!activeTrade) return;

  try {
    const { par, quantity, trailingStopPercent, highestPrice } = activeTrade;
    const ticker = await axios.get(`https://api.kraken.com/0/public/Ticker?pair=${par}`);
    const currentPrice = parseFloat(ticker.data.result[par].c[0]);

    // Actualizar precio máximo
    activeTrade.highestPrice = Math.max(highestPrice, currentPrice);
    const stopPrice = activeTrade.highestPrice * (1 - (trailingStopPercent / 100));

    console.log(`📊 ${par} | Precio: ${currentPrice} | Máx: ${activeTrade.highestPrice} | Stop: ${stopPrice}`);

    // Vender si se activa el trailing stop
    if (currentPrice <= stopPrice) {
      await kraken.api('AddOrder', {
        pair: par,
        type: 'sell',
        ordertype: 'market',
        volume: quantity
      });
      clearInterval(activeTrade.checkInterval);
      console.log(`🚨 VENTA: ${quantity} ${par} | Precio: ${currentPrice}`);
      activeTrade = null;
    }
  } catch (error) {
    console.error('⚠️ Error monitoreando:', error.message);
  }
}
// Añade esto ANTES del app.listen:
app.get('/', (req, res) => {
  res.status(200).json({ 
    status: '🚀 Bot activo',
    endpoints: {
      alerta: 'POST /alerta',
      description: 'Envía una alerta de TradingView para comprar en Kraken'
    }
  });
});
app.listen(PORT, () => console.log(`Bot activo en puerto ${PORT}`));
