async function requireAuth(req, reply) {
  try {
    await req.jwtVerify();
  } catch {
    return reply.status(401).send({ error: 'unauthorized', message: 'Authentication required' });
  }
}

async function optionalAuth(req, reply) {
  try {
    await req.jwtVerify();
  } catch {
    // Not authenticated — that's OK for optional routes
  }
}

module.exports = { requireAuth, optionalAuth };
