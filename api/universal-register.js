// /api/universal-register.js — Vercel Serverless Function
// Playwright-based universal registration handler.
// Works on ANY website with a signup/register form.
//
// Required npm packages (add to package.json):
//   "playwright-core": "^1.44.0",
//   "@sparticuz/chromium": "^123.0.0",
//   "node-fetch": "^3.3.2"
//
// Required env vars (Vercel dashboard):
//   API_SECRET   — optional, must match X-API-Key header if set
//
// Vercel settings:
//   maxDuration: 180 (Pro plan required for 180s — free plan max is 60s)
//   region: iad1 (US East is fastest for most targets)

export const config = {
  maxDuration: 180,
};

// ── Auth ───────────────────────────────────────────────────────
function checkAuth(req, res) {
  const secret = process.env.API_SECRET;
  if (!secret) return true;
  if ((req.headers['x-api-key'] || '') !== secret) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// ── Field detection map (mirrors frontend) ────────────────────
const FIELD_PATTERNS = {
  email:     /email|e-mail|\bmail\b/i,
  password:  /\bpassword\b|\bpasswd\b|\bpass\b|\bpwd\b/i,
  password2: /confirm.?pass|password.?2|retype|repeat.?pass|verify.?pass/i,
  username:  /user.?name|\buser\b|login|\bhandle\b|\bnick\b|screen.?name/i,
  firstName: /first.?name|fname|given.?name|forename/i,
  lastName:  /last.?name|lname|family.?name|surname/i,
  fullName:  /\bname\b|full.?name|display.?name|real.?name/i,
  phone:     /phone|mobile|\btel\b/i,
  website:   /website|\burl\b|\bblog\b|homepage/i,
  bio:       /\bbio\b|about.?me|description|biography/i,
  city:      /\bcity\b|\btown\b/i,
  country:   /\bcountry\b/i,
  zipcode:   /\bzip\b|postal.?code/i,
  birthYear: /birth.?year|year.?of.?birth/i,
  birthMonth:/birth.?month|month.?of.?birth/i,
  birthDay:  /birth.?day|day.?of.?birth/i,
  gender:    /\bgender\b|\bsex\b/i,
};

function detectFieldType(nameAttr, idAttr, phAttr, inputType) {
  const combined = [nameAttr, idAttr, phAttr].join(' ').toLowerCase();
  // Check password2 before password (more specific)
  if (FIELD_PATTERNS.password2.test(combined)) return 'password2';
  for (const [field, pattern] of Object.entries(FIELD_PATTERNS)) {
    if (field === 'password2') continue;
    if (pattern.test(combined)) return field;
  }
  // Type-based fallback
  if (inputType === 'email') return 'email';
  if (inputType === 'password') return 'password';
  if (inputType === 'tel') return 'phone';
  if (inputType === 'url') return 'website';
  return null;
}

// ── Main handler ───────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  if (!checkAuth(req, res)) return;

  const { url, profile, captchaKey, proxy, headless = true, autoVerify } = req.body || {};
  if (!url || !profile) return res.status(400).json({ error: 'url and profile are required' });

  const log = [];
  const L = (msg, cls = 'tm') => { log.push({ msg, cls }); console.log('[universal-register]', msg); };

  const result = {
    ok: false,
    note: '',
    log,
    formFields: [],
    captchaSolved: false,
    verifyStatus: 'unverified',
    verifyLink: null,
    profileUrl: null,
    submitStatus: '',
  };

  let browser;

  try {
    // Dynamic imports (avoid cold-start issues)
    const { chromium } = await import('playwright-core');
    const chromiumExec = await import('@sparticuz/chromium');

    L(`🌐 Launching Chromium → ${url}`, 't-accent');

    const launchOpts = {
      executablePath: await chromiumExec.default.executablePath(),
      args: [
        ...chromiumExec.default.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
      ],
      headless: chromiumExec.default.headless,
    };

    if (proxy) {
      launchOpts.proxy = { server: proxy };
      L(`🛡 Using proxy: ${proxy}`, 'tm');
    }

    browser = await chromium.launch(launchOpts);
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });

    // Stealth: remove webdriver flag
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const page = await context.newPage();

    // ── Navigate ───────────────────────────────────────────────────────────
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    L(`✔ Page loaded: ${await page.title()}`, 't-info');

    // ── Find registration form if not already on one ───────────────────────
    const isRegPage = await page.evaluate(() => {
      const bodyText = document.body?.innerText?.toLowerCase() || '';
      const pwInputs = document.querySelectorAll('input[type="password"]').length;
      const emailInputs = document.querySelectorAll('input[type="email"],input[name*="email"]').length;
      return pwInputs >= 1 || emailInputs >= 1 ||
        /sign\s*up|register|create.{0,15}account|join\s*free/i.test(bodyText.slice(0, 1000));
    });

    if (!isRegPage) {
      L('🔍 Not on reg page — searching for signup link…', 'tm');
      const signupSelectors = [
        'a[href*="signup"]', 'a[href*="register"]', 'a[href*="join"]',
        'a[href*="create-account"]', 'a[href*="sign-up"]', 'a[href*="create_account"]',
        'a[href*="new-account"]', 'a[href*="enroll"]',
        'a:text-matches("sign up", "i")', 'a:text-matches("register", "i")',
        'a:text-matches("create account", "i")', 'a:text-matches("join free", "i")',
        'button:text-matches("sign up", "i")', 'button:text-matches("register", "i")',
      ];
      let found = false;
      for (const sel of signupSelectors) {
        try {
          const el = await page.$(sel);
          if (el && await el.isVisible()) {
            const href = await el.getAttribute('href') || sel;
            L(`→ Found signup link: ${href}`, 't-info');
            await el.click();
            await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
            found = true;
            break;
          }
        } catch (e) { /* continue */ }
      }
      if (!found) L('⚠ Could not find signup link — attempting current page', 't-warn');
    } else {
      L('✔ Already on registration page', 't-info');
    }

    await page.waitForTimeout(1500);

    // ── Scan and fill all form inputs ─────────────────────────────────────
    L('🔎 Scanning form fields…', 'tm');
    const fieldsFilled = [];

    const inputs = await page.$$(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]):not([type="reset"]):not([type="file"]), select, textarea'
    );
    L(`→ Found ${inputs.length} form field(s)`, 'tm');

    for (const input of inputs) {
      try {
        const tagName   = await input.evaluate(el => el.tagName.toLowerCase());
        const inputType = await input.evaluate(el => (el.getAttribute('type') || 'text').toLowerCase());
        const nameAttr  = await input.evaluate(el => el.getAttribute('name') || '');
        const idAttr    = await input.evaluate(el => el.getAttribute('id') || '');
        const phAttr    = await input.evaluate(el => el.getAttribute('placeholder') || '');
        const isVisible = await input.isVisible();
        if (!isVisible) continue;

        // ── Handle <select> ──────────────────────────────────────────────
        if (tagName === 'select') {
          await input.evaluate(el => {
            if (el.options.length > 1) el.selectedIndex = 1;
            const opts = [...el.options].map(o => o.value.toLowerCase());
            const maleIdx = opts.findIndex(o => o === 'male' || o === 'm');
            if (maleIdx > -1) el.selectedIndex = maleIdx;
          });
          fieldsFilled.push('select:' + (nameAttr || idAttr));
          continue;
        }

        // ── Handle checkboxes (terms, newsletter) ────────────────────────
        if (inputType === 'checkbox') {
          const checked = await input.isChecked();
          if (!checked) await input.check().catch(() => {});
          fieldsFilled.push('checkbox:' + (nameAttr || idAttr));
          continue;
        }

        // ── Handle radio ─────────────────────────────────────────────────
        if (inputType === 'radio') {
          await input.check().catch(() => {});
          fieldsFilled.push('radio:' + (nameAttr || idAttr));
          continue;
        }

        // ── Detect field type and fill ───────────────────────────────────
        const field = detectFieldType(nameAttr, idAttr, phAttr, inputType);

        const valueMap = {
          email:      profile.email,
          password:   profile.password,
          password2:  profile.password,
          username:   profile.username,
          firstName:  profile.firstName,
          lastName:   profile.lastName,
          fullName:   profile.fullName,
          phone:      profile.phone,
          website:    profile.website,
          bio:        profile.bio,
          city:       profile.city,
          country:    profile.country,
          zipcode:    profile.zipcode,
          birthYear:  String(profile.birthYear || '1990'),
          birthMonth: profile.birthMonth || '01',
          birthDay:   profile.birthDay || '01',
          gender:     profile.gender || 'Male',
        };

        const value = field ? valueMap[field] : null;

        if (value !== undefined && value !== null) {
          await input.fill(String(value));
          fieldsFilled.push(nameAttr || idAttr || inputType);
          L(`  ✔ Filled [${nameAttr || idAttr || inputType}] = ${inputType === 'password' ? '***' : String(value).slice(0, 30)}`, 'tm');
          await page.waitForTimeout(100 + Math.random() * 100);
        }
      } catch (e) { /* field inaccessible, skip */ }
    }

    result.formFields = fieldsFilled;
    L(`✔ Filled ${fieldsFilled.length} field(s)`, 't-info');

    // ── CAPTCHA detection & solving ────────────────────────────────────────
    const hasCaptcha = await page.evaluate(() => {
      return !!(
        document.querySelector('.g-recaptcha, .h-captcha, [data-sitekey], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], #cf-challenge-running, #challenge-form')
      ) || (document.body?.innerHTML || '').includes('data-sitekey');
    });

    if (hasCaptcha && captchaKey) {
      L('🧩 CAPTCHA detected — solving via 2captcha…', 't-accent');
      try {
        const siteKey = await page.evaluate(() => {
          const el = document.querySelector('[data-sitekey]');
          return el?.getAttribute('data-sitekey') || '';
        });
        const pageUrl = page.url();

        if (siteKey) {
          // Detect hCaptcha vs reCAPTCHA
          const isHCaptcha = await page.evaluate(() => !!document.querySelector('.h-captcha, iframe[src*="hcaptcha"]'));

          const params = isHCaptcha
            ? `key=${captchaKey}&method=hcaptcha&sitekey=${siteKey}&pageurl=${encodeURIComponent(pageUrl)}&json=1`
            : `key=${captchaKey}&method=userrecaptcha&googlekey=${siteKey}&pageurl=${encodeURIComponent(pageUrl)}&json=1`;

          const { default: fetch } = await import('node-fetch');
          const submitR = await fetch('https://2captcha.com/in.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params,
          });
          const submitData = await submitR.json();

          if (submitData.status === 1) {
            const captchaId = submitData.request;
            L(`⏳ 2captcha task #${captchaId} — waiting for solution…`, 'tm');
            let solution = null;
            for (let attempt = 0; attempt < 24; attempt++) {
              await page.waitForTimeout(5000);
              const resR = await fetch(`https://2captcha.com/res.php?key=${captchaKey}&action=get&id=${captchaId}&json=1`);
              const resData = await resR.json();
              if (resData.status === 1) { solution = resData.request; break; }
              if (resData.request === 'ERROR_CAPTCHA_UNSOLVABLE') break;
            }
            if (solution) {
              await page.evaluate((token) => {
                try { document.getElementById('g-recaptcha-response').style.display = 'block'; document.getElementById('g-recaptcha-response').value = token; } catch (e) {}
                try { const cb = window.___grecaptcha_cfg?.clients?.[0]?.callback; if (typeof cb === 'function') cb(token); } catch (e) {}
                try { window.captchaCallback?.(token); } catch (e) {}
                // hCaptcha injection
                try { document.querySelector('[name="h-captcha-response"]').value = token; } catch (e) {}
              }, solution);
              result.captchaSolved = true;
              L('✅ CAPTCHA solved and injected!', 't-accent');
            } else {
              L('⚠ CAPTCHA solution timed out', 't-warn');
            }
          } else {
            L(`⚠ 2captcha submit failed: ${JSON.stringify(submitData)}`, 't-warn');
          }
        } else {
          L('⚠ Could not extract sitekey from page', 't-warn');
        }
      } catch (e) {
        L(`❌ CAPTCHA solve error: ${e.message}`, 't-err');
      }
    } else if (hasCaptcha && !captchaKey) {
      L('⚠ CAPTCHA detected but no 2captcha key — may fail', 't-warn');
    }

    await page.waitForTimeout(600);

    // ── Click submit ───────────────────────────────────────────────────────
    L('🖱 Looking for submit button…', 'tm');
    const submitSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:text-matches("sign up", "i")',
      'button:text-matches("register", "i")',
      'button:text-matches("create account", "i")',
      'button:text-matches("create my account", "i")',
      'button:text-matches("join", "i")',
      'button:text-matches("get started", "i")',
      'button:text-matches("next", "i")',
      'button:text-matches("continue", "i")',
      '[data-testid*="submit"]',
      '[data-testid*="signup"]',
      'form button:last-of-type',
      '.submit-btn', '#submit-btn', '#registerBtn', '#signupBtn',
    ];

    let submitted = false;
    for (const sel of submitSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn && await btn.isVisible()) {
          L(`→ Clicking: ${sel}`, 'tm');
          await btn.click();
          submitted = true;
          break;
        }
      } catch (e) { /* continue */ }
    }

    if (!submitted) {
      const fallback = await page.evaluate(() => {
        const form = document.querySelector('form');
        if (form) { form.submit(); return true; }
        return false;
      });
      if (fallback) { submitted = true; L('→ form.submit() fallback used', 'tm'); }
    }

    if (!submitted) {
      L('⚠ Could not find submit button', 't-warn');
      result.submitStatus = 'no-submit-found';
    } else {
      L('✔ Submit clicked', 't-info');
      result.submitStatus = 'submitted';
    }

    // ── Wait for post-submit state ─────────────────────────────────────────
    await page.waitForTimeout(3000);
    await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});

    const afterUrl  = page.url();
    const afterBody = await page.evaluate(() => document.body?.innerText?.toLowerCase().slice(0, 1500) || '');
    L(`→ Post-submit URL: ${afterUrl}`, 'tm');

    const successSignals = ['thank', 'success', 'verify', 'check your email', 'welcome', 'confirm',
      'account created', 'registered', 'almost done', 'one more step', 'sent you', 'activation', 'you\'re in'];
    const errorSignals   = ['error', 'invalid', 'already taken', 'already exists', 'already registered',
      'username taken', 'email already', 'try again', 'failed', 'not available'];

    const isSuccess = successSignals.some(s => afterBody.includes(s)) || afterUrl !== url;
    const isError   = !isSuccess && errorSignals.some(s => afterBody.includes(s));

    if (isSuccess) {
      result.ok = true;
      result.note = 'Registration accepted — ' + afterUrl.slice(0, 80);
      result.verifyStatus = 'submitted-success';
      result.profileUrl = afterUrl;
      L(`✅ SUCCESS: ${result.note}`, 't-accent');
    } else if (isError) {
      result.ok = false;
      result.note = 'Form error detected on page after submit';
      L('❌ Error signals detected on page', 't-err');
    } else {
      result.ok = submitted;
      result.note = submitted
        ? 'Submitted — outcome unclear (no explicit success message)'
        : 'Could not submit form';
      L(`⚠ Ambiguous outcome — marking as ${submitted ? 'success' : 'failure'}`, 't-warn');
    }

    // ── Extract profile URL if available ──────────────────────────────────
    if (!result.profileUrl) {
      try {
        const pUrl = await page.evaluate(() => {
          const links = [...document.querySelectorAll('a[href*="/profile"],a[href*="/user"],a[href*="/u/"],a[href*="/member"],a[href*="/@"]')];
          return links[0]?.href || '';
        });
        if (pUrl) result.profileUrl = pUrl;
      } catch (e) { /* not critical */ }
    }

  } catch (err) {
    result.ok = false;
    result.note = 'Playwright error: ' + err.message;
    L(`❌ Fatal: ${err.message}`, 't-err');
    console.error('[universal-register] Fatal:', err);
  } finally {
    try { await browser?.close(); } catch (e) {}
  }

  return res.status(200).json(result);
}
