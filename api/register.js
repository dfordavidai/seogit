// /api/register.js — Vercel Serverless Function
// Handles preset platform registrations for:
// Dev.to, Hashnode, Medium, WordPress.com, Tumblr, Reddit,
// Quora, Weebly, Wix, Strikingly, Site123, Blogger
//
// Required env vars (set in Vercel dashboard):
//   API_SECRET   — optional, must match X-API-Key header if set
//
// Install (package.json):
//   "dependencies": {
//     "node-fetch": "^3.3.2"
//   }

export const config = { maxDuration: 180 }; // 3 min timeout

// ── Auth middleware ────────────────────────────────────────────
function checkAuth(req, res) {
  const secret = process.env.API_SECRET;
  if (!secret) return true; // no secret set → open
  const key = req.headers['x-api-key'] || '';
  if (key !== secret) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// ── Helpers ────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── mail.tm inbox creation (server-side, no CORS issues) ──────
async function createMailTmInbox() {
  const fetch = (await import('node-fetch')).default;
  // Get available domains
  const domResp = await fetch('https://api.mail.tm/domains?page=1');
  const domData = await domResp.json();
  const domain = domData?.['hydra:member']?.[0]?.domain;
  if (!domain) throw new Error('No mail.tm domain available');

  const rnd = Math.random().toString(36).slice(2, 10);
  const address = `${rnd}@${domain}`;
  const password = 'Reg!st3r#' + rnd;

  const accResp = await fetch('https://api.mail.tm/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, password }),
  });
  const accData = await accResp.json();
  if (!accResp.ok) throw new Error(accData?.['hydra:description'] || 'mail.tm account creation failed');

  const tokResp = await fetch('https://api.mail.tm/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, password }),
  });
  const tokData = await tokResp.json();
  if (!tokResp.ok) throw new Error('mail.tm token failed');

  return { address, token: tokData.token, id: accData.id };
}

// ── Poll mail.tm for verification email ───────────────────────
async function pollMailTm(token, maxWaitMs = 90000) {
  const fetch = (await import('node-fetch')).default;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await sleep(5000);
    try {
      const r = await fetch('https://api.mail.tm/messages?page=1', {
        headers: { Authorization: 'Bearer ' + token },
      });
      const data = await r.json();
      const msgs = data?.['hydra:member'] || [];
      if (msgs.length) {
        const msgR = await fetch(`https://api.mail.tm/messages/${msgs[0].id}`, {
          headers: { Authorization: 'Bearer ' + token },
        });
        const msgData = await msgR.json();
        const html = msgData.html?.[0] || msgData.text || '';
        const links = [...html.matchAll(/https?:\/\/[^\s"'<>]+/g)].map(m => m[0]);
        const verifyLink = links.find(l => /verif|confirm|activ|token|activate|register/i.test(l));
        return { found: true, link: verifyLink || links[0] || null, subject: msgs[0].subject || '' };
      }
    } catch (e) { /* continue */ }
  }
  return { found: false, link: null };
}

// ── Click a URL (for email verification) ──────────────────────
async function clickLink(url) {
  const fetch = (await import('node-fetch')).default;
  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      redirect: 'follow',
    });
    return r.ok || r.status < 400;
  } catch (e) { return false; }
}

// ══════════════════════════════════════════════════════════════
// PLATFORM REGISTRATION HANDLERS
// ══════════════════════════════════════════════════════════════

async function registerDevTo(username, password, email, log) {
  const fetch = (await import('node-fetch')).default;
  const L = (msg, cls = 'tm') => log.push({ msg, cls });
  L('🔗 Registering on Dev.to via API…', 't-info');
  try {
    const resp = await fetch('https://dev.to/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        user: { username, email, password, password_confirmation: password, name: username },
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok || resp.status === 201 || resp.status === 200) {
      L('✅ Dev.to registration accepted', 't-accent');
      return { ok: true, email, profileUrl: `https://dev.to/${username}`, note: 'Registered — check email for verification', verifyStatus: 'submitted-success' };
    }
    const errMsg = data?.error || data?.errors?.join(', ') || `HTTP ${resp.status}`;
    L(`❌ Dev.to error: ${errMsg}`, 't-err');
    return { ok: false, note: errMsg, verifyStatus: 'unverified' };
  } catch (e) {
    L(`❌ Dev.to exception: ${e.message}`, 't-err');
    return { ok: false, note: e.message, verifyStatus: 'unverified' };
  }
}

