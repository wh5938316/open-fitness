import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { mountFoods } from './foods';

const root = document.querySelector<HTMLElement>('main')!;
const messages = JSON.parse(document.getElementById('messages')!.textContent!) as Record<
  string,
  string
>;
const status = document.getElementById('status')!;
let navigating = false;
function navigate(): void {
  navigating = true;
  location.assign(root.dataset.returnTo || '/admin');
}
async function post(path: string, body: unknown = {}): Promise<any> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as { data: unknown; error?: { message: string } };
  if (!response.ok) throw new Error(result.error?.message ?? messages.failure);
  return result.data;
}
async function run(action: () => Promise<void>) {
  document.querySelectorAll('button').forEach((button) => (button.disabled = true));
  status.textContent = '';
  status.setAttribute('role', 'status');
  try {
    await action();
  } catch (error) {
    status.textContent =
      error instanceof Error && error.name === 'Error' ? error.message : messages.failure!;
    status.setAttribute('role', 'alert');
  } finally {
    if (!navigating)
      document.querySelectorAll('button').forEach((button) => (button.disabled = false));
  }
}
document.getElementById('register-form')?.addEventListener('submit', (event) => {
  event.preventDefault();
  void run(async () => {
    const setupToken = document.querySelector<HTMLInputElement>('#setup-token')?.value;
    const name = document.querySelector<HTMLInputElement>('#passkey-name')!.value;
    const optionsJSON = await post('/auth/passkeys/registration-options', { setupToken });
    const response = await startRegistration({ optionsJSON });
    await post('/auth/passkeys/register', { response, name });
    navigate();
  });
});
document.getElementById('sign-in')?.addEventListener('click', () => {
  void run(async () => {
    const optionsJSON = await post('/auth/passkeys/authentication-options');
    const response = await startAuthentication({ optionsJSON });
    await post('/auth/passkeys/authenticate', { response });
    navigate();
  });
});
if (root.dataset.mode === 'foods') mountFoods(root, messages, status);
