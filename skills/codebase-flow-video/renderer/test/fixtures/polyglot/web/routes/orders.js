const { charge } = require('../services/payments');
const db = require('../services/db');

async function placeOrder(req, res) {
  const order = parseOrder(req.body);
  if (!order.items.length) {
    return res.status(400).send('empty');
  }
  try {
    await charge(order.total, order.card);
  } catch (err) {
    return res.status(402).send('declined');
  }
  await db.saveOrder(order);
  res.status(201).send(order.id);
}

function parseOrder(body) {
  return { id: body.id, items: body.items || [], total: body.total, card: body.card };
}

module.exports = { placeOrder };
