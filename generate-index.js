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
      if (ext === ".json") {
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
function extractEmbeddedMediaAndRewrite(json, entitySubfolder, imageFileName, rawRelativePath) {
  const spec = json.spec || {};
  const entityType = getTopLevelFolder(rawRelativePath);

  // Build the final relative path for the extracted image
  const relativeDir = stripJsonExtension(rawRelativePath);
  const finalRelativeImagePath = path.posix.join(
    sanitizeForFilesystem(relativeDir),
    imageFileName
  );
  const absoluteImageUrl = `${BASE_URL}/${finalRelativeImagePath}`;

  // Certain entity types store images in spec.extraData.data.imageSourceJson
  const isApiContentFamily = ["apicontents", "generativeais", "pagecontents", "catalogs"].includes(
    entityType.toLowerCase()
  );

  // 1) Handle embedded or local => remote for the image
  if (spec.embeddedImageBase64) {
    // If there's an embedded base64 image, decode it.
    try {
      const buffer = Buffer.from(spec.embeddedImageBase64, "base64");
      delete spec.embeddedImageBase64;

      // Write the image file to the subfolder
      const fullImagePathOnDisk = path.join(entitySubfolder, imageFileName);
      fs.writeFileSync(fullImagePathOnDisk, buffer);
      console.log("Wrote embedded image:", fullImagePathOnDisk);

      // Update references
      if (isApiContentFamily) {
        setApiContentImageSource(spec, absoluteImageUrl);
        delete spec.imageSource; // not used by ApiContent-based
      } else {
        spec.imageSource = { kind: "remote", url: absoluteImageUrl };
      }
    } catch (err) {
      console.warn("Failed to decode embeddedImageBase64:", err);
    }
  } else {
    // Convert a local or generated image reference into a remote one, if needed
    if (
      spec.imageSource &&
      (spec.imageSource.kind === "local" || spec.imageSource.kind === "generated")
    ) {
      if (isApiContentFamily) {
        setApiContentImageSource(spec, absoluteImageUrl);
        delete spec.imageSource;
      } else {
        spec.imageSource = { kind: "remote", url: absoluteImageUrl };
      }
    }
  }

  // 2) If this is a SoundSet, also extract embedded audio from each BGM array
  if (entityType.toLowerCase() === "soundsets") {
    const audioKeys = ["openingBGM", "talkBGM", "newsBGM", "endingBGM", "jingleBGM"];

    // We'll store each file under a "sounds" subfolder, grouped by elementId
    const soundsFolder = path.join(entitySubfolder, "sounds");
    ensureDirExists(soundsFolder);

    for (const key of audioKeys) {
      if (!Array.isArray(spec[key])) continue;

      for (let i = 0; i < spec[key].length; i++) {
        const element = spec[key][i];
        if (!element || !element.embeddedSoundBase64) continue;

        // We have embedded audio data to extract
        const b64 = element.embeddedSoundBase64;
        delete element.embeddedSoundBase64;

        const embeddedFileName = element.embeddedSoundFileName;
        delete element.embeddedSoundFileName;

        try {
          const audioBuffer = Buffer.from(b64, "base64");

          // Use element.id or generate one if missing
          const elementId = element.id || generateUUID();

          // Determine the file extension; default to .m4a if not known
          const extension = embeddedFileName ? path.extname(embeddedFileName) : ".m4a";
          const baseOfFileName = embeddedFileName
            ? path.basename(embeddedFileName, extension)
            : elementId; // fallback if no file name

          // Construct final file name
          const finalFileName = sanitizeForFilesystem(baseOfFileName) + (extension || ".m4a");

          // Write the audio file to "sounds/<elementId>/<finalFileName>"
          const elementSubFolder = path.join(soundsFolder, elementId);
          ensureDirExists(elementSubFolder);

          const audioPathOnDisk = path.join(elementSubFolder, finalFileName);
          fs.writeFileSync(audioPathOnDisk, audioBuffer);

          // Form the remote URL for this audio file
          const finalRelativeAudio = path.posix.join(
            sanitizeForFilesystem(relativeDir),
            "sounds",
            elementId,
            finalFileName
          );
          const absoluteAudioUrl = `${BASE_URL}/${finalRelativeAudio}`;

          // Update this element's soundSource
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

  // Store the updated spec back into json
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
