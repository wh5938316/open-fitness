import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const origin = 'http://localhost:18787';

async function signIn(request: import('@playwright/test').APIRequestContext, sub: string) {
  const minted = await request.post('/__test/clerk-token', { data: { sub, sid: 'sess_' + sub } });
  expect(minted.status()).toBe(200);
  const token = (await minted.json()).data.token as string;
  const exchanged = await request.post('/auth/clerk/session', {
    headers: { Origin: origin, Authorization: 'Bearer ' + token },
    data: { returnTo: '/account' },
  });
  expect(exchanged.status()).toBe(200);
  const cookie = exchanged
    .headersArray()
    .find(
      (header) =>
        header.name.toLowerCase() === 'set-cookie' && header.value.startsWith('of_session='),
    )
    ?.value.split(';')[0];
  expect(cookie).toBeTruthy();
  return cookie!;
}

test('provisions two Clerk users and hides one user from the other', async ({ request }) => {
  const suffix = randomUUID().slice(0, 8);
  const a = await signIn(request, 'user_e2e_a_' + suffix);
  const b = await signIn(request, 'user_e2e_b_' + suffix);
  const saved = await request.post('/api/v1/foods', {
    headers: { Cookie: a, Origin: origin },
    data: {
      operationId: randomUUID(),
      data: {
        name: 'E2E private rice ' + suffix,
        basis: { quantity: 100, unit: 'g' },
        nutrients: { energyKcal: 130 },
        source: { kind: 'bot_estimate', basis: 'Browser isolation fixture.' },
      },
    },
  });
  expect(saved.status()).toBe(200);
  const foodId = (await saved.json()).data.id as string;
  const hidden = await request.get('/api/v1/foods/' + foodId, { headers: { Cookie: b } });
  expect(hidden.status()).toBe(404);
  const account = await request.get('/account', { headers: { Cookie: b } });
  expect(account.status()).toBe(200);
  expect(await account.text()).not.toContain('E2E private rice ' + suffix);
  const ownAccount = await request.get('/account', { headers: { Cookie: a } });
  expect(await ownAccount.text()).toContain('Account');
  expect(await ownAccount.text()).not.toContain(foodId);
});
