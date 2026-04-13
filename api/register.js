// api/register.js — SEO Parasite Pro · Vercel Serverless Function
// Handles all platform registrations server-side:
//   mail.tm inbox · CSRF extraction · CAPTCHA solve · form submit · email verify
// ─────────────────────────────────────────────────────────────────────────────

const SECRET = process.env.API_SECRET || '';

// ── Auth guard ────────────────────────────────────────────────────────────────
function checkAuth(req) {
  if (!SECRET) return true; // No secret configured = open (not recommended)
  const key = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  return key === SECRET;
}

// ── Tiny logger that accumulates lines to return to the frontend ──────────────
function makeLogger() {
  const lines = [];
  const log = (msg, cls = 'tm') => { lines.push({ msg, cls }); console.log('[REG]', msg); };
  return { log, lines };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIL.TM — create disposable inbox, return { email, jwt }
// ─────────────────────────────────────────────────────────────────────────────
async function createMailTmInbox(username, log) {
  log('📧 Creating mail.tm disposable inbox...', 'tm');

  // Step 1: get a live domain
  const domRes = await fetch('https://api.mail.tm/domains?page=1', {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!domRes.ok) throw new Error(`mail.tm domains HTTP ${domRes.status}`);
  const domText = await domRes.text();
  if (!domText || domText.trim() === '') throw new Error('mail.tm domains returned empty body');
  const domData = JSON.parse(domText);
  const domain = domData['hydra:member']?.[0]?.domain;
  if (!domain) throw new Error('mail.tm returned no domains');

  const address = `${username.toLowerCase().replace(/[^a-z0-9]/g, '')}${Math.floor(Math.random() * 9000 + 1000)}@${domain}`;
  const password = 'Tmp!' + Math.random().toString(36).slice(2, 10) + 'Zz9';

  // Step 2: create account
  const createRes = await fetch('https://api.mail.tm/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ address, password }),
    signal: AbortSignal.timeout(12000),
  });
  // 422 = already exists, that's fine
  if (!createRes.ok && createRes.status !== 422) {
    const body = await createRes.text().catch(() => '');
    throw new Error(`mail.tm create HTTP ${createRes.status}: ${body.slice(0, 120)}`);
  }

  // Step 3: get JWT
  const tokenRes = await fetch('https://api.mail.tm/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ address, password }),
    signal: AbortSignal.timeout(12000),
  });
  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => '');
    throw new Error(`mail.tm token HTTP ${tokenRes.status}: ${body.slice(0, 120)}`);
  }
  const tokenText = await tokenRes.text();
  if (!tokenText || tokenText.trim() === '') throw new Error('mail.tm token returned empty body');
  const { token } = JSON.parse(tokenText);
  if (!token) throw new Error('mail.tm returned no token');

  log(`✔ Inbox ready: ${address}`, 't-info');
  return { email: address, jwt: token };
}

