const DEFAULT_BASE_URL = "https://zaslyxa.github.io/facetest-research";
const DEFAULT_USERS = 10;
const DEFAULT_INITIAL_PHOTOS = 6;
const DEFAULT_CONCURRENCY = 12;
const SET_IDS = ["set-a", "set-b", "set-c"];

const options = parseArgs(process.argv.slice(2));
const baseUrl = normalizeBaseUrl(options.base || DEFAULT_BASE_URL);
const userCount = Number(options.users || DEFAULT_USERS);
const initialPhotos = Number(options.initialPhotos || DEFAULT_INITIAL_PHOTOS);
const concurrency = Number(options.concurrency || DEFAULT_CONCURRENCY);

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

async function main() {
  const warmIndex = await fetchText(`${baseUrl}/index.html?loadtest=${Date.now()}`);
  const pageAssets = parsePageAssets(warmIndex.text);
  const manifestAsset = pageAssets.find((asset) => asset.includes("data/photo-sets.js")) || "data/photo-sets.js";
  const manifestText = await fetchText(toAbsoluteUrl(manifestAsset));
  const manifest = parseWindowAssignment(manifestText.text, "PHOTO_SET_MANIFEST");

  const users = Array.from({ length: userCount }, (_, index) => {
    const setId = SET_IDS[index % SET_IDS.length];
    const set = manifest.sets.find((candidate) => candidate.id === setId);
    if (!set) throw new Error(`Set not found in manifest: ${setId}`);

    const shuffled = seededShuffle(set.stimuli || set.photos || [], 1000 + index);
    const firstPhotos = shuffled
      .filter((stimulus) => stimulus.type === "image")
      .slice(0, initialPhotos)
      .map((stimulus) => stimulus.src);

    return {
      id: index + 1,
      setId,
      firstPhotos
    };
  });

  const tasks = [];
  for (const user of users) {
    const commonAssets = [
      `stage2.html?set=${user.setId}&loadtest=${Date.now()}-${user.id}`,
      `index.html?set=${user.setId}&stage=2&loadtest=${Date.now()}-${user.id}`,
      ...pageAssets
    ];

    for (const asset of commonAssets) {
      tasks.push({ user, kind: "page_asset", url: toAbsoluteUrl(asset) });
    }

    for (const photo of user.firstPhotos) {
      tasks.push({ user, kind: "initial_photo", url: toAbsoluteUrl(photo) });
    }
  }

  const startedAt = Date.now();
  const results = await runLimited(tasks, concurrency, (task) => fetchBytes(task.url, task));
  const elapsedMs = Date.now() - startedAt;

  const failed = results.filter((result) => !result.ok);
  const bytesByKind = sumBy(results.filter((result) => result.ok), "kind", "bytes");
  const totalBytes = sum(results.filter((result) => result.ok).map((result) => result.bytes));
  const responseTimes = results.filter((result) => result.ok).map((result) => result.ms).sort((a, b) => a - b);
  const fullPhotoBytesBySet = Object.fromEntries(
    manifest.sets.map((set) => [
      set.id,
      sum((set.stimuli || set.photos || []).map((stimulus) => stimulus.bytes || 0))
    ])
  );
  const estimatedFullPhotoBytes = sum(users.map((user) => fullPhotoBytesBySet[user.setId] || 0));

  const report = {
    baseUrl,
    users: userCount,
    simulatedLocale: "ru-RU",
    concurrency,
    initialPhotosPerUser: initialPhotos,
    elapsedMs,
    requests: results.length,
    failedRequests: failed.length,
    bytesDownloaded: totalBytes,
    bytesDownloadedMb: toMb(totalBytes),
    bytesByKindMb: Object.fromEntries(
      Object.entries(bytesByKind).map(([kind, bytes]) => [kind, toMb(bytes)])
    ),
    estimatedFullPhotoTrafficMb: toMb(estimatedFullPhotoBytes),
    responseTimeMs: {
      p50: percentile(responseTimes, 0.5),
      p95: percentile(responseTimes, 0.95),
      max: responseTimes[responseTimes.length - 1] || 0
    },
    usersBySet: Object.fromEntries(
      SET_IDS.map((setId) => [setId, users.filter((user) => user.setId === setId).length])
    )
  };

  console.log(JSON.stringify(report, null, 2));
  if (failed.length) {
    console.error("Failed requests:");
    failed.slice(0, 20).forEach((failure) => {
      console.error(`${failure.status || "ERR"} ${failure.kind} ${failure.url} ${failure.error || ""}`);
    });
    process.exitCode = 1;
  }
}

function parseArgs(args) {
  return Object.fromEntries(
    args.map((arg) => {
      const [key, value = "true"] = arg.replace(/^--/, "").split("=");
      return [key, value];
    })
  );
}

function normalizeBaseUrl(url) {
  return url.replace(/\/$/, "");
}

function toAbsoluteUrl(pathOrUrl) {
  return new URL(pathOrUrl, `${baseUrl}/`).href;
}

function parsePageAssets(html) {
  const assets = [];
  for (const match of html.matchAll(/<(?:script|link)\b[^>]+(?:src|href)="([^"]+)"/g)) {
    const asset = match[1];
    if (!asset.startsWith("http") && !asset.startsWith("//")) assets.push(asset);
  }
  return assets;
}

function parseWindowAssignment(source, propertyName) {
  const prefix = `window.${propertyName} = `;
  const start = source.indexOf(prefix);
  if (start === -1) throw new Error(`Cannot find ${propertyName} assignment.`);
  return JSON.parse(source.slice(start + prefix.length));
}

function seededShuffle(items, seed) {
  const result = [...items];
  const random = mulberry32(seed);
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function mulberry32(seed) {
  return function random() {
    let value = seed += 0x6D2B79F5;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

async function runLimited(items, limit, worker) {
  const results = [];
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

async function fetchText(url) {
  const result = await fetchBytes(url, { kind: "text" });
  if (!result.ok) throw new Error(`Cannot fetch ${url}: ${result.status || result.error}`);
  return {
    ...result,
    text: Buffer.from(result.buffer).toString("utf8")
  };
}

async function fetchBytes(url, task = {}) {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      headers: {
        "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.7",
        "Cache-Control": "no-cache"
      }
    });
    const buffer = await response.arrayBuffer();
    return {
      ok: response.ok,
      status: response.status,
      url,
      kind: task.kind || "unknown",
      user: task.user?.id,
      setId: task.user?.setId,
      bytes: buffer.byteLength,
      buffer,
      ms: Date.now() - startedAt
    };
  } catch (error) {
    return {
      ok: false,
      url,
      kind: task.kind || "unknown",
      user: task.user?.id,
      setId: task.user?.setId,
      bytes: 0,
      ms: Date.now() - startedAt,
      error: error.message
    };
  }
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function sumBy(items, keyProperty, valueProperty) {
  return items.reduce((totals, item) => {
    totals[item[keyProperty]] = (totals[item[keyProperty]] || 0) + item[valueProperty];
    return totals;
  }, {});
}

function percentile(sortedValues, ratio) {
  if (!sortedValues.length) return 0;
  const index = Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * ratio) - 1);
  return sortedValues[index];
}

function toMb(bytes) {
  return Math.round(bytes / 1024 / 1024 * 100) / 100;
}
