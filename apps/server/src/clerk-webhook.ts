import { verifyWebhook } from '@clerk/backend/webhooks';
import { AppError } from './errors';
import type { Env } from './types';

interface ClerkEmail {
  id?: string;
  email_address?: string;
}
interface ClerkEventData {
  id?: string;
  primary_email_address_id?: string | null;
  email_addresses?: ClerkEmail[];
}

export async function handleClerkWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.CLERK_WEBHOOK_SECRET) throw new AppError(503, 'CLERK_NOT_CONFIGURED', 'internalError');
  let event: { type: string; data: ClerkEventData };
  try {
    event = await verifyWebhook(request, { signingSecret: env.CLERK_WEBHOOK_SECRET });
  } catch {
    return Response.json(
      { error: { code: 'INVALID_WEBHOOK', message: 'Webhook verification failed.' } },
      { status: 401 },
    );
  }
  const deliveryId = request.headers.get('svix-id')?.trim();
  if (!deliveryId)
    return Response.json(
      { error: { code: 'INVALID_WEBHOOK', message: 'Webhook verification failed.' } },
      { status: 401 },
    );
  const dedupeKey = 'clerk:webhook:' + deliveryId;
  if (await env.CACHE.get(dedupeKey)) return new Response(null, { status: 200 });
  const data = event.data ?? {};
  if (
    (event.type === 'session.revoked' ||
      event.type === 'session.ended' ||
      event.type === 'session.removed') &&
    data.id
  )
    await env.DB.prepare('DELETE FROM sessions WHERE clerk_session_id=?').bind(data.id).run();
  if (event.type === 'user.deleted' && data.id)
    await env.DB.prepare(
      "UPDATE owners SET status='disabled', session_epoch=session_epoch+1 WHERE clerk_user_id=? AND status='active'",
    )
      .bind(data.id)
      .run();
  if (event.type === 'user.updated' && data.id) {
    const email =
      data.email_addresses?.find((item) => item.id === data.primary_email_address_id)
        ?.email_address ?? null;
    await env.DB.prepare('UPDATE owners SET email=? WHERE clerk_user_id=?')
      .bind(email, data.id)
      .run();
  }
  await env.CACHE.put(dedupeKey, '1', { expirationTtl: 604800 });
  return new Response(null, { status: 200 });
}
