const DEFAULT_CONFIG = {
  supabaseUrl: "",
  supabaseAnonKey: "",
  supabaseTable: "experiment_responses",
  stimulusDurationMs: 3000,
  openQuestion: "Что именно вы запомнили о человеке?",
  requireDesktop: true,
  minimumViewportWidth: 760,
  minimumViewportHeight: 520,
  allowSetChoiceWhenMissingUrl: true,
  showDebugDownload: false
};

const config = { ...DEFAULT_CONFIG, ...(window.EXPERIMENT_CONFIG || {}) };
const query = new URLSearchParams(window.location.search);
const forcedSetId = query.get("set");
const debugMode = query.get("debug") === "1" || config.showDebugDownload;

const state = {
  photoSets: [],
  selectedSet: null,
  participant: null,
  trials: [],
  trialIndex: -1,
  rows: [],
  phase: "setup",
  currentTrial: null,
  currentRow: null,
  stimulusStartedAt: 0,
  stimulusStartedIso: "",
  stimulusTimerId: null,
  countdownTimerId: null,
  sessionId: createId()
};

const els = {
  unsupportedView: document.getElementById("unsupportedView"),
  unsupportedMessage: document.getElementById("unsupportedMessage"),
  setupView: document.getElementById("setupView"),
  readyView: document.getElementById("readyView"),
  experimentView: document.getElementById("experimentView"),
  questionView: document.getElementById("questionView"),
  finishView: document.getElementById("finishView"),
  participantForm: document.getElementById("participantForm"),
  setField: document.getElementById("setField"),
  photoSetSelect: document.getElementById("photoSetSelect"),
  setupError: document.getElementById("setupError"),
  readyGroup: document.getElementById("readyGroup"),
  durationLabel: document.getElementById("durationLabel"),
  loadStatus: document.getElementById("loadStatus"),
  beginButton: document.getElementById("beginButton"),
  experimentSet: document.getElementById("experimentSet"),
  progressText: document.getElementById("progressText"),
  progressFill: document.getElementById("progressFill"),
  timerText: document.getElementById("timerText"),
  stimulusImage: document.getElementById("stimulusImage"),
  numberStimulus: document.getElementById("numberStimulus"),
  stimulusCaption: document.getElementById("stimulusCaption"),
  responseButtons: Array.from(document.querySelectorAll("[data-answer]")),
  questionTitle: document.getElementById("questionTitle"),
  questionPhotoId: document.getElementById("questionPhotoId"),
  memoryForm: document.getElementById("memoryForm"),
  memoryText: document.getElementById("memoryText"),
  finishSummary: document.getElementById("finishSummary"),
  saveStatus: document.getElementById("saveStatus"),
  downloadCsvButton: document.getElementById("downloadCsvButton")
};

init();

async function init() {
  bindEvents();
  els.durationLabel.textContent = formatDuration(config.stimulusDurationMs);

  const deviceCheck = getDeviceCheck();
  if (!deviceCheck.ok) {
    els.unsupportedMessage.textContent = deviceCheck.message;
    showView("unsupported");
    return;
  }

  try {
    const manifest = await loadPhotoManifest();
    state.photoSets = manifest.sets || [];
    validateManifest(state.photoSets);
    renderSetOptions(manifest.defaultSetId);
  } catch (error) {
    els.setupError.textContent = error.message;
    els.participantForm.querySelector("button").disabled = true;
  }
}

function bindEvents() {
  els.participantForm.addEventListener("submit", handleParticipantSubmit);
  els.beginButton.addEventListener("click", beginExperiment);
  els.memoryForm.addEventListener("submit", handleMemorySubmit);
  els.downloadCsvButton.addEventListener("click", downloadCsv);

  els.responseButtons.forEach((button) => {
    button.addEventListener("click", () => handleRecognition(button.dataset.answer));
  });

  window.addEventListener("keydown", (event) => {
    if (state.phase !== "stimulus" || event.repeat) return;

    const answer = event.key.toLowerCase();
    if (answer === "y") handleRecognition("Y");
    if (answer === "n") handleRecognition("N");
  });
}

async function loadPhotoManifest() {
  if (window.PHOTO_SET_MANIFEST) {
    return window.PHOTO_SET_MANIFEST;
  }

  const response = await fetch("data/photo-sets.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error("Не удалось загрузить список стимулов data/photo-sets.json.");
  }
  return response.json();
}

