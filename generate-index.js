#!/usr/bin/env node

/**
 * generate-index.js
 *
 * Summary:
 * -------
 * This script processes a source repository of JSON entities and other files, 
 * then generates a structured output folder. 
 * Although we refer to the input folder as "repository/" and the output folder 
 * as "docs/", both names are purely conceptual here. Their actual values 
 * (sourceDir and targetDir) are specified in the user-provided config.json.
 *
 * Key Steps:
 * ----------
 * 1) **Clear the target folder**: Removes any existing contents of the output directory 
 *    (conceptually called "docs/") to ensure a fresh start.
 * 2) **Recursively scan the source directory** (conceptually "repository/").
 * 3) **For each entity** (a .json file or a folder containing "entity.json"):
 *    a) Parse the JSON to detect its "digest" (id, name, etc.) and entity type.
 *    b) Create a subfolder in the target directory, extracting embedded media 
 *       (images/audio) and rewriting references to remote URLs.
 *    c) Write the final entity JSON and produce an index entry referencing it.
 * 4) **For non-JSON files**, copy them as-is and note a `downloadURL` in the index.
 * 5) **Generate an index.json** in each directory with the shape:
 *    {
 *      "info": { / Directory metadata (if any) / },
 *      "items": [ / List of items in this directory / ]
 *    }
 *
 * Configuration (config.json):
 * ---------------------------
 * - sourceDir: The input folder (e.g., "repository/" but can be any path).
 * - targetDir: The output folder (e.g., "docs/" but can be any path).
 * - baseUrl:   The prefix for generated URLs (e.g., "http://localhost:3000").
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const AdmZip = require("adm-zip");
const os = require("os");

// The JSON file name that, if present in a directory, is read into the "info" field of index.json
const REPO_METADATA_FILENAME = "repo-metadata.json";

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

// Read the configuration
const configData = loadConfig();

// Pull out the key config fields. Convert the paths to absolute paths.
// The source and target folder names come from config.json; 
// we conceptually refer to them as "repository/" and "docs/", 
// but they can be any valid directory paths.
const SOURCE_DIR = path.resolve(__dirname, configData.sourceDir);
const TARGET_DIR = path.resolve(__dirname, configData.targetDir);

// This baseUrl is used to build the `downloadURL` and to rewrite references 
// to images/audio as remote URLs.
const BASE_URL = configData.baseUrl || "";

/**
 * Generate a random UUID (version 4).
 * Used when we need a unique ID for newly-extracted audio elements, if none is present.
 */
function generateUUID() {
  const bytes = crypto.randomBytes(16);
  // set version bits to 4
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  // set variant bits to (10)
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

/**
 * Convert a date/time string or numeric timestamp to a Unix epoch in seconds.
 * Returns the current time if parsing fails or if input is null/undefined.
 */
function toUnixEpochSeconds(dateVal) {
  if (!dateVal) {
    return Math.floor(Date.now() / 1000);
  }
  if (typeof dateVal === "number") {
    return dateVal;
  }
  const parsed = Date.parse(dateVal);
  if (isNaN(parsed)) {
    return Math.floor(Date.now() / 1000);
  }
  return Math.floor(parsed / 1000);
}

/**
 * Completely removes the target folder before regenerating its contents.
 * This ensures a clean slate for each run.
 */
function clearDocsFolder(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`Removed existing folder: ${dir}`);
  }
}

/**
 * Ensures a directory exists at the given path, creating it if it does not exist.
 * Equivalent to a "mkdir -p" operation.
 */
function ensureDirExists(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Copies a single file from source to target, ensuring the target directory exists.
 */
function copyFile(sourcePath, targetPath) {
  ensureDirExists(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);
}

/**
 * Safely parse JSON from a file. Returns `null` on read or parse failure.
 */
function parseJsonFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content);
  } catch (e) {
    console.warn("Failed to parse JSON:", filePath, e);
    return null;
  }
}

/**
 * Replace all spaces in a string with dashes for file system safety.
 * Used to create sanitized folder or file names derived from entity names or file names.
 */
function sanitizeForFilesystem(name) {
  return name.replace(/\s+/g, "-");
}

/**
 * Removes the trailing ".json" extension from a string, if present (case-insensitive).
 */
function stripJsonExtension(filePath) {
  return filePath.replace(/\.json$/i, "");
}

/**
 * Reads `repo-metadata.json` in the given directory (if present) and returns it as an object,
 * or null if it doesn't exist or fails to parse.
 * This metadata (if present) is placed into the "info" field in the local index.json.
 */
function readRepoMetadata(dirPath) {
  const metaPath = path.join(dirPath, REPO_METADATA_FILENAME);
  if (fs.existsSync(metaPath)) {
    const metadata = parseJsonFile(metaPath);
    if (metadata) {
      return metadata;
    }
  }
  return null;
}

/**
 * Main entry point:
 * 1) Validate the source directory existence.
 * 2) Clear the target folder (output).
 * 3) Recursively scan the source directory and build indexes/files in the target directory.
 */