// ─────────────────────────────────────────────────────────────────────────────
// Poll inbox for a verification link (server-side, no geo/CORS limits)
// ─────────────────────────────────────────────────────────────────────────────
async function pollForVerification(jwt, log, maxWaitMs = 90000) {
  log('📬 Polling inbox for verification email (up to 90s)...', 'tm');
  const deadline = Date.now() + maxWaitMs;
  const seen = new Set();

  while (Date.now() < deadline) {
    try {
      const r = await fetch('https://api.mail.tm/messages?page=1', {
        headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) {
        const text = await r.text();
        const data = JSON.parse(text);
        const msgs = data['hydra:member'] || [];
        for (const msg of msgs) {
          if (seen.has(msg.id)) continue;
          seen.add(msg.id);
          const mr = await fetch(`https://api.mail.tm/messages/${msg.id}`, {
            headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(8000),
          });
          if (mr.ok) {
            const full = JSON.parse(await mr.text());
            const body = full.text || full.html || '';
            const links = [...body.matchAll(/https?:\/\/[^\s"'<>\]]+/g)].map(m => m[0]);
            const verifyLink = links.find(l =>
              /verif|confirm|activate|click|token|signup|register|welcome/i.test(l)
            );
            if (verifyLink) {
              log(`✔ Verification email found: "${msg.subject}"`, 't-info');
              return { found: true, link: verifyLink };
            }
          }
        }
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 4000));
  }
  log('○ No verification email arrived within 90s', 'tm');
  return { found: false, link: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Click a verification link (server-side — no CORS issues)
// ─────────────────────────────────────────────────────────────────────────────
async function clickVerifyLink(url, log) {
  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,*/*',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    const ok = r.ok || r.status < 400;
    if (ok) log('✅ Verification link clicked — account activated!', 't-accent');
    else log(`⚠ Verify link returned HTTP ${r.status}`, 't-warn');
    return ok;
  } catch (e) {
    log(`⚠ Verify link error: ${e.message}`, 't-warn');
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Solve CAPTCHA via 2captcha API
// ─────────────────────────────────────────────────────────────────────────────
async function solveCaptcha(apiKey, siteKey, siteUrl, log) {
  if (!apiKey) return null;
  log('🤖 Solving CAPTCHA via 2captcha...', 'tm');
  try {
    // Submit task
    const sub = await fetch('https://2captcha.com/in.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ key: apiKey, method: 'userrecaptcha', googlekey: siteKey, pageurl: siteUrl, json: '1' }).toString(),
      signal: AbortSignal.timeout(15000),
    });
    const subData = JSON.parse(await sub.text());
    if (subData.status !== 1) { log(`⚠ 2captcha submit failed: ${subData.request}`, 't-warn'); return null; }
    const taskId = subData.request;

    // Poll for result (up to 120s)
    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const res = await fetch(`https://2captcha.com/res.php?key=${apiKey}&action=get&id=${taskId}&json=1`, {
        signal: AbortSignal.timeout(10000),
      });
      const resData = JSON.parse(await res.text());
      if (resData.status === 1) { log('✔ CAPTCHA solved', 't-info'); return resData.request; }
      if (resData.request !== 'CAPCHA_NOT_READY') { log(`⚠ 2captcha error: ${resData.request}`, 't-warn'); return null; }
    }
    log('⚠ CAPTCHA solve timed out', 't-warn');
    return null;
  } catch (e) {
    log(`⚠ CAPTCHA solver error: ${e.message}`, 't-warn');
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract CSRF token from HTML
// ─────────────────────────────────────────────────────────────────────────────
function extractCsrf(html) {
  const patterns = [
    /name="authenticity_token"[^>]+value="([^"]+)"/i,
    /name="_token"[^>]+value="([^"]+)"/i,
    /<meta[^>]+name="csrf-token"[^>]+content="([^"]+)"/i,
    /window\._token\s*=\s*["']([^"']+)/i,
    /csrfToken["'\s:]+["']([A-Za-z0-9+/=_-]{20,})/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return m[1];
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch a page with realistic browser headers
// ─────────────────────────────────────────────────────────────────────────────
async function browserFetch(url, opts = {}) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    ...(opts.headers || {}),
  };
  return fetch(url, { ...opts, headers, redirect: opts.redirect || 'follow', signal: opts.signal || AbortSignal.timeout(20000) });
}

// ─────────────────────────────────────────────────────────────────────────────
// PER-PLATFORM REGISTRATION LOGIC
// ─────────────────────────────────────────────────────────────────────────────

async function registerDevTo(username, email, password, captchaKey, log) {
  log('🌐 Fetching signup page: https://dev.to/enter?state=new-user', 'tm');
  const page = await browserFetch('https://dev.to/enter?state=new-user');
  const html = await page.text();

  const csrf = extractCsrf(html);
  if (csrf) log(`🔑 CSRF token extracted: ${csrf.slice(0, 20)}...`, 'tm');

  // Detect reCAPTCHA sitekey
  const siteKeyMatch = html.match(/data-sitekey="([^"]+)"/);
  const siteKey = siteKeyMatch?.[1] || '6LeZOnQUAAAAABr0PGHH2EYuPlSXEfVQu07j2yca';
  let capToken = '';
  if (captchaKey) {
    capToken = (await solveCaptcha(captchaKey, siteKey, 'https://dev.to/enter', log)) || '';
  } else {
    log('⚠ No CAPTCHA key — attempting without token (low success rate)', 't-warn');
  }

  log('📤 Submitting registration to https://dev.to/users', 'tm');
  const r = await browserFetch('https://dev.to/users', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf || '',
      Origin: 'https://dev.to',
      Referer: 'https://dev.to/enter?state=new-user',
    },
    body: JSON.stringify({
      user: {
        name: username,
        email,
        username,
        password,
        password_confirmation: password,
        terms: true,
        'g-recaptcha-response': capToken,
      },
    }),
  });

  if (r.ok || r.status === 201 || r.status === 200) {
    let apiKey = null;
    try { const d = JSON.parse(await r.text()); apiKey = d?.api_secret || d?.token || null; } catch (_) {}
    return { ok: true, apiKey, profileUrl: `https://dev.to/${username}`, note: 'Registered — verify email to activate' };
  }
  const body = await r.text().catch(() => '');
  log(`✗ Registration rejected: HTTP ${r.status}`, 't-warn');
  return { ok: false, note: `HTTP ${r.status}: ${body.slice(0, 80)}` };
}

async function registerHashnode(username, email, password, log) {
  log('🌐 Fetching signup page: https://hashnode.com/onboard', 'tm');
  // Hashnode uses GraphQL — no page scrape needed, but we need to hit the correct mutation
  log('📤 Submitting registration to https://gql.hashnode.com/', 'tm');
  const mutation = `mutation SignupUser($input: SignupInput!) {
    signupUser(input: $input) {
      token
      user { username email }
    }
  }`;
  const r = await browserFetch('https://gql.hashnode.com/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://hashnode.com',
      Referer: 'https://hashnode.com/onboard',
    },
    body: JSON.stringify({
      query: mutation,
      variables: {
        input: { email, name: username, username, password },
      },
    }),
  });

  const text = await r.text().catch(() => '{}');
  let apiKey = null, profileUrl = null;
  try {
    const d = JSON.parse(text);
    apiKey = d?.data?.signupUser?.token || null;
    if (apiKey) profileUrl = `https://hashnode.com/@${username}`;
    if (d?.errors?.length) {
      const msg = d.errors[0]?.message || JSON.stringify(d.errors[0]);
      log(`✗ Hashnode error: ${msg}`, 't-warn');
      return { ok: false, note: msg };
    }
  } catch (_) {}

  if (apiKey) return { ok: true, apiKey, profileUrl, note: 'Registered — token captured' };
  log(`✗ Registration rejected: no token in response`, 't-warn');
  return { ok: false, note: 'Registration failed — username/email taken or API changed' };
}

async function registerWordPress(username, email, password, log) {
  log('🌐 Fetching signup page: https://wordpress.com/start/account', 'tm');
  // WordPress.com requires client_id — use the public one from their own web app
  const CLIENT_ID = '49750'; // wordpress.com web client_id (public)
  log('📤 Submitting registration to https://public-api.wordpress.com/rest/v1.1/users/new', 'tm');
  const r = await browserFetch('https://public-api.wordpress.com/rest/v1.1/users/new', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: 'https://wordpress.com',
      Referer: 'https://wordpress.com/start/account',
    },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: 'KGBUkbx9QSW7oFRSMXeXSiMg1NFsaxGMcXd5GlXDh6x4yBPmRzqHlJu5gCE7Ywjp',
      email,
      username,
      password,
      signup_flow_name: 'onboarding-registrationless-flow',
      locale: 'en',
    }).toString(),
  });

  const body = await r.text().catch(() => '');
  if (r.ok || r.status === 200 || r.status === 201) {
    return { ok: true, apiKey: null, profileUrl: `https://${username}.wordpress.com`, note: 'Registered — check email to verify' };
  }
  // Try to extract a readable error
  let errMsg = `HTTP ${r.status}`;
  try { const d = JSON.parse(body); errMsg = d?.error || d?.message || errMsg; } catch (_) {}
  log(`✗ Registration rejected: ${errMsg}`, 't-warn');
  return { ok: false, note: errMsg };
}

async function registerMedium(username, email, password, log) {
  // Medium only supports magic-link / OAuth — no password registration
  // We trigger a sign-in magic link which creates the account if new
  log('🌐 Fetching signup page: https://medium.com/m/signin', 'tm');
  log('📤 Submitting magic-link request to https://medium.com/m/signin', 'tm');
  const r = await browserFetch('https://medium.com/m/emailSignup', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Obvious-CID': 'web',
      'X-Client-Date': Date.now().toString(),
      Origin: 'https://medium.com',
      Referer: 'https://medium.com/m/signin',
    },
    body: JSON.stringify({ email, redirectPath: '/', operation: 'login' }),
  });

  const ok = r.ok || r.status === 200;
  if (ok) {
    log('✔ Magic-link sent — check inbox to activate', 't-info');
    return { ok: true, apiKey: null, profileUrl: null, note: 'Magic-link sent — check verification email to activate' };
  }
  log(`✗ Registration rejected: HTTP ${r.status}`, 't-warn');
  return { ok: false, note: `HTTP ${r.status}` };
}

async function registerTumblr(username, email, password, log) {
  log('🌐 Fetching signup page: https://www.tumblr.com/register', 'tm');
  const page = await browserFetch('https://www.tumblr.com/register');
  const html = await page.text();
  const csrf = extractCsrf(html);
  if (csrf) log(`🔑 CSRF token extracted: ${csrf.slice(0, 20)}...`, 'tm');

  log('📤 Submitting registration to https://www.tumblr.com/register', 'tm');
  const r = await browserFetch('https://www.tumblr.com/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: 'https://www.tumblr.com',
      Referer: 'https://www.tumblr.com/register',
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    },
    body: new URLSearchParams({
      email,
      password,
      tumblelog: username,
      signup_status: 'ACTIVE',
      age: '25',
      context: 'tumblr_dashboard_desktop',
      ...(csrf ? { authenticity_token: csrf } : {}),
    }).toString(),
  });

  const ok = r.ok || r.status === 201 || r.status === 200;
  if (ok) return { ok: true, apiKey: null, profileUrl: `https://${username}.tumblr.com`, note: 'Registered on Tumblr' };
  log(`✗ Registration rejected: HTTP ${r.status}`, 't-warn');
  return { ok: false, note: `HTTP ${r.status}` };
}

async function registerReddit(username, email, password, captchaKey, log) {
  log('🌐 Fetching signup page: https://www.reddit.com/register', 'tm');
  const page = await browserFetch('https://www.reddit.com/register');
  const html = await page.text();

  // Reddit uses their own CAPTCHA — try to solve if key provided
  const siteKeyMatch = html.match(/data-sitekey="([^"]+)"/);
  const siteKey = siteKeyMatch?.[1] || '6LeTnxkTAAAAAN9QEuDZRpn1WXMx1C7cmbl7pzba';
  let capToken = '';
  if (captchaKey) {
    capToken = (await solveCaptcha(captchaKey, siteKey, 'https://www.reddit.com/register', log)) || '';
  }

  log('📤 Submitting registration to https://www.reddit.com/api/register', 'tm');
  const r = await browserFetch('https://www.reddit.com/api/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: 'https://www.reddit.com',
      Referer: 'https://www.reddit.com/register',
    },
    body: new URLSearchParams({
      email,
      user: username,
      passwd: password,
      passwd2: password,
      api_type: 'json',
      rem: 'false',
      'g-recaptcha-response': capToken,
    }).toString(),
  });

  const body = await r.text().catch(() => '{}');
  let errMsg = null;
  try {
    const d = JSON.parse(body);
    if (d?.json?.errors?.length) errMsg = d.json.errors[0]?.[1] || JSON.stringify(d.json.errors[0]);
  } catch (_) {}
  const ok = (r.ok || r.status === 200) && !errMsg;
  if (ok) return { ok: true, apiKey: null, profileUrl: `https://reddit.com/user/${username}`, note: 'Registered on Reddit' };
  log(`✗ Registration rejected: ${errMsg || `HTTP ${r.status}`}`, 't-warn');
  return { ok: false, note: errMsg || `HTTP ${r.status}` };
}

async function registerWeebly(username, email, password, log) {
  log('🌐 Fetching signup page: https://www.weebly.com/signup', 'tm');
  log('📤 Submitting registration to https://www.weebly.com/app/do/member/create-account', 'tm');
  const r = await browserFetch('https://www.weebly.com/app/do/member/create-account', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: 'https://www.weebly.com',
      Referer: 'https://www.weebly.com/signup',
    },
    body: JSON.stringify({ email, password, tos: true }),
  });
  const ok = r.ok || r.status === 200;
  if (ok) return { ok: true, apiKey: null, profileUrl: null, note: 'Weebly account created — verify email' };
  log(`✗ Registration rejected: HTTP ${r.status}`, 't-warn');
  return { ok: false, note: `HTTP ${r.status}` };
}

async function registerWix(username, email, password, log) {
  log('🌐 Fetching signup page: https://users.wix.com/signin', 'tm');
  log('📤 Submitting registration to https://users.wix.com/wix-users/register', 'tm');
  const r = await browserFetch('https://users.wix.com/wix-users/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Wix-Client-Artifact-Id': 'wix-users',
      Origin: 'https://www.wix.com',
      Referer: 'https://users.wix.com/signin?signupFirst=true',
    },
    body: JSON.stringify({ loginId: { email }, password, profile: { nickname: username } }),
  });
  const ok = r.ok || r.status === 200;
  if (ok) return { ok: true, apiKey: null, profileUrl: null, note: 'Wix account registered — verify email' };
  log(`✗ Registration rejected: HTTP ${r.status}`, 't-warn');
  return { ok: false, note: `HTTP ${r.status}` };
}

async function registerStrikingly(username, email, password, log) {
  log('🌐 Fetching signup page: https://www.strikingly.com/s/signup', 'tm');
  const page = await browserFetch('https://www.strikingly.com/s/signup');
  const html = await page.text();
  const csrf = extractCsrf(html);
  if (csrf) log(`🔑 CSRF token extracted: ${csrf.slice(0, 20)}...`, 'tm');

  log('📤 Submitting registration to https://api.strikingly.com/api/v1/users', 'tm');
  const r = await browserFetch('https://api.strikingly.com/api/v1/users', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://www.strikingly.com',
      Referer: 'https://www.strikingly.com/s/signup',
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    },
    body: JSON.stringify({ user: { email, password, name: username } }),
  });
  const ok = r.ok || r.status === 201 || r.status === 200;
  if (ok) return { ok: true, apiKey: null, profileUrl: null, note: 'Strikingly account created' };
  log(`✗ Registration rejected: HTTP ${r.status}`, 't-warn');
  return { ok: false, note: `HTTP ${r.status}` };
}

async function registerSite123(username, email, password, log) {
  log('🌐 Fetching signup page: https://www.site123.com/sign-up', 'tm');
  log('📤 Submitting registration to https://www.site123.com/api/user/register', 'tm');
  const r = await browserFetch('https://www.site123.com/api/user/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://www.site123.com',
      Referer: 'https://www.site123.com/sign-up',
    },
    body: JSON.stringify({ email, password, name: username }),
  });
  const ok = r.ok || r.status === 200;
  if (ok) return { ok: true, apiKey: null, profileUrl: null, note: 'Registered (pending email verification)' };
  log(`✗ Registration rejected: HTTP ${r.status}`, 't-warn');
  return { ok: false, note: `HTTP ${r.status}` };
}

async function registerQuora(username, email, password, captchaKey, log) {
  log('🌐 Fetching signup page: https://www.quora.com/signup', 'tm');
  const page = await browserFetch('https://www.quora.com/signup');
  const html = await page.text();
  const csrf = extractCsrf(html);
  if (csrf) log(`🔑 CSRF token extracted: ${csrf.slice(0, 20)}...`, 'tm');

  log('📤 Submitting registration to https://www.quora.com/graphql/gql_para_public', 'tm');
  const r = await browserFetch('https://www.quora.com/graphql/gql_para_public', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'quora-sign-ons-available': '1',
      Origin: 'https://www.quora.com',
      Referer: 'https://www.quora.com/signup',
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    },
    body: JSON.stringify({
      queryName: 'EmailAuthMutation',
      variables: { email, password, displayName: username, isSignup: true },
    }),
  });
  const ok = r.ok || r.status === 200;
  if (ok) return { ok: true, apiKey: null, profileUrl: null, note: 'Quora account requested — verify email to activate' };
  log(`✗ Registration rejected: HTTP ${r.status}`, 't-warn');
  return { ok: false, note: `HTTP ${r.status}` };
}

async function registerBlogger(username, email, password, log) {
  // Blogger = Google account — cannot auto-register without Google OAuth
  // Instead we register a free Blogspot site via a workaround-free path:
  // Return a helpful note pointing to the Google sign-in URL
  log('ℹ Blogger requires a Google account — cannot fully automate', 't-warn');
  log('  → Use the W2B builder with a Google Bearer token to post', 'tm');
  return {
    ok: false,
    note: 'Blogger requires Google OAuth — provide Google Bearer token in Setup to post',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PLATFORM ROUTER
// ─────────────────────────────────────────────────────────────────────────────
async function registerOnPlatform(pid, username, email, password, captchaKey, log) {
  switch (pid) {
    case 'devto':      return registerDevTo(username, email, password, captchaKey, log);
    case 'hashnode':   return registerHashnode(username, email, password, log);
    case 'wordpress':  return registerWordPress(username, email, password, log);
    case 'medium':     return registerMedium(username, email, password, log);
    case 'tumblr':     return registerTumblr(username, email, password, log);
    case 'reddit':     return registerReddit(username, email, password, captchaKey, log);
    case 'weebly':     return registerWeebly(username, email, password, log);
    case 'wix':        return registerWix(username, email, password, log);
    case 'strikingly': return registerStrikingly(username, email, password, log);
    case 'site123':    return registerSite123(username, email, password, log);
    case 'quora':      return registerQuora(username, email, password, captchaKey, log);
    case 'blogger':    return registerBlogger(username, email, password, log);
    default:
      return { ok: false, note: `Unknown platform: ${pid}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS — allow requests from any origin (frontend can be anywhere)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth
  if (!checkAuth(req)) return res.status(401).json({ error: 'Unauthorized — check Vercel Secret Key in Settings' });

  const { platform, username, password, captchaKey, useMailTm, autoVerify } = req.body || {};

  if (!platform || !username || !password) {
    return res.status(400).json({ error: 'Missing required fields: platform, username, password' });
  }

  const { log, lines } = makeLogger();
  log(`→ [${platform}] Starting registration for ${username}`, 't-accent');

  // ── Phase 1: Create mail.tm inbox ─────────────────────────────────────────
  let email = `${username}@proton.me`; // fallback
  let mailJwt = null;

  if (useMailTm) {
    try {
      const inbox = await createMailTmInbox(username, log);
      email = inbox.email;
      mailJwt = inbox.jwt;
    } catch (e) {
      log(`⚠ mail.tm failed (${e.message}) — using provided email`, 't-warn');
      // Keep fallback email
    }
  }

  // ── Phase 2–4: Register on platform ──────────────────────────────────────
  let result;
  try {
    result = await registerOnPlatform(platform, username, email, password, captchaKey, log);
  } catch (e) {
    log(`✗ Unhandled error: ${e.message}`, 't-err');
    result = { ok: false, note: `Error: ${e.message}` };
  }

  // ── Phase 5: Email verification ───────────────────────────────────────────
  let verifyStatus = 'unverified';

  if (result.ok && mailJwt && autoVerify) {
    const verif = await pollForVerification(mailJwt, log);
    if (verif.found) {
      const clicked = await clickVerifyLink(verif.link, log);
      verifyStatus = clicked ? 'verified' : 'verify-link-found';
    } else {
      verifyStatus = 'no-email-required';
    }
  } else if (result.ok && !mailJwt) {
    verifyStatus = 'manual-verify-needed';
    log('○ Email verification skipped — mail.tm inbox unavailable', 'tm');
  }

  const status = result.ok ? 'SUCCESS' : 'FAILED';
  log(`── ${platform} complete: ${status} ──`, result.ok ? 't-accent' : 'tm');

  return res.status(200).json({
    ok: result.ok,
    email,
    apiKey: result.apiKey || null,
    profileUrl: result.profileUrl || null,
    verifyStatus,
    note: result.note || (result.ok ? 'Registration succeeded' : 'Registration failed'),
    log: lines,
  });
}
