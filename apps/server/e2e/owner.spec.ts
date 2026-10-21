import { test, expect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

test('registers and signs in with passkeys, authorizes an agent, uses private media, and revokes its grant', async ({
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
    const origin = 'http://localhost:18787';
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const options = {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    } as const;
    const primary = await cdp.send('WebAuthn.addVirtualAuthenticator', { options });
    await page.goto('/setup');
    await page.locator('#setup-token').fill('e2e-only-setup-token-with-more-than-32-characters');
    await page.route(
      '**/auth/passkeys/register',
      async (route) => {
        const payload = route.request().postDataJSON();
        const clientData = JSON.parse(
          Buffer.from(payload.response.response.clientDataJSON, 'base64url').toString('utf8'),
        );
        clientData.origin = 'https://attacker.example';
        payload.response.response.clientDataJSON = Buffer.from(JSON.stringify(clientData)).toString(
          'base64url',
        );
        await route.continue({ postData: JSON.stringify(payload) });
      },
      { times: 1 },
    );
    const rejectedRegistration = page.waitForResponse((response) =>
      response.url().endsWith('/auth/passkeys/register'),
    );
    await page.getByRole('button', { name: 'Register a passkey', exact: true }).click();
    expect((await rejectedRegistration).status()).toBe(401);
    await expect(page.getByRole('alert')).toBeVisible();
    await page.getByRole('button', { name: 'Register a passkey', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Connected assistants' })).toBeVisible();
    await cdp.send('WebAuthn.removeVirtualAuthenticator', {
      authenticatorId: primary.authenticatorId,
    });
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options });
    await page.locator('#passkey-name').fill('Acceptance backup key');
    const backupResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/auth/passkeys/register') &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Add a backup passkey', exact: true }).click();
    expect((await backupResponse).status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Connected assistants' })).toBeVisible();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByRole('button', { name: 'Sign in with a passkey', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Connected assistants' })).toBeVisible();
    await page.screenshot({ path: 'test-results/admin-en.png', fullPage: true });
    await page.getByRole('link', { name: 'Foods', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Foods', exact: true })).toBeVisible();
    await page.getByLabel('Name').fill('明治无糖低脂纯牛奶');
    await page.getByLabel('Aliases').fill('明治低脂奶');
    await page.getByLabel('Basis quantity').fill('100');
    await page.getByLabel('Basis unit').selectOption('ml');
    await page.getByLabel('Serving quantity').fill('200');
    await page.getByLabel('Serving unit').selectOption('ml');
    await page.getByLabel('Energy (kcal)').fill('47');
    await page.getByLabel('Protein (g)').fill('3.5');
    await page.getByLabel('Carbohydrate (g)').fill('5');
    await page.getByLabel('Fat (g)').fill('1.4');
    await page.getByLabel('Sodium (mg)').fill('60');
    await page.getByLabel('Calcium (mg)').fill('115');
    await page.getByLabel('Source note').fill('Label per 100 ml: 196 kJ (47 kcal).');
    await page.locator('#food-cover').setInputFiles({
      name: 'meiji.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP9sAAAAASUVORK5CYII=',
        'base64',
      ),
    });
    await page.getByRole('button', { name: 'Save food', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Food saved.');
    const card = page.locator('.food-card', { hasText: '明治无糖低脂纯牛奶' });
    await expect(card).toBeVisible();
    await expect
      .poll(() => card.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(1);
    await expect(card.locator('input.portion')).toHaveValue('200');
    await expect(card.locator('select.portion-unit')).toHaveValue('ml');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(card.locator('img')).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 720 });
    await card.getByRole('button', { name: 'Log portion', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Meal logged. 94 kcal');
    await expect(page.locator('#meal-list')).toContainText('明治无糖低脂纯牛奶 200 ml');
    await expect(page.locator('#meal-list')).toContainText('94 kcal');
    await page.screenshot({ path: 'test-results/foods-en.png', fullPage: true });
    await page.goto('/admin');
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
    expect((await request.get(`/api/v1/media/${ticket.asset.id}/content`)).status()).toBe(401);
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