function main() {
  if (!fs.existsSync(SOURCE_DIR)) {
    console.error("Error: sourceDir (repository) not found:", SOURCE_DIR);
    process.exit(1);
  }
  clearDocsFolder(TARGET_DIR);
  recurseAndBuildAllIndexes(SOURCE_DIR, TARGET_DIR);
}

/**
 * Recursively traverse the source directory.
 * For each item:
 *   - If it's a directory containing an "entity.json", treat the entire folder as a single entity.
 *   - If it's a regular subfolder, recurse into it to build a nested index.
 *   - If it's a .json file, process it as an entity (if valid) or copy as-is (if invalid).
 *   - If it's a non-JSON file, copy it as-is to the target directory.
 *
 * Regardless of contents, produce an "index.json" in each folder with the shape:
 * {
 *   "info": { Possibly loaded from repo-metadata.json },
 *   "items": [ Array of entries describing each file/folder/entity within ]
 * }
 *
 * @param {string} sourceDir        The source folder to read.
 * @param {string} targetDir        The target folder to write.
 * @param {string} webRelativePath  A relative path (used to build final URLs). 
 *                                  Defaults to "" at the top-level.
 */
function recurseAndBuildAllIndexes(sourceDir, targetDir, webRelativePath = "") {
  // Ensure the target folder exists (it might not if it's newly created).
  ensureDirExists(targetDir);

  // Attempt to read any local metadata file (repo-metadata.json)
  let dirMetadata = readRepoMetadata(sourceDir) || {};

  // Read entries in the current sourceDir
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  const indexItems = [];

  // For each file/folder in sourceDir
  for (const entry of entries) {
    // Skip hidden/system files or an existing index.json
    if (entry.name.startsWith(".") || entry.name === "index.json") {
      continue;
    }

    // Also skip listing "repo-metadata.json" itself in the "items"
    if (entry.name === REPO_METADATA_FILENAME) {
      continue;
    }

    const childSourcePath = path.join(sourceDir, entry.name);

    // Build the relative path used for URLs
    const nextRelativePath = webRelativePath
      ? path.join(webRelativePath, entry.name)
      : entry.name;

    if (entry.isDirectory()) {
      // Check if the directory has an "entity.json"
      const entityJsonPath = path.join(childSourcePath, "entity.json");
      if (fs.existsSync(entityJsonPath)) {
        // => This is a folder containing a single entity
        const result = processEntityFolder(
          childSourcePath,
          targetDir,
          nextRelativePath,
          entry.name
        );
        if (result) {
          indexItems.push(result);
        }
      } else {
        // => A normal subfolder (no "entity.json"), so we recurse
        const subTargetDir = path.join(targetDir, sanitizeForFilesystem(entry.name));
        recurseAndBuildAllIndexes(childSourcePath, subTargetDir, nextRelativePath);

        indexItems.push({
          name: entry.name,
          path: sanitizeForFilesystem(entry.name),
          isDirectory: true,
        });
      }
    } else {
      // It's a file. We check if it's JSON or another format.
      const ext = path.extname(entry.name).toLowerCase();
      if (ext === ".zip" && getTopLevelFolder(nextRelativePath).toLowerCase() === "programs") {
        /* ------------------------------------------------------------------
           A *zipped* Program package exported by the iOS app
           ------------------------------------------------------------------ */
        const result = processProgramPackageZip(
          childSourcePath,        // …/repository/Programs/MyShow.zip
          targetDir,              // …/docs/Programs
          nextRelativePath        // Programs/MyShow.zip
        );
        if (result) indexItems.push(result);

      } else if (ext === ".json") {
        // Process a JSON entity (if valid)
        const result = processEntityJson(childSourcePath, targetDir, nextRelativePath);
        if (result) {
          indexItems.push(result);
        }
      } else {
        // Non-JSON file => copy as-is
        const childTargetPath = path.join(targetDir, sanitizeForFilesystem(entry.name));
        copyFile(childSourcePath, childTargetPath);

        // Provide a download URL in the index
        const downloadURL = `${BASE_URL}/${sanitizeForFilesystem(nextRelativePath)}`;

        indexItems.push({
          name: entry.name,
          path: sanitizeForFilesystem(entry.name),
          isDirectory: false,
          downloadURL,
        });
      }
    }
  }

  // Finally, produce the index.json for this folder
  const finalIndex = {
    info: dirMetadata,
    items: indexItems,
  };

  const indexFilePath = path.join(targetDir, "index.json");
  fs.writeFileSync(indexFilePath, JSON.stringify(finalIndex, null, 2), "utf-8");
  console.log("Created index.json in:", targetDir);
}

/**
 * Handle a .zip that contains a full Program package (.programpkg).
 * 1. Unzip into a temp folder.
 * 2. Locate the folder that has an entity.json (the root of the package).
 * 3. Move that folder into the docs tree with a nice name.
 * 4. Rewrite local / generated image & audio references to "remote".
 * 5. Return an index item (digest) so the caller can list it.
 */
