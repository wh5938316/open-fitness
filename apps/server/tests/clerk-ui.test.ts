import { describe, expect, it } from 'vitest';
import { clerkUiScriptUrl } from '../src/web/clerk-ui';

describe('Clerk UI script', () => {
  it('builds the Frontend API UI bundle URL from the publishable key', () => {
    const domain = 'clerk.example.test';
    const key = 'pk_test_' + btoa(domain + '$');
    expect(clerkUiScriptUrl(key)).toBe(`https://${domain}/npm/@clerk/ui@1/dist/ui.browser.js`);
  });

  it('rejects a publishable key that does not encode a host', () => {
    expect(() => clerkUiScriptUrl('pk_test')).toThrow('Invalid Clerk publishable key');
    expect(() => clerkUiScriptUrl('pk_test_' + btoa('https://evil.example/ui$'))).toThrow(
      'Invalid Clerk publishable key',
    );
  });
});
