const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");

const files = [
  "_headers",
  "app.js",
  "config.js",
  "index.html",
  "stage2.html",
  "styles.css"
];

const directories = [
  "assets",
  "data"
];

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

for (const file of files) {
  copyFile(file);
}

for (const directory of directories) {
  copyDirectory(directory);
}

console.log(`Cloudflare Pages build ready: ${path.relative(root, dist)}`);

function copyFile(relativePath) {
  const source = path.join(root, relativePath);
  const target = path.join(dist, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function copyDirectory(relativePath) {
  const source = path.join(root, relativePath);
  const target = path.join(dist, relativePath);
  fs.cpSync(source, target, { recursive: true });
}