function processProgramPackageZip(sourceZipPath, parentTargetDir, rawRelativePath) {
  // ---------- 1) unzip -------------------------------------------------------
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pkg-"));
  const zip = new AdmZip(sourceZipPath);
  zip.extractAllTo(tmpRoot, true);

  // find the first entity.json inside the extracted tree
  const candidate = walkForEntityJson(tmpRoot);
  if (!candidate) {
    console.warn("No entity.json inside", sourceZipPath);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    return null;
  }
  const { entityDir, entityJsonPath } = candidate;

  // ---------- 2) read Program spec ------------------------------------------
  const programJson = parseJsonFile(entityJsonPath);
  if (!programJson) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    return null;
  }
  const digest = parseProgramDigest(programJson.spec || {});

  // decide the final folder name
  const fallbackName = stripJsonExtension(path.basename(sourceZipPath));
  const finalFolderName = sanitizeForFilesystem(digest.name || fallbackName);

  // ---------- 3) move folder into docs tree ---------------------------------
  const destFolder = path.join(parentTargetDir, finalFolderName);
  ensureDirExists(path.dirname(destFolder));
  fs.renameSync(entityDir, destFolder);

  // Read the *rewritten* program JSON so that image URLs are already remote
  const progJsonPath = path.join(destFolder, "entity.json");
  const progJson     = parseJsonFile(progJsonPath);
  if (progJson) {
    const blob = buildAggregatedBlob(progJson.spec, destFolder);
    const aggregated = { ...progJson, ...blob };
    fs.writeFileSync(
      path.join(destFolder, "entity+deps.json"),
      JSON.stringify(aggregated, null, 2),
      "utf-8"
    );
    console.log("Created entity+deps.json in", destFolder);
  }

  // ---------- 4) rewrite media refs inside ALL entity.json files ------------
  recursivelyRewriteEntityFolder(destFolder, path.posix.join(
    path.dirname(rawRelativePath.replace(/\.zip$/i, "")), // Programs/…
    finalFolderName                                       // …/MyShow
  ));

  // ---------- 5) create index entry -----------------------------------------
  const parentDirRel = path.posix.dirname(rawRelativePath).replace(/\.zip$/i, "");
  const indexPath = parentDirRel === "." ? finalFolderName
                                         : path.posix.join(parentDirRel, finalFolderName);

  return {
    name: digest.name || fallbackName,
    path: indexPath,
    isDirectory: false,
    digest,
  };
}

/**
 * Builds the `{ dependencies: … }` section for *entity+deps.json*.
 * It scans the Program spec for every referenced UUID (top level **and**
 * nested segments), loads the matching `…/entity.json` files from the
 * un-zipped package folder, and groups them into
 *   feeds · apiContents · pageContents · generativeAis
 * so the importer can hydrate the preview with a single HTTP request.
 */
function buildAggregatedBlob(programSpec, pkgRootAbs) {
  /**
   * Helper that reads `soundset/<soundSetId>/soundElement/<elementId>/entity.json`
   * and returns an array of all discovered soundElement objects.
   */
  function gatherSoundElements(soundSetId) {
    const results = [];
    const soundElementRoot = path.join(pkgRootAbs, "soundset", soundSetId.toString(), "soundElement");
    if (!fs.existsSync(soundElementRoot)) {
      return results;
    }
    const dirs = fs.readdirSync(soundElementRoot, { withFileTypes: true });
    for (const dirent of dirs) {
      if (!dirent.isDirectory()) continue;
      const elemFolder = path.join(soundElementRoot, dirent.name);
      const entityPath = path.join(elemFolder, "entity.json");
      const se = parseJsonFile(entityPath);
      if (se) {
        results.push(se);
      }
    }
    return results;
  }

  /**
   * Simplified "pick" function from your existing code.  This looks up any
   * `entity.json` at the given relative sub-path and parses it.
   * If the file does not exist or parsing fails, it returns `null`.
   */
  function pick(relPath) {
    const fullPath = path.join(pkgRootAbs, relPath, "entity.json");
    if (!fs.existsSync(fullPath)) {
      return null;
    }
    const obj = parseJsonFile(fullPath);
    if (!obj) {
      return null; // parse failed
    }

    // For Person or SoundSet, check if type === "predefined"
    // or if it's a SoundElement with type === "preInstalled"
    const spec = obj.spec || {};
    if (spec.type === "predefined" || spec.type === "preInstalled") {
      return null;
    }
    return obj;
  }

  // ------------------------------------------------------------------
  // 1) Gather top-level references for feedIds, apiContentIds, etc.
  // ------------------------------------------------------------------
  const feedIds       = programSpec.feedIds        ?? [];
  const apiContentIds = programSpec.apiContentIds  ?? [];
  const pageContentIds= programSpec.pageContentIds ?? [];
  const segmentFeeds  = new Set();
  const segmentApis   = new Set();
  const segmentPages  = new Set();
  const segmentAis    = new Set();

  // Walk segments to pick up feedId / apiContentId / pageContentId / generativeAiId
  (function walkSegments(segs) {
    for (const s of segs) {
      if (s.generativeAiId) {
        segmentAis.add(s.generativeAiId);
      }
      if (s.source) {
        if (s.source.feedId)        segmentFeeds.add(s.source.feedId);
        if (s.source.apiContentId)  segmentApis.add(s.source.apiContentId);
        if (s.source.pageContentId) segmentPages.add(s.source.pageContentId);
      }
      if (Array.isArray(s.subSegments)) {
        walkSegments(s.subSegments);
      }
    }
  })(programSpec.programSegments ?? []);

  // ------------------------------------------------------------------
  // 2) Gather persons and soundSets
  // ------------------------------------------------------------------
  const personalityIds = programSpec.personalityIds ?? [];
  const persons = personalityIds
    .map((pid) => pick(`person/${pid}`))
    .filter(Boolean);

  let soundSets = [];
  let soundElements = [];

  if (programSpec.soundSetId) {
    const sId = programSpec.soundSetId.toString();
    const sObj = pick(`soundset/${sId}`);
    if (sObj) {
      soundSets.push(sObj);
      // Also gather any local soundElements from that soundSet folder
      const elementObjs = gatherSoundElements(programSpec.soundSetId);
      if (elementObjs.length > 0) {
        soundElements.push(...elementObjs);
      }
    }
  }

  // ------------------------------------------------------------------
  // 3) Gather segment-level generativeAi plus program-level references
  // ------------------------------------------------------------------
  const allGenAiIds = [
    programSpec.generatorModelId,
    programSpec.summarizerModelId,
    programSpec.translatorModelId,
    programSpec.coverImageModelId,
    ...segmentAis,
  ].filter(Boolean);

  const generativeAis = allGenAiIds
    .map((gid) => pick(`generativeAi/${gid}`))
    .filter(Boolean);

  // ------------------------------------------------------------------
  // 4) Now build the final dependencies object
  // ------------------------------------------------------------------
  const deps = {
    persons,
    soundSets,
    soundElements,
    feeds: [
      ...feedIds,
      ...segmentFeeds,
    ]
      .map((fid) => pick(`feed/${fid}`))
      .filter(Boolean),
    apiContents: [
      ...apiContentIds,
      ...segmentApis,
    ]
      .map((aid) => pick(`apiContent/${aid}`))
      .filter(Boolean),
    pageContents: [
      ...pageContentIds,
      ...segmentPages,
    ]
      .map((pid) => pick(`pageContent/${pid}`))
      .filter(Boolean),
    generativeAis,
  };

  return { dependencies: deps };
}

