// api/register.js — True browser-simulation registration engine
// Workflow per platform:
//   1. Fetch real signup page via server (no CORS, real IP)
//   2. Parse HTML form — extract fields, CSRF tokens, sitekeys
//   3. Solve any CAPTCHA via solver service
//   4. Submit form with real browser headers
//   5. Return result + any captured tokens/cookies

import { cors, checkAuth } from '../lib/auth.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Platform definitions: real signup URLs + form strategies ─────────────────
const PLATFORMS = {
  devto: {
    name: 'Dev.to',
    signupUrl: 'https://dev.to/enter?state=new-user',
    origin: 'https://dev.to',
    referer: 'https://dev.to/enter',
    strategy: 'json_api',
    endpoint: 'https://dev.to/users',
    method: 'POST',
    buildBody: ({ username, email, password, csrfToken, captchaToken }) => JSON.stringify({
      user: { name: username, email, password, username, terms: true, 'g-recaptcha-response': captchaToken || '' }
    }),
    contentType: 'application/json',
    captcha: { type: 'recaptcha_v2', siteKey: '6LeZOnQUAAAAABr0PGHH2EYuPlSXEfVQu07j2yca' },
    extraHeaders: (csrf) => ({ 'X-CSRF-Token': csrf || '' }),
    parseSuccess: (body, status) => status === 200 || status === 201 || body.includes('"id":'),
    parseToken: (body) => { try { const d = JSON.parse(body); return d?.api_secret || d?.token || null; } catch { return null; } },
    profileUrl: (username) => `https://dev.to/${username}`,
  },

  hashnode: {
    name: 'Hashnode',
    signupUrl: 'https://hashnode.com/onboard',
    origin: 'https://hashnode.com',
    referer: 'https://hashnode.com/onboard',
    strategy: 'graphql',
    endpoint: 'https://gql.hashnode.com/',
    method: 'POST',
    buildBody: ({ username, email, password }) => JSON.stringify({
      query: `mutation { createAccount(input: { email:"${email}", name:"${username}", username:"${username}", password:"${password}" }) { token user { username id } } }`
    }),
    contentType: 'application/json',
    captcha: null,
    parseSuccess: (body) => { try { const d = JSON.parse(body); return !!d?.data?.createAccount?.token; } catch { return false; } },
    parseToken: (body) => { try { return JSON.parse(body)?.data?.createAccount?.token || null; } catch { return null; } },
    profileUrl: (username) => `https://hashnode.com/@${username}`,
  },

  wordpress: {
    name: 'WordPress.com',
    signupUrl: 'https://wordpress.com/start/account',
    origin: 'https://wordpress.com',
    referer: 'https://wordpress.com/start/account',
    strategy: 'rest_form',
    endpoint: 'https://public-api.wordpress.com/rest/v1.1/users/new',
    method: 'POST',
    buildBody: ({ username, email, password }) =>
      new URLSearchParams({ email, username, password, signup_flow_name: 'signup', locale: 'en', client_id: '1854', client_secret: 'QNFqFpey9rNc' }).toString(),
    contentType: 'application/x-www-form-urlencoded',
    captcha: null,
    parseSuccess: (body, status) => status === 200 || status === 201 || (body.includes('user_id') && !body.includes('"error"')),
    parseToken: () => null,
    profileUrl: (username) => `https://${username}.wordpress.com`,
  },

  tumblr: {
    name: 'Tumblr',
    signupUrl: 'https://www.tumblr.com/register',
    origin: 'https://www.tumblr.com',
    referer: 'https://www.tumblr.com/register',
    strategy: 'html_form',
    endpoint: 'https://www.tumblr.com/register',
    method: 'POST',
    buildBody: ({ username, email, password, csrfToken }) =>
      new URLSearchParams({ email, password, tumblelog: username, signup_status: 'ACTIVE', age: '25', context: 'tumblr_dashboard_desktop', 'form_key': csrfToken || '' }).toString(),
    contentType: 'application/x-www-form-urlencoded',
    captcha: null,
    csrfSelector: 'input[name="form_key"]',
    parseSuccess: (body, status) => status === 200 || status === 201 || body.includes('tumblr.com/dashboard'),
    parseToken: () => null,
    profileUrl: (username) => `https://${username}.tumblr.com`,
  },

  reddit: {
    name: 'Reddit',
    signupUrl: 'https://www.reddit.com/register/',
    origin: 'https://www.reddit.com',
    referer: 'https://www.reddit.com/register/',
    strategy: 'json_api',
    endpoint: 'https://www.reddit.com/api/register',
    method: 'POST',
    buildBody: ({ username, email, password }) =>
      new URLSearchParams({ email, user: username, passwd: password, passwd2: password, api_type: 'json', rem: 'false', newsletter_subscribe: 'false' }).toString(),
    contentType: 'application/x-www-form-urlencoded',
    captcha: null,
    parseSuccess: (body) => { try { const d = JSON.parse(body); return !(d?.json?.errors?.length); } catch { return false; } },
    parseToken: () => null,
    profileUrl: (username) => `https://www.reddit.com/user/${username}`,
  },

  weebly: {
    name: 'Weebly',
    signupUrl: 'https://www.weebly.com/',
    origin: 'https://www.weebly.com',
    referer: 'https://www.weebly.com/',
    strategy: 'json_api',
    endpoint: 'https://www.weebly.com/app/do/member/create-account',
    method: 'POST',
    buildBody: ({ email, password }) => JSON.stringify({ email, password, tos: true }),
    contentType: 'application/json',
    captcha: null,
    parseSuccess: (body, status) => status === 200 && !body.includes('"error"'),
    parseToken: () => null,
    profileUrl: () => null,
  },

  wix: {
    name: 'Wix',
    signupUrl: 'https://www.wix.com/',
    origin: 'https://www.wix.com',
    referer: 'https://www.wix.com/',
    strategy: 'json_api',
    endpoint: 'https://users.wix.com/wix-users/register',
    method: 'POST',
    buildBody: ({ username, email, password }) => JSON.stringify({
      loginId: { email }, password, profile: { nickname: username }
    }),
    contentType: 'application/json',
    extraHeaders: () => ({ 'X-Wix-Client-Artifact-Id': 'wix-users' }),
    captcha: null,
    parseSuccess: (body, status) => status === 200 && body.includes('userId'),
    parseToken: () => null,
    profileUrl: () => null,
  },

  strikingly: {
    name: 'Strikingly',
    signupUrl: 'https://www.strikingly.com/s/signup',
    origin: 'https://www.strikingly.com',
    referer: 'https://www.strikingly.com/s/signup',
    strategy: 'json_api',
    endpoint: 'https://api.strikingly.com/api/v1/users',
    method: 'POST',
    buildBody: ({ email, password }) => JSON.stringify({ user: { email, password } }),
    contentType: 'application/json',
    captcha: null,
    parseSuccess: (body, status) => status === 200 || status === 201,
    parseToken: (body) => { try { return JSON.parse(body)?.auth_token || null; } catch { return null; } },
    profileUrl: () => null,
  },

  site123: {
    name: 'Site123',
    signupUrl: 'https://www.site123.com/sign-up',
    origin: 'https://www.site123.com',
    referer: 'https://www.site123.com/sign-up',
    strategy: 'json_api',
    endpoint: 'https://www.site123.com/api/user/register',
    method: 'POST',
    buildBody: ({ username, email, password }) => JSON.stringify({ email, password, name: username }),
    contentType: 'application/json',
    captcha: null,
    parseSuccess: (body, status) => status === 200 && !body.includes('"error"') && !body.includes('"status":false'),
    parseToken: (body) => { try { return JSON.parse(body)?.token || JSON.parse(body)?.api_token || null; } catch { return null; } },
    profileUrl: () => null,
  },

  medium: {
    name: 'Medium',
    signupUrl: 'https://medium.com/m/signin',
    origin: 'https://medium.com',
    referer: 'https://medium.com/',
    strategy: 'json_api',
    endpoint: 'https://medium.com/m/signin?redirect=/',
    method: 'POST',
    buildBody: ({ email }) => JSON.stringify({ email, redirectPath: '/', operation: 'login' }),
    contentType: 'application/json',
    extraHeaders: () => ({ 'X-Obvious-CID': 'web' }),
    captcha: null,
    parseSuccess: (body, status) => status === 200,
    parseToken: () => null,
    profileUrl: () => 'https://medium.com (check inbox for magic link)',
    note: 'Magic-link sent — check verification email to activate',
  },

  quora: {
    name: 'Quora',
    signupUrl: 'https://www.quora.com/',
    origin: 'https://www.quora.com',
    referer: 'https://www.quora.com/',
    strategy: 'graphql',
    endpoint: 'https://www.quora.com/graphql/gql_para_public',
    method: 'POST',
    buildBody: ({ username, email, password }) => JSON.stringify({
      queryName: 'EmailAuthMutation',
      variables: { email, password, displayName: username, isSignup: true }
    }),
    contentType: 'application/json',
    extraHeaders: () => ({ 'quora-sign-ons-available': '1' }),
    captcha: null,
    parseSuccess: (body, status) => status === 200,
    parseToken: () => null,
    profileUrl: () => null,
  },
};

