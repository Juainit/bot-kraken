const express = require('express');
const KrakenClient = require('kraken-api');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const CHECK_INTERVAL = 600000; // 10 minutos (ajustable)
const kraken = new KrakenClient(process.env.API_KEY, process.env.API_SECRET);

// Estado global: solo 1 trade activo a la vez
let activeTrade = null;

// Middleware para parsear tanto JSON como texto plano (RAW)
app.use(express.json()); // Intenta parsear como JSON primero
app.use(express.text({ type: '*/*' })); // Si falla, acepta texto plano

// Endpoint para alertas de TradingView
app.post('/alerta', async (req, res) => {
  let data;
  
  try {
    // Intenta parsear el body como JSON (funciona si el Content-Type es correcto)
    if (typeof req.body === 'string') {
      data = JSON.parse(req.body); // Para TradingView (texto plano)
    } else {
      data = req.body; // Para solicitudes con Content-Type: application/json
    }
  } catch (e) {
    return res.status(400).json({ error: 'Formato inválido. Envía un JSON válido.' });
  }

  const { par, cantidad, trailingStopPercent } = data;

  // Validaciones
  if (activeTrade) {
    return res.status(400).json({ error: 'Ya hay un trade activo. Vende antes de comprar.' });
  }
  if (!par || !cantidad || !trailingStopPercent) {
    return res.status(400).json({ error: 'Faltan parámetros (par, cantidad, trailingStopPercent)' });
  }

  try {
    // 1. Ejecutar compra
    const order = await kraken.api('AddOrder', {
      pair: par,
      type: 'buy',
      ordertype: 'market',
      volume: cantidad.toString()
    });

    // 2. Registrar el trade
    activeTrade = {
      par,
      quantity: cantidad,
      trailingStopPercent: parseFloat(trailingStopPercent),
      highestPrice: parseFloat(order.result.price),
      checkInterval: setInterval(() => checkTrailingStop(), CHECK_INTERVAL)
    };

    console.log(`✅ COMPRA: ${cantidad} ${par} | Trailing Stop: ${trailingStopPercent}%`);
    res.status(200).json({ message: 'Compra exitosa' });

  } catch (error) {
    console.error('❌ Error comprando:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Función para verificar trailing stop (sin cambios)
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
        volume: quantity.toString()
      });
      clearInterval(activeTrade.checkInterval);
      console.log(`🚨 VENTA: ${quantity} ${par} | Precio: ${currentPrice}`);
      activeTrade = null; // Liberar para nuevas operaciones
    }
  } catch (error) {
    console.error('⚠️ Error monitoreando:', error.message);
  }
}

app.listen(PORT, () => console.log(`Bot activo en puerto ${PORT}`));
