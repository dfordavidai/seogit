// /api/click-link.js — Vercel Serverless Function
// Clicks a URL using a real browser (Playwright + Chromium).
// Used by Account Creator to click email verification links,
// bypassing anti-bot protection and handling redirects properly.
//
// Required npm packages:
//   "playwright-core": "^1.44.0",
//   "@sparticuz/chromium": "^123.0.0"
//
// Required env vars:
//   API_SECRET   — optional, must match X-API-Key header if set

export const config = { maxDuration: 60 };

function checkAuth(req, res) {
  const secret = process.env.API_SECRET;
  if (!secret) return true;
  if ((req.headers['x-api-key'] || '') !== secret) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  if (!checkAuth(req, res)) return;

  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url is required' });

  let browser;
  try {
    const { chromium } = await import('playwright-core');
    const chromiumExec = await import('@sparticuz/chromium');

    browser = await chromium.launch({
      executablePath: await chromiumExec.default.executablePath(),
      args: [...chromiumExec.default.args, '--no-sandbox', '--disable-setuid-sandbox'],
      headless: chromiumExec.default.headless,
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    const finalUrl  = page.url();
    const bodyText  = await page.evaluate(() => document.body?.innerText?.toLowerCase().slice(0, 500) || '');
    const isSuccess = /success|verified|activated|confirmed|complete|welcome|thank/i.test(bodyText) || finalUrl !== url;

    return res.status(200).json({
      ok:       isSuccess,
      finalUrl,
      note:     isSuccess ? 'Verification link clicked successfully' : 'Link clicked but outcome unclear',
    });

  } catch (e) {
    console.error('[click-link] Error:', e.message);
    return res.status(200).json({ ok: false, error: e.message });
  } finally {
    try { await browser?.close(); } catch (e) {}
  }
}