function validateManifest(sets) {
  if (!Array.isArray(sets) || sets.length === 0) {
    throw new Error("В манифесте нет наборов стимулов.");
  }

  sets.forEach((set) => {
    const stimuli = getSetStimuli(set);
    if (!set.id || !set.label || stimuli.length === 0) {
      throw new Error("Каждый набор должен иметь id, label и непустой массив stimuli.");
    }

    stimuli.forEach((stimulus) => {
      if (!stimulus.id || !stimulus.type) {
        throw new Error(`В наборе ${set.id} есть стимул без id или type.`);
      }

      if (stimulus.type === "image" && !stimulus.src) {
        throw new Error(`В наборе ${set.id} есть изображение без src.`);
      }

      if (stimulus.type === "number" && stimulus.value === undefined) {
        throw new Error(`В наборе ${set.id} есть числовой стимул без value.`);
      }

      if (!["image", "number"].includes(stimulus.type)) {
        throw new Error(`Тип стимула "${stimulus.type}" в наборе ${set.id} не поддерживается.`);
      }
    });
  });
}

function renderSetOptions(defaultSetId) {
  const selectedId = forcedSetId || defaultSetId || state.photoSets[0].id;
  const forcedSet = forcedSetId ? state.photoSets.find((set) => set.id === forcedSetId) : null;

  if (forcedSetId && !forcedSet) {
    els.setupError.textContent = `Набор "${forcedSetId}" не найден в data/photo-sets.json.`;
    els.participantForm.querySelector("button").disabled = true;
    return;
  }

  els.photoSetSelect.innerHTML = "";
  state.photoSets.forEach((set) => {
    const option = document.createElement("option");
    option.value = set.id;
    option.textContent = set.label;
    option.selected = set.id === selectedId;
    els.photoSetSelect.append(option);
  });

  if (forcedSetId || !config.allowSetChoiceWhenMissingUrl) {
    els.setField.classList.add("hidden");
    els.photoSetSelect.required = false;
  }
}

function handleParticipantSubmit(event) {
  event.preventDefault();
  els.setupError.textContent = "";

  const formData = new FormData(els.participantForm);
  const photoSetId = forcedSetId || formData.get("photoSetId") || els.photoSetSelect.value;
  const selectedSet = state.photoSets.find((set) => set.id === photoSetId);

  if (!selectedSet) {
    els.setupError.textContent = "Выберите корректную группу стимулов.";
    return;
  }

  const age = Number(formData.get("age"));
  if (!Number.isInteger(age) || age < 1 || age > 120) {
    els.setupError.textContent = "Укажите возраст числом от 1 до 120.";
    return;
  }

  state.participant = {
    id: createId(),
    name: String(formData.get("name")).trim(),
    age,
    gender: String(formData.get("gender"))
  };

  state.selectedSet = selectedSet;
  state.trials = shuffle(getSetStimuli(selectedSet)).map((stimulus, index) => ({
    ...stimulus,
    order: index + 1
  }));

  els.readyGroup.textContent = selectedSet.label;
  showView("ready");
}

async function beginExperiment() {
  els.beginButton.disabled = true;
  els.loadStatus.textContent = "Подготавливаем стимулы...";

  try {
    await preloadImages(state.trials.filter((trial) => trial.type === "image").map((trial) => trial.src));
  } catch (error) {
    els.loadStatus.textContent = error.message;
    els.beginButton.disabled = false;
    return;
  }

  els.loadStatus.textContent = "Стимулы готовы.";
  state.trialIndex = -1;
  showNextTrial();
}

function preloadImages(srcList) {
  return Promise.all(
    srcList.map((src) => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = resolve;
      image.onerror = () => reject(new Error(`Не удалось загрузить изображение: ${src}`));
      image.src = src;
    }))
  );
}

function showNextTrial() {
  state.trialIndex += 1;

  if (state.trialIndex >= state.trials.length) {
    finishExperiment();
    return;
  }

  const trial = state.trials[state.trialIndex];
  state.currentTrial = trial;
  state.currentRow = null;
  state.phase = "stimulus";

  const total = state.trials.length;
  els.experimentSet.textContent = state.selectedSet.label;
  els.progressText.textContent = `Стимул ${state.trialIndex + 1} из ${total}`;
  els.progressFill.style.width = `${(state.trialIndex / total) * 100}%`;
  els.stimulusCaption.textContent = "Ответьте Y или N";
  renderStimulus(trial);

  showView("experiment");

  requestAnimationFrame(() => {
    state.stimulusStartedAt = performance.now();
    state.stimulusStartedIso = new Date().toISOString();
    startCountdown();
    state.stimulusTimerId = window.setTimeout(() => handleNoResponse(), config.stimulusDurationMs);
  });
}