async function registerHashnode(username, password, email, log) {
  const fetch = (await import('node-fetch')).default;
  const L = (msg, cls = 'tm') => log.push({ msg, cls });
  L('🔗 Registering on Hashnode via GraphQL…', 't-info');
  const query = `mutation SignupUser($input: SignupInput!) {
    signupUser(input: $input) {
      user { username email }
      errors { field message }
    }
  }`;
  try {
    const resp = await fetch('https://api.hashnode.com/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        variables: { input: { username, email, password, name: username } },
      }),
    });
    const data = await resp.json();
    const errors = data?.data?.signupUser?.errors;
    if (errors?.length) {
      const msg = errors.map(e => `${e.field}: ${e.message}`).join('; ');
      L(`❌ Hashnode errors: ${msg}`, 't-err');
      return { ok: false, note: msg, verifyStatus: 'unverified' };
    }
    if (data?.data?.signupUser?.user) {
      L('✅ Hashnode registration accepted', 't-accent');
      return { ok: true, email, profileUrl: `https://hashnode.com/@${username}`, note: 'Registered — check email', verifyStatus: 'submitted-success' };
    }
    const gqlErr = data?.errors?.[0]?.message || `HTTP ${resp.status}`;
    L(`❌ Hashnode: ${gqlErr}`, 't-err');
    return { ok: false, note: gqlErr, verifyStatus: 'unverified' };
  } catch (e) {
    L(`❌ Hashnode exception: ${e.message}`, 't-err');
    return { ok: false, note: e.message, verifyStatus: 'unverified' };
  }
}

async function registerWordPress(username, password, email, log) {
  const fetch = (await import('node-fetch')).default;
  const L = (msg, cls = 'tm') => log.push({ msg, cls });
  L('🔗 Registering on WordPress.com…', 't-info');
  try {
    // Step 1: Get nonce/token from signup page
    const pageResp = await fetch('https://wordpress.com/start/user', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SeoParaPro/1.0)' },
    });
    const pageText = await pageResp.text();

    // Step 2: POST to WP REST signup endpoint
    const resp = await fetch('https://wordpress.com/wp-login.php?action=register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Referer: 'https://wordpress.com/start/user',
      },
      body: new URLSearchParams({
        user_login: username,
        user_email: email,
        redirect_to: 'https://wordpress.com',
      }).toString(),
    });

    // WordPress.com returns 302 on success, 200 with error on fail
    if (resp.status === 302 || resp.ok) {
      L('✅ WordPress.com registration submitted', 't-accent');
      return { ok: true, email, profileUrl: `https://${username}.wordpress.com`, note: 'Check email to complete activation', verifyStatus: 'submitted-success' };
    }
    L(`⚠ WordPress.com HTTP ${resp.status}`, 't-warn');
    return { ok: false, note: `HTTP ${resp.status} — WP may require CAPTCHA`, verifyStatus: 'unverified' };
  } catch (e) {
    L(`❌ WordPress.com exception: ${e.message}`, 't-err');
    return { ok: false, note: e.message, verifyStatus: 'unverified' };
  }
}