/* ------------------------------------------------------------------------- */
/* Helper: walk a directory tree until we find an entity.json                */
function walkForEntityJson(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    const candidate = path.join(dir, "entity.json");
    if (fs.existsSync(candidate)) {
      return { entityDir: dir, entityJsonPath: candidate };
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
    }
  }
  return null;
}

/**
 * Walk a folder tree, rewrite every entity.json **and** entity+deps.json
 * so that any “local / generated / embeddedBase64” media reference becomes
 * `{ kind:"remote", url:"http://…"}`
 *
 * @param {string} folderAbsPath           Absolute path we are scanning
 * @param {string} webRelPathFromPrograms  Path relative to “…/Programs/…”
 *                                         (used to build final URLs)
 */
function recursivelyRewriteEntityFolder(folderAbsPath, webRelPathFromPrograms) {
  const fsEntries = fs.readdirSync(folderAbsPath, { withFileTypes: true });
  const topFolder = webRelPathFromPrograms.split("/")[0] || "Programs";

  for (const entry of fsEntries) {
    const abs = path.join(folderAbsPath, entry.name);

    /* ------------------------------------------------------------------ */
    /* 1) Recurse into sub-directories                                    */
    /* ------------------------------------------------------------------ */
    if (entry.isDirectory()) {
      recursivelyRewriteEntityFolder(
        abs,
        path.posix.join(webRelPathFromPrograms, entry.name)
      );
      continue;
    }

    /* ------------------------------------------------------------------ */
    /* 2) Normal entity.json inside an entity subfolder                   */
    /* ------------------------------------------------------------------ */
    if (entry.name === "entity.json") {
      const json = parseJsonFile(abs);
      if (!json) continue;

      extractEmbeddedMediaAndRewrite(
        json,                                   // full wrapper object
        path.dirname(abs),                      // on-disk folder
        getEntityImageFilename(topFolder),      // person.png / feed.png / …
        path.posix.join(webRelPathFromPrograms, entry.name)
      );

      fs.writeFileSync(abs, JSON.stringify(json, null, 2), "utf-8");
      continue;
    }

    /* ------------------------------------------------------------------ */
    /* 3) Aggregated entity+deps.json sitting next to the Program         */
    /* ------------------------------------------------------------------ */
    if (entry.name === "entity+deps.json") {
      const blob = parseJsonFile(abs);
      if (!blob) continue;

      /* 3-A  · rewrite the Program spec itself ------------------------- */
      extractEmbeddedMediaAndRewrite(
        blob,                                   // program wrapper
        path.dirname(abs),
        getEntityImageFilename(topFolder),
        path.posix.join(webRelPathFromPrograms, entry.name)
      );

      /* 3-B  · rewrite every dependency object ------------------------- */
      if (blob.dependencies && typeof blob.dependencies === "object") {
        for (const [depKey, list] of Object.entries(blob.dependencies)) {
          if (!Array.isArray(list)) continue;

          // feeds → feed.png, apiContents → apicontent.png, …
          const imgFile = getEntityImageFilename(depKey);

          for (const spec of list) {
            extractEmbeddedMediaAndRewrite(
              { spec },                         // wrap to match helper sig
              path.dirname(abs),
              imgFile,
              path.posix.join(webRelPathFromPrograms, entry.name)
            );
          }
        }
      }

      fs.writeFileSync(abs, JSON.stringify(blob, null, 2), "utf-8");
      continue;                                // VERY important
    }

    /* ------------------------------------------------------------------ */
    /* 4) Anything else (non-JSON files) – ignore here                    */
    /* ------------------------------------------------------------------ */
  }
}

