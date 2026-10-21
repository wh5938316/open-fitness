import { base64url } from './crypto';

const CLERK_RSA_PREFIX = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA';
const CLERK_RSA_SUFFIX = 'IDAQAB';

function pem(label: string, bytes: ArrayBuffer): string {
  const encoded = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  const lines = encoded.match(/.{1,64}/g)?.join('\n') ?? encoded;
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}
function compactPemBody(value: string): string {
  return value
    .replace(/-----BEGIN.*?-----/g, '')
    .replace(/-----END.*?-----/g, '')
    .replace(/\s/g, '');
}
export function isClerkJwtPublicKey(pemValue: string): boolean {
  const body = compactPemBody(pemValue);
  return body.startsWith(CLERK_RSA_PREFIX) && body.endsWith(CLERK_RSA_SUFFIX);
}
export interface ClerkTestKeys {
  publicPem: string;
  privatePem: string;
}
export async function generateClerkTestKeys(): Promise<ClerkTestKeys> {
  for (let attempt = 0; attempt < 32; attempt++) {
    const pair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign'],
    );
    const publicPem = pem('PUBLIC KEY', await crypto.subtle.exportKey('spki', pair.publicKey));
    if (!isClerkJwtPublicKey(publicPem)) continue;
    return {
      publicPem,
      privatePem: pem('PRIVATE KEY', await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
    };
  }
  throw new Error('Could not generate a 2048-bit RSA key Clerk can verify offline.');
}
export async function signClerkTestToken(
  privatePem: string,
  claims: Record<string, unknown>,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    Uint8Array.from(atob(compactPemBody(privatePem)), (char) => char.charCodeAt(0)),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64url(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(header + '.' + payload),
  );
  return header + '.' + payload + '.' + base64url(new Uint8Array(signature));
}
