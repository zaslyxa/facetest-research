const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const manifestPath = path.join(root, "data", "photo-sets.json");
const manifestJsPath = path.join(root, "data", "photo-sets.js");

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exitCode = 1;
}

if (!fs.existsSync(manifestJsPath)) {
  fail("data/photo-sets.js is missing. Local file launch depends on it.");
}

function readManifestFromJs(filePath) {
  try {
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(filePath, "utf8"), sandbox, { filename: filePath });
    return sandbox.window.PHOTO_SET_MANIFEST;
  } catch (error) {
    fail(`Cannot read manifest ${path.relative(root, filePath)}: ${error.message}`);
    return null;
  }
}

const manifest = readManifestFromJs(manifestJsPath);
if (!manifest) process.exit(1);

if (fs.existsSync(manifestPath)) {
  try {
    JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(`Optional JSON manifest is invalid: ${error.message}`);
  }
}

if (!Array.isArray(manifest.sets) || manifest.sets.length === 0) {
  fail("data/photo-sets.json must contain a non-empty sets array.");
}

const setIds = new Set();
const stimulusIds = new Set();

for (const set of manifest.sets || []) {
  if (!set.id) fail("Every set must have an id.");
  if (!set.label) fail(`Set ${set.id || "(without id)"} must have a label.`);
  if (set.id && setIds.has(set.id)) fail(`Duplicate set id: ${set.id}`);
  if (set.id) setIds.add(set.id);

  const stimuli = set.stimuli || set.photos || [];
  if (!Array.isArray(stimuli) || stimuli.length === 0) {
    fail(`Set ${set.id || "(without id)"} must contain at least one stimulus.`);
    continue;
  }

  for (const stimulus of stimuli) {
    if (!stimulus.id) fail(`Stimulus in set ${set.id} is missing id.`);
    if (!stimulus.type) fail(`Stimulus ${stimulus.id || "(without id)"} in set ${set.id} is missing type.`);
    if (!["number", "image"].includes(stimulus.type)) {
      fail(`Stimulus ${stimulus.id || "(without id)"} in set ${set.id} has unsupported type: ${stimulus.type}`);
    }

    const stimulusKey = `${set.id}:${stimulus.id}`;
    if (stimulus.id && stimulusIds.has(stimulusKey)) fail(`Duplicate stimulus id inside ${set.id}: ${stimulus.id}`);
    if (stimulus.id) stimulusIds.add(stimulusKey);

    if (stimulus.type === "number" && stimulus.value === undefined) {
      fail(`Number stimulus ${stimulus.id} in set ${set.id} is missing value.`);
    }

    if (stimulus.type === "image") {
      if (!stimulus.src) {
        fail(`Image stimulus ${stimulus.id} in set ${set.id} is missing src.`);
      } else {
        const stimulusPath = path.join(root, stimulus.src);
        if (!fs.existsSync(stimulusPath)) {
          fail(`Missing file for image stimulus ${stimulus.id}: ${stimulus.src}`);
        }
      }
    }
  }
}

if (manifest.defaultSetId && !setIds.has(manifest.defaultSetId)) {
  fail(`defaultSetId "${manifest.defaultSetId}" does not exist in sets.`);
}

if (process.exitCode) {
  console.error("Project check failed.");
  process.exit(process.exitCode);
}

console.log(`Project check passed: ${setIds.size} sets, ${stimulusIds.size} stimuli.`);