/**
 * Process a directory containing "entity.json" as a single entity.
 * The folder as a whole is treated as one item with `isDirectory: false` 
 * in the parent's index.json. 
 *
 * Internally, we still create a matching subfolder in the target directory 
 * (conceptually "docs/") to place the final entity.json, extracted images/audio, etc.
 *
 * @param {string} folderSourcePath  The path of the source folder.
 * @param {string} parentTargetDir   The parent directory in the output where this entity subfolder will go.
 * @param {string} rawRelativePath   Relative path (used to build final URLs).
 * @param {string} folderName        The name of the folder (used in the final subfolder).
 */
function processEntityFolder(folderSourcePath, parentTargetDir, rawRelativePath, folderName) {
  const entityPath = path.join(folderSourcePath, "entity.json");
  const originalJson = parseJsonFile(entityPath);
  if (!originalJson) {
    // If parsing fails, skip
    console.warn("Warning: invalid entity.json in folder:", folderSourcePath);
    return null;
  }

  // Derive entity type from the top-level folder name (e.g., "Persons", "Feeds", etc.)
  const entityType = getTopLevelFolder(rawRelativePath);

  // Build a minimal digest from the entity
  let digest = buildDigest(originalJson, entityType);

  // Use the folder name as a fallback if no name is in the JSON
  let displayName = digest.name || folderName;

  // Create a corresponding subfolder in the output
  const entitySubfolder = path.join(parentTargetDir, sanitizeForFilesystem(folderName));
  ensureDirExists(entitySubfolder);

  // Extract any embedded media (images/audio) and rewrite references in the JSON
  extractEmbeddedMediaAndRewrite(
    originalJson,
    entitySubfolder,
    getEntityImageFilename(entityType),
    rawRelativePath
  );

  // Rebuild the digest after the rewrite (image/audio references may have changed)
  digest = buildDigest(originalJson, entityType);
  if (!digest.name) {
    digest.name = displayName;
  }

  // Write out the final entity.json
  const finalJsonPath = path.join(entitySubfolder, "entity.json");
  fs.writeFileSync(finalJsonPath, JSON.stringify(originalJson, null, 2), "utf-8");
  console.log(`Wrote final JSON => ${finalJsonPath}`);

  // Return an index entry to the parent folder
  const parentDir = path.posix.dirname(rawRelativePath);
  const subfolderName = sanitizeForFilesystem(folderName);
  const finalPath =
    parentDir === "." || !parentDir
      ? subfolderName
      : path.posix.join(parentDir, subfolderName);

  return {
    name: digest.name,
    path: finalPath,
    isDirectory: false,
    digest,
  };
}

/**
 * Process a single JSON file that is not already in a dedicated folder.
 * We parse the file, create a subfolder with the same base name, 
 * extract any media, rewrite references, and produce "entity.json".
 *
 * @param {string} sourcePath        The .json file to read.
 * @param {string} parentTargetDir   Where to create the subfolder in the output.
 * @param {string} rawRelativePath   Relative path for building final URLs.
 */
function processEntityJson(sourcePath, parentTargetDir, rawRelativePath) {
  const originalJson = parseJsonFile(sourcePath);
  if (!originalJson) {
    // If parsing fails, just copy the file as-is (fallback).
    const fallbackName = path.basename(sourcePath);
    const fallbackTarget = path.join(parentTargetDir, fallbackName);
    copyFile(sourcePath, fallbackTarget);
    return null;
  }

  // Identify entity type from the top-level folder
  const entityType = getTopLevelFolder(rawRelativePath);
  let digest = buildDigest(originalJson, entityType);

  // Fallback to the file's base name if we don't have a name in the JSON
  let baseName = stripJsonExtension(path.basename(sourcePath));
  if (!digest.name) {
    digest.name = baseName;
  }

  // Create the subfolder for this entity
  const entitySubfolder = path.join(parentTargetDir, sanitizeForFilesystem(baseName));
  ensureDirExists(entitySubfolder);

  // Extract embedded media and rewrite references
  extractEmbeddedMediaAndRewrite(
    originalJson,
    entitySubfolder,
    getEntityImageFilename(entityType),
    rawRelativePath
  );

  // Rebuild digest in case references changed
  digest = buildDigest(originalJson, entityType);
  if (!digest.name) {
    digest.name = baseName;
  }

  // Write the final entity.json
  const finalJsonPath = path.join(entitySubfolder, "entity.json");
  fs.writeFileSync(finalJsonPath, JSON.stringify(originalJson, null, 2), "utf-8");
  console.log("Wrote final JSON (entity.json):", finalJsonPath);

  // Return the index entry describing this entity
  const parentDir = path.posix.dirname(rawRelativePath);
  const subfolderName = sanitizeForFilesystem(baseName);
  const finalPath =
    parentDir === "." || !parentDir
      ? subfolderName
      : path.posix.join(parentDir, subfolderName);

  return {
    name: digest.name,
    path: finalPath,
    isDirectory: false,
    digest,
  };
}