async function registerReddit(username, password, email, captchaKey, log) {
  const fetch = (await import('node-fetch')).default;
  const L = (msg, cls = 'tm') => log.push({ msg, cls });
  L('🔗 Registering on Reddit…', 't-info');
  L('⚠ Reddit requires CAPTCHA — a valid 2captcha key is needed', 't-warn');
  if (!captchaKey) {
    L('❌ No CAPTCHA key provided — Reddit registration will likely fail', 't-err');
    return { ok: false, note: 'Reddit requires CAPTCHA solving. Add a 2captcha key.', verifyStatus: 'unverified' };
  }

  try {
    // Get Reddit API token (client_credentials)
    const tokenResp = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from('CHXpKbf_hPh_PA:').toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'SeoParaPro/1.0',
      },
      body: 'grant_type=client_credentials',
    });

    // Attempt registration via Reddit API
    const resp = await fetch('https://www.reddit.com/api/register.json', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'SeoParaPro/1.0',
      },
      body: new URLSearchParams({
        user: username,
        passwd: password,
        passwd2: password,
        email,
        api_type: 'json',
      }).toString(),
    });

    const data = await resp.json();
    if (data?.json?.errors?.length) {
      const msg = data.json.errors.map(e => e[1]).join('; ');
      L(`❌ Reddit errors: ${msg}`, 't-err');
      return { ok: false, note: msg, verifyStatus: 'unverified' };
    }
    if (data?.json?.data?.modhash) {
      L('✅ Reddit registration accepted!', 't-accent');
      return { ok: true, email, profileUrl: `https://www.reddit.com/user/${username}`, note: 'Reddit account created', verifyStatus: 'no-email-required' };
    }
    const errMsg = JSON.stringify(data).slice(0, 120);
    L(`❌ Reddit: ${errMsg}`, 't-err');
    return { ok: false, note: errMsg, verifyStatus: 'unverified' };
  } catch (e) {
    L(`❌ Reddit exception: ${e.message}`, 't-err');
    return { ok: false, note: e.message, verifyStatus: 'unverified' };
  }
}

async function registerMedium(username, password, email, log) {
  const L = (msg, cls = 'tm') => log.push({ msg, cls });
  L('⚠ Medium no longer supports direct email registration via API — redirects to OAuth (Google/Twitter)', 't-warn');
  L('💡 Use the Universal Account Creator (Playwright tab) for Medium instead', 't-info');
  return {
    ok: false,
    email,
    note: 'Medium requires OAuth (Google/Twitter) — use Universal Creator tab with Playwright',
    verifyStatus: 'manual-verify-needed',
  };
}

async function registerTumblr(username, password, email, log) {
  const fetch = (await import('node-fetch')).default;
  const L = (msg, cls = 'tm') => log.push({ msg, cls });
  L('🔗 Registering on Tumblr…', 't-info');
  try {
    const resp = await fetch('https://www.tumblr.com/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Referer: 'https://www.tumblr.com/register',
      },
      body: new URLSearchParams({
        email,
        password,
        tumblelog_name: username,
        form_key: '',
      }).toString(),
      redirect: 'manual',
    });
    if (resp.status === 302 || resp.status === 301 || resp.ok) {
      L('✅ Tumblr registration submitted', 't-accent');
      return { ok: true, email, profileUrl: `https://${username}.tumblr.com`, note: 'Check email to verify', verifyStatus: 'submitted-success' };
    }
    L(`⚠ Tumblr HTTP ${resp.status}`, 't-warn');
    return { ok: false, note: `HTTP ${resp.status}`, verifyStatus: 'unverified' };
  } catch (e) {
    L(`❌ Tumblr exception: ${e.message}`, 't-err');
    return { ok: false, note: e.message, verifyStatus: 'unverified' };
  }
}

async function registerWeebly(username, password, email, log) {
  const fetch = (await import('node-fetch')).default;
  const L = (msg, cls = 'tm') => log.push({ msg, cls });
  L('🔗 Registering on Weebly…', 't-info');
  try {
    const resp = await fetch('https://www.weebly.com/app/do/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: JSON.stringify({ email, password, name: username }),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok || data?.user) {
      L('✅ Weebly registration accepted', 't-accent');
      return { ok: true, email, profileUrl: `https://${username}.weebly.com`, note: 'Weebly account created', verifyStatus: 'submitted-success' };
    }
    const errMsg = data?.message || data?.error || `HTTP ${resp.status}`;
    L(`❌ Weebly: ${errMsg}`, 't-err');
    return { ok: false, note: errMsg, verifyStatus: 'unverified' };
  } catch (e) {
    L(`❌ Weebly exception: ${e.message}`, 't-err');
    return { ok: false, note: e.message, verifyStatus: 'unverified' };
  }
}

