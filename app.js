'use strict';

(() => {
  const ACCOUNTS_KEY = 'account-demo.accounts.v1';
  const SESSION_KEY = 'account-demo.session.v1';
  const RESET_EMAIL_KEY = 'account-demo.reset-email.v1';
  const FEED_RETURN_KEY = 'account-demo.feed-return.v1';
  const HASH_ITERATIONS = 120000;
  const encoder = new TextEncoder();
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const state = { user: null, resetCode: '', resetEmail: '', ready: false, route: '', toastTimer: null };

  function readJson(storage, key, fallback) {
    const raw = storage.getItem(key);
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch { throw new Error('The saved demo data is unreadable. Clear this site’s browser data to start fresh.'); }
  }

  function accounts() {
    const records = readJson(localStorage, ACCOUNTS_KEY, []);
    if (!Array.isArray(records)) throw new Error('The saved demo accounts are unreadable. Clear this site’s browser data to start fresh.');
    return records.filter(account => account && typeof account.email === 'string' && typeof account.name === 'string' && typeof account.salt === 'string' && /^[0-9a-f]{32}$/.test(account.salt) && typeof account.hash === 'string' && /^[0-9a-f]{64}$/.test(account.hash) && Number.isInteger(account.revision) && account.revision > 0 && account.iterations === HASH_ITERATIONS);
  }

  function saveAccounts(records) { localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(records)); }
  function normalizeEmail(email) { return email.trim().toLowerCase(); }
  function validEmail(email) { return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
  function randomBytes(length) { return crypto.getRandomValues(new Uint8Array(length)); }
  function hex(bytes) { return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join(''); }
  function unhex(value) { return new Uint8Array(value.match(/.{2}/g).map(part => parseInt(part, 16))); }
  function equalHash(left, right) {
    if (left.length !== right.length) return false;
    let difference = 0;
    for (let i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
    return difference === 0;
  }

  async function passwordHash(password, salt) {
    const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: unhex(salt), iterations: HASH_ITERATIONS, hash: 'SHA-256' }, key, 256);
    return hex(bits);
  }

  async function credentials(password) {
    const salt = hex(randomBytes(16));
    return { salt, hash: await passwordHash(password, salt), iterations: HASH_ITERATIONS };
  }

  async function resetDigest(email, code, nonce) {
    return hex(await crypto.subtle.digest('SHA-256', encoder.encode(`${email}:${code}:${nonce}`)));
  }

  function currentUser() {
    const session = readJson(sessionStorage, SESSION_KEY, null);
    if (!session || typeof session.email !== 'string') return null;
    const account = accounts().find(item => item.email === session.email && item.revision === session.revision);
    if (!account) sessionStorage.removeItem(SESSION_KEY);
    return account || null;
  }

  function startSession(account) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ email: account.email, revision: account.revision, id: hex(randomBytes(16)) }));
    state.user = account;
  }

  function clearPasswords() {
    $$('input[type=password], input[data-password-field]').forEach(input => {
      input.value = '';
      input.type = 'password';
      const toggle = $(`[data-toggle="${input.id}"]`);
      if (toggle) { toggle.textContent = 'Show'; toggle.setAttribute('aria-label', 'Show password'); }
    });
  }

  function signOut(message = 'You’re signed out.') {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(FEED_RETURN_KEY);
    state.user = null;
    clearPasswords();
    clearErrors($('#login-form'));
    navigate('login');
    if (message) toast(message);
  }

  function clearErrors(form) {
    $('.form-message', form).hidden = true;
    $('.form-message', form).classList.remove('success');
    $$('.field-error', form).forEach(node => { node.hidden = true; node.textContent = ''; });
    $$('[aria-invalid]', form).forEach(node => node.removeAttribute('aria-invalid'));
  }

  function formError(form, message, fieldId) {
    const summary = $('.form-message', form);
    summary.textContent = message;
    summary.classList.remove('success');
    summary.hidden = false;
    if (fieldId) {
      const field = document.getElementById(fieldId);
      field.setAttribute('aria-invalid', 'true');
      const error = document.getElementById(`${fieldId}-error`);
      if (error) { error.textContent = message; error.hidden = false; field.setAttribute('aria-describedby', error.id); }
      field.focus();
    }
    return false;
  }

  function formSuccess(form, message) {
    const summary = $('.form-message', form);
    summary.textContent = message;
    summary.classList.add('success');
    summary.hidden = false;
  }

  function validateEmail(form, fieldId) {
    const email = normalizeEmail(document.getElementById(fieldId).value);
    if (!validEmail(email)) return formError(form, 'Enter a valid email address.', fieldId);
    return email;
  }

  function validateName(form, fieldId) {
    const name = document.getElementById(fieldId).value.trim();
    if (name.length < 2 || name.length > 60) return formError(form, 'Enter a name between 2 and 60 characters.', fieldId);
    return name;
  }

  function validateNewPassword(form, passwordId, confirmId) {
    const password = document.getElementById(passwordId).value;
    if (password.length < 8 || password.length > 128) return formError(form, 'Use a password between 8 and 128 characters.', passwordId);
    if (password !== document.getElementById(confirmId).value) return formError(form, 'The passwords don’t match. Enter them again.', confirmId);
    return password;
  }

  async function busyForm(form, action) {
    const button = $('[type=submit]', form);
    if (button.disabled) return;
    clearErrors(form);
    button.disabled = true;
    form.setAttribute('aria-busy', 'true');
    try { await action(); } catch (error) { formError(form, friendlyError(error)); }
    finally { button.disabled = false; form.removeAttribute('aria-busy'); }
  }

  function friendlyError(error) {
    if (error?.name === 'QuotaExceededError') return 'This browser’s demo storage is full. Clear this site’s browser data and try again.';
    if (error?.name === 'SecurityError') return 'Allow browser storage for this site to use demo accounts.';
    return error?.message || 'Something went wrong. Please try again.';
  }

  function toast(message) {
    const node = $('#toast');
    node.textContent = message;
    node.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { node.hidden = true; }, 4500);
  }

  function navigate(route) {
    if (location.hash === `#/${route}`) renderRoute();
    else location.hash = `/${route}`;
  }

  function safeFeedRoute(value) {
    const [route, query = ''] = String(value).replace(/^#\/?/, '').split('?');
    if (route !== 'feed') return 'feed';
    const params = new URLSearchParams(query);
    const post = params.get('post');
    if (post === 'coast-01' || /^own-[a-z0-9-]{8,48}$/.test(post || '')) return `feed?post=${encodeURIComponent(post)}`;
    const tab = params.get('tab');
    return ['home', 'saved', 'profile'].includes(tab) ? `feed?tab=${tab}` : 'feed';
  }

  function returnToFeed() {
    const route = safeFeedRoute(sessionStorage.getItem(FEED_RETURN_KEY) || 'feed');
    sessionStorage.removeItem(FEED_RETURN_KEY);
    navigate(route);
  }

  function renderRoute() {
    if (!state.ready) return;
    const validRoutes = ['login', 'signup', 'forgot', 'reset', 'success', 'feed'];
    const route = location.hash.replace(/^#\/?/, '').split('?')[0] || 'login';
    if (!validRoutes.includes(route)) { navigate(state.user ? 'feed' : 'login'); return; }
    state.user = currentUser();
    if (['success', 'feed'].includes(route) && !state.user) {
      if (route === 'feed') sessionStorage.setItem(FEED_RETURN_KEY, safeFeedRoute(location.hash));
      navigate('login');
      return;
    }
    if (state.user && ['login', 'signup', 'success'].includes(route)) { returnToFeed(); return; }
    if (state.route && state.route !== route) clearPasswords();
    state.route = route;
    document.body.classList.toggle('on-feed', route === 'feed');
    if (route !== 'feed') window.AccountFeed.deactivate();
    $$('main > section').forEach(view => { view.hidden = view.id !== `view-${route}`; });
    if (route === 'success') {
      $('#success-name').textContent = state.user.name;
      $('#success-email').textContent = state.user.email;
    }
    if (route === 'feed') window.AccountFeed.render(state.user);
    if (route === 'forgot' && state.resetEmail) $('#forgot-email').value = state.resetEmail;
    if (route === 'reset' && state.resetEmail) $('#reset-email').value = state.resetEmail;
    const title = route === 'feed' ? $('#view-feed .feed-pane:not([hidden]) h1') : $(`#view-${route} h1`);
    document.title = `${title.textContent.trim()} — InstaGreed`;
    window.scrollTo({ top: 0, behavior: 'instant' });
    title.focus({ preventScroll: true });
  }

  function safeAction(action) {
    try { action(); } catch (error) { toast(friendlyError(error)); }
  }

  $('#login-form').addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    busyForm(form, async () => {
      const email = validateEmail(form, 'login-email');
      if (!email) return;
      const password = $('#login-password').value;
      if (!password) return formError(form, 'Enter your password.', 'login-password');
      const account = accounts().find(record => record.email === email);
      if (!account || !equalHash(await passwordHash(password, account.salt), account.hash)) return formError(form, 'The email or password is incorrect. Try again.', 'login-password');
      // Recheck after hashing so a simultaneous reset cannot revive an old credential.
      const latest = accounts().find(record => record.email === email);
      if (!latest || latest.revision !== account.revision || latest.hash !== account.hash) return formError(form, 'This password was changed. Log in with the new password.', 'login-password');
      startSession(latest);
      clearPasswords();
      returnToFeed();
      toast(`Welcome back, ${latest.name}.`);
    });
  });

  $('#signup-form').addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    busyForm(form, async () => {
      const name = validateName(form, 'signup-name');
      if (!name) return;
      const email = validateEmail(form, 'signup-email');
      if (!email) return;
      const password = validateNewPassword(form, 'signup-password', 'signup-confirm');
      if (!password) return;
      if (accounts().some(account => account.email === email)) return formError(form, 'That email already has a demo account. Log in or reset its password.', 'signup-email');
      const secured = await credentials(password);
      const records = accounts();
      if (records.some(account => account.email === email)) return formError(form, 'That email already has a demo account. Log in instead.', 'signup-email');
      const account = { email, name, ...secured, revision: 1, createdAt: new Date().toISOString() };
      records.push(account);
      saveAccounts(records);
      startSession(account);
      form.reset();
      clearPasswords();
      returnToFeed();
      toast(`You’re in, ${name}. Your demo account is ready.`);
    });
  });

  $('#forgot-form').addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    busyForm(form, async () => {
      const email = validateEmail(form, 'forgot-email');
      if (!email) return;
      const account = accounts().find(record => record.email === email);
      if (!account) return formError(form, 'No demo account uses that email in this browser. Sign up first.', 'forgot-email');
      const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
      const nonce = hex(randomBytes(16));
      const digest = await resetDigest(email, code, nonce);
      const records = accounts();
      const latest = records.find(record => record.email === email);
      if (!latest || latest.revision !== account.revision) return formError(form, 'The account changed. Request a new reset code.');
      latest.reset = { digest, nonce, expiresAt: Date.now() + 10 * 60 * 1000, revision: latest.revision };
      saveAccounts(records);
      state.resetCode = code;
      state.resetEmail = email;
      sessionStorage.setItem(RESET_EMAIL_KEY, email);
      $('#reset-code').textContent = code;
      $('#reset-code-panel').hidden = false;
      formSuccess(form, 'Your demo reset code is ready below. No email was sent.');
      $('#reset-code-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  });

  $('#reset-form').addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    busyForm(form, async () => {
      const email = validateEmail(form, 'reset-email');
      if (!email) return;
      const code = $('#reset-token').value.trim();
      if (!/^\d{6}$/.test(code)) return formError(form, 'Enter the 6-digit reset code.', 'reset-token');
      const password = validateNewPassword(form, 'reset-password', 'reset-confirm');
      if (!password) return;
      const account = accounts().find(record => record.email === email);
      const token = account?.reset;
      if (!token || token.revision !== account.revision || token.expiresAt <= Date.now()) return formError(form, 'This code has expired or was already used. Get a new reset code.', 'reset-token');
      if (!equalHash(await resetDigest(email, code, token.nonce), token.digest)) return formError(form, 'That reset code is incorrect. Check the code and email.', 'reset-token');
      const secured = await credentials(password);
      const records = accounts();
      const latest = records.find(record => record.email === email);
      if (!latest?.reset || latest.reset.digest !== token.digest || latest.reset.expiresAt <= Date.now() || latest.revision !== account.revision) return formError(form, 'This code is no longer valid. Get a new reset code.', 'reset-token');
      Object.assign(latest, secured, { revision: latest.revision + 1 });
      delete latest.reset;
      saveAccounts(records);
      sessionStorage.removeItem(SESSION_KEY);
      sessionStorage.removeItem(RESET_EMAIL_KEY);
      state.user = null;
      state.resetCode = '';
      state.resetEmail = '';
      $('#reset-code').textContent = '';
      $('#reset-code-panel').hidden = true;
      form.reset();
      clearPasswords();
      $('#login-email').value = email;
      clearErrors($('#login-form'));
      formSuccess($('#login-form'), 'Password reset. Log in with your new password.');
      navigate('login');
      toast('Password reset. All existing demo sessions for this account are signed out.');
    });
  });

  $$('.password-toggle').forEach(button => button.addEventListener('click', () => {
    const input = document.getElementById(button.dataset.toggle);
    input.dataset.passwordField = 'true';
    const showing = input.type === 'password';
    input.type = showing ? 'text' : 'password';
    button.textContent = showing ? 'Hide' : 'Show';
    button.setAttribute('aria-label', showing ? 'Hide password' : 'Show password');
  }));
  $('body').addEventListener('input', event => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    input.removeAttribute('aria-invalid');
    const error = document.getElementById(`${input.id}-error`);
    if (error) error.hidden = true;
  });
  $('#sign-out').addEventListener('click', () => safeAction(() => signOut()));
  $('#feed-sign-out').addEventListener('click', () => safeAction(() => signOut()));
  $('#use-reset-code').addEventListener('click', () => { $('#reset-email').value = state.resetEmail; $('#reset-token').value = state.resetCode; navigate('reset'); });
  window.addEventListener('hashchange', () => safeAction(renderRoute));
  window.addEventListener('storage', event => {
    if (![ACCOUNTS_KEY, null].includes(event.key) || !state.ready) return;
    safeAction(() => {
      const hadUser = Boolean(state.user);
      state.user = currentUser();
      if (hadUser && !state.user) { signOut('Your demo session ended. Log in again.'); return; }
      if (state.user && ['success', 'feed'].includes(state.route)) renderRoute();
    });
  });

  async function boot() {
    try {
      if (!crypto?.subtle) throw new Error('Open this demo over HTTPS or localhost to enable secure browser password hashing.');
      localStorage.setItem('account-demo.storage-check', 'ok');
      localStorage.removeItem('account-demo.storage-check');
      sessionStorage.setItem('account-demo.storage-check', 'ok');
      sessionStorage.removeItem('account-demo.storage-check');
      const records = accounts();
      if (!records.some(account => account.email === 'demo@example.com')) {
        const secured = await credentials('DemoPass123!');
        const latestRecords = accounts();
        if (!latestRecords.some(account => account.email === 'demo@example.com')) {
          latestRecords.push({ email: 'demo@example.com', name: 'Nash Amer L. Carampatana', ...secured, revision: 1, createdAt: new Date().toISOString() });
          saveAccounts(latestRecords);
        }
      }
      const namedRecords = accounts();
      const demoAccount = namedRecords.find(account => account.email === 'demo@example.com');
      if (demoAccount?.name === 'Demo User') {
        demoAccount.name = 'Nash Amer L. Carampatana';
        saveAccounts(namedRecords);
      }
      state.resetEmail = sessionStorage.getItem(RESET_EMAIL_KEY) || '';
      state.user = currentUser();
      state.ready = true;
      $('#loading').hidden = true;
      if (!location.hash) navigate(state.user ? 'feed' : 'login');
      else renderRoute();
    } catch (error) {
      $('#loading').hidden = true;
      $('#startup-error').textContent = friendlyError(error);
      $('#startup-error').hidden = false;
    }
  }

  boot();
})();
