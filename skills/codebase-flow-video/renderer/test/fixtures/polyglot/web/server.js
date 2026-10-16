const express = require('express');
const { placeOrder } = require('./routes/orders');
const app = express();
app.post('/orders', placeOrder);
app.get('/health', (req, res) => res.send('ok'));
app.listen(3000);