async function registerWix(username, password, email, log) {
  const fetch = (await import('node-fetch')).default;
  const L = (msg, cls = 'tm') => log.push({ msg, cls });
  L('🔗 Registering on Wix…', 't-info');
  try {
    const resp = await fetch('https://users.wix.com/_api/iam/authentication/v2/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: JSON.stringify({
        loginId: { email },
        password,
        profile: { nickname: username },
        captchaTokens: [],
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok || data?.sessionToken) {
      L('✅ Wix registration accepted', 't-accent');
      return { ok: true, email, profileUrl: `https://www.wix.com/${username}`, note: 'Wix account created — check email', verifyStatus: 'submitted-success' };
    }
    const errMsg = data?.message || `HTTP ${resp.status}`;
    L(`❌ Wix: ${errMsg}`, 't-err');
    return { ok: false, note: errMsg, verifyStatus: 'unverified' };
  } catch (e) {
    L(`❌ Wix exception: ${e.message}`, 't-err');
    return { ok: false, note: e.message, verifyStatus: 'unverified' };
  }
}

async function registerStrikingly(username, password, email, log) {
  const fetch = (await import('node-fetch')).default;
  const L = (msg, cls = 'tm') => log.push({ msg, cls });
  L('🔗 Registering on Strikingly…', 't-info');
  try {
    const resp = await fetch('https://app.strikingly.com/api/users/signup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: JSON.stringify({ user: { email, password, name: username } }),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok || data?.id || data?.user) {
      L('✅ Strikingly registration accepted', 't-accent');
      return { ok: true, email, profileUrl: `https://${username}.strikingly.com`, note: 'Account created — check email', verifyStatus: 'submitted-success' };
    }
    const errMsg = data?.message || data?.error || `HTTP ${resp.status}`;
    L(`❌ Strikingly: ${errMsg}`, 't-err');
    return { ok: false, note: errMsg, verifyStatus: 'unverified' };
  } catch (e) {
    L(`❌ Strikingly exception: ${e.message}`, 't-err');
    return { ok: false, note: e.message, verifyStatus: 'unverified' };
  }
}

async function registerSite123(username, password, email, log) {
  const fetch = (await import('node-fetch')).default;
  const L = (msg, cls = 'tm') => log.push({ msg, cls });
  L('🔗 Registering on Site123…', 't-info');
  try {
    const resp = await fetch('https://www.site123.com/api/auth/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: JSON.stringify({ email, password, name: username }),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok || data?.token || data?.user) {
      L('✅ Site123 registration accepted', 't-accent');
      return { ok: true, email, note: 'Account created — check email', verifyStatus: 'submitted-success' };
    }
    const errMsg = data?.message || data?.error || `HTTP ${resp.status}`;
    L(`❌ Site123: ${errMsg}`, 't-err');
    return { ok: false, note: errMsg, verifyStatus: 'unverified' };
  } catch (e) {
    L(`❌ Site123 exception: ${e.message}`, 't-err');
    return { ok: false, note: e.message, verifyStatus: 'unverified' };
  }
}

async function registerQuora(username, password, email, log) {
  const L = (msg, cls = 'tm') => log.push({ msg, cls });
  L('⚠ Quora blocks API-based registration — requires browser automation', 't-warn');
  L('💡 Use Universal Account Creator (Playwright tab) with URL: https://www.quora.com/signup', 't-info');
  return {
    ok: false,
    email,
    note: 'Quora blocks direct API reg — use Universal Creator (Playwright) instead',
    verifyStatus: 'manual-verify-needed',
  };
}

async function registerBlogger(username, password, email, log) {
  const L = (msg, cls = 'tm') => log.push({ msg, cls });
  L('⚠ Blogger requires a Google OAuth token (not email+password)', 't-warn');
  L('💡 Use Universal Account Creator with your Google-authenticated session, or manually create a Google account first', 't-info');
  return {
    ok: false,
    email,
    note: 'Blogger requires Google OAuth — create Google account first, then use Universal Creator',
    verifyStatus: 'manual-verify-needed',
  };
}

