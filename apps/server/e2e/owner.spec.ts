import { test, expect, request as playwrightRequest } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const origin = 'http://localhost:18787';

test('signs in with a Clerk test session, authorizes an agent, uses private media, and revokes its grant', async ({
  page,
  request,
}) => {
  const callbackServer = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('Authorization returned to the client.');
  });
  await new Promise<void>((resolve) => callbackServer.listen(0, '127.0.0.1', resolve));
  const callbackUrl = `http://127.0.0.1:${(callbackServer.address() as AddressInfo).port}/callback`;
  try {
    const minted = await request.post('/__test/clerk-token', {
      data: { sub: 'user_owner_e2e', sid: 'sess_owner_e2e' },
    });
    expect(minted.status()).toBe(200);
    const token = (await minted.json()).data.token as string;
    const exchanged = await request.post('/auth/clerk/session', {
      headers: { Origin: origin, Authorization: 'Bearer ' + token },
      data: { returnTo: '/admin' },
    });
    expect(exchanged.status()).toBe(200);
    const session = exchanged
      .headersArray()
      .find(
        (header) =>
          header.name.toLowerCase() === 'set-cookie' && header.value.startsWith('of_session='),
      )
      ?.value.split(';')[0];
    expect(session).toBeTruthy();
    const [name, value] = session!.split('=');
    await page.context().addCookies([{ name: name!, value: value!, url: origin }]);
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Connected assistants' })).toBeVisible();
    await page.screenshot({ path: 'test-results/admin-en.png', fullPage: true });
    await page.getByRole('button', { name: '简体中文', exact: true }).click();
    await expect(page.getByRole('heading', { name: '已连接的助手' })).toBeVisible();
    await page.screenshot({ path: 'test-results/admin-zh-CN.png', fullPage: true });

    const registration = await request.post('/oauth/register', {
      data: {
        client_name: 'OpenFitness browser acceptance',
        redirect_uris: [callbackUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
    });
    expect(registration.status()).toBe(201);
    const client = await registration.json();
    const verifier = randomUUID() + randomUUID();
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: callbackUrl,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      scope: 'fitness:full offline_access',
      resource: origin,
      state: 'browser-acceptance',
    });
    await page.goto('/authorize?' + query);
    await expect(page.getByRole('heading', { name: '连接健身助手' })).toBeVisible();
    await page.getByRole('button', { name: 'English', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Connect a fitness assistant' })).toBeVisible();
    await page.getByRole('button', { name: '简体中文', exact: true }).click();
    await expect(page.getByRole('heading', { name: '连接健身助手' })).toBeVisible();
    await page.getByRole('button', { name: '允许连接', exact: true }).click();
    await page.waitForURL(
      (url) => url.origin === new URL(callbackUrl).origin && url.pathname === '/callback',
    );
    const callback = new URL(page.url());
    expect(callback.searchParams.get('state')).toBe('browser-acceptance');
    const exchange = await request.post('/oauth/token', {
      form: {
        grant_type: 'authorization_code',
        client_id: client.client_id,
        redirect_uri: callbackUrl,
        code: callback.searchParams.get('code')!,
        code_verifier: verifier,
        resource: origin,
      },
    });
    expect(exchange.status()).toBe(200);
    const tokens = await exchange.json();
    const headers = { Authorization: 'Bearer ' + tokens.access_token };
    const context = await request.get('/api/v1/agent-context', { headers });
    const identity = (await context.json()).data;
    expect(identity.actorType).toBe('bot');
    expect(identity.locale).toBe('zh-CN');
    const upload = await request.post('/api/v1/media/uploads', {
      headers,
      data: { operationId: randomUUID(), contentType: 'image/png' },
    });
    expect(upload.status()).toBe(200);
    const ticket = (await upload.json()).data;
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP9sAAAAASUVORK5CYII=',
      'base64',
    );
    const uploaded = await request.put(ticket.uploadUrl, {
      data: bytes,
      headers: { 'Content-Type': 'image/png' },
    });
    expect(uploaded.status()).toBe(200);
    const image = await request.get(`/api/v1/media/${ticket.asset.id}/content`, { headers });
    expect(image.status()).toBe(200);
    expect(await image.body()).toEqual(bytes);
    const anonymous = await playwrightRequest.newContext();
    expect(
      (await anonymous.get(`${origin}/api/v1/media/${ticket.asset.id}/content`)).status(),
    ).toBe(401);
    await anonymous.dispose();
    const meal = await request.post('/api/v1/meals', {
      headers,
      data: {
        operationId: randomUUID(),
        occurredAt: '2026-10-20T12:00:00-04:00',
        imageAssetId: ticket.asset.id,
        ingredients: [
          {
            quantity: 200,
            unit: 'g',
            food: {
              name: 'Acceptance rice estimate',
              basis: { quantity: 100, unit: 'g' },
              nutrients: { energyKcal: 130 },
              source: { kind: 'bot_estimate', basis: 'A synthetic acceptance fixture.' },
            },
          },
        ],
      },
    });
    expect(meal.status()).toBe(200);
    expect((await meal.json()).data.healthSync).toBe('awaiting_device');
    await page.goto(origin + '/admin');
    await expect(page.getByText('OpenFitness browser acceptance', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    expect((await request.get('/api/v1/agent-context', { headers })).status()).toBe(401);
  } finally {
    await new Promise<void>((resolve) => callbackServer.close(() => resolve()));
  }
});
