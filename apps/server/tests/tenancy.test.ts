import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { AuthService } from '../src/auth';
import { randomToken, sha256 } from '../src/crypto';

const origin = 'http://localhost:8787';

describe('per-owner session epoch', () => {
  it('leaves the bootstrap owner untouched when another owner rotates epoch', async () => {
    const auth = new AuthService(env);
    const owner = await auth.owner();
    const otherId = crypto.randomUUID();
    const stamp = crypto.randomUUID();
    const now = Date.now();
    const ownerToken = randomToken();
    const otherToken = randomToken();
    const meal = 'meal-' + stamp;
    await env.DB.batch([
      env.DB.prepare('INSERT INTO owners(id,status,created_at) VALUES(?,?,?)').bind(
        otherId,
        'active',
        now,
      ),
      env.DB.prepare(
        'INSERT INTO sessions(token_hash,epoch,expires_at,owner_id,created_at) VALUES(?,?,?,?,?)',
      ).bind(await sha256(ownerToken), owner.session_epoch, now + 600000, owner.id, now),
      env.DB.prepare(
        'INSERT INTO sessions(token_hash,epoch,expires_at,owner_id,created_at) VALUES(?,?,?,?,?)',
      ).bind(await sha256(otherToken), 0, now + 600000, otherId, now),
      env.DB.prepare(
        'INSERT INTO bots(id,client_id,name,status,epoch,created_at,owner_id) VALUES(?,?,?,?,?,?,?)',
      ).bind(
        'bot-owner-' + stamp,
        'client',
        'Owner bot',
        'active',
        owner.session_epoch,
        new Date(now).toISOString(),
        owner.id,
      ),
      env.DB.prepare(
        'INSERT INTO bots(id,client_id,name,status,epoch,created_at,owner_id) VALUES(?,?,?,?,?,?,?)',
      ).bind(
        'bot-other-' + stamp,
        'client',
        'Other bot',
        'active',
        0,
        new Date(now).toISOString(),
        otherId,
      ),
      env.DB.prepare(
        'INSERT INTO documents(owner_id,kind,id,version,data,deleted,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      ).bind(
        owner.id,
        'food',
        meal,
        1,
        '{"name":"Owner food"}',
        0,
        new Date(now).toISOString(),
        new Date(now).toISOString(),
      ),
      env.DB.prepare(
        'INSERT INTO documents(owner_id,kind,id,version,data,deleted,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      ).bind(
        otherId,
        'food',
        meal,
        1,
        '{"name":"Other food"}',
        0,
        new Date(now).toISOString(),
        new Date(now).toISOString(),
      ),
    ]);
    await env.DB.prepare('UPDATE owners SET session_epoch=session_epoch+1 WHERE id=?')
      .bind(otherId)
      .run();
    const requestFor = (token: string) =>
      new Request(origin, { headers: { Cookie: auth.sessionCookie + '=' + token } });
    expect((await auth.session(requestFor(ownerToken)))?.owner.id).toBe(owner.id);
    expect(await auth.session(requestFor(otherToken))).toBeNull();
    expect(
      await env.DB.prepare('SELECT status FROM bots WHERE id=?')
        .bind('bot-owner-' + stamp)
        .first<{ status: string }>(),
    ).toMatchObject({ status: 'active' });
    expect(
      await env.DB.prepare('SELECT status FROM bots WHERE id=?')
        .bind('bot-other-' + stamp)
        .first<{ status: string }>(),
    ).toMatchObject({ status: 'revoked' });
    expect(
      await env.DB.prepare('SELECT data FROM documents WHERE owner_id=? AND id=?')
        .bind(owner.id, meal)
        .first<{ data: string }>(),
    ).toMatchObject({ data: '{"name":"Owner food"}' });
    expect(
      await env.DB.prepare('SELECT data FROM documents WHERE owner_id=? AND id=?')
        .bind(otherId, meal)
        .first<{ data: string }>(),
    ).toMatchObject({ data: '{"name":"Other food"}' });
    const other = await auth.owner(otherId);
    await expect(
      auth.botActor(
        { ownerId: otherId, botId: 'bot-other-' + stamp, epoch: 0 },
        new Request(origin),
      ),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      auth.botActor(
        { ownerId: owner.id, botId: 'bot-owner-' + stamp, epoch: owner.session_epoch },
        new Request(origin),
      ),
    ).resolves.toMatchObject({ ownerId: owner.id, id: 'bot-owner-' + stamp, kind: 'bot' });
    expect(other.session_epoch).toBe(1);
    expect((await auth.owner()).session_epoch).toBe(owner.session_epoch);
  });

  it('rejects sessions and bots for a disabled owner', async () => {
    const auth = new AuthService(env);
    const id = crypto.randomUUID();
    const token = randomToken();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO owners(id,status,created_at) VALUES(?,'disabled',?)").bind(
        id,
        now,
      ),
      env.DB.prepare(
        'INSERT INTO sessions(token_hash,epoch,expires_at,owner_id,created_at) VALUES(?,?,?,?,?)',
      ).bind(await sha256(token), 0, now + 600000, id, now),
      env.DB.prepare(
        'INSERT INTO bots(id,client_id,name,status,epoch,created_at,owner_id) VALUES(?,?,?,?,?,?,?)',
      ).bind('bot-' + id, 'client', 'Disabled', 'active', 0, new Date(now).toISOString(), id),
    ]);
    expect(
      await auth.session(
        new Request(origin, { headers: { Cookie: auth.sessionCookie + '=' + token } }),
      ),
    ).toBeNull();
    await expect(
      auth.botActor({ ownerId: id, botId: 'bot-' + id, epoch: 0 }, new Request(origin)),
    ).rejects.toMatchObject({ code: 'CONNECTION_REVOKED' });
  });
});