// ══════════════════════════════════════════════════════════════
// MAIN HANDLER
// ══════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  if (!checkAuth(req, res)) return;

  const { platform, username, password, captchaKey, useMailTm, autoVerify } = req.body || {};
  if (!platform || !username || !password) {
    return res.status(400).json({ error: 'platform, username, and password are required' });
  }

  const log = [];
  const L = (msg, cls = 'tm') => { log.push({ msg, cls }); console.log(`[register][${platform}]`, msg); };

  // ── Create disposable email via mail.tm if requested ──────
  let email = `${username}@mail.com`;
  let mailTmToken = null;

  if (useMailTm) {
    try {
      L('📧 Creating mail.tm inbox…', 'tm');
      const inbox = await createMailTmInbox();
      email = inbox.address;
      mailTmToken = inbox.token;
      L(`✔ Inbox: ${email}`, 't-info');
    } catch (e) {
      L(`⚠ mail.tm failed: ${e.message} — using fallback email`, 't-warn');
      email = `${username}@guerrillamail.com`;
    }
  }

  // ── Route to platform handler ─────────────────────────────
  let result;
  try {
    switch (platform) {
      case 'devto':      result = await registerDevTo(username, password, email, log); break;
      case 'hashnode':   result = await registerHashnode(username, password, email, log); break;
      case 'medium':     result = await registerMedium(username, password, email, log); break;
      case 'wordpress':  result = await registerWordPress(username, password, email, log); break;
      case 'reddit':     result = await registerReddit(username, password, email, captchaKey, log); break;
      case 'tumblr':     result = await registerTumblr(username, password, email, log); break;
      case 'weebly':     result = await registerWeebly(username, password, email, log); break;
      case 'wix':        result = await registerWix(username, password, email, log); break;
      case 'strikingly': result = await registerStrikingly(username, password, email, log); break;
      case 'site123':    result = await registerSite123(username, password, email, log); break;
      case 'quora':      result = await registerQuora(username, password, email, log); break;
      case 'blogger':    result = await registerBlogger(username, password, email, log); break;
      default:
        L(`❌ Unknown platform: ${platform}`, 't-err');
        result = { ok: false, note: `Unknown platform: ${platform}`, verifyStatus: 'unverified' };
    }
  } catch (e) {
    L(`❌ Platform handler exception: ${e.message}`, 't-err');
    result = { ok: false, note: `Handler error: ${e.message}`, verifyStatus: 'unverified' };
  }

  // ── Auto email verification via mail.tm polling ───────────
  if (autoVerify && mailTmToken && result.ok && result.verifyStatus !== 'verified' && result.verifyStatus !== 'no-email-required') {
    L('⏳ Polling mail.tm for verification email (up to 90s)…', 'tm');
    const mailResult = await pollMailTm(mailTmToken, 90000);
    if (mailResult.found && mailResult.link) {
      L(`📨 Email received: "${mailResult.subject}"`, 't-info');
      L(`🔗 Verify link: ${mailResult.link.slice(0, 80)}…`, 't-accent');
      const clicked = await clickLink(mailResult.link);
      result.verifyStatus = clicked ? 'verified' : 'verify-link-found';
      result.verifyLink = mailResult.link;
      if (clicked) L('✅ Email verified — account fully activated!', 't-accent');
      else L('⚠ Link found but click failed — verify manually', 't-warn');
    } else {
      L('⚠ No verification email arrived in 90s', 't-warn');
      if (result.verifyStatus === 'submitted-success') result.verifyStatus = 'submitted-success';
    }
  }

  // ── Return final result ───────────────────────────────────
  return res.status(200).json({
    ok:           result.ok || false,
    email:        result.email || email,
    apiKey:       result.apiKey || null,
    profileUrl:   result.profileUrl || null,
    verifyStatus: result.verifyStatus || 'unverified',
    verifyLink:   result.verifyLink || null,
    note:         result.note || '',
    log,
  });
}