/**
 * Extract the top-level folder name from the path.
 * For example: "Persons/Featured/David.json" => "Persons"
 *
 * @param {string} webRelativePath  The relative path
 * @returns {string} The top-level folder name
 */
function getTopLevelFolder(webRelativePath) {
  if (!webRelativePath) return "";
  const slashIndex = webRelativePath.indexOf("/");
  return slashIndex === -1
    ? webRelativePath
    : webRelativePath.substring(0, slashIndex);
}

/**
 * Determine the appropriate filename for an entity's image when extracted from base64.
 *
 * @param {string} entityType  The type of entity (e.g. "Persons", "SoundSets", etc.)
 * @returns {string}           The filename to use (e.g. "person.png")
 */
function getEntityImageFilename(entityType) {
  switch (entityType.toLowerCase()) {
    case "persons":
      return "person.png";
    case "feeds":
      return "feed.png";
    case "soundsets":
      return "soundset.png";
    case "generativeais":
      return "generativeai.png";
    case "pagecontents":
      return "pagecontent.png";
    case "apicontents":
      return "apicontent.png";
    case "programs":
      return "program.png";
    case "broadcasts":
      return "broadcast.png";
    case "catalogs":
      return "catalog.png";
    default:
      return "entity.png";
  }
}

/**
 * For ApiContent-based entities (ApiContents, GenerativeAis, PageContents, Catalogs),
 * we store the image reference in `spec.extraData.data.imageSourceJson`.
 * This function sets it accordingly, encoding the image source data as JSON.
 *
 * @param {object} spec         The spec object where we place image info.
 * @param {string} absoluteUrl  The absolute URL of the extracted image.
 */
function setApiContentImageSource(spec, absoluteUrl) {
  if (!spec.extraData) {
    spec.extraData = { data: {} };
  }
  if (!spec.extraData.data) {
    spec.extraData.data = {};
  }

  const imageSourceObj = {
    kind: "remote",
    url: absoluteUrl,
  };

  // Store as a string in extraData.data.imageSourceJson
  spec.extraData.data.imageSourceJson = JSON.stringify(imageSourceObj);
}

/**
 * Extracts embedded media (image/audio) from an entity JSON (if present) and 
 * rewrites references to use remote URLs pointing to the extracted files.
 *
 * Steps:
 * 1) If `spec.embeddedImageBase64` is present, decode and write out an image file, 
 *    then rewrite `spec.imageSource` or `spec.extraData.data.imageSourceJson` to a remote reference.
 * 2) If it's a SoundSet, look for embedded audio in certain keys and decode each 
 *    to a "sounds/<elementId>/<filename>" path, then rewrite `soundSource` to `kind:"remote"`.
 *
 * @param {object} json             The entity JSON object (parsed).
 * @param {string} entitySubfolder  The local subfolder to place extracted files (under the targetDir).
 * @param {string} imageFileName    The file name to use for extracted images (e.g. "person.png").
 * @param {string} rawRelativePath  A path used to determine the top-level folder and form final URLs.
 */
