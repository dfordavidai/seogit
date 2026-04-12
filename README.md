# SEO Parasite Pro — Vercel Backend

Serverless API backend for SEO Parasite Pro v17. Deploy in under 2 minutes.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Connection test — returns server status + env check |
| `POST /api/proxy` | Universal CORS proxy — fetches any URL server-side |
| `POST /api/ping` | Pings search engines + blog ping services after publishing |
| `POST /api/index` | Submits URLs to Google Indexing API + Bing URL Submission |
| `POST /api/headers` | Fetches HTTP response headers for any URL (HEAD request) |
| `GET /api/whois` | RDAP domain age + registration lookup (free, no key needed) |
| `POST /api/captcha` | Routes captcha jobs to 2captcha / anti-captcha / capmonster |
| `POST /api/sync` | Server-side Supabase sync (keeps service-role key off browser) |

---

## Deploy to Vercel (2 minutes)

### Option A — Vercel CLI
```bash
npm i -g vercel
cd vercel-backend
vercel --prod
```

### Option B — GitHub + Vercel Dashboard
1. Push this folder to a GitHub repo
2. Go to [vercel.com/new](https://vercel.com/new) → Import repo
3. Framework: **Other** — Vercel auto-detects the `api/` folder
4. Click Deploy

---

## Environment Variables

Set these in **Vercel Dashboard → Project → Settings → Environment Variables**:

| Variable | Required | Description |
|---|---|---|
| `API_SECRET_KEY` | ✅ Recommended | Any random string. Set the same value in SEO tool Settings → Vercel Secret Key. Protects your endpoints. |
| `SUPABASE_URL` | Optional | Your Supabase project URL e.g. `https://xxx.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Optional | Supabase service-role key (server-only, never in browser) |
| `GOOGLE_SA_JSON` | Optional | Google service account JSON (for Indexing API). Paste the entire JSON as one line. |
| `BING_API_KEY` | Optional | Bing Webmaster Tools API key (for URL submission) |
| `TWOCAPTCHA_KEY` | Optional | 2captcha.com API key |
| `ANTICAPTCHA_KEY` | Optional | anti-captcha.com API key |
| `CAPMONSTER_KEY` | Optional | capmonster.cloud API key |

> **Minimum viable setup:** Just `API_SECRET_KEY`. Everything else is optional and enables extra features.

---

## Configure in SEO Tool

1. Open SEO tool → Settings → **Vercel Backend**
2. **Vercel API URL**: your deployed URL e.g. `https://seo-parasite-pro.vercel.app`
3. **Vercel Secret Key**: same value as `API_SECRET_KEY` env var
4. Toggle **Use Vercel Backend** ON
5. Click **▲ Test Vercel Connection** — should show ✓

---

## Security Notes

- The `API_SECRET_KEY` auth check is enforced on every endpoint except `/api/health`
- Internal/private IP ranges are blocked in the proxy endpoint
- Response body is capped at 5 MB to prevent abuse
- Max function runtime: 30 seconds (configurable in `vercel.json`)
