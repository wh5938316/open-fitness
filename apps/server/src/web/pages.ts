import { messages, t } from '../i18n';
import type { Locale } from '../types';
import type { ConsentDescription } from '@cloudflare/workers-oauth-provider';

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
export function page(
  locale: Locale,
  mode: 'setup' | 'login' | 'admin' | 'consent' | 'foods',
  content: string,
  returnTo = '/admin',
  timeZone?: string,
): string {
  const serialized = JSON.stringify(messages[locale]).replaceAll('<', '\\u003c');
  const width = mode === 'foods' ? '880px' : '640px';
  const zone = timeZone ? ` data-time-zone="${escapeHtml(timeZone)}"` : '';
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenFitness</title><style>
  :root{font:16px/1.6 system-ui,sans-serif;color:#182827;background:#f4f7f3}body{margin:0;padding:32px 20px}main{max-width:${width};margin:36px auto;background:white;padding:32px;border:1px solid #dce5dd;border-radius:16px}h1{font-size:28px;line-height:1.2}a{color:#176246}label{display:block;margin:16px 0}input,select,textarea{box-sizing:border-box;display:block;width:100%;padding:12px;margin-top:5px;border:1px solid #aabdb0;border-radius:7px;font:inherit;background:white}textarea{min-height:88px}button{font:inherit;cursor:pointer;padding:10px 18px;border:1px solid #176246;border-radius:7px;color:white;background:#176246;margin:6px 6px 6px 0}button.secondary{background:white;color:#176246}button:disabled{opacity:.55}header{display:flex;justify-content:space-between;align-items:center;gap:20px}small,.muted{color:#53665d}#status[role=alert]{color:#a02727}code{overflow-wrap:anywhere}form.inline{display:inline}li{margin:16px 0}section{margin:28px 0}footer{margin-top:32px;border-top:1px solid #e5ebe4;padding-top:16px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}.food-card{display:flex;gap:16px;align-items:flex-start;padding:16px 0;border-top:1px solid #e5ebe4}.food-cover,#food-cover-preview{width:96px;height:96px;object-fit:cover;border-radius:12px;background:#e7eee9;flex:none}#food-cover-preview{width:160px;height:160px}.food-log{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px}.food-log input,.food-log select{width:auto;margin:0;padding:8px}@media(max-width:640px){.grid{grid-template-columns:1fr}.food-card{flex-direction:column}}
  </style></head><body><main data-mode="${mode}" data-return-to="${escapeHtml(returnTo)}"${zone}><header><strong>OpenFitness</strong><div><form class="inline" action="/language" method="post"><input type="hidden" name="locale" value="en"><input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}"><button class="secondary" lang="en">${t(locale, 'englishName')}</button></form><form class="inline" action="/language" method="post"><input type="hidden" name="locale" value="zh-CN"><input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}"><button class="secondary" lang="zh-CN">${t(locale, 'simplifiedChineseName')}</button></form></div></header>${content}<p id="status" role="status" aria-live="polite"></p><footer><small><a href="/README.md">README</a> · <a href="/openapi.json">OpenAPI</a> · MIT</small></footer></main><script id="messages" type="application/json">${serialized}</script><script type="module" src="/auth.js"></script></body></html>`;
}
export function loginPage(locale: Locale, setup: boolean, returnTo: string): string {
  const content = setup
    ? `<h1>${t(locale, 'setup')}</h1><p>${t(locale, 'setupHelp')}</p><form id="register-form"><label>${t(locale, 'setupToken')}<input id="setup-token" type="password" autocomplete="off" required minlength="32"></label><label>${t(locale, 'passkeyName')}<input id="passkey-name" value="${t(locale, 'defaultPasskeyName')}" maxlength="100"></label><button type="submit">${t(locale, 'registerPasskey')}</button></form>`
    : `<h1>${t(locale, 'signIn')}</h1><button id="sign-in">${t(locale, 'signIn')}</button>`;
  return page(locale, setup ? 'setup' : 'login', content, returnTo);
}
export function adminPage(
  locale: Locale,
  bots: { id: string; name: string; created_at: string }[],
  timeZone: string,
): string {
  const format = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  });
  const list = bots.length
    ? `<ul>${bots.map((bot) => `<li><strong>${escapeHtml(bot.name)}</strong><br><small>${escapeHtml(format.format(new Date(bot.created_at)))}</small><form method="post" action="/admin/bots/${encodeURIComponent(bot.id)}/revoke"><button class="secondary">${t(locale, 'revoke')}</button></form></li>`).join('')}</ul>`
    : `<p>${t(locale, 'noConnections')}</p>`;
  return page(
    locale,
    'admin',
    `<h1>${t(locale, 'connections')}</h1><p><a href="/foods">${t(locale, 'foodsNav')}</a></p>${list}<section><h2>${t(locale, 'addPasskey')}</h2><form id="register-form"><label>${t(locale, 'passkeyName')}<input id="passkey-name" maxlength="100" value="${t(locale, 'defaultBackupPasskeyName')}"></label><button>${t(locale, 'addPasskey')}</button></form></section><form action="/auth/logout" method="post"><button class="secondary">${t(locale, 'signOut')}</button></form>`,
  );
}
export function consentPage(
  locale: Locale,
  input: ConsentDescription & { handle: string },
  returnTo = '/admin',
): string {
  const provenance = input.clientDomain
    ? `<p>${t(locale, 'clientDomainLabel')}: <strong>${escapeHtml(input.clientDomain)}</strong></p>`
    : `<p>${t(locale, 'selfRegisteredClient')}</p>`;
  const scope = `<li>${t(locale, 'fullAccess')}</li>${input.scope.includes('offline_access') ? `<li>${t(locale, 'offlineAccess')}</li>` : ''}`;
  return page(
    locale,
    'consent',
    `<h1>${t(locale, 'consentTitle')}</h1><p>${t(locale, 'consentHelp')}</p><dl><dt>${t(locale, 'clientLabel')}</dt><dd>${escapeHtml(input.clientName)}</dd><dt>${t(locale, 'redirectLabel')}</dt><dd><strong>${escapeHtml(input.redirectHost)}</strong><br><code>${escapeHtml(input.redirectUri)}</code></dd></dl>${provenance}${input.redirectIsLoopback ? `<p><strong>${t(locale, 'loopbackWarning')}</strong></p>` : ''}<h2>${t(locale, 'scopesLabel')}</h2><ul>${scope}</ul><form action="/authorize" method="post"><input type="hidden" name="handle" value="${escapeHtml(input.handle)}"><button name="decision" value="allow">${t(locale, 'allow')}</button><button class="secondary" name="decision" value="deny">${t(locale, 'deny')}</button></form>`,
    returnTo,
  );
}
export function foodsPage(locale: Locale, timeZone: string): string {
  const unit = (value: string, label: string) => `<option value="${value}">${label}</option>`;
  return page(
    locale,
    'foods',
    `<p><a href="/admin">${t(locale, 'connections')}</a></p><h1>${t(locale, 'foodsTitle')}</h1><p>${t(locale, 'foodsHelp')}</p><section><h2>${t(locale, 'saveFoodAction')}</h2><form id="food-form"><input id="food-id" type="hidden"><input id="food-version" type="hidden"><input id="food-cover-id" type="hidden"><input id="food-thumb-id" type="hidden"><label>${t(locale, 'foodName')}<input id="food-name" required maxlength="200"></label><label>${t(locale, 'foodAliases')}<input id="food-aliases" maxlength="2000" placeholder="${escapeHtml(t(locale, 'foodAliasesHint'))}"></label><div class="grid"><label>${t(locale, 'basisQuantity')}<input id="basis-quantity" type="number" inputmode="decimal" min="0" step="any" value="100" required></label><label>${t(locale, 'basisUnit')}<select id="basis-unit">${unit('g', 'g')}${unit('ml', 'ml')}${unit('serving', t(locale, 'unitServing'))}</select></label><label>${t(locale, 'servingQuantity')}<input id="serving-quantity" type="number" inputmode="decimal" min="0" step="any"></label><label>${t(locale, 'servingUnit')}<select id="serving-unit">${unit('g', 'g')}${unit('ml', 'ml')}</select></label><label>${t(locale, 'density')}<input id="density" type="number" inputmode="decimal" min="0" step="any"></label><label>${t(locale, 'preparation')}<select id="food-preparation">${unit('as_sold', t(locale, 'preparationAsSold'))}${unit('raw', t(locale, 'preparationRaw'))}${unit('cooked', t(locale, 'preparationCooked'))}</select></label></div><p class="muted">${t(locale, 'servingHint')}</p><p class="muted">${t(locale, 'nutrientHint')}</p><div class="grid"><label>${t(locale, 'energyKcal')}<input id="nutrient-energyKcal" type="number" inputmode="decimal" min="0" step="any"></label><label>${t(locale, 'proteinG')}<input id="nutrient-proteinG" type="number" inputmode="decimal" min="0" step="any"></label><label>${t(locale, 'carbohydrateG')}<input id="nutrient-carbohydrateG" type="number" inputmode="decimal" min="0" step="any"></label><label>${t(locale, 'fatG')}<input id="nutrient-fatG" type="number" inputmode="decimal" min="0" step="any"></label><label>${t(locale, 'fiberG')}<input id="nutrient-fiberG" type="number" inputmode="decimal" min="0" step="any"></label><label>${t(locale, 'sodiumMg')}<input id="nutrient-sodiumMg" type="number" inputmode="decimal" min="0" step="any"></label><label>${t(locale, 'calciumMg')}<input id="nutrient-calciumMg" type="number" inputmode="decimal" min="0" step="any"></label></div><label>${t(locale, 'sourceKind')}<select id="food-source">${unit('user', t(locale, 'sourceUser'))}${unit('bot_estimate', t(locale, 'sourceEstimate'))}${unit('open_food_facts', t(locale, 'sourceCatalog'))}</select></label><label>${t(locale, 'sourceNote')}<textarea id="food-basis" maxlength="4000"></textarea></label><label>${t(locale, 'sourceReference')}<input id="food-reference" maxlength="2000"></label><label>${t(locale, 'foodNotes')}<textarea id="food-notes" maxlength="10000"></textarea></label><label>${t(locale, 'coverImage')}<input id="food-cover" type="file" accept="image/png,image/jpeg,image/webp"></label><p class="muted">${t(locale, 'coverHint')}</p><img id="food-cover-preview" alt="" hidden><div><button id="food-save" type="submit">${t(locale, 'saveFoodAction')}</button><button id="food-reset" class="secondary" type="button">${t(locale, 'clearForm')}</button><button id="food-remove-cover" class="secondary" type="button" hidden>${t(locale, 'removeCover')}</button><button id="food-delete" class="secondary" type="button" hidden>${t(locale, 'deleteFood')}</button></div></form></section><section><h2>${t(locale, 'savedFoods')}</h2><label>${t(locale, 'searchFoods')}<input id="food-search" maxlength="200"></label><div id="food-list"></div></section><section><h2>${t(locale, 'recentMeals')}</h2><div id="meal-list"></div></section>`,
    '/foods',
    timeZone,
  );
}
