// https://clerk.com/docs/js-frontend/getting-started/quickstart
export function clerkUiScriptUrl(publishableKey: string): string {
  const encoded = publishableKey.split('_')[2];
  if (!encoded) throw new Error('Invalid Clerk publishable key');
  let domain = '';
  try {
    domain = atob(encoded).slice(0, -1);
  } catch {
    throw new Error('Invalid Clerk publishable key');
  }
  if (!/^[a-z0-9.-]+$/i.test(domain) || domain.includes('..') || domain.startsWith('.'))
    throw new Error('Invalid Clerk publishable key');
  return `https://${domain}/npm/@clerk/ui@1/dist/ui.browser.js`;
}
