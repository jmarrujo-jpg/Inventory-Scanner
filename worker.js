/**
 * Inventory Count — Cloudflare Worker (BACKEND)
 * ------------------------------------------------------------------------------------------
 * Front end is on GitHub Pages; this Worker is the backend. The browser POSTs {fn, args} here
 * and this reads/writes the Google Sheet directly using a service account (no Apps Script).
 *
 * Self-contained: paste this whole file into a dashboard Worker (Create Worker > Edit code),
 * or deploy with wrangler. Set these variables (Settings > Variables and Secrets):
 *   GCP_SA_EMAIL        (secret)  service account email  (client_email in the key JSON)
 *   GCP_SA_PRIVATE_KEY  (secret)  the private_key from the key JSON (PEM; literal \n is fine)
 *   SHEET_ID            (var)     spreadsheet id (optional; defaults to the Inventory workbook)
 *   ALLOWED_ORIGIN      (var)     e.g. https://jmarrujo-jpg.github.io  (optional; default *)
 *   API_TOKEN           (secret)  optional shared token; if set, the client must send it
 *
 * Reads AND writes are live: getLookups() serves the three lookup tabs, appendEntry() writes a
 * counted row to the Metals / Plastics tabs — the same contract the Apps Script backend used.
 */

// Inventory workbook id — used when the SHEET_ID variable isn't set. Override it by setting a
// SHEET_ID variable on the Worker if the workbook ever changes.
const DEFAULT_SHEET_ID = '1GNw1gAnB1jI9L6PdUoUeQAlOKCHlPJ1f0-kxcQroI9U';

// ---- Tab names (change here if you rename tabs) ----
const TAB = {
  ends: 'Ends_Lookup',
  cans: 'Cans_Lookup',
  plastics: 'Plastics_Lookup',
  metalsOut: 'Metals',
  plasticsOut: 'Plastics',
};

export default {
  async fetch(request, env) {
    // Echo the caller's Origin so the CORS header always matches (avoids a misconfigured
    // ALLOWED_ORIGIN silently blocking the app). If ALLOWED_ORIGIN is set to a specific origin,
    // only that origin is allowed; otherwise any origin is echoed back.
    const reqOrigin = request.headers.get('Origin') || '*';
    const allowOrigin = (env.ALLOWED_ORIGIN && env.ALLOWED_ORIGIN !== '*')
      ? (env.ALLOWED_ORIGIN === reqOrigin ? reqOrigin : env.ALLOWED_ORIGIN)
      : reqOrigin;
    const cors = {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    const json = (obj, status) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method === 'GET') return json({ ok: true, service: 'inventory-count-api', build: 'v1' }, 200);
    if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

    let payload;
    try { payload = JSON.parse((await request.text()) || '{}'); }
    catch (e) { return json({ ok: false, error: 'Bad request body' }, 400); }

    if (env.API_TOKEN && String(payload.secret || '') !== String(env.API_TOKEN)) {
      return json({ ok: false, error: 'Unauthorized' }, 200);
    }
    try {
      const result = await handle(payload.fn, payload.args || [], env);
      return json({ ok: true, result }, 200);
    } catch (e) {
      return json({ ok: false, error: e && e.message ? e.message : String(e) }, 200);
    }
  },
};

// ---------------- dispatcher ----------------
async function handle(fn, args, env) {
  const sheets = await makeSheets(env);
  args = args || [];
  switch (fn) {
    case 'getLookups': return getLookups(sheets);
    case 'appendEntry': return appendEntry(sheets, args[0], args[1]);
    default:
      throw new Error('Unknown function: ' + fn);
  }
}

// ---------------- value helpers (match the old Apps Script) ----------------
function str_(v) { return (v === null || v === undefined) ? '' : String(v).trim(); }
function num_(v) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(v);
  return isNaN(n) ? str_(v) : n;
}

