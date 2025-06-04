#!/usr/bin/env node

/**
 * metadata-admin-server.js
 *
 * A minimal Node.js server that provides a Web UI to create or edit the
 * `repo-metadata.json` file in whichever folder inside your "repository" the
 * user is currently browsing.  It also optionally lets you upload a banner
 * image (≤ 512 KB) that will be referenced from the metadata JSON.
 *
 * -----------------------------------------------------------------------------
 * WHAT IS THE "METADATA ADMIN"?
 * -----------------------------------------------------------------------------
 * In the backend you have a "repository" folder that the front-end (e.g.
 * SwiftUI) presents to end-users as a "Catalog."  So, "Repository" = "Catalog".
 *
 * - Repository (backend, physically on disk)
 * - Catalog    (frontend, user-facing concept)
 *
 * Each folder inside the repository may contain a `repo-metadata.json`
 * describing that specific sub-catalog: a display name, a description, an
 * optional `bannerImage` filename, and a `lastModified` timestamp.  This admin
 * server lets you edit those fields from a browser without hand-editing JSON.
 *
 * -----------------------------------------------------------------------------
 * BANNER IMAGE
 * -----------------------------------------------------------------------------
 * You can upload one optional banner image per directory.  The file is stored
 * next to the JSON as `banner.<ext>` and its name is saved in the metadata
 * under `"bannerImage"`.  Maximum accepted size is 512 KB.
 *
 * -----------------------------------------------------------------------------
 * DIRECTORY NAVIGATION
 * -----------------------------------------------------------------------------
 * The Web UI shows the repository tree so you can drill down into
 * sub-directories.  Whatever directory you are viewing becomes the "current
 * repository folder" and that is where metadata is read from / written to, and
 * where any banner image is stored.
 *
 * -----------------------------------------------------------------------------
 * HOW DOES IT FIND THE REPOSITORY FOLDER?
 * -----------------------------------------------------------------------------
 * It reads `config.json` located next to this script.  The `sourceDir` field is
 * taken as the *root* of the repository (e.g. "../CatalogRepository").
 *
 * -----------------------------------------------------------------------------
 * DISCLAIMER
 * -----------------------------------------------------------------------------
 * This is a simple developer-tool intended to run only on localhost.  It is not
 * production-grade and lacks any authentication or TLS.
 *
 * -----------------------------------------------------------------------------
 *
 * SECURITY NOTE:
 * This is a small local-only tool.  It **must not** be exposed to
 * the public internet without proper authentication, HTTPS, etc.
 * 
 * Usage:
 *   node metadata-admin-server.js
 * Then open http://localhost:4000
 */

const http      = require("http");
const fs        = require("fs");
const path      = require("path");
const queryutil = require("querystring");
const { URL }   = require("url");

/* ───────────── 1. CONFIG ─────────────────────────────────────────────────── */

function loadConfig() {
  const cfgPath = path.join(__dirname, "config.json");
  if (!fs.existsSync(cfgPath)) {
    console.error(`Error: config.json not found at: ${cfgPath}`);
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  } catch (err) {
    console.error("Error parsing config.json:", err);
    process.exit(1);
  }
}

const cfg                 = loadConfig();
const REPOSITORY_ROOT_DIR = path.resolve(__dirname, cfg.sourceDir);  // absolute
const METADATA_FILENAME   = "repo-metadata.json";
const PORT                = 4000;

/* ───────────── 2. METADATA UTILITIES (directory-aware) ───────────────────── */

function safeRelPath(rel) {
  /*  Prevent ".." escapes.  Returns clean relative path (may be ""). */
  if (!rel) return "";
  const normal = path.normalize(rel).replace(/^[\\/]+/, ""); // remove leading /
  if (normal.includes("..")) return "";                      // disallow traversal
  return normal;
}

function dirFromQuery(searchParams) {
  return safeRelPath(searchParams.get("dir") || "");
}

function workingDirFor(rel) {
  return path.join(REPOSITORY_ROOT_DIR, rel);
}

function metadataPathFor(dirAbs) {
  return path.join(dirAbs, METADATA_FILENAME);
}

function readMetadata(dirAbs) {
  const p = metadataPathFor(dirAbs);
  if (fs.existsSync(p)) {
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch (e) {
      console.warn("[MetadataAdmin] Could not parse metadata:", e);
    }
  }
  return {};
}

function writeMetadata(dirAbs, obj) {
  const p = metadataPathFor(dirAbs);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf-8");
}

/* ───────────── 3. HTML RENDERING ─────────────────────────────────────────── */

