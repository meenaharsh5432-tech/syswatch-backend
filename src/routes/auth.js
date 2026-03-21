const { createUser, getUserByGoogleId, getUserById } = require('../db');
const { requireAuth } = require('../middleware/auth');

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

async function authRoutes(fastify) {
  // GET /auth/google — redirect to Google
  fastify.get('/auth/google', async (req, reply) => {
    if (!process.env.GOOGLE_CLIENT_ID) {
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      return reply.redirect(`${frontendUrl}/login?error=oauth_not_configured`);
    }
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3001/auth/google/callback',
      response_type: 'code',
      scope: 'email profile',
      access_type: 'offline'
    });
    return reply.redirect(`${GOOGLE_AUTH_URL}?${params}`);
  });

  // GET /auth/google/callback — exchange code, create user, issue JWT
  fastify.get('/auth/google/callback', async (req, reply) => {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    try {
      const { code, error } = req.query;
      if (error || !code) throw new Error(error || 'No authorization code received');

      const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uri: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3001/auth/google/callback',
          grant_type: 'authorization_code'
        }).toString()
      });
      const tokens = await tokenRes.json();
      if (!tokens.access_token) throw new Error('Failed to get access token from Google');

      const profileRes = await fetch(`${GOOGLE_USERINFO_URL}?access_token=${tokens.access_token}`);
      const profile = await profileRes.json();
      if (!profile.email) throw new Error('Failed to get user profile from Google');

      let user = getUserByGoogleId(profile.id);
      if (!user) {
        user = createUser({
          email: profile.email,
          name: profile.name,
          avatar: profile.picture,
          google_id: profile.id
        });
      }

      const jwt = fastify.jwt.sign(
        { userId: user.id, email: user.email, plan: user.plan },
        { expiresIn: '7d' }
      );

      return reply.redirect(`${frontendUrl}/auth/callback?token=${jwt}`);
    } catch (err) {
      fastify.log.error('[Auth] OAuth error:', err.message);
      return reply.redirect(`${frontendUrl}/login?error=auth_failed`);
    }
  });

  // GET /api/auth/me — current user info
  fastify.get('/api/auth/me', { preHandler: [requireAuth] }, async (req, reply) => {
    const user = getUserById(req.user.userId);
    if (!user) return reply.status(404).send({ error: 'not_found', message: 'User not found' });
    const { google_id, stripe_customer_id, stripe_subscription_id, ...safe } = user;
    return reply.send(safe);
  });

  // POST /api/auth/refresh — re-issue JWT with latest plan info
  fastify.post('/api/auth/refresh', { preHandler: [requireAuth] }, async (req, reply) => {
    const user = getUserById(req.user.userId);
    if (!user) return reply.status(404).send({ error: 'not_found', message: 'User not found' });
    const jwt = fastify.jwt.sign(
      { userId: user.id, email: user.email, plan: user.plan },
      { expiresIn: '7d' }
    );
    return reply.send({ token: jwt });
  });
}

module.exports = authRoutes;