function startCountdown() {
  clearInterval(state.countdownTimerId);
  const duration = config.stimulusDurationMs;

  const update = () => {
    const elapsed = performance.now() - state.stimulusStartedAt;
    const remainingMs = Math.max(0, duration - elapsed);
    els.timerText.textContent = (remainingMs / 1000).toFixed(1);
  };

  update();
  state.countdownTimerId = window.setInterval(update, 100);
}

function handleRecognition(answer) {
  if (state.phase !== "stimulus") return;

  state.phase = answer === "Y" ? "question" : "between";
  const reactionTimeMs = Math.round(performance.now() - state.stimulusStartedAt);
  clearStimulusTimers();
  setResponseButtonsEnabled(false);

  const row = buildRow({
    answer,
    recognized: answer === "Y",
    memoryText: "",
    reactionTimeMs
  });

  if (answer === "Y") {
    state.currentRow = row;
    els.questionTitle.textContent = config.openQuestion;
    els.questionPhotoId.textContent = `Стимул: ${state.currentTrial.id}`;
    els.memoryText.value = "";
    showView("question");
    requestAnimationFrame(() => els.memoryText.focus());
    return;
  }

  state.rows.push(row);
  setResponseButtonsEnabled(true);
  showNextTrial();
}

function handleNoResponse() {
  if (state.phase !== "stimulus") return;

  state.phase = "between";
  clearStimulusTimers();
  setResponseButtonsEnabled(false);

  state.rows.push(buildRow({
    answer: "NO_RESPONSE",
    recognized: null,
    memoryText: "",
    reactionTimeMs: null
  }));

  window.setTimeout(() => {
    setResponseButtonsEnabled(true);
    showNextTrial();
  }, 180);
}

function handleMemorySubmit(event) {
  event.preventDefault();

  if (!state.currentRow) return;

  state.currentRow.memoryText = els.memoryText.value.trim();
  state.rows.push(state.currentRow);
  state.currentRow = null;
  setResponseButtonsEnabled(true);
  showNextTrial();
}

function buildRow({ answer, recognized, memoryText, reactionTimeMs }) {
  const trial = state.currentTrial;
  const participant = state.participant;

  return {
    session_id: state.sessionId,
    participant_id: participant.id,
    participant_name: participant.name,
    participant_age: participant.age,
    participant_gender: participant.gender,
    screen_width: window.screen.width,
    screen_height: window.screen.height,
    viewport_width: window.innerWidth,
    viewport_height: window.innerHeight,
    device_pixel_ratio: window.devicePixelRatio || 1,
    stimulus_set_id: state.selectedSet.id,
    stimulus_id: trial.id,
    stimulus_order: trial.order,
    stimulus_type: trial.type,
    stimulus_value: trial.value === undefined ? "" : String(trial.value),
    answer,
    recognized,
    memory_text: memoryText,
    reaction_time_ms: reactionTimeMs,
    shown_at: state.stimulusStartedIso,
    user_agent: navigator.userAgent
  };
}

async function finishExperiment() {
  clearStimulusTimers();
  state.phase = "finish";
  els.progressFill.style.width = "100%";
  els.finishSummary.textContent = `Записано ответов: ${state.rows.length}. ID сессии: ${state.sessionId}.`;
  els.saveStatus.textContent = "Сохраняем результаты...";
  els.downloadCsvButton.classList.toggle("hidden", !debugMode);
  showView("finish");

  const result = await saveToSupabase(state.rows);
  if (result.ok) {
    els.saveStatus.textContent = "Результаты сохранены.";
    return;
  }

  queueFailedSubmission(state.rows);
  els.saveStatus.textContent = result.message;
}

async function saveToSupabase(rows) {
  const hasConfig = config.supabaseUrl && config.supabaseAnonKey;
  if (!hasConfig) {
    return {
      ok: false,
      message: "Supabase пока не настроен. Для локальной проверки откройте страницу с ?debug=1 и скачайте CSV."
    };
  }

  const endpoint = `${config.supabaseUrl.replace(/\/$/, "")}/rest/v1/${config.supabaseTable}`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        apikey: config.supabaseAnonKey,
        Authorization: `Bearer ${config.supabaseAnonKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify(rows)
    });

    if (!response.ok) {
      const message = await response.text();
      return {
        ok: false,
        message: `Не удалось сохранить результаты в Supabase: ${message || response.status}.`
      };
    }

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: `Нет соединения с базой. Результаты временно сохранены в браузере: ${error.message}`
    };
  }
}

function queueFailedSubmission(rows) {
  try {
    const key = "facetest_failed_submissions";
    const current = JSON.parse(localStorage.getItem(key) || "[]");
    current.push({
      savedAt: new Date().toISOString(),
      rows
    });
    localStorage.setItem(key, JSON.stringify(current));
  } catch {
    // Local storage can be disabled in private browsing modes.
  }
}

function downloadCsv() {
  const headers = [
    "session_id",
    "participant_id",
    "participant_name",
    "participant_age",
    "participant_gender",
    "screen_width",
    "screen_height",
    "viewport_width",
    "viewport_height",
    "device_pixel_ratio",
    "stimulus_set_id",
    "stimulus_order",
    "stimulus_id",
    "stimulus_type",
    "stimulus_value",
    "answer",
    "recognized",
    "memory_text",
    "reaction_time_ms",
    "shown_at",
    "user_agent"
  ];

  const lines = [
    headers.join(","),
    ...state.rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))
  ];

  const blob = new Blob([`\ufeff${lines.join("\n")}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `facetest-${state.sessionId}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  return `"${String(value).replaceAll('"', '""')}"`;
}

function showView(viewName) {
  const map = {
    unsupported: els.unsupportedView,
    setup: els.setupView,
    ready: els.readyView,
    experiment: els.experimentView,
    question: els.questionView,
    finish: els.finishView
  };

  Object.values(map).forEach((view) => view.classList.add("hidden"));
  map[viewName].classList.remove("hidden");
}

function clearStimulusTimers() {
  window.clearTimeout(state.stimulusTimerId);
  window.clearInterval(state.countdownTimerId);
  state.stimulusTimerId = null;
  state.countdownTimerId = null;
}

function setResponseButtonsEnabled(enabled) {
  els.responseButtons.forEach((button) => {
    button.disabled = !enabled;
  });
}

function getSetStimuli(set) {
  return set.stimuli || set.photos || [];
}

function renderStimulus(trial) {
  if (trial.type === "image") {
    els.numberStimulus.classList.add("hidden");
    els.stimulusImage.classList.remove("hidden");
    els.stimulusImage.src = trial.src;
    return;
  }

  els.stimulusImage.classList.add("hidden");
  els.stimulusImage.removeAttribute("src");
  els.numberStimulus.classList.remove("hidden");
  els.numberStimulus.textContent = String(trial.value);
}

function getDeviceCheck() {
  if (!config.requireDesktop) return { ok: true };

  const width = window.innerWidth;
  const height = window.innerHeight;
  const ua = navigator.userAgent || "";
  const uaDataMobile = Boolean(navigator.userAgentData?.mobile);
  const mobileOrTabletUa = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Tablet/i.test(ua);
  const iPadDesktopUa = /Macintosh/i.test(ua) && navigator.maxTouchPoints > 1;
  const coarseTouch = window.matchMedia("(pointer: coarse)").matches && navigator.maxTouchPoints > 0;

  if (uaDataMobile || mobileOrTabletUa || iPadDesktopUa || coarseTouch) {
    return {
      ok: false,
      message: "Откройте ссылку на ноутбуке или настольном компьютере. Телефоны и планшеты для этого исследования не допускаются."
    };
  }

  if (width < config.minimumViewportWidth || height < config.minimumViewportHeight) {
    return {
      ok: false,
      message: `Увеличьте окно браузера минимум до ${config.minimumViewportWidth}x${config.minimumViewportHeight}. Сейчас: ${width}x${height}.`
    };
  }

  return { ok: true };
}

function shuffle(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function createId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  if (!window.crypto?.getRandomValues) {
    return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (char) => (
      Number(char) ^ (Math.random() * 16 & (15 >> (Number(char) / 4)))
    ).toString(16));
  }

  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (char) => {
    const random = window.crypto.getRandomValues(new Uint8Array(1))[0];
    return (Number(char) ^ (random & (15 >> (Number(char) / 4)))).toString(16);
  });
}

function formatDuration(milliseconds) {
  const seconds = milliseconds / 1000;
  const formatted = Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1);

  if (formatted.endsWith("1") && formatted !== "11") return `${formatted} секунда`;
  if (["2", "3", "4"].some((digit) => formatted.endsWith(digit)) && !["12", "13", "14"].includes(formatted)) {
    return `${formatted} секунды`;
  }
  return `${formatted} секунд`;
}