function escapeHtml(str) {
  return String(str)
    .replace(/&/g,  "&amp;")
    .replace(/"/g,  "&quot;")
    .replace(/'/g,  "&#39;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;");
}

function renderDirectoryList(currentRel) {
  const abs   = workingDirFor(currentRel);
  const parts = currentRel ? currentRel.split(path.sep) : [];
  const crumbs = ['<a href="/">Root</a>'];
  let accumRel = "";
  for (const seg of parts) {
    accumRel = path.join(accumRel, seg);
    crumbs.push(`<a href="/?dir=${encodeURIComponent(accumRel)}">${escapeHtml(seg)}</a>`);
  }

  let links = "";
  try {
    const entries = fs.readdirSync(abs, { withFileTypes: true })
                      .filter(e => e.isDirectory())
                      .sort((a, b) => a.name.localeCompare(b.name));
    if (entries.length) {
      links += "<ul>";
      for (const d of entries) {
        const rel = path.join(currentRel, d.name);
        links += `<li><a href="/?dir=${encodeURIComponent(rel)}">${escapeHtml(d.name)}/</a></li>`;
      }
      links += "</ul>";
    }
  } catch { /* ignore */ }
  return `<nav><p>${crumbs.join(" / ")}</p>${links}</nav>`;
}

function renderHtmlPage(meta, currentRel) {
  const { name = "", description = "", bannerImage = "" } = meta;
  const bannerTag = bannerImage
    ? `<div style="margin-top:1em"><strong>Existing banner:</strong><br>
         <img class="banner" 
             src="/asset?dir=${encodeURIComponent(currentRel)}&file=${encodeURIComponent(bannerImage)}"
             alt="banner" style="max-width:100%;height:auto;border:1px solid #ddd">
       </div>`
    : "";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>Metadata Admin</title>
  <style>
    /* ─────────────  Light / Dark theme (same palette as whats-new.js) ───────────── */
    :root{
      /* Tell the browser we handle both schemes so native widgets switch too */
      color-scheme: light dark;
      --bg       : #ffffff;
      --fg       : #000000;
      --border   : #cccccc;
      --control  : #f5f5f5;
      --btn-bg   : #e0e0e0;
      --btn-fg   : #000000;
    }
    @media (prefers-color-scheme: dark){
      :root{
        --bg      : #121212;
        --fg      : #e0e0e0;
        --border  : #333333;
        --control : #1e1e1e;
        --btn-bg  : #333333;
        --btn-fg  : #ffffff;
      }
    }
    /* ─────────────  Component styles  ───────────── */
    body      { font-family:sans-serif; max-width:700px; margin:40px auto;
                background:var(--bg); color:var(--fg); }
    label     { display:block; margin-top:1em; font-weight:bold; }
    input[type="text"], textarea {
                width:100%; padding:0.5em; font-family:inherit;
                background:var(--control); color:var(--fg);
                border:1px solid var(--border); }
    .button-row { margin-top:1.5em; }
    button    { padding:0.6em 1.2em; font-size:1em;
                background:var(--btn-bg); color:var(--btn-fg);
                border:1px solid var(--border); }
    .notice   { margin-top:1em; font-size:0.9em; color:var(--fg); opacity:.70; }
    nav ul    { margin-left:0; padding-left:1em; }
    nav li    { list-style-type:disc; margin:2px 0; }
    img.banner{ max-width:100%; height:auto; border:1px solid var(--border); }
  </style>
</head>
<body>
  <h1>Repository (Catalog) Metadata Admin</h1>
  ${renderDirectoryList(currentRel)}
  <form method="POST" action="/save?dir=${encodeURIComponent(currentRel)}" enctype="multipart/form-data">
    <label for="name">Repository (Catalog) Name</label>
    <input type="text" id="name" name="name" value="${escapeHtml(name)}" required />

    <label for="description">Description</label>
    <textarea id="description" name="description" rows="5">${escapeHtml(description)}</textarea>

    <label for="banner">Banner Image (optional, ≤ 512 KB)</label>
    <input type="file" id="banner" name="banner" accept="image/*" />

    <div class="notice">
      <strong>Note 1:</strong> “Last Modified” is automatically updated when you save.<br>
      <strong>Note 2:</strong> Banner image will overwrite any previous one.<br>
      <strong>Note 3:</strong> All data are stored inside the selected directory.
    </div>

    ${bannerTag}

    <div class="button-row"><button type="submit">Save</button></div>
  </form>
</body>
</html>`;
}

/* ───────────── 4. MULTIPART PARSER (built-in, minimal) ───────────────────── */

const MAX_BANNER_SIZE = 512 * 1024;     // 512 KB

/**
 * parseMultipart(buffer, boundary) → { fields:{}, file?:{filename,buffer} }
 * Very small subset of RFC 2388 good enough for single file + text fields.
 */
function parseMultipart(buf, boundaryStr) {
  const dashBoundary = Buffer.from("--" + boundaryStr);
  const dashBoundaryEnd = Buffer.from("--" + boundaryStr + "--");

  const parts = [];
  let start = buf.indexOf(dashBoundary);
  while (start !== -1) {
    const end = buf.indexOf(dashBoundary, start + dashBoundary.length);
    const partBuf = end !== -1 ? buf.slice(start + dashBoundary.length, end)
                               : buf.slice(start + dashBoundary.length);
    parts.push(partBuf);
    start = end;
  }

  const result = { fields: {} };

  for (const raw of parts) {
    // Trim leading CRLF
    let pBuf = raw;
    if (pBuf[0] === 0x0d && pBuf[1] === 0x0a) pBuf = pBuf.slice(2);

    const headerEnd = pBuf.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd === -1) continue;

    const headerText = pBuf.slice(0, headerEnd).toString("utf-8");
    const body      = pBuf.slice(headerEnd + 4, pBuf.length - 2); // drop trailing CRLF

    const disposition = /Content-Disposition:[^\r\n]+/i.exec(headerText);
    if (!disposition) continue;

    const nameMatch = /name="([^"]+)"/.exec(disposition[0]);
    if (!nameMatch) continue;
    const fieldName = nameMatch[1];

    const filenameMatch = /filename="([^"]*)"/.exec(disposition[0]);

    if (filenameMatch && filenameMatch[1]) {
      // It's a file
      result.file = {
        fieldName,
        filename: path.basename(filenameMatch[1]),
        buffer: body
      };
    } else {
      // Regular text field
      result.fields[fieldName] = body.toString("utf-8");
    }
  }
  return result;
}

/* ───────────── 5. HTTP SERVER ────────────────────────────────────────────── */

const server = http.createServer((req, res) => {
  try {
    const u      = new URL(req.url, `http://${req.headers.host}`);
    const relDir = dirFromQuery(u.searchParams);          // "" or "sub/dir"
    const absDir = workingDirFor(relDir);

    // 0. Static asset fetch
    if (req.method === "GET" && u.pathname === "/asset") {
      const fileName = safeRelPath(u.searchParams.get("file") || "");
      if (!fileName) return send404(res);
      const filePath = path.join(absDir, fileName);
      if (filePath.indexOf(absDir) !== 0 || !fs.existsSync(filePath)) {
        return send404(res);
      }
      const stream = fs.createReadStream(filePath);
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      return stream.pipe(res);
    }

    // 1. UI page
    if (req.method === "GET" && u.pathname === "/") {
      const meta = readMetadata(absDir);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(renderHtmlPage(meta, relDir));
    }

    // 2. Save handler
    if (req.method === "POST" && u.pathname === "/save") {
      const ctype = req.headers["content-type"] || "";
      if (!ctype.startsWith("multipart/form-data")) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        return res.end("Expected multipart/form-data");
      }
      const boundaryMatch = /boundary=([^;]+)/.exec(ctype);
      if (!boundaryMatch) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        return res.end("Malformed multipart/form-data (no boundary)");
      }
      const boundary = boundaryMatch[1];

      collectRequestBuffer(req, (buf) => {
        const { fields, file } = parseMultipart(buf, boundary);

        const updated = {
          name:         fields.name || "",
          description:  fields.description || "",
          lastModified: Math.floor(Date.now() / 1000).toString()
        };

        // Existing metadata to preserve banner if no new file:
        const existing = readMetadata(absDir);
        if (existing.bannerImage) updated.bannerImage = existing.bannerImage;

        if (file && file.fieldName === "banner" && file.buffer.length) {
          if (file.buffer.length > MAX_BANNER_SIZE) {
            res.writeHead(413, { "Content-Type": "text/plain" });
            return res.end("Banner image exceeds 512 KB limit.");
          }
          const ext = path.extname(file.filename) || ".img";
          const saveName = "banner" + ext.toLowerCase();
          const savePath = path.join(absDir, saveName);
          fs.writeFileSync(savePath, file.buffer);
          updated.bannerImage = saveName;
        }

        try {
          writeMetadata(absDir, updated);

          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"/>
  <title>Saved</title></head><body>
  <h1>Metadata Updated</h1>
  <p><strong>Name:</strong> ${escapeHtml(updated.name)}</p>
  <p><strong>Description:</strong> ${escapeHtml(updated.description)}</p>
  <p><strong>Last Modified:</strong> ${escapeHtml(updated.lastModified)}</p>
  ${updated.bannerImage ? `<p><strong>Banner Image:</strong> ${escapeHtml(updated.bannerImage)}</p>` : ""}
  <p><a href="/?dir=${encodeURIComponent(relDir)}">Return to Editor</a></p>
</body></html>`);
        } catch (e) {
          console.error("[MetadataAdmin] Write failed:", e);
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Failed to save metadata.");
        }
      });
      return;
    }

    /* fallthrough → 404 */
    return send404(res);
  } catch (e) {
    console.error("[MetadataAdmin] Fatal:", e);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal Server Error.");
  }
});

/* ───────────── 6. HELPERS ───────────────────────────────────────────────── */

function collectRequestBuffer(req, cb) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => cb(Buffer.concat(chunks)));
}

function send404(res) {
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("404 Not Found");
}

/* ───────────── 7. STARTUP ───────────────────────────────────────────────── */

server.listen(PORT, () => {
  console.log(`Metadata admin server listening on http://localhost:${PORT}/`);
  console.log(`Repository root : ${REPOSITORY_ROOT_DIR}`);
});