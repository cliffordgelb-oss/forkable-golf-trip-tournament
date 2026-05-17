// Supabase Edge Function: send-push
// Triggered (via pg_net from notification_events insert) with { event_id }.
// Reads the event, fans out Web Push to all matching push_subscriptions,
// cleans up expired subscriptions (404/410), and marks the event as sent/failed.

import webpush from 'npm:web-push@3'
import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY')!
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:you@example.com'

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })

  let body: { event_id?: number } = {}
  try { body = await req.json() } catch { /* ignore */ }
  const eventId = body.event_id
  if (!eventId) return new Response('event_id required', { status: 400 })

  const { data: event, error: eErr } = await sb
    .from('notification_events').select('*').eq('id', eventId).single()
  if (eErr || !event) {
    return new Response('event not found', { status: 404 })
  }
  if (event.status !== 'pending') {
    return new Response('already processed', { status: 200 })
  }

  // Build recipient query: exclude actor for trash-talk; include everyone for scores.
  let q = sb.from('push_subscriptions').select('*')
  if (event.type === 'message' && event.actor_id) {
    q = q.neq('player_id', event.actor_id)
  }
  const { data: subs, error: sErr } = await q
  if (sErr) {
    await sb.from('notification_events').update({
      status: 'failed', last_error: 'sub-fetch: ' + sErr.message, attempts: event.attempts + 1,
    }).eq('id', eventId)
    return new Response('sub fetch failed', { status: 500 })
  }

  const payloadStr = JSON.stringify(event.payload || {})
  const expiredEndpoints: string[] = []
  let okCount = 0, failCount = 0
  const errors: string[] = []

  await Promise.all((subs || []).map(async (sub) => {
    try {
      await webpush.sendNotification({
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      }, payloadStr)
      okCount++
    } catch (err: any) {
      const sc = err?.statusCode
      if (sc === 404 || sc === 410) {
        expiredEndpoints.push(sub.endpoint)
      } else {
        failCount++
        errors.push(`${sc || 'err'}:${(err?.body || err?.message || '').toString().slice(0, 120)}`)
      }
    }
  }))

  if (expiredEndpoints.length) {
    await sb.from('push_subscriptions').delete().in('endpoint', expiredEndpoints)
  }

  const newStatus = failCount === 0 ? 'sent' : 'failed'
  await sb.from('notification_events').update({
    status: newStatus,
    attempts: event.attempts + 1,
    last_error: errors.length ? errors.slice(0, 3).join(' | ') : null,
    processed_at: new Date().toISOString(),
  }).eq('id', eventId)

  return new Response(JSON.stringify({
    ok: okCount, failed: failCount, expired: expiredEndpoints.length,
  }), { headers: { 'Content-Type': 'application/json' } })
})