// ── Fetch a page and return body + cookies ───────────────────────────────────
async function fetchPage(url, opts = {}) {
  const headers = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    ...(opts.headers || {}),
  };
  const r = await fetch(url, {
    method: opts.method || 'GET',
    headers,
    body: opts.body,
    redirect: opts.redirect || 'follow',
    signal: AbortSignal.timeout(opts.timeout || 20000),
  });
  const text = await r.text().catch(() => '');
  const setCookie = r.headers.get('set-cookie') || '';
  return { ok: r.ok, status: r.status, text, setCookie, headers: r.headers };
}

// ── Parse CSRF token from HTML ───────────────────────────────────────────────
function parseCsrf(html) {
  const patterns = [
    /name=["']authenticity_token["'][^>]*value=["']([^"']+)["']/i,
    /name=["']_token["'][^>]*value=["']([^"']+)["']/i,
    /name=["']csrf_token["'][^>]*value=["']([^"']+)["']/i,
    /name=["']form_key["'][^>]*value=["']([^"']+)["']/i,
    /"csrfToken"\s*:\s*"([^"]+)"/,
    /meta\s+name=["']csrf-token["']\s+content=["']([^"']+)["']/i,
    /name=["']_csrf["'][^>]*value=["']([^"']+)["']/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return m[1];
  }
  return null;
}

// ── Detect CAPTCHA type from HTML ────────────────────────────────────────────
function detectCaptcha(html) {
  if (/grecaptcha|google\.com\/recaptcha/i.test(html)) {
    const siteKeyMatch = html.match(/data-sitekey=["']([^"']+)["']/) ||
                         html.match(/"sitekey"\s*:\s*"([^"]+)"/) ||
                         html.match(/sitekey:\s*["']([^"']+)["']/);
    return { type: 'recaptcha_v2', siteKey: siteKeyMatch?.[1] || '' };
  }
  if (/hcaptcha/i.test(html)) {
    const m = html.match(/data-sitekey=["']([^"']+)["']/);
    return { type: 'hcaptcha', siteKey: m?.[1] || '' };
  }
  if (/turnstile/i.test(html)) {
    const m = html.match(/data-sitekey=["']([^"']+)["']/);
    return { type: 'turnstile', siteKey: m?.[1] || '' };
  }
  return null;
}

// ── Solve CAPTCHA via configured solver ──────────────────────────────────────
async function solveCaptcha({ type, siteKey, pageUrl, apiKey, solver }) {
  if (!apiKey) return { solved: false, token: null, error: 'No CAPTCHA API key provided' };

  const solverName = solver ||
    (process.env.TWOCAPTCHA_KEY  ? 'twocaptcha'  : null) ||
    (process.env.ANTICAPTCHA_KEY ? 'anticaptcha' : null) ||
    (process.env.CAPMONSTER_KEY  ? 'capmonster'  : null) ||
    'twocaptcha';

  const key = apiKey || process.env.TWOCAPTCHA_KEY || process.env.ANTICAPTCHA_KEY || process.env.CAPMONSTER_KEY;

  try {
    if (solverName === 'twocaptcha') {
      let body = `key=${key}&json=1&soft_id=4509`;
      if (type === 'recaptcha_v2') body += `&method=userrecaptcha&googlekey=${siteKey}&pageurl=${encodeURIComponent(pageUrl)}`;
      else if (type === 'hcaptcha') body += `&method=hcaptcha&sitekey=${siteKey}&pageurl=${encodeURIComponent(pageUrl)}`;
      else if (type === 'turnstile') body += `&method=turnstile&sitekey=${siteKey}&pageurl=${encodeURIComponent(pageUrl)}`;

      const submitR = await fetch('https://2captcha.com/in.php', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
        signal: AbortSignal.timeout(15000)
      });
      const submitData = await submitR.json();
      if (!submitData.request || submitData.status !== 1) throw new Error('2captcha submit failed: ' + JSON.stringify(submitData));

      const taskId = submitData.request;
      // Poll for result
      const deadline = Date.now() + 120000;
      await new Promise(r => setTimeout(r, 8000));
      while (Date.now() < deadline) {
        const pollR = await fetch(`https://2captcha.com/res.php?action=get&key=${key}&id=${taskId}&json=1`, { signal: AbortSignal.timeout(10000) });
        const pollData = await pollR.json();
        if (pollData.status === 1) return { solved: true, token: pollData.request };
        if (pollData.request !== 'CAPCHA_NOT_READY') throw new Error('2captcha poll error: ' + pollData.request);
        await new Promise(r => setTimeout(r, 4000));
      }
      throw new Error('2captcha timeout');
    } else {
      // anticaptcha / capmonster share the same JSON API format
      const endpoints = {
        anticaptcha: { submit: 'https://api.anti-captcha.com/createTask', result: 'https://api.anti-captcha.com/getTaskResult' },
        capmonster:  { submit: 'https://api.capmonster.cloud/createTask', result: 'https://api.capmonster.cloud/getTaskResult' },
      };
      const ep = endpoints[solverName];
      let task = {};
      if (type === 'recaptcha_v2') task = { type: 'NoCaptchaTaskProxyless', websiteURL: pageUrl, websiteKey: siteKey };
      else if (type === 'hcaptcha') task = { type: 'HCaptchaTaskProxyless', websiteURL: pageUrl, websiteKey: siteKey };

      const submitR = await fetch(ep.submit, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: key, task }),
        signal: AbortSignal.timeout(15000)
      });
      const submitData = await submitR.json();
      if (submitData.errorId) throw new Error(submitData.errorDescription);

      const deadline = Date.now() + 120000;
      await new Promise(r => setTimeout(r, 8000));
      while (Date.now() < deadline) {
        const pollR = await fetch(ep.result, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientKey: key, taskId: submitData.taskId }),
          signal: AbortSignal.timeout(10000)
        });
        const pollData = await pollR.json();
        if (pollData.status === 'ready') return { solved: true, token: pollData.solution?.gRecaptchaResponse || pollData.solution?.token };
        if (pollData.errorId) throw new Error(pollData.errorDescription);
        await new Promise(r => setTimeout(r, 4000));
      }
      throw new Error('Captcha solver timeout');
    }
  } catch (e) {
    return { solved: false, token: null, error: e.message };
  }
}

// ── mail.tm: get domain + create inbox + get JWT ─────────────────────────────
async function mailTmCreateInbox(address, password) {
  // Get available domains
  const domR = await fetch('https://api.mail.tm/domains?page=1', { signal: AbortSignal.timeout(12000) });
  const domData = await domR.json();
  const domain = domData['hydra:member']?.[0]?.domain || 'mail.tm';

  // Create account
  const r1 = await fetch('https://api.mail.tm/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, password }),
    signal: AbortSignal.timeout(12000),
  });
  // 422 = already exists — still try to get token
  if (!r1.ok && r1.status !== 422) {
    const err = await r1.text().catch(() => '');
    throw new Error(`mail.tm create failed ${r1.status}: ${err.slice(0,100)}`);
  }

  // Get JWT
  const r2 = await fetch('https://api.mail.tm/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, password }),
    signal: AbortSignal.timeout(12000),
  });
  if (!r2.ok) throw new Error('mail.tm auth failed: ' + r2.status);
  const { token } = await r2.json();
  return { token, domain };
}

