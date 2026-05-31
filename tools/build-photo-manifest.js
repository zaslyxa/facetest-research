const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const assetsRoot = path.join(root, "assets", "photos");
const outputJsPath = path.join(root, "data", "photo-sets.js");
const outputJsonPath = path.join(root, "data", "photo-sets.json");
const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);

const setDefinitions = [
  { id: "set-a", label: "\u0413\u0440\u0443\u043f\u043f\u0430 1", directory: "set-a", prefix: "a" },
  { id: "set-b", label: "\u0413\u0440\u0443\u043f\u043f\u0430 2", directory: "set-b", prefix: "b" },
  { id: "set-c", label: "\u0413\u0440\u0443\u043f\u043f\u0430 3", directory: "set-c", prefix: "c" }
];

function naturalCompare(left, right) {
  return left.localeCompare(right, "en", { numeric: true, sensitivity: "base" });
}

function escapeNonAscii(text) {
  return text.replace(/[^\x00-\x7f]/g, (character) => (
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  ));
}

function buildSet(definition) {
  const directoryPath = path.join(assetsRoot, definition.directory);
  const fileNames = fs.readdirSync(directoryPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && imageExtensions.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort(naturalCompare);

  if (fileNames.length === 0) {
    throw new Error(`No web images found in assets/photos/${definition.directory}.`);
  }

  return {
    id: definition.id,
    label: definition.label,
    stimuli: fileNames.map((fileName) => ({
      id: `${definition.prefix}-${path.parse(fileName).name}`,
      type: "image",
      src: path.posix.join("assets", "photos", definition.directory, fileName)
    }))
  };
}

const manifest = {
  defaultSetId: "set-a",
  sets: setDefinitions.map(buildSet)
};

const json = escapeNonAscii(`${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(outputJsonPath, json, "utf8");
fs.writeFileSync(outputJsPath, `window.PHOTO_SET_MANIFEST = ${json}`, "utf8");

const counts = manifest.sets.map((set) => `${set.id}: ${set.stimuli.length}`).join(", ");
console.log(`Photo manifest generated (${counts}).`);
