import jwt from 'jsonwebtoken'
import axios from 'axios'
import { getPrisma } from '../lib/prisma.js'

function issueToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '30d' })
}


export async function googleRedirect(request, reply) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${process.env.BACKEND_URL || 'http://localhost:3000'}/api/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'select_account'
  })
  return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`)
}

export async function googleCallback(request, reply) {
  const prisma = getPrisma()
  const { code } = request.query

  if (!code) {
    return reply.redirect(`${process.env.FRONTEND_URL}/login?error=no_code`)
  }

  try {
    // Exchange code for tokens
    const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${process.env.BACKEND_URL || 'http://localhost:3000'}/api/auth/google/callback`,
      grant_type: 'authorization_code'
    })

    const { access_token } = tokenRes.data

    // Fetch Google profile
    const profileRes = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` }
    })

    const { id: googleId, email, name } = profileRes.data

    // Upsert user
    let user = await prisma.user.findUnique({ where: { googleId } })
    if (!user) {
      user = await prisma.user.create({
        data: { googleId, email, name }
      })
    }

    const token = issueToken(user.id)

    const redirectTo = user.onboardingDone
      ? `${process.env.FRONTEND_URL}/auth/callback?token=${token}`
      : `${process.env.FRONTEND_URL}/auth/callback?token=${token}&onboarding=true`

    return reply.redirect(redirectTo)
  } catch (err) {
    console.error('[Auth] Google callback error:', err.message)
    return reply.redirect(`${process.env.FRONTEND_URL}/login?error=auth_failed`)
  }
}

export async function getMe(request, reply) {
  const { id, email, name, tier, voiceProfile, quotaUsed, quotaResetAt, onboardingDone, createdAt } =
    request.user
  return reply.send({ id, email, name, tier, voiceProfile, quotaUsed, quotaResetAt, onboardingDone, createdAt })
}

export async function logout(request, reply) {
  return reply.send({ ok: true })
}

export async function completeOnboarding(request, reply) {
  const prisma = getPrisma()
  const user = await prisma.user.update({
    where: { id: request.user.id },
    data: { onboardingDone: true }
  })
  return reply.send({ onboardingDone: user.onboardingDone })
}
