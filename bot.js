const express = require('express');
const KrakenClient = require('kraken-api');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const CHECK_INTERVAL = 600000; // 10 minutos

// → Aquí verificamos las variables de entorno (justo después de definir PORT)
console.log("🔑 API_KEY:", process.env.API_KEY ? "✅ Cargada" : "❌ Faltante");
console.log("🔒 API_SECRET:", process.env.API_SECRET ? "✅ Cargada" : "❌ Faltante");

const kraken = new KrakenClient(process.env.API_KEY, process.env.API_SECRET);

let activeTrade = null;

// ✨ NUEVO: Función para verificar saldo
async function checkBalance(pair) {
  try {
    const balance = await kraken.api('Balance');
    const currency = pair.replace('USD', ''); // Ej: SOLUSD → SOL
    return parseFloat(balance.result[`Z${currency}`] || balance.result[`X${currency}`] || 0);
  } catch (error) {
    console.error('⚠️ Error al verificar saldo:', error.message);
    return 0;
  }
}

// Middleware estándar
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

    // Verificar si el par existe
    const ticker = await axios.get(`https://api.kraken.com/0/public/Ticker?pair=${cleanPair}`).catch(e => {
      throw new Error(`Par ${cleanPair} no válido en Kraken`);
    });

    if (!ticker.data.result[cleanPair]) {
      console.error('Contenido recibido de Kraken:', ticker.data);
      throw new Error(`Par ${cleanPair} no encontrado en Kraken`);
    }

    const currentPrice = parseFloat(ticker.data.result[cleanPair].c[0]);
    const cantidadCrypto = (cantidadUSD / currentPrice).toFixed(8);

    console.log('🛒 Ejecutando orden de compra con los siguientes datos:');
    console.log({
      pair: cleanPair,
      volume: cantidadCrypto.toString(),
      cantidadUSD,
      currentPrice,
      trailingStopPercent
    });

    const order = await kraken.api('AddOrder', {
      pair: cleanPair,
      type: 'buy',
      ordertype: 'market',
      volume: cantidadCrypto.toString()
    });

    console.log('📥 Respuesta de Kraken tras compra:', order);

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

// Cálculo Trailing
async function checkTrailingStop() {
  if (!activeTrade) return;

  try {
    const { par, quantity, trailingStopPercent, highestPrice } = activeTrade;
    const currentBalance = await checkBalance(par); // Verifica saldo antes de vender

    if (currentBalance <= 0) {
      console.log(`⚠️ Sin saldo de ${par}. Trade cancelado.`);
      clearInterval(activeTrade.checkInterval);
      activeTrade = null;
      return;
    }

    // Lógica existente de monitoreo de precio
    const ticker = await axios.get(`https://api.kraken.com/0/public/Ticker?pair=${par}`);
    const currentPrice = parseFloat(ticker.data.result[par].c[0]);

    activeTrade.highestPrice = Math.max(highestPrice, currentPrice);
    const stopPrice = activeTrade.highestPrice * (1 - (trailingStopPercent / 100));

    console.log(`📊 ${par} | Precio: ${currentPrice} | Máx: ${activeTrade.highestPrice} | Stop: ${stopPrice}`);

    if (currentPrice <= stopPrice) {
      const sellOrder = await kraken.api('AddOrder', {
        pair: par,
        type: 'sell',
        ordertype: 'market',
        volume: quantity.toString()
      });
      clearInterval(activeTrade.checkInterval);
      console.log(`🚨 VENTA: ${quantity} ${par} | Precio: ${currentPrice} | Orden ID: ${sellOrder.result.txid[0]}`);
      activeTrade = null;
    }
  } catch (error) {
    console.error('⚠️ Error monitoreando:', error.message);
  }
}
// ... Suerte!

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