// ---------------- backend functions ----------------
// Ends_Lookup:     Label Code  | Description | Per Pallet     | Weight | Type
// Cans_Lookup:     Label Number | Description | Per Pallet
// Plastics_Lookup: Item #       | Description | Type           | Per Pallet/Box
async function getLookups(sheets) {
  const [ends, cans, plastics] = await Promise.all([
    sheets.rows(TAB.ends),
    sheets.rows(TAB.cans),
    sheets.rows(TAB.plastics),
  ]);
  return {
    ends: ends.filter((r) => str_(r[1])).map((r) => ({
      code: str_(r[0]), desc: str_(r[1]), perUnit: num_(r[2]), weight: str_(r[3]), type: str_(r[4]),
    })),
    cans: cans.filter((r) => str_(r[1])).map((r) => ({
      code: str_(r[0]), desc: str_(r[1]), perUnit: num_(r[2]),
    })),
    plastics: plastics.filter((r) => str_(r[1])).map((r) => ({
      code: str_(r[0]), desc: str_(r[1]), type: str_(r[2]), perUnit: num_(r[3]),
    })),
  };
}

/**
 * Append one counted entry. dept = 'metals' or 'plastics'.
 * The Sheets values:append (INSERT_ROWS) is atomic server-side, so concurrent counters
 * appending at once each get their own new row — no LockService needed.
 */
async function appendEntry(sheets, e, dept) {
  e = e || {};
  let tab, row;
  if (dept === 'plastics') {
    tab = TAB.plasticsOut;
    // Timestamp | Counter | Item # | Description | Type | Per Unit | Full | Extra | Total | Location
    row = [e.ts, e.counter, e.code, e.desc, e.type, e.per, e.full, e.extra, e.total, e.loc];
  } else {
    tab = TAB.metalsOut;
    // Timestamp | Counter | Category | Code | Description | Weight | Type | Per Unit | Full | Extra | Total | Location
    row = [e.ts, e.counter, e.category, e.code, e.desc, e.weight, e.type, e.per, e.full, e.extra, e.total, e.loc];
  }
  await sheets.append(tab, row);
  return true;
}

// ---------------- Google auth + Sheets ----------------
let cachedToken = null;

function b64urlBytes(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlStr(str) { return b64urlBytes(new TextEncoder().encode(str)); }
function pemToPkcs8(pem) {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s+/g, '');
  const raw = atob(body);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf.buffer;
}
async function mintToken(env) {
  const email = env.GCP_SA_EMAIL;
  const key = (env.GCP_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('Service account not configured (GCP_SA_EMAIL / GCP_SA_PRIVATE_KEY).');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = { iss: email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 };
  const unsigned = b64urlStr(JSON.stringify(header)) + '.' + b64urlStr(JSON.stringify(claim));
  const ck = await crypto.subtle.importKey('pkcs8', pemToPkcs8(key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', ck, new TextEncoder().encode(unsigned));
  const jwt = unsigned + '.' + b64urlBytes(new Uint8Array(sig));
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + encodeURIComponent(jwt),
  });
  const data = await resp.json();
  if (!resp.ok || !data.access_token) throw new Error('Token exchange failed: ' + (data.error_description || data.error || resp.status));
  return { token: data.access_token, exp: now + (data.expires_in || 3600) };
}
async function getToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.token;
  cachedToken = await mintToken(env);
  return cachedToken.token;
}
async function makeSheets(env) {
  const token = await getToken(env);
  const id = env.SHEET_ID || DEFAULT_SHEET_ID;
  const base = 'https://sheets.googleapis.com/v4/spreadsheets/' + id;
  const auth = { Authorization: 'Bearer ' + token };
  async function call(url, opts) {
    const r = await fetch(url, opts);
    const t = await r.text();
    let j; try { j = t ? JSON.parse(t) : {}; } catch (e) { throw new Error('Sheets API non-JSON: ' + t.slice(0, 200)); }
    if (!r.ok) throw new Error('Sheets API ' + r.status + ': ' + (j.error && j.error.message ? j.error.message : t.slice(0, 200)));
    return j;
  }
  return {
    id,
    // Read every data row (row 2 onward) of a tab as raw values.
    async rows(tab) {
      const j = await call(base + '/values/' + encodeURIComponent(tab)
        + '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER', { headers: auth });
      const values = j.values || [];
      return values.slice(1); // drop the header row
    },
    async append(tab, row) {
      return call(base + '/values/' + encodeURIComponent(tab) + ':append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS',
        { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [row] }) });
    },
  };
}