// ── mail.tm: poll for verification email ─────────────────────────────────────
async function mailTmPoll(jwt, maxWaitMs = 90000) {
  const deadline = Date.now() + maxWaitMs;
  const seen = new Set();
  while (Date.now() < deadline) {
    try {
      const r = await fetch('https://api.mail.tm/messages?page=1', {
        headers: { 'Authorization': 'Bearer ' + jwt },
        signal: AbortSignal.timeout(10000),
      });
      if (r.ok) {
        const data = await r.json();
        for (const msg of (data['hydra:member'] || [])) {
          if (seen.has(msg.id)) continue;
          seen.add(msg.id);
          const mr = await fetch(`https://api.mail.tm/messages/${msg.id}`, {
            headers: { 'Authorization': 'Bearer ' + jwt },
            signal: AbortSignal.timeout(10000),
          });
          if (mr.ok) {
            const full = await mr.json();
            const body = full.text || full.html || '';
            const links = [...body.matchAll(/https?:\/\/[^\s"'<>\]]+/g)].map(m => m[0]);
            const link = links.find(l => /verif|confirm|activate|click|token|signup|register|welcome/i.test(l));
            if (link) return { found: true, link, subject: msg.subject };
          }
        }
      }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 5000));
  }
  return { found: false, link: null };
}

// ── Click verification link ───────────────────────────────────────────────────
async function clickVerificationLink(url) {
  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    return { clicked: true, status: r.status, ok: r.ok || r.status < 400 };
  } catch (e) {
    return { clicked: false, ok: false, error: e.message };
  }
}

// ── Main registration handler ─────────────────────────────────────────────────
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!checkAuth(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const {
    platform,       // platform id string e.g. 'devto'
    username,
    email,
    password,
    captchaApiKey,  // user's 2captcha/anticaptcha/capsolver key
    captchaSolver,  // 'twocaptcha' | 'anticaptcha' | 'capmonster'
    useMailTm = true,
    autoVerify = true,
  } = req.body || {};

  const log = [];
  const step = (msg, status = 'info') => { log.push({ t: new Date().toISOString(), msg, status }); };

  const plat = PLATFORMS[platform];
  if (!plat) return res.status(400).json({ ok: false, error: 'Unknown platform: ' + platform, log });

  step(`→ [${plat.name}] Starting registration for ${username}`);

  // ── PHASE 1: Get a real mail.tm inbox ────────────────────────────────────
  let finalEmail = email;
  let mailJwt = null;

  if (useMailTm) {
    try {
      step('📧 Creating mail.tm disposable inbox...');
      const mailPw = password + '_mail';
      const { token, domain } = await mailTmCreateInbox(email, mailPw);
      mailJwt = token;
      step(`✔ Inbox ready: ${email} (${domain})`, 'success');
    } catch (e) {
      step(`⚠ mail.tm failed (${e.message}) — using provided email`, 'warn');
    }
  }

  // ── PHASE 2: Fetch the real signup page ──────────────────────────────────
  let csrfToken = null;
  let captchaInfo = plat.captcha; // use platform default, may be overridden by page parse

  try {
    step(`🌐 Fetching signup page: ${plat.signupUrl}`);
    const page = await fetchPage(plat.signupUrl, {
      headers: { 'Origin': plat.origin, 'Referer': plat.referer },
    });

    if (page.text) {
      // Parse CSRF
      csrfToken = parseCsrf(page.text);
      if (csrfToken) step(`🔑 CSRF token extracted: ${csrfToken.slice(0, 20)}...`);

      // Detect live CAPTCHA from actual page (may differ from static config)
      const liveCaptcha = detectCaptcha(page.text);
      if (liveCaptcha?.siteKey && liveCaptcha.siteKey !== captchaInfo?.siteKey) {
        captchaInfo = liveCaptcha;
        step(`🧩 CAPTCHA detected: ${liveCaptcha.type} siteKey=${liveCaptcha.siteKey.slice(0,20)}...`);
      }
    }
  } catch (e) {
    step(`⚠ Signup page fetch failed: ${e.message} — proceeding with direct API`, 'warn');
  }

  // ── PHASE 3: Solve CAPTCHA if needed ─────────────────────────────────────
  let captchaToken = null;

  if (captchaInfo?.siteKey && (captchaApiKey || process.env.TWOCAPTCHA_KEY || process.env.ANTICAPTCHA_KEY || process.env.CAPMONSTER_KEY)) {
    step(`🧩 Solving ${captchaInfo.type} CAPTCHA...`);
    const result = await solveCaptcha({
      type: captchaInfo.type,
      siteKey: captchaInfo.siteKey,
      pageUrl: plat.signupUrl,
      apiKey: captchaApiKey,
      solver: captchaSolver,
    });
    if (result.solved) {
      captchaToken = result.token;
      step(`✔ CAPTCHA solved`, 'success');
    } else {
      step(`⚠ CAPTCHA solve failed: ${result.error} — attempting without token`, 'warn');
    }
  } else if (captchaInfo?.siteKey) {
    step(`⚠ CAPTCHA detected but no solver key provided — attempting without token`, 'warn');
  }

  // ── PHASE 4: Submit registration ─────────────────────────────────────────
  step(`📤 Submitting registration to ${plat.endpoint}`);

  let regOk = false;
  let regStatus = 0;
  let regBody = '';
  let apiToken = null;

  try {
    const extraHdrs = plat.extraHeaders ? plat.extraHeaders(csrfToken) : {};
    const body = plat.buildBody({ username, email: finalEmail, password, csrfToken, captchaToken });

    const regR = await fetch(plat.endpoint, {
      method: plat.method,
      headers: {
        'Content-Type': plat.contentType,
        'User-Agent': UA,
        'Accept': 'application/json, text/html, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': plat.origin,
        'Referer': plat.referer,
        ...extraHdrs,
      },
      body,
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });

    regStatus = regR.status;
    regBody = await regR.text().catch(() => '');
    regOk = plat.parseSuccess(regBody, regStatus);
    apiToken = plat.parseToken ? plat.parseToken(regBody) : null;

    if (regOk) {
      step(`✔ Registration accepted (HTTP ${regStatus})`, 'success');
      if (apiToken) step(`🔑 API token captured: ${apiToken.slice(0, 24)}...`, 'success');
    } else {
      // Extract error from response
      let errMsg = `HTTP ${regStatus}`;
      try {
        const errObj = JSON.parse(regBody);
        errMsg = errObj?.error || errObj?.message || errObj?.errors?.[0] || errMsg;
      } catch {}
      step(`✗ Registration rejected: ${errMsg}`, 'error');
    }
  } catch (e) {
    step(`✗ Registration request failed: ${e.message}`, 'error');
  }

  // ── PHASE 5: Email verification ──────────────────────────────────────────
  let verifyStatus = 'not_attempted';
  let verifyLink = null;

  if (regOk && autoVerify && mailJwt) {
    step(`📬 Polling inbox for verification email (up to 90s)...`);
    try {
      const poll = await mailTmPoll(mailJwt, 90000);
      if (poll.found) {
        verifyLink = poll.link;
        step(`📨 Verification email: "${poll.subject}"`, 'success');
        step(`🔗 Clicking: ${poll.link.slice(0, 80)}...`);
        const clickResult = await clickVerificationLink(poll.link);
        if (clickResult.ok) {
          verifyStatus = 'verified';
          step(`✅ Email verified — account fully activated!`, 'success');
        } else {
          verifyStatus = 'click_failed';
          step(`⚠ Link click failed (${clickResult.error || 'server rejected'}) — try manually: ${poll.link}`, 'warn');
        }
      } else {
        verifyStatus = 'no_email';
        step(`○ No verification email arrived within 90s (platform may not require it)`, 'info');
      }
    } catch (e) {
      verifyStatus = 'poll_error';
      step(`⚠ Inbox poll error: ${e.message}`, 'warn');
    }
  } else if (regOk && !mailJwt) {
    verifyStatus = 'no_inbox';
    step(`○ Email verification skipped — mail.tm inbox unavailable`, 'info');
  }

  // ── Done ────────────────────────────────────────────────────────────────
  const profileUrl = plat.profileUrl ? plat.profileUrl(username) : null;
  const finalNote = plat.note || (regOk
    ? (verifyStatus === 'verified' ? 'Registered and email verified ✅' : 'Registered (pending email verification)')
    : 'Registration failed');

  step(`\n── ${plat.name} complete: ${regOk ? 'SUCCESS' : 'FAILED'} ──`, regOk ? 'success' : 'error');

  return res.status(200).json({
    ok: regOk,
    platform,
    platformName: plat.name,
    username,
    email: finalEmail,
    password,
    apiToken,
    profileUrl,
    verifyStatus,
    verifyLink,
    httpStatus: regStatus,
    note: finalNote,
    log,
  });
}