function extractEmbeddedMediaAndRewrite(
  json,
  entitySubfolder,
  imageFileName,
  rawRelativePath
) {
  const spec = json.spec || {};
  const entityType = getTopLevelFolder(rawRelativePath);

  // Determine the *real* folder that contains the entity assets.
  // • For single-file entities (…/Foo.json) we add the file-basename,
  //   because `processEntityJson()` created a sub-folder with that name.
  // • For folder entities (…/Foo) the path is already the right one.
  // If we are patching *entity+deps.json* the assets sit in the same folder,
  // so don’t append “entity+deps”.
  const isAggregated = path.posix.basename(rawRelativePath).toLowerCase()
                         .startsWith("entity+deps");
  const parentRel = rawRelativePath.toLowerCase().endsWith(".json") && !isAggregated
    ? path.posix.join(
        path.posix.dirname(rawRelativePath),
        stripJsonExtension(path.posix.basename(rawRelativePath))
      )
    : path.posix.dirname(rawRelativePath);

  // For certain entities (ApiContent, GenerativeAi, etc.) we store image in extraData
  const isApiContentFamily = [
    "apicontents",
    "generativeais",
    "pagecontents",
    "catalogs",
  ].includes(entityType.toLowerCase());

  // 1) If there's an embedded base64 image, decode it (unchanged logic)
  if (spec.embeddedImageBase64) {
    try {
      const buffer = Buffer.from(spec.embeddedImageBase64, "base64");
      delete spec.embeddedImageBase64;

      const fullImagePathOnDisk = path.join(entitySubfolder, imageFileName);
      fs.writeFileSync(fullImagePathOnDisk, buffer);
      console.log("Wrote embedded image:", fullImagePathOnDisk);

      const absoluteImageUrl = `${BASE_URL}/${path.posix.join(
        sanitizeForFilesystem(parentRel),
        imageFileName
      )}`;

      if (isApiContentFamily) {
        setApiContentImageSource(spec, absoluteImageUrl);
        delete spec.imageSource; // not used directly
      } else {
        spec.imageSource = { kind: "remote", url: absoluteImageUrl };
      }
    } catch (err) {
      console.warn("Failed to decode embeddedImageBase64:", err);
    }

  // 2) If it’s "local" or "generated" but references, say, "images/cover.png",
  //    just rewrite the JSON to "remote" with full URL. (NO copying—already unzipped.)
  } else if (
    spec.imageSource &&
    (spec.imageSource.kind === "local" || spec.imageSource.kind === "generated")
  ) {
    const localRel = spec.imageSource.url || imageFileName;
    // The final path might be "Programs/MyProgram/images/cover.png"
    const finalRelImagePath = path.posix.join(
      sanitizeForFilesystem(parentRel),
      localRel
    );
    const absoluteImageUrl = `${BASE_URL}/${finalRelImagePath}`;

    if (isApiContentFamily) {
      setApiContentImageSource(spec, absoluteImageUrl);
      delete spec.imageSource;
    } else {
      spec.imageSource = { kind: "remote", url: absoluteImageUrl };
    }
  }

  // 3) SoundSet audio extraction (same logic as before)
  if (entityType.toLowerCase() === "soundsets") {
    const audioKeys = ["openingBGM", "talkBGM", "newsBGM", "endingBGM", "jingleBGM"];
    const soundsFolder = path.join(entitySubfolder, "sounds");
    ensureDirExists(soundsFolder);

    for (const key of audioKeys) {
      if (!Array.isArray(spec[key])) continue;
      for (let i = 0; i < spec[key].length; i++) {
        const element = spec[key][i];
        if (!element || !element.embeddedSoundBase64) continue;

        // existing logic to decode and rewrite ...
        const b64 = element.embeddedSoundBase64;
        delete element.embeddedSoundBase64;

        const embeddedFileName = element.embeddedSoundFileName;
        delete element.embeddedSoundFileName;

        try {
          const audioBuffer = Buffer.from(b64, "base64");
          const elementId = element.id || generateUUID();
          const extension = embeddedFileName ? path.extname(embeddedFileName) : ".m4a";
          const baseOfFileName = embeddedFileName
            ? path.basename(embeddedFileName, extension)
            : elementId;
          const finalFileName = sanitizeForFilesystem(baseOfFileName) + extension;

          const elementSubFolder = path.join(soundsFolder, elementId);
          ensureDirExists(elementSubFolder);

          const audioPathOnDisk = path.join(elementSubFolder, finalFileName);
          fs.writeFileSync(audioPathOnDisk, audioBuffer);

          const finalRelativeAudio = path.posix.join(
            sanitizeForFilesystem(parentRel),
            "sounds",
            elementId,
            finalFileName
          );
          const absoluteAudioUrl = `${BASE_URL}/${finalRelativeAudio}`;

          element.soundSource = {
            kind: "remote",
            url: absoluteAudioUrl,
          };

          console.log("Wrote embedded audio =>", audioPathOnDisk);
        } catch (audioErr) {
          console.warn("Failed to decode embeddedSoundBase64:", audioErr);
        }
      }
    }
  }

  // Done
  json.spec = spec;
}

/**
 * Build a "digest" object that describes an entity in minimal form (id, name, etc.).
 * The structure depends on the entity type. 
 * 
 * @param {object} rootJson       The parsed entity JSON, expected to have a `spec` field.
 * @param {string} topFolderName  The name of the top-level folder, indicating entity type.
 * @returns {object}              The constructed digest with standard fields.
 */
function buildDigest(rootJson, topFolderName) {
  const m = rootJson.spec || {};
  switch (topFolderName.toLowerCase()) {
    case "persons":
      return parsePersonDigest(m);
    case "feeds":
      return parseFeedDigest(m);
    case "soundsets":
      return parseSoundSetDigest(m);
    case "generativeais":
      return parseGenerativeAiDigest(m);
    case "pagecontents":
      return parsePageContentDigest(m);
    case "apicontents":
      return parseApiContentDigest(m);
    case "programs":
      return parseProgramDigest(m);
    case "broadcasts":
      return parseBroadcastDigest(m);
    case "catalogs":
      return parseCatalogDigest(m);
    default:
      // Unknown folder => build a generic digest
      return {
        entityType: "Unknown",
        id: m.id || generateUUID(),
        name: m.name || "",
        lastModified: toUnixEpochSeconds(m.lastModified),
        imageSource: decodeImageSource(m),
      };
  }
}

//------------------------------------
// parseXxxDigest utility functions
//------------------------------------

