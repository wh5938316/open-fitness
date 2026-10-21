const root = document.querySelector<HTMLElement>('main')!;
const messages = JSON.parse(document.getElementById('messages')!.textContent!) as Record<
  string,
  string
>;
const statusNode = document.getElementById('status')!;
let navigating = false;
void startClerk().catch(() => {
  statusNode.textContent = messages.clerkExchangeFailed ?? messages.failure!;
  statusNode.setAttribute('role', 'alert');
});
async function startClerk(): Promise<void> {
  const key = root.dataset.clerkKey;
  const mode = root.dataset.mode;
  if (
    !key ||
    (mode !== 'login' &&
      mode !== 'clerk-complete' &&
      mode !== 'clerk-sign-out' &&
      mode !== 'account')
  )
    return;
  const [{ Clerk }, { zhCN }] = await Promise.all([
    import('@clerk/clerk-js'),
    import('@clerk/localizations'),
  ]);
  const clerk = new Clerk(key);
  await clerk.load({ localization: document.documentElement.lang === 'zh-CN' ? zhCN : undefined });
  if (mode === 'account') {
    const profile = document.querySelector<HTMLDivElement>('#clerk-profile');
    if (profile) clerk.mountUserProfile(profile);
    return;
  }
  if (mode === 'clerk-sign-out') {
    await clerk.signOut();
    navigating = true;
    location.replace('/sign-in');
    return;
  }
  const completeUrl = new URL(root.dataset.clerkComplete || '/auth/clerk/complete', location.origin)
    .href;
  if (mode === 'login') {
    if (clerk.session) {
      navigating = true;
      location.assign(completeUrl);
      return;
    }
    const node = document.querySelector<HTMLDivElement>('#clerk-sign-in');
    if (node)
      clerk.mountSignIn(node, {
        forceRedirectUrl: completeUrl,
        signUpForceRedirectUrl: completeUrl,
      });
    return;
  }
  const token = await clerk.session?.getToken();
  if (!token) {
    statusNode.textContent = messages.clerkExchangeFailed ?? messages.failure!;
    statusNode.setAttribute('role', 'alert');
    return;
  }
  const response = await fetch('/auth/clerk/session', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ returnTo: root.dataset.returnTo || '/admin' }),
  });
  const result = (await response.json()) as {
    data?: { returnTo?: string };
    error?: { message?: string };
  };
  if (!response.ok || !result.data?.returnTo) {
    statusNode.textContent =
      result.error?.message ?? messages.clerkExchangeFailed ?? messages.failure!;
    statusNode.setAttribute('role', 'alert');
    return;
  }
  navigating = true;
  location.replace(result.data.returnTo);
}
