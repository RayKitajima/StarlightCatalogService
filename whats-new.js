/**
 * Lightweight release-notes editor for Whats-New JSON
 * No external dependencies – runs on plain Node 18+
 */
const http       = require('http');
const fs         = require('fs');
const path       = require('path');
const { URL }    = require('url');
const qs         = require('querystring');

const PORT = 5000;

function loadConfig() {
  const cfgPath = path.join(__dirname, 'config.json');
  if (fs.existsSync(cfgPath)) {
    try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
    catch (err) { console.warn('[Whats-New] Invalid config.json, using script dir.', err); }
  }
  return {};
}

const cfg                 = loadConfig();
const REPOSITORY_ROOT_DIR = path.resolve(__dirname, cfg.sourceDir || '.');
const JSON_PATH           = path.join(REPOSITORY_ROOT_DIR, 'whats-new.json');

/* ----------------------------- Helpers ----------------------------- */

/** current date in YYYY-MM-DD (ISO8601 calendar date) */
function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

/** read JSON file, or return null on error */
function loadJson() {
  try {
    const raw  = fs.readFileSync(JSON_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (!data.id) data.id = isoToday();      // auto-fix missing id
    return data;
  } catch {
    // file missing or unreadable → start fresh
    return { id: isoToday(), title: '', sections: [] };
  }
}

/** overwrite JSON file (pretty-printed) */
function saveJson(obj) {
  // ensure target directory exists (should, but be defensive)
  fs.mkdirSync(path.dirname(JSON_PATH), { recursive: true });
  fs.writeFileSync(JSON_PATH, JSON.stringify(obj, null, 2), 'utf8');
}

/** minimal schema check – throws if invalid */
function validateWhatsNew(data) {
  if (typeof data !== 'object' || data === null) throw 'Root must be an object';
  if (typeof data.id !== 'string'   ) throw '`id` must be string';
  if (typeof data.title !== 'string') throw '`title` must be string';
  if (!Array.isArray(data.sections) ) throw '`sections` must be array';
  data.sections.forEach((s,i) => {
    if (typeof s.title !== 'string' || typeof s.body !== 'string')
      throw `sections[${i}] invalid (title/body strings required)`;
  });
  if (data.cta) {
    if (typeof data.cta.label !== 'string') throw '`cta.label` must be string';
    if (typeof data.cta.url   !== 'string') throw '`cta.url` must be string';
  }
  return data;
}

/** standard 4-liner response */
function send(res, status, body, type='application/json') {
  res.writeHead(status, {'Content-Type': type, 'Cache-Control':'no-store'});
  res.end(body);
}

/* ----------------------------- HTML UI ----------------------------- */

/** simple editor – loads current JSON via fetch and posts new JSON */
const EDITOR_HTML = /*html*/`
<!DOCTYPE html>
<html lang="en"><meta charset="utf-8">
<title>What's-New Editor</title>
<style>
body{font-family:system-ui,sans-serif;margin:2rem;max-width:50rem}
input,textarea{width:100%} label{font-weight:600} .row{margin-bottom:1rem}
table{border-collapse:collapse;width:100%}
td{padding:.25rem;vertical-align:top}
button{padding:.5rem 1rem;font-size:1rem}
</style>
<h1>What's-New Editor</h1>
<form id="form">
  <div class="row"><label>ID <input name="id" required></label></div>
  <div class="row"><label>Title <input name="title" required></label></div>

  <h2>Sections</h2>
  <table id="sections"></table>
  <button type="button" onclick="addSection()">+ Add Section</button>

  <h2>CTA (optional)</h2>
  <div class="row"><label>Label <input name="ctaLabel"></label></div>
  <div class="row"><label>URL   <input name="ctaURL"></label></div>

  <button type="submit">💾 Save</button>
</form>
<pre id="status"></pre>

<script>
const form      = document.getElementById('form');
const sectionsT = document.getElementById('sections');
const statusEl  = document.getElementById('status');

const todayISO = () => new Date().toISOString().slice(0,10);

fetch('/whats-new.json')
  .then(r => r.ok ? r.json() : Promise.reject())
  .then(j => {
    form.id.value    = j.id    || todayISO();
    form.title.value = j.title || '';
    (j.sections || []).forEach(s => addSection(s.title, s.body));
    if (j.cta) { form.ctaLabel.value = j.cta.label; form.ctaURL.value = j.cta.url; }
  })
  .catch(() => {                 // file missing, first-run, etc.
    form.id.value = todayISO();
  });

/* ----------- build dynamic table ----------- */
function addSection(title = '', body = '') {
  const row = sectionsT.insertRow();
  row.innerHTML = \`
    <td><input  placeholder="Title" value="\${title}"></td>
    <td><textarea placeholder="Body" rows="3" style="width:100%">\${body}</textarea></td>
    <td><button type="button" onclick="this.closest('tr').remove()">🗑️</button></td>\`;
}

/* ----------- load current json ----------- */
fetch('/whats-new.json').then(r=>r.json()).then(j=>{
  form.id.value    = j.id    ?? '';
  form.title.value = j.title ?? '';
  (j.sections||[]).forEach(s=>addSection(s.title, s.body));
  if(j.cta){form.ctaLabel.value=j.cta.label;form.ctaURL.value=j.cta.url;}
}).catch(()=>{});

/* ----------- submit ----------- */
form.addEventListener('submit', (e)=>{
  e.preventDefault();

  const sections = [...sectionsT.rows].map((r) => {
    const title = r.querySelector('input')    .value.trim();
    const body  = r.querySelector('textarea') .value.trim();
    return { title, body };
  }).filter(s => s.title && s.body);

  const payload = {
    id:    form.id.value.trim(),
    title: form.title.value.trim(),
    sections,
    cta:   form.ctaLabel.value.trim() ? {label: form.ctaLabel.value.trim(),
                                         url:   form.ctaURL.value.trim()} : undefined
  };
  fetch('/save', {method:'POST',
                  headers:{'Content-Type':'application/json'},
                  body:JSON.stringify(payload)})
    .then(r=>r.text()).then(t=>statusEl.textContent=t)
    .catch(err=>statusEl.textContent=err);
});
</script>`;

/* ----------------------------- HTTP Router ----------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  /* GET /whats-new.json -------------------------------------------------- */
  if (req.method === 'GET' && url.pathname === '/whats-new.json') {
    const data = loadJson();
    if (!data) return send(res, 500, '{"error":"file unreadable"}');
    return send(res, 200, JSON.stringify(data), 'application/json');
  }

  /* GET /editor ---------------------------------------------------------- */
  if (req.method === 'GET' && url.pathname === '/editor') {
    return send(res, 200, EDITOR_HTML, 'text/html');
  }

  /* POST /save ----------------------------------------------------------- */
  if (req.method === 'POST' && url.pathname === '/save') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const parsed = validateWhatsNew(JSON.parse(body));
        saveJson(parsed);
        send(res, 200, '✅ Saved.');
      } catch (err) {
        send(res, 400, `❌ ${err}`);
      }
    });
    return;
  }

  /* fallback ------------------------------------------------------------- */
  send(res, 404, 'Not found', 'text/plain');
});

/* ----------------------------- Boot ------------------------------------ */
server.listen(PORT, () =>
  console.log(`Whats-New server running → http://localhost:${PORT}\n` +
              `• /editor            - web form\n` +
              `• /whats-new.json    - raw JSON (for the app)`));
