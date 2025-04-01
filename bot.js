const express = require('express');
const KrakenClient = require('kraken-api');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const CHECK_INTERVAL = 600000; // 10 minutos
const kraken = new KrakenClient(process.env.API_KEY, process.env.API_SECRET);

let activeTrade = null;

// Middleware para parsear JSON y texto plano
app.use(express.json());
app.use(express.text({ type: '*/*' }));

// Endpoint para alertas (¡VERSIÓN ACTUALIZADA!)
app.post('/alerta', async (req, res) => {
  let data;
  try {
    // 1. Parsear el body (soporta JSON y texto plano)
    if (typeof req.body === 'string') {
      const rawData = req.body.replace(/\{\{|\}\}/g, '').trim(); // Elimina {{}} si existen
      data = JSON.parse(rawData);
    } else {
      data = req.body;
    }

    const { par, cantidadUSD, trailingStopPercent } = data;

    // 2. Validaciones básicas
    if (activeTrade) {
      return res.status(400).json({ error: 'Ya hay un trade activo. Vende antes de comprar.' });
    }
    if (!par || !cantidadUSD || !trailingStopPercent) {
      return res.status(400).json({ error: 'Faltan parámetros (par, cantidadUSD, trailingStopPercent)' });
    }

    // 3. Limpiar y validar el par
    const cleanPair = par.replace(/[^a-zA-Z0-9]/g, ''); // Elimina caracteres no alfanuméricos
    if (cleanPair !== par) {
      console.warn(`⚠️ Par corregido: ${par} → ${cleanPair}`);
    }

    // 4. Verificar si el par existe en Kraken
    const ticker = await axios.get(`https://api.kraken.com/0/public/Ticker?pair=${cleanPair}`).catch(e => {
      throw new Error(`Par ${cleanPair} no válido en Kraken. ¿Quizás es REQUSD o SOLUSD?`);
    });

    if (!ticker.data.result[cleanPair]) {
      throw new Error(`Par ${cleanPair} no encontrado en Kraken`);
    }

    // 5. Lógica original de compra (sin cambios)
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
    console.error('❌ Error mejorado:', error.message);
    res.status(500).json({ 
      error: error.message,
      suggestion: "Usa pares válidos como REQUSD, SOLUSD o XBTUSD. Ver lista: https://api.kraken.com/0/public/AssetPairs"
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

app.listen(PORT, () => console.log(`Bot activo en puerto ${PORT}`));
