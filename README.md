# Starlight Catalog Service

This repository provides a **catalog service** for \[Radio Starlight], a generative radio station application. It is a self-contained toolset enabling you to organize various entities (such as **SoundSets**, **Programs**, **Persons**, etc.) into a browsable "catalog," which Radio Starlight can access and import.

By following these instructions, you can:
1. Maintain a local "Repository" of entity packages (usually `.zip` archives) along with images and other media files.
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

* **Repository (sourceDir)**: This folder now typically contains zipped entity packages (e.g. `Programs/MyShow.zip`). Each archive bundles an `entity.json` and its media. `generate-index.js` can still read standalone JSON files, but using zip archives is recommended.
* **Docs (targetDir)**: After running `generate-index.js`, a structured site is created, containing:

  * Each zip archive becomes a folder with its final `entity.json` and extracted images.
  * Program archives additionally include `entity+deps.json` with bundled dependencies.
  * Automatically generated `index.json` files allow hierarchical browsing.


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
├─ Programs/
│   ├─ Featured/
│   │   └─ MyShow.zip
│   └─ MyShow.zip
│
├─ Persons/
│   ├─ Featured/
│   │   └─ Announcer.zip
│   └─ Announcer.zip
│
├─ SoundSets/
│   └─ MySet.zip
│
├─ Feeds/
│   └─ MyFeed.zip
│
├─ repo-metadata.json  <-- Optional folder-level metadata
└─ ...
```
> **Note:** The repository can have arbitrary subfolders for organization, and you may place either `.zip` archives or raw JSON files. When using the `Featured` folder, only the items placed **directly** inside `Featured` are listed as featured items; nested subfolders are ignored (though the catalog browser will still show them).

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
3. For each `.zip` archive or standalone JSON entity:

   * Parses it, extracts images/audio if found as Base64, and writes them into the output folder.
   * Generates an `entity.json` with updated references (pointing to the newly extracted media).
   * Produces an `index.json` in each directory, listing items present (including `downloadURL` for non-JSON files).
   * Handles `.zip` packages exported by the app, automatically unpacking them.
     Program archives become folders with their resources and an `entity+deps.json` file, while other entity archives become folders containing `entity.json` and images.
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

Inside each entity directory (e.g. `Persons/`, `Feeds/`, `SoundSets/`), you can place a subfolder named **`Featured`**. Any zipped packages (or JSON files) placed *directly* in that `Featured` folder are picked up as "featured" items by Radio Starlight.

Example:

```
SoundSets/
└─ Featured/
   ├─ MyCoolSet.zip
   ├─ AnotherFeaturedSet.zip
   └─ MySingleFileSoundSet.zip
```

Radio Starlight’s catalog browser will list these items as "Featured" in the app, also nested items in subfolders will be shown.

---

## Typical Workflow

1. **Prepare the Repository**

   * Export your entities as `.zip` packages from Radio Starlight (you can also use raw JSON).
   * Place those archives (or JSON files) into the `sourceDir` (e.g. `CatalogRepository/`).
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
