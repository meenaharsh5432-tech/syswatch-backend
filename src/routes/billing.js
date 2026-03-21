const { requireAuth } = require('../middleware/auth');
const { getUserById, updateUserPlan, getUserByStripeCustomer } = require('../db');

let _stripe = null;
function getStripe() {
  if (!_stripe && process.env.STRIPE_SECRET_KEY) {
    _stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  }
  return _stripe;
}

async function billingRoutes(fastify) {
  // POST /api/billing/checkout — create Stripe checkout session
  fastify.post('/api/billing/checkout', { preHandler: [requireAuth] }, async (req, reply) => {
    const stripe = getStripe();
    if (!stripe) return reply.status(503).send({ error: 'stripe_not_configured', message: 'Stripe is not configured' });
    if (!process.env.STRIPE_PRO_PRICE_ID) return reply.status(503).send({ error: 'stripe_not_configured', message: 'STRIPE_PRO_PRICE_ID not set' });

    try {
      const user = getUserById(req.user.userId);
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        payment_method_types: ['card'],
        customer_email: user.email,
        line_items: [{ price: process.env.STRIPE_PRO_PRICE_ID, quantity: 1 }],
        success_url: `${frontendUrl}/billing?success=true`,
        cancel_url: `${frontendUrl}/billing?canceled=true`,
        metadata: { userId: String(user.id) }
      });

      return reply.send({ url: session.url });
    } catch (err) {
      fastify.log.error('[Billing] checkout error:', err.message);
      return reply.status(500).send({ error: 'checkout_failed', message: err.message });
    }
  });

  // POST /api/billing/portal — create Stripe billing portal session
  fastify.post('/api/billing/portal', { preHandler: [requireAuth] }, async (req, reply) => {
    const stripe = getStripe();
    if (!stripe) return reply.status(503).send({ error: 'stripe_not_configured', message: 'Stripe is not configured' });

    try {
      const user = getUserById(req.user.userId);
      if (!user.stripe_customer_id) {
        return reply.status(400).send({ error: 'no_subscription', message: 'No active subscription found' });
      }

      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      const session = await stripe.billingPortal.sessions.create({
        customer: user.stripe_customer_id,
        return_url: `${frontendUrl}/billing`
      });

      return reply.send({ url: session.url });
    } catch (err) {
      fastify.log.error('[Billing] portal error:', err.message);
      return reply.status(500).send({ error: 'portal_failed', message: err.message });
    }
  });

  // POST /api/billing/webhook — Stripe webhook (needs raw body)
  fastify.post('/api/billing/webhook', { config: { rawBody: true } }, async (req, reply) => {
    const stripe = getStripe();
    if (!stripe) return reply.status(503).send({ error: 'stripe_not_configured' });

    const sig = req.headers['stripe-signature'];
    if (!sig) return reply.status(400).send({ error: 'missing_signature' });

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      fastify.log.warn('[Billing] Webhook signature failed:', err.message);
      return reply.status(400).send({ error: 'invalid_signature', message: err.message });
    }

    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const userId = parseInt(session.metadata?.userId);
        if (userId) {
          updateUserPlan(userId, 'pro', session.customer, session.subscription);
          fastify.log.info('[Billing] User', userId, 'upgraded to pro');
        }
      }

      if (event.type === 'customer.subscription.deleted') {
        const sub = event.data.object;
        const user = getUserByStripeCustomer(sub.customer);
        if (user) {
          updateUserPlan(user.id, 'free');
          fastify.log.info('[Billing] User', user.id, 'downgraded to free');
        }
      }
    } catch (err) {
      fastify.log.error('[Billing] Webhook handler error:', err.message);
    }

    return reply.send({ received: true });
  });

  // GET /api/billing/status
  fastify.get('/api/billing/status', { preHandler: [requireAuth] }, async (req, reply) => {
    const user = getUserById(req.user.userId);
    return reply.send({
      plan: user.plan,
      hasSubscription: !!user.stripe_subscription_id,
      email: user.email
    });
  });
}

module.exports = billingRoutes;
