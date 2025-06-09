# Starlight Catalog Service

This repository provides a **catalog service** for \[Radio Starlight], a generative radio station application. It is a self-contained toolset enabling you to organize various entities (such as **SoundSets**, **Programs**, **Persons**, etc.) into a browsable "catalog," which Radio Starlight can access and import.

By following these instructions, you can:

1. Maintain a local "Repository" of JSON entities, images, and other media files.
2. Automatically generate a **static site** (`docs/`) that indexes these entities, using **`generate-index.js`**.
3. Host that generated site locally (or on any static hosting platform).
4. Optionally run a minimal **admin interface** (`metadata-admin-server.js`) to edit repository-level metadata.
5. Preview your content locally with `local-server.js`.
6. Edit release notes stored in `whats-new.json` using `whats-new.js`.

---

## Contents

* [Overview](#overview)
* [Prerequisites](#prerequisites)
* [Repository Structure](#repository-structure)
* [Configuration](#configuration)
* [Scripts](#scripts)

  * [1. metadata-admin-server.js](#1-metadata-admin-serverjs)
  * [2. generate-index.js](#2-generate-indexjs)
  * [3. local-server.js](#3-local-serverjs)
  * [4. whats-new.js](#4-whats-newjs)
* [Featured Items](#featured-items)
* [Typical Workflow](#typical-workflow)

---

## Overview

* **Repository (sourceDir)**: This folder contains your raw JSON entities and any embedded or referenced media. In Radio Starlight, these JSON files might be exported by [Radio Starlight] itself. 
* **Docs (targetDir)**: After running `generate-index.js`, a structured site is created, containing:

  * A folder (or subfolder) for each entity (with its processed `entity.json`).
  * Any extracted images or audio files.
  * Automatically generated `index.json` files to allow hierarchical browsing.

Once the site is generated, you can serve it via `local-server.js` (or any static server) so that Radio Starlight (or any other client) can fetch the catalog data.

---

## Prerequisites

* **Node.js** (v14 or higher recommended)
* Basic familiarity with the command line and JSON.

Clone or download this repository. Inside the directory, you should see:

```
├─ generate-index.js
├─ local-server.js
├─ metadata-admin-server.js
├─ whats-new.js
├─ config.sample.json
└─ ... (other files)
```

---

## Repository Structure

Your **Repository** (`sourceDir`) typically follows this pattern:

```
CatalogRepository/
│
├─ Persons/
│   ├─ Featured/
│   │   └─ (featured person's JSON files)
│   └─ (other subfolders or JSON files)
│
├─ SoundSets/
│   ├─ Featured/
│   │   └─ (featured soundset's JSON files)
│   └─ (other subfolders or JSON files)
│
├─ Feeds/
│   ├─ Featured/
│   │   └─ ...
│   └─ ...
│
├─ repo-metadata.json  <-- Optional folder-level metadata
│
└─ ...
```

> **Note:** The repository can have arbitrary subfolders for organizational purposes. However, if you are using the Featured functionality in Radio Starlight, the application **only** looks at the items (JSON files) **directly** under the `Featured` folder itself. Files placed in nested subfolders **inside** `Featured` will **not** be listed as featured items. (Catalog browser will show them.)

---

## Configuration

1. Copy `config.sample.json` to `config.json`.
2. Modify these fields:

   * **sourceDir**: Path to your **Repository** (e.g. `"../CatalogRepository"`).
   * **targetDir**: Path to your **Docs** folder (e.g. `"../CatalogSite/docs"`).
   * **baseUrl**: Base URL used to form any `downloadURL` or remote references (e.g. `"http://localhost:3000"`).

Example:

```json
{
  "sourceDir": "../CatalogRepository",
  "targetDir": "../CatalogSite/docs",
  "baseUrl": "http://localhost:3000"
}
```

---

## Scripts

### 1. `metadata-admin-server.js`

A quick local admin tool to edit the metadata file named `repo-metadata.json`. This file typically stores:

* `name` (the name of your repository)
* `description` (short description)
* `lastModified` (automatically updated on save)

**Usage**:

```bash
node metadata-admin-server.js
```

* Opens a server at [http://localhost:4000](http://localhost:4000)
* Lets you edit the name & description in a simple HTML form.
* Writes out `repo-metadata.json` in your `sourceDir` folder whenever you hit "Save."

### 2. `generate-index.js`

**Core script** that processes your **Repository** and creates a structured **Docs** folder. It:

1. **Clears** the target folder (removing old contents).
2. Recursively scans the source directory.
3. For each JSON entity or folder:

   * Parses it, extracts images/audio if found as Base64, and writes them into the output folder.
   * Generates an `entity.json` with updated references (pointing to the newly extracted media).
   * Produces an `index.json` in each directory, listing items present (including `downloadURL` for non-JSON files).
   * Handles `.zip` packages exported by the app, automatically unpacking and indexing them.
4. If a `whats-new.json` file exists at the repository root, it is copied to the docs root.
5. The final output folder can then be served or hosted anywhere.

**Usage**:

```bash
node generate-index.js
```

* Ensure you have a valid `config.json` in the same directory.
* After it completes, look in your `targetDir` (e.g. `../CatalogSite/docs`) for the generated site.

### 3. `local-server.js`

A minimal local HTTP server to serve the generated **Docs** folder to test or preview your catalog. 

**Usage**:

```bash
node local-server.js
```

* By default, listens on [http://localhost:3000](http://localhost:3000).
* Serves files directly from `targetDir` as set in `config.json`.
* Any directory requests automatically serve that folder’s `index.json` if it exists.
* Useful for previewing or local testing before deploying the site.

### 4. `whats-new.js`

A lightweight editor for a `whats-new.json` file that describes recent changes.

**Usage**:

```bash
node whats-new.js
```

* Opens an editor at [http://localhost:5000/editor](http://localhost:5000/editor).
* Saves the JSON to your `sourceDir` whenever you hit "Save".

---

## Featured Items

Inside each entity directory (e.g. `Persons/`, `Feeds/`, `SoundSets/`), you can place a subfolder named **`Featured`**. Any **JSON entities** placed *directly* in that `Featured` folder are picked up as "featured" items by Radio Starlight.

Example:

```
SoundSets/
└─ Featured/
   ├─ MyCoolSet.json
   ├─ AnotherFeaturedSet.json
   └─ MySingleFileSoundSet.json
```

Radio Starlight’s catalog browser will list these items as "Featured" in the app, also nested items in subfolders will be shown.

---

## Typical Workflow

1. **Prepare the Repository**

   * Export your JSON entities from Radio Starlight (or create them manually).
   * Place your JSON files and any subfolders into the `sourceDir` (e.g. `CatalogRepository/`).
   * Run `metadata-admin-server.js` to set top-level metadata (like the repository name/description).
2. **Generate the Docs Site**

   * `node generate-index.js`
   * This wipes the old `targetDir` (e.g. `docs/`), then creates a fresh, fully indexed site.
   * Check the console output for logs about extracted images, audio, etc.
3. **Preview Locally**

   * `node local-server.js`
   * Add your catalog URL in Radio Starlight to point to the local server.
   * Open Radio Starlight and browse your catalog.
4. **Publish**

   * Once satisfied, you can deploy the `targetDir` (e.g. `docs/`) to any static hosting service (like GitHub Pages, Netlify, etc.).

---

**Enjoy building your Radio Starlight Catalog!** For questions or suggestions, feel free to open an issue or fork this project.