/**
 * Parse a Person digest from `spec`, capturing the fields relevant to a Person.
 */
function parsePersonDigest(m) {
  return {
    entityType: "Person",
    id: m.id || generateUUID(),
    name: m.name || "",
    personality: m.personality || "dj",
    voice: m.voice || "",
    imageSource: decodeImageSource(m),
    type: m.type || "userdefined",
    lastModified: toUnixEpochSeconds(m.lastModified),
  };
}

/**
 * Parse a Feed digest from `spec`.
 */
function parseFeedDigest(m) {
  return {
    entityType: "Feed",
    id: m.id || generateUUID(),
    name: m.name || "",
    source: m.source || "",
    url: m.url || null,
    imageSource: decodeImageSource(m),
    lastModified: toUnixEpochSeconds(m.lastModified),
  };
}

/**
 * Parse a SoundSet digest from `spec`.
 */
function parseSoundSetDigest(m) {
  return {
    entityType: "SoundSet",
    id: m.id || generateUUID(),
    name: m.name || "",
    imageSource: decodeImageSource(m),
    type: m.type || "userdefined",
    lastModified: toUnixEpochSeconds(m.lastModified),
  };
}

/**
 * Parse a GenerativeAi digest from `spec`.
 */
function parseGenerativeAiDigest(m) {
  return {
    entityType: "GenerativeAi",
    id: m.id || generateUUID(),
    name: m.name || "",
    endpoint: m.endpoint || "",
    contentType: m.contentType || "TEXT",
    description: m.description || null,
    imageSource: decodeImageSource(m),
    lastModified: toUnixEpochSeconds(m.lastModified),
  };
}

/**
 * Parse a PageContent digest from `spec`.
 */
function parsePageContentDigest(m) {
  return {
    entityType: "PageContent",
    id: m.id || generateUUID(),
    name: m.name || "",
    endpoint: m.endpoint || "",
    contentType: m.contentType || "PAGE",
    description: m.description || null,
    imageSource: decodeImageSource(m),
    lastModified: toUnixEpochSeconds(m.lastModified),
  };
}

/**
 * Parse an ApiContent digest from `spec`.
 */
function parseApiContentDigest(m) {
  return {
    entityType: "ApiContent",
    id: m.id || generateUUID(),
    name: m.name || "",
    endpoint: m.endpoint || "",
    contentType: m.contentType || "TEXT",
    description: m.description || null,
    imageSource: decodeImageSource(m),
    lastModified: toUnixEpochSeconds(m.lastModified),
  };
}

/**
 * Parse a Program digest from `spec`.
 */
function parseProgramDigest(m) {
  return {
    entityType: "Program",
    id: m.id || generateUUID(),
    name: m.name || "",
    lang: m.lang || { code: "en", language: "english" },
    description: m.description || null,
    programMode: m.programMode || "Basic",
    imageSource: decodeImageSource(m),
    lastModified: toUnixEpochSeconds(m.lastModified),
  };
}

/**
 * Parse a Broadcast digest from `spec`.
 * The name field is derived from the 'headline' array if present.
 */
function parseBroadcastDigest(m) {
  const broadcastName =
    Array.isArray(m.headline) && m.headline.length > 0
      ? m.headline.join(", ")
      : "Untitled Broadcast";

  return {
    entityType: "Broadcast",
    id: m.id || generateUUID(),
    programId: m.programId || null,
    soundSetId: m.soundSetId || null,
    name: broadcastName,
    headline: Array.isArray(m.headline) ? m.headline : [],
    estimatedTime: m.estimatedTime || null,
    generatedTime: toUnixEpochSeconds(m.generatedTime),
    status: m.status || "composing",
    lastModified: toUnixEpochSeconds(m.lastModified),
    imageSource: decodeImageSource(m),
  };
}

/**
 * Parse a Catalog digest from `spec`.
 */
function parseCatalogDigest(m) {
  return {
    entityType: "Catalog",
    id: m.id || generateUUID(),
    name: m.name || "",
    endpoint: m.endpoint || "",
    description: m.description || null,
    imageSource: decodeImageSource(m),
    lastModified: toUnixEpochSeconds(m.lastModified),
  };
}

/**
 * Attempt to decode the image source from `spec.imageSource` 
 * or `spec.extraData.data.imageSourceJson` (for ApiContent-based entities).
 *
 * Returns a fallback { kind: "bundle", name: "no_image" } if nothing is found or if parsing fails.
 */
function decodeImageSource(specObj) {
  // If there's a top-level imageSource, return it directly
  if (specObj.imageSource) {
    return specObj.imageSource;
  }
  // If there's an imageSourceJson in extraData, parse it
  if (
    specObj.extraData &&
    specObj.extraData.data &&
    typeof specObj.extraData.data.imageSourceJson === "string"
  ) {
    try {
      return JSON.parse(specObj.extraData.data.imageSourceJson);
    } catch (e) {
      console.warn("Invalid JSON in imageSourceJson:", e);
      return { kind: "bundle", name: "no_image" };
    }
  }
  // Otherwise, no image source is found
  return { kind: "bundle", name: "no_image" };
}

// Run the main process
main();
