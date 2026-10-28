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
  if (!key || (mode !== 'clerk-sign-in' && mode !== 'clerk-complete' && mode !== 'clerk-sign-out'))
    return;
  const { Clerk } = await import('@clerk/clerk-js');
  const clerk = new Clerk(key);
  await clerk.load();
  if (mode === 'clerk-sign-out') {
    await clerk.signOut();
    navigating = true;
    location.replace('/sign-in');
    return;
  }
  const returnTo = root.dataset.returnTo || '/admin';
  if (mode === 'clerk-sign-in' && !clerk.session) {
    const complete = root.dataset.clerkRedirect!;
    navigating = true;
    await clerk.redirectToSignIn({
      signInForceRedirectUrl: complete,
      signUpForceRedirectUrl: complete,
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
    body: JSON.stringify({ returnTo }),
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
