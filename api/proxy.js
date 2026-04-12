// api/proxy.js — universal CORS proxy for the SEO tool
// Bypasses browser CORS restrictions for fetching external pages,
// checking backlinks, scraping meta tags, posting to blogs, etc.

import { cors, checkAuth } from '../lib/auth.js';

const BLOCKED_HOSTS = [
  'localhost', '127.0.0.1', '0.0.0.0', '169.254.', '10.', '192.168.', '172.16.'
];
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB response cap
const DEFAULT_TIMEOUT = 20000;

function isSafeUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    const host = u.hostname.toLowerCase();
    return !BLOCKED_HOSTS.some(b => host === b || host.startsWith(b));
  } catch { return false; }
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!checkAuth(req, res)) return;

  // Target URL comes from ?url= (GET) or body.url (POST)
  let targetUrl = '';
  let method = 'GET';
  let bodyToSend = undefined;
  let extraHeaders = {};
  let timeout = DEFAULT_TIMEOUT;

  if (req.method === 'POST') {
    const b = req.body || {};
    targetUrl    = b.url        || '';
    method       = (b.method    || 'GET').toUpperCase();
    bodyToSend   = b.body       || undefined;
    extraHeaders = b.headers    || {};
    timeout      = parseInt(b.timeout) || DEFAULT_TIMEOUT;
  } else {
    targetUrl    = req.query.url    || '';
    method       = (req.query.method || 'GET').toUpperCase();
    timeout      = parseInt(req.query.timeout) || DEFAULT_TIMEOUT;
  }

  if (!targetUrl) return res.status(400).json({ error: 'Missing url parameter' });
  if (!isSafeUrl(targetUrl)) return res.status(400).json({ error: 'Invalid or unsafe URL' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const fetchOpts = {
      method,
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        ...extraHeaders
      },
    };
    if (bodyToSend && ['POST','PUT','PATCH'].includes(method)) {
      fetchOpts.body = typeof bodyToSend === 'string' ? bodyToSend : JSON.stringify(bodyToSend);
      if (!fetchOpts.headers['Content-Type']) {
        fetchOpts.headers['Content-Type'] = typeof bodyToSend === 'string'
          ? 'application/x-www-form-urlencoded'
          : 'application/json';
      }
    }

    const upstream = await fetch(targetUrl, fetchOpts);
    clearTimeout(timer);

    // Stream capped response
    const contentType = upstream.headers.get('content-type') || 'text/plain';
    const buffer = await upstream.arrayBuffer();
    const bytes = Buffer.from(buffer).slice(0, MAX_BODY_BYTES);

    res.status(upstream.status);
    res.setHeader('X-Proxy-Status', upstream.status);
    res.setHeader('X-Proxy-Url', targetUrl);
    res.setHeader('Content-Type', contentType);

    // Pass through useful response headers
    for (const h of ['x-powered-by','server','last-modified','etag']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader('X-Upstream-' + h, v);
    }

    return res.send(bytes);

  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Upstream request timed out', url: targetUrl });
    }
    return res.status(502).json({ error: err.message, url: targetUrl });
  }
}
