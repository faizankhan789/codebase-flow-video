const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_KEY);

async function charge(amount, card) {
  return stripe.charges.create({ amount, source: card });
}
module.exports = { charge };
