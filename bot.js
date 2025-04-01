const express = require('express');
const KrakenClient = require('kraken-api');
const app = express();

app.use(express.json());

const kraken = new KrakenClient(
  process.env.API_KEY,   // Lo pondremos luego en Railway
  process.env.API_SECRET
);

app.post('/alerta', async (req, res) => {
  const { tipo, par, cantidad } = req.body;
  try {
    const respuesta = await kraken.api('AddOrder', {
      pair: par || 'XBTUSD',
      type: tipo,  // "buy" o "sell"
      ordertype: 'market',
      volume: cantidad || '0.01'
    });
    console.log('✅ Orden ejecutada:', respuesta);
    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).send('Error');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot listo en puerto ${PORT}`));
