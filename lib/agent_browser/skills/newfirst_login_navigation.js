// ============================================================================
// lib/agent_browser/skills/newfirst_login_navigation.js  (Ed 2026-10-23)
// ----------------------------------------------------------------------------
// Kat's first NewFirst step, and nothing more: open www.newfirst.com, select the
// Business tab on the login panel (it defaults to Personal), and confirm the
// business username field, password field and Login button are there.
//
// It NEVER types and NEVER clicks Login: there is no typing action and no Login
// action in the declaration, and "login" is on this skill's forbidden labels as
// a second check. Only www.newfirst.com is reachable; the banking host behind
// Login (poda.robo.secureinternetbank.com) is not declared, so nothing can reach it.
// Credentials and authentication come later, after NewFirst authorizes Kat's
// restricted read-only user and the bank-approved sign-in method.
// ============================================================================
const HOST = 'www.newfirst.com';

const declaration = {
  id: 'newfirst.login_navigation',
  version: 1,
  owner: 'kat',
  purpose: 'Confirm Kat can reach NewFirst and find the business login (no sign-in).',
  hosts: [HOST],
  forbidden: /\b(log ?in|sign ?in|submit|enroll)\b/i,
  actions: {
    open_home: { type: 'goto', url: `https://${HOST}/` },
    select_business: { type: 'click', page: { host: HOST, path: '/' }, selector: '#nav-ebc-form', label: /^Business$/i, waitFor: 'form.BOLoginForm input.BOLoginUsernameInput' },
  },
  read: {
    business_tab: '#nav-ebc-form',
    business_form: 'form.BOLoginForm',
    username_field: 'form.BOLoginForm input.BOLoginUsernameInput',
    password_field: 'form.BOLoginForm input.BOLoginPasswordInput',
    login_button: 'form.BOLoginForm .BOLoginSubmitButton',
  },
};

async function run(g) {
  await g.do('open_home');
  await g.do('select_business');
  const found = {};
  for (const k of Object.keys(declaration.read)) found[k] = await g.read(k);
  const tabSelected = await g.read('business_tab');
  const ok = found.business_form.visible && found.username_field.visible && found.password_field.visible && found.login_button.visible
    && found.password_field.type === 'password';
  await g.record('identify_login', { result: ok ? 'found' : 'incomplete', found: Object.fromEntries(Object.entries(found).map(([k, v]) => [k, { visible: v.visible, type: v.type, label: v.label }])) });
  if (!ok) throw new g.GuardStop('failed', 'the business login fields were not all visible after selecting Business (the page changed?)');
  return { business_tab: tabSelected.label || 'Business', fields: found, signed_in: false, credentials_used: false };
}

module.exports = { declaration, run };
