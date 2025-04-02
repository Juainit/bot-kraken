const express = require('express');
const KrakenClient = require('kraken-api');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const CHECK_INTERVAL = 600000; // 10 minutos
const kraken = new KrakenClient(process.env.API_KEY, process.env.API_SECRET);

let activeTrade = null;

// Middleware estándar para parsear JSON correctamente
app.use(express.json());

app.post('/alerta', async (req, res) => {
  console.log("Body recibido (objeto):", req.body);

  try {
    const { par, cantidadUSD, trailingStopPercent } = req.body;

    if (activeTrade) {
      return res.status(400).json({ error: 'Ya hay un trade activo. Vende antes de comprar.' });
    }
    if (!par || !cantidadUSD || !trailingStopPercent) {
      return res.status(400).json({ error: 'Faltan parámetros (par, cantidadUSD, trailingStopPercent)' });
    }

    const cleanPair = par.replace(/[^a-zA-Z0-9]/g, '');
    if (cleanPair !== par) {
      console.warn(`⚠️ Par corregido: ${par} → ${cleanPair}`);
    }

    const ticker = await axios.get(`https://api.kraken.com/0/public/Ticker?pair=${cleanPair}`).catch(e => {
      throw new Error(`Par ${cleanPair} no válido en Kraken. ¿Quizás es REQUSD o SOLUSD?`);
    });

    if (!ticker.data.result[cleanPair]) {
      throw new Error(`Par ${cleanPair} no encontrado en Kraken`);
    }

    const currentPrice = parseFloat(ticker.data.result[cleanPair].c[0]);
    const cantidadCrypto = (cantidadUSD / currentPrice).toFixed(8);

    const order = await kraken.api('AddOrder', {
      pair: cleanPair,
      type: 'buy',
      ordertype: 'market',
      volume: cantidadCrypto.toString()
    });

    activeTrade = {
      par: cleanPair,
      quantity: cantidadCrypto,
      trailingStopPercent: parseFloat(trailingStopPercent),
      highestPrice: currentPrice,
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

async function checkTrailingStop() {
  if (!activeTrade) return;

  try {
    const { par, quantity, trailingStopPercent, highestPrice } = activeTrade;
    const ticker = await axios.get(`https://api.kraken.com/0/public/Ticker?pair=${par}`);
    const currentPrice = parseFloat(ticker.data.result[par].c[0]);

    activeTrade.highestPrice = Math.max(highestPrice, currentPrice);
    const stopPrice = activeTrade.highestPrice * (1 - (trailingStopPercent / 100));

    console.log(`📊 ${par} | Precio: ${currentPrice} | Máx: ${activeTrade.highestPrice} | Stop: ${stopPrice}`);

    if (currentPrice <= stopPrice) {
      await kraken.api('AddOrder', {
        pair: par,
        type: 'sell',
        ordertype: 'market',
        volume: quantity.toString()
      });
      clearInterval(activeTrade.checkInterval);
      console.log(`🚨 VENTA: ${quantity} ${par} | Precio: ${currentPrice}`);
      activeTrade = null;
    }
  } catch (error) {
    console.error('⚠️ Error monitoreando:', error.message);
  }
}

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
