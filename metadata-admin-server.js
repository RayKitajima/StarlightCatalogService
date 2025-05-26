#!/usr/bin/env node

/**
 * metadata-admin-server.js
 *
 * A minimal Node.js server that provides a Web UI to create or edit the
 * `repo-metadata.json` file in the folder that is conceptually your "repository."
 * 
 * This version automatically updates the "lastModified" field to the current time
 * (as epoch seconds) on every save, rather than letting the user input it.
 *
 * -----------------------------------------------------------------------------
 * WHAT IS THE "METADATA ADMIN"?
 * -----------------------------------------------------------------------------
 * In your backend code, you have a "repository" folder containing various JSON
 * files, images, etc. Meanwhile, your SwiftUI (or other) front-end might call it a
 * "Catalog" for user-friendly naming. Essentially, "Repository" = "Catalog":
 *
 * - Repository (backend, physically on disk)
 * - Catalog (frontend, user-facing concept)
 *
 * The metadata in `repo-metadata.json` describes high-level info about this 
 * Repository/Catalog, such as a display name, a description, and a `lastModified`
 * timestamp. This admin server allows you to edit these fields via a simple local
 * web form, without requiring manual edits to the JSON file.
 *
 * -----------------------------------------------------------------------------
 *
 * HOW DOES IT FIND THE REPOSITORY FOLDER?
 * -----------------------------------------------------------------------------
 * This script reads the user configuration from `config.json`. In that file, 
 * you'll see fields like "sourceDir" and "targetDir". Here, we take `sourceDir` 
 * as the folder path for the repository (a.k.a. catalog). The default might be 
 * something like "../CatalogRepository", but you can set it to anything you like.
 *
 * DISCLAIMER: This is a simple local admin tool, not secure for production.
 *
 * Usage:
 *   node metadata-admin-server.js
 * Then open http://localhost:4000
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const querystring = require("querystring");

/**
 * Load the user-supplied configuration from "config.json".
 * Exits the script if not found or if there's a parsing error.
 */
function loadConfig() {
  const configPath = path.join(__dirname, "config.json");
  if (!fs.existsSync(configPath)) {
    console.error(`Error: config.json not found at: ${configPath}`);
    process.exit(1);
  }
  try {
    const configRaw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(configRaw);
  } catch (err) {
    console.error("Error parsing config.json:", err);
    process.exit(1);
  }
}

// Read the config to determine the repository folder
const configData = loadConfig();

/**
 * The directory containing the repository (catalog).
 * e.g. "../CatalogRepository"
 */
const REPOSITORY_DIR = path.resolve(__dirname, configData.sourceDir);

/**
 * The metadata file name we'll be editing.
 */
const METADATA_FILENAME = "repo-metadata.json";

/**
 * The path to the metadata JSON file.
 * e.g. "<repository_folder>/repo-metadata.json"
 */
const METADATA_PATH = path.join(REPOSITORY_DIR, METADATA_FILENAME);

// Port for the metadata admin server
const PORT = 4000;

/**
 * Utility to read the metadata file if it exists.
 * Returns { name, description, lastModified, ... } or an empty object.
 */
function readMetadata() {
  if (fs.existsSync(METADATA_PATH)) {
    try {
      const content = fs.readFileSync(METADATA_PATH, "utf-8");
      return JSON.parse(content);
    } catch (error) {
      console.warn("[MetadataAdmin] Could not parse existing metadata JSON:", error);
      return {};
    }
  } else {
    return {};
  }
}

/**
 * Utility to write out the metadata file.
 */
function writeMetadata(metadataObj) {
  fs.writeFileSync(METADATA_PATH, JSON.stringify(metadataObj, null, 2), "utf-8");
}

/**
 * Returns the current Unix epoch in seconds as a string.
 */
function getCurrentEpochSeconds() {
  return Math.floor(Date.now() / 1000).toString();
}

/**
 * Minimal HTML template rendering. Takes the current metadata object and
 * renders a form for name + description. The "lastModified" field is not shown;
 * we update that automatically on save.
 */
function renderHtmlPage(metadata) {
  const { name = "", description = "" } = metadata;

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>Metadata Admin</title>
  <style>
    body {
      font-family: sans-serif; 
      max-width: 600px; 
      margin: 40px auto;
    }
    label { display: block; margin-top: 1em; font-weight: bold; }
    input[type="text"], textarea {
      width: 100%; 
      padding: 0.5em; 
      font-family: inherit;
    }
    .button-row {
      margin-top: 1.5em;
    }
    button {
      padding: 0.6em 1.2em; 
      font-size: 1em;
    }
    .notice {
      margin-top: 1em; 
      font-size: 0.9em;
      color: #666;
    }
  </style>
</head>
<body>
  <h1>Repository (Catalog) Metadata Admin</h1>
  <form method="POST" action="/save">
    <label for="name">Repository (Catalog) Name</label>
    <input type="text" id="name" name="name" value="${escapeHtml(name)}" required />

    <label for="description">Description</label>
    <textarea id="description" name="description" rows="5">${escapeHtml(description)}</textarea>

    <div class="notice">
      <strong>Note:</strong> "Last Modified" is automatically updated when you save.
    </div>

    <div class="button-row">
      <button type="submit">Save</button>
    </div>
  </form>
</body>
</html>
  `;
}

/**
 * Simple utility to escape HTML special characters in user-inputted strings.
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * HTTP server for handling:
 *   GET /  => show the form with current metadata
 *   POST /save => update the metadata file with the submitted form data
 */
const server = http.createServer((req, res) => {
  const { method, url } = req;

  // 1) GET / => serve the form
  if (method === "GET" && url === "/") {
    const metadata = readMetadata();
    const html = renderHtmlPage(metadata);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  // 2) POST /save => parse form data and write out to JSON
  if (method === "POST" && url === "/save") {
    let bodyData = "";
    req.on("data", (chunk) => {
      bodyData += chunk;
    });

    req.on("end", () => {
      const formFields = querystring.parse(bodyData);
      const updatedMetadata = {
        name: formFields.name || "",
        description: formFields.description || "",
        // Auto-update lastModified on every save:
        lastModified: getCurrentEpochSeconds(),
      };

      try {
        writeMetadata(updatedMetadata);
        // Show a confirmation page
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8" /><title>Saved</title></head>
<body>
  <h1>Metadata Updated</h1>
  <p><strong>Name:</strong> ${escapeHtml(updatedMetadata.name)}</p>
  <p><strong>Description:</strong> ${escapeHtml(updatedMetadata.description)}</p>
  <p><strong>Last Modified:</strong> ${escapeHtml(updatedMetadata.lastModified)}</p>
  <p><a href="/">Return to Editor</a></p>
</body>
</html>
        `);
      } catch (error) {
        console.error("[MetadataAdmin] Failed writing metadata:", error);
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h1>500 Internal Server Error</h1><p>Failed to save metadata file.</p>");
      }
    });
    return;
  }

  // Otherwise, 404
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("404 Not Found");
});

// Start the server
server.listen(PORT, () => {
  console.log(`Metadata admin server listening on http://localhost:${PORT}/`);
  console.log(`Using repository folder: ${REPOSITORY_DIR}`);
  console.log(`Editing file at: ${METADATA_PATH}`);
});
