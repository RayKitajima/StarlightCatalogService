#!/usr/bin/env node

/**
 * local-server.js
 *
 * A minimal Node.js HTTP server that serves files from the folder specified 
 * by "targetDir" in config.json (often the "docs" directory) on http://localhost:3000.
 *
 * Usage:
 *   node local-server.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

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

// Read the config
const configData = loadConfig();

// Use configData.targetDir for the folder to serve
const ROOT_DIR = path.resolve(__dirname, configData.targetDir);

// Choose a port (still hardcoded here, or read from configData if desired)
const PORT = 3000;

// Optional: Set to true to allow cross-origin requests,
// in case your SwiftUI app or other front-end is on a different localhost port.
const ENABLE_CORS = true;

/**
 * A helper function to safely resolve a requested file path.
 * Prevents directory traversal (e.g., "../" attempts).
 */
function safeJoin(base, target) {
  // Normalize the incoming path to avoid malicious ../
  const targetPath = "." + target;
  return path.join(base, path.normalize(targetPath));
}

/**
 * A helper function to guess the Content-Type from the file extension.
 */
function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".json":
      return "application/json";
    case ".js":
      return "application/javascript";
    case ".css":
      return "text/css";
    case ".html":
    case ".htm":
      return "text/html";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
}

/**
 * Create an HTTP server that listens for requests
 * and serves files from the configured targetDir (ROOT_DIR).
 */
const server = http.createServer((req, res) => {
  // Simple log of each request
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);

  // Enable CORS if desired
  if (ENABLE_CORS) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    // res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    // res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  // If it's a preflight request (OPTIONS), respond quickly
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // For a directory request (e.g., "/"), let's serve "index.json" if available
  let requestedPath = req.url === "/" ? "/index.json" : req.url;

  // Build the absolute path on disk
  const filePath = safeJoin(ROOT_DIR, requestedPath);

  // Check if the file or directory exists
  fs.stat(filePath, (err, stats) => {
    if (err) {
      // File doesn't exist or error reading it
      return notFound(res);
    }

    if (stats.isDirectory()) {
      // If it's a directory, try appending "/index.json"
      const indexJsonPath = path.join(filePath, "index.json");
      fs.stat(indexJsonPath, (dirErr, dirStats) => {
        if (dirErr || !dirStats.isFile()) {
          // index.json not found
          return notFound(res);
        }
        // Serve the directory's index.json
        serveFile(indexJsonPath, res);
      });
    } else {
      // It's a file, serve it
      serveFile(filePath, res);
    }
  });
});

/**
 * A helper function to read and serve a file.
 */
function serveFile(filePath, res) {
  // Guess the content type
  const contentType = getContentType(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      return internalError(res);
    }
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
}

/**
 * Send a 404 Not Found response.
 */
function notFound(res) {
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("404 Not Found\n");
}

/**
 * Send a 500 Internal Server Error response.
 */
function internalError(res) {
  res.writeHead(500, { "Content-Type": "text/plain" });
  res.end("500 Internal Server Error\n");
}

// Start the server
server.listen(PORT, () => {
  console.log(`Local server running at http://localhost:${PORT}/`);
  console.log(`Serving files from: ${ROOT_DIR}`);
});
