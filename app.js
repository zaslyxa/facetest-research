const DEFAULT_CONFIG = {
  supabaseUrl: "",
  supabaseAnonKey: "",
  supabaseTable: "experiment_responses",
  stimulusDurationMs: 3000,
  requireMinimumViewport: true,
  minimumViewportWidth: 760,
  minimumViewportHeight: 520,
  preloadConcurrency: 3,
  supabaseRequestAttempts: 8,
  supabaseRequestTimeoutMs: 15000,
  allowSetChoiceWhenMissingUrl: true,
  showDebugDownload: false
};

const config = { ...DEFAULT_CONFIG, ...(window.EXPERIMENT_CONFIG || {}) };
const query = new URLSearchParams(window.location.search);
const forcedSetId = query.get("set");
const experimentStage = query.get("stage") === "2" ? "2" : "1";
const skipTextQuestionnaire = experimentStage === "2";
const debugQueryMode = query.get("debug") === "1";
const debugMode = debugQueryMode || config.showDebugDownload;
const ACTIVE_PROGRESS_KEY = skipTextQuestionnaire
  ? "facetest_active_progress_stage2_v1"
  : "facetest_active_progress_v1";
const SETUP_DRAFT_KEY = skipTextQuestionnaire
  ? "facetest_setup_draft_stage2_v1"
  : "facetest_setup_draft_v1";
const PENDING_SUBMISSIONS_KEY = "facetest_pending_submissions_v1";
const LEGACY_FAILED_SUBMISSIONS_KEY = "facetest_failed_submissions";
const BACKGROUND_SYNC_INTERVAL_MS = 30000;
const FINISH_DOWNLOAD_PROMPT = "Скачайте CSV-файл с результатами и отправьте его исследователю.";
const FINISH_DOWNLOAD_DETAILS = skipTextQuestionnaire
  ? "В файле сохранены анкетные данные и результаты фототеста."
  : "В файле сохранены ответы на вопросы анкеты и результаты фототеста.";
const pendingResponseSaves = new Set();
const hasLocalStorage = canUseLocalStorage();
let pendingSubmissionSync = Promise.resolve({ ok: true });

const state = {
  photoSets: [],
  selectedSet: null,
  participant: null,
  trials: [],
  trialIndex: -1,
  rows: [],
  surveySections: [],
  surveyIndex: 0,
  questionnaireAnswers: {},
  phase: "setup",
  currentTrial: null,
  stimulusStartedAt: 0,
  stimulusStartedIso: "",
  stimulusTimerId: null,
  sessionId: createId()
};

const els = {
  unsupportedView: document.getElementById("unsupportedView"),
  unsupportedMessage: document.getElementById("unsupportedMessage"),
  setupView: document.getElementById("setupView"),
  surveyView: document.getElementById("surveyView"),
  readyView: document.getElementById("readyView"),
  experimentView: document.getElementById("experimentView"),
  finishView: document.getElementById("finishView"),
  finishTitle: document.getElementById("finishTitle"),
  participantForm: document.getElementById("participantForm"),
  setField: document.getElementById("setField"),
  photoSetSelect: document.getElementById("photoSetSelect"),
  setupError: document.getElementById("setupError"),
  surveyForm: document.getElementById("surveyForm"),
  surveyProgress: document.getElementById("surveyProgress"),
  surveyCounter: document.getElementById("surveyCounter"),
  surveySectionTitle: document.getElementById("surveySectionTitle"),
  surveyDescription: document.getElementById("surveyDescription"),
  surveyOptions: document.getElementById("surveyOptions"),
  surveyError: document.getElementById("surveyError"),
  surveyBackButton: document.getElementById("surveyBackButton"),
  surveyNextButton: document.getElementById("surveyNextButton"),
  readyGroup: document.getElementById("readyGroup"),
  durationLabel: document.getElementById("durationLabel"),
  loadStatus: document.getElementById("loadStatus"),
  beginButton: document.getElementById("beginButton"),
  responseHint: document.getElementById("responseHint"),
  stimulusImage: document.getElementById("stimulusImage"),
  numberStimulus: document.getElementById("numberStimulus"),
  finishSummary: document.getElementById("finishSummary"),
  saveStatus: document.getElementById("saveStatus"),
  downloadCsvButton: document.getElementById("downloadCsvButton")
};

init();

async function init() {
  bindEvents();
  startPendingSubmissionSync();
  els.durationLabel.textContent = formatDuration(config.stimulusDurationMs);
  if (!hasLocalStorage) {
    els.setupError.textContent = "Браузер запретил локальное сохранение. Не обновляйте страницу: после перезагрузки продолжить тест с того же места не получится.";
  }

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
    restoreSetupDraft();
    restoreProgress();
  } catch (error) {
    els.setupError.textContent = error.message;
    els.participantForm.querySelector("button").disabled = true;
  }
}

function bindEvents() {
  els.participantForm.addEventListener("submit", handleParticipantSubmit);
  els.participantForm.addEventListener("input", saveSetupDraft);
  els.participantForm.addEventListener("change", saveSetupDraft);
  els.surveyForm.addEventListener("submit", handleSurveySubmit);
  els.surveyForm.addEventListener("change", () => {
    if (state.phase !== "survey") return;
    rememberSurveyAnswers(state.surveySections[state.surveyIndex], new FormData(els.surveyForm));
    saveProgress();
  });
  els.surveyBackButton.addEventListener("click", handleSurveyBack);
  els.beginButton.addEventListener("click", beginExperiment);
  els.downloadCsvButton.addEventListener("click", handleCsvDownload);
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-reset-progress]");
    if (!button) return;
    if (!window.confirm("Начать тест заново? Сохраненный прогресс этой попытки будет удален.")) return;
    clearProgress();
    clearSetupDraft();
    window.location.reload();
  });
  window.addEventListener("keydown", (event) => {
    if (!["stimulus", "waiting_response"].includes(state.phase) || event.repeat) return;

    const answer = getKeyboardAnswer(event);
    if (!answer) return;

    event.preventDefault();
    handleRecognition(answer);
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

  const identifier = String(formData.get("identifier")).trim();
  const institution = String(formData.get("institution")).trim();
  if (!identifier || !institution) {
    els.setupError.textContent = "Заполните ID и вуз/факультет.";
    return;
  }

  state.participant = {
    id: createId(),
    identifier,
    age,
    gender: String(formData.get("gender")),
    institution
  };

  state.selectedSet = selectedSet;
  state.trials = shuffle(getSetStimuli(selectedSet)).map((stimulus, index) => ({
    ...stimulus,
    order: index + 1
  }));

  state.surveySections = skipTextQuestionnaire ? [] : getSurveySections();
  state.surveyIndex = 0;
  state.questionnaireAnswers = getInitialQuestionnaireAnswers();
  state.phase = "survey";
  clearSetupDraft();

  if (skipTextQuestionnaire) {
    queueSessionForCurrentState();
    showReadyView();
    return;
  }

  saveProgress();
  renderSurveySection();
  showView("survey");
}

async function handleSurveySubmit(event) {
  event.preventDefault();
  els.surveyError.textContent = "";

  const section = state.surveySections[state.surveyIndex];
  const formData = new FormData(els.surveyForm);
  const missingQuestion = section.questions.find((question) => !formData.get(question.id));

  if (missingQuestion) {
    els.surveyError.textContent = "Ответьте на все вопросы на этой странице.";
    document.getElementById(`survey-${missingQuestion.id}`)?.scrollIntoView({ block: "center" });
    return;
  }

  rememberSurveyAnswers(section, formData);

  if (state.surveyIndex < state.surveySections.length - 1) {
    state.surveyIndex += 1;
    saveProgress();
    renderSurveySection();
    window.scrollTo({ top: 0 });
    return;
  }

  els.surveyNextButton.disabled = true;
  els.surveyBackButton.disabled = true;
  saveProgress();

  queueSessionForCurrentState();
  showReadyView();
}

function handleSurveyBack() {
  if (state.surveyIndex === 0) return;

  rememberSurveyAnswers(state.surveySections[state.surveyIndex], new FormData(els.surveyForm));
  state.surveyIndex -= 1;
  saveProgress();
  els.surveyError.textContent = "";
  renderSurveySection();
  window.scrollTo({ top: 0 });
}

function rememberSurveyAnswers(section, formData) {
  section.questions.forEach((question) => {
    const answer = formData.get(question.id);
    if (answer) state.questionnaireAnswers[question.id] = answer;
  });
}

function getSurveySections() {
  const questionnaire = window.PRETEST_QUESTIONNAIRE;
  if (!questionnaire?.sections?.length) {
    throw new Error("Не удалось загрузить предтестовый опросник.");
  }

  return questionnaire.sections;
}

function getInitialQuestionnaireAnswers() {
  if (!skipTextQuestionnaire) return {};

  return {
    _experiment_stage: experimentStage,
    _text_questionnaire_skipped: "true"
  };
}

function queueSessionForCurrentState() {
  const session = buildSessionRow();
  queuePendingSubmission({ session });
  saveSessionInBackground(session);
}

function showReadyView() {
  els.readyGroup.textContent = state.selectedSet.label;
  state.phase = "ready";
  saveProgress();
  showView("ready");
}

function renderSurveySection() {
  const section = state.surveySections[state.surveyIndex];
  els.surveyProgress.textContent = "Опрос перед тестом";
  els.surveyCounter.textContent = `${state.surveyIndex + 1} / ${state.surveySections.length}`;
  els.surveySectionTitle.textContent = section.title;
  els.surveyDescription.textContent = section.description;
  els.surveyOptions.innerHTML = "";
  els.surveyBackButton.disabled = state.surveyIndex === 0;
  els.surveyNextButton.disabled = false;
  els.surveyNextButton.textContent = state.surveyIndex === state.surveySections.length - 1
    ? "Завершить опрос"
    : "Далее";

  section.questions.forEach((question, questionIndex) => {
    const fieldset = document.createElement("fieldset");
    fieldset.className = "survey-question";
    fieldset.id = `survey-${question.id}`;

    const legend = document.createElement("legend");
    legend.textContent = `${questionIndex + 1}. ${getQuestionText(question)}`;

    const options = document.createElement("div");
    options.className = "survey-option-grid";
    section.options.forEach((option) => {
      const label = document.createElement("label");
      label.className = "survey-option";

      const input = document.createElement("input");
      input.type = "radio";
      input.name = question.id;
      input.value = option.value;
      input.checked = option.value === state.questionnaireAnswers[question.id];

      const text = document.createElement("span");
      text.textContent = option.label;

      label.append(input, text);
      options.append(label);
    });

    fieldset.append(legend, options);
    els.surveyOptions.append(fieldset);
  });
}

function getQuestionText(question) {
  if (typeof question.text === "string") return question.text;
  return state.participant.gender === "female" ? question.text.female : question.text.male;
}

async function beginExperiment() {
  els.beginButton.disabled = true;
  els.loadStatus.textContent = "Подготавливаем стимулы...";

  try {
    await preloadImages(
      state.trials.slice(state.rows.length).filter((trial) => trial.type === "image").map((trial) => trial.src),
      (loaded, total) => {
        els.loadStatus.textContent = `Подготавливаем стимулы: ${loaded} из ${total}...`;
      }
    );
  } catch (error) {
    els.loadStatus.textContent = error.message;
    els.beginButton.disabled = false;
    return;
  }

  els.loadStatus.textContent = "Стимулы готовы.";
  state.trialIndex = state.rows.length - 1;
  showNextTrial();
}

async function preloadImages(srcList, onProgress) {
  const queue = [...srcList];
  const total = queue.length;
  let loaded = 0;

  onProgress?.(loaded, total);

  async function worker() {
    while (queue.length > 0) {
      const src = queue.shift();
      await loadImageWithRetry(src);
      loaded += 1;
      onProgress?.(loaded, total);
    }
  }

  const concurrency = Math.max(1, Math.min(config.preloadConcurrency, total));
  await Promise.all(Array.from({ length: concurrency }, worker));
}

async function loadImageWithRetry(src, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await loadImage(src);
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
      await wait(500 * attempt + Math.random() * 500);
    }
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = resolve;
    image.onerror = () => reject(new Error(`Не удалось загрузить изображение: ${src}`));
    image.src = src;
  });
}

function wait(durationMs) {
  return new Promise((resolve) => window.setTimeout(resolve, durationMs));
}

function showNextTrial() {
  state.trialIndex += 1;

  if (state.trialIndex >= state.trials.length) {
    finishExperiment();
    return;
  }

  const trial = state.trials[state.trialIndex];
  state.currentTrial = trial;
  state.phase = "stimulus";

  renderStimulus(trial);

  showView("experiment");

  requestAnimationFrame(() => {
    state.stimulusStartedAt = performance.now();
    state.stimulusStartedIso = new Date().toISOString();
    state.stimulusTimerId = window.setTimeout(() => hideStimulusAndWait(), config.stimulusDurationMs);
  });
}

function handleRecognition(answer) {
  if (!["stimulus", "waiting_response"].includes(state.phase)) return;

  state.phase = "between";
  const reactionTimeMs = Math.round(performance.now() - state.stimulusStartedAt);
  clearStimulusTimers();
  clearStimulusDisplay();

  const row = buildRow({
    answer,
    recognized: answer === "Y",
    reactionTimeMs
  });

  state.rows.push(row);
  saveProgress();
  queuePendingSubmission({ rows: [row] });
  saveResponseInBackground(row);
  showNextTrial();
}

function hideStimulusAndWait() {
  if (state.phase !== "stimulus") return;

  state.phase = "waiting_response";
  clearStimulusTimers();
  clearStimulusDisplay();
}

function buildRow({ answer, recognized, reactionTimeMs }) {
  const trial = state.currentTrial;
  const participant = state.participant;

  return {
    id: createResponseId(state.sessionId, trial.order),
    session_id: state.sessionId,
    participant_id: participant.id,
    participant_name: participant.identifier,
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
    reaction_time_ms: reactionTimeMs,
    shown_at: state.stimulusStartedIso,
    user_agent: navigator.userAgent
  };
}

async function finishExperiment() {
  clearStimulusTimers();
  state.phase = "finish";
  saveProgress();
  showCsvDownloadPrompt();
  setSaveStatus("Сохраняем результаты...");
  showView("finish");

  const session = buildSessionRow();
  const queuedLocally = queuePendingSubmission({ session, rows: state.rows });
  await Promise.allSettled([...pendingResponseSaves]);
  const result = queuedLocally
    ? await syncPendingSubmissions({
      onlySessionId: state.sessionId,
      requestAttempts: config.supabaseRequestAttempts,
      updateStatus: true
    })
    : await saveCurrentSubmissionToSupabase(session);
  if (result.ok) {
    setSaveStatus("Результаты сохранены.");
    clearProgress();
    return;
  }

  setSaveStatus(result.message);
  showCsvDownloadPrompt();
}

function showCsvDownloadPrompt() {
  els.finishTitle.textContent = "Скачайте CSV-файл";
  els.finishSummary.textContent = `${FINISH_DOWNLOAD_PROMPT} ${FINISH_DOWNLOAD_DETAILS}`;
  els.downloadCsvButton.textContent = "Скачать CSV";
  els.downloadCsvButton.classList.remove("hidden");
}

function handleCsvDownload() {
  downloadCsv();
  els.finishTitle.textContent = "Спасибо за участие";
  els.finishSummary.textContent = "CSV-файл скачан. Его можно отправить исследователю.";
  els.downloadCsvButton.textContent = "Скачать CSV ещё раз";
  clearProgress();
}

function setSaveStatus(message) {
  els.saveStatus.textContent = message;
}

function buildSessionRow() {
  const participant = state.participant;
  return {
    session_id: state.sessionId,
    participant_id: participant.id,
    participant_identifier: participant.identifier,
    participant_age: participant.age,
    participant_gender: participant.gender,
    institution: participant.institution,
    screen_width: window.screen.width,
    screen_height: window.screen.height,
    viewport_width: window.innerWidth,
    viewport_height: window.innerHeight,
    device_pixel_ratio: window.devicePixelRatio || 1,
    stimulus_set_id: state.selectedSet.id,
    questionnaire_answers: getSessionQuestionnaireAnswers(),
    user_agent: navigator.userAgent
  };
}

function getSessionQuestionnaireAnswers() {
  if (!skipTextQuestionnaire) return state.questionnaireAnswers;
  return {
    ...getInitialQuestionnaireAnswers(),
    ...state.questionnaireAnswers
  };
}

function saveSessionInBackground(session) {
  const request = saveSessionToSupabase(session, { requestAttempts: 1 });
  pendingResponseSaves.add(request);
  request
    .then((result) => {
      if (result.ok) clearPendingSession(session.session_id);
    })
    .finally(() => pendingResponseSaves.delete(request));
}

async function saveSessionToSupabase(row, { requestAttempts = config.supabaseRequestAttempts, onRetry } = {}) {
  const hasConfig = config.supabaseUrl && config.supabaseAnonKey;
  if (!hasConfig) {
    return {
      ok: false,
      message: "Supabase пока не настроен. Невозможно сохранить опросник."
    };
  }

  const endpoint = `${config.supabaseUrl.replace(/\/$/, "")}/rest/v1/experiment_sessions`;
  try {
    const response = await fetchWithRetry(endpoint, {
      method: "POST",
      headers: buildSupabaseHeaders(),
      body: JSON.stringify(row)
    }, onRetry, requestAttempts);

    if (!response.ok) {
      const message = await response.text();
      if (isDuplicateSessionError(message)) {
        return { ok: true };
      }

      return {
        ok: false,
        message: `Не удалось сохранить опросник в Supabase: ${message || response.status}.`
      };
    }

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: `Нет соединения с базой. Попробуйте ещё раз: ${error.message}`
    };
  }
}

function isDuplicateSessionError(message) {
  try {
    const error = JSON.parse(message);
    return error.code === "23505" && error.message?.includes("experiment_sessions_pkey");
  } catch {
    return false;
  }
}

function saveResponseInBackground(row) {
  const request = saveToSupabase([row], { requestAttempts: 1 });
  pendingResponseSaves.add(request);
  request
    .then((result) => {
      if (result.ok) clearPendingRows(row.session_id, [row]);
    })
    .finally(() => pendingResponseSaves.delete(request));
}

async function saveToSupabase(rows, { requestAttempts = config.supabaseRequestAttempts, onRetry } = {}) {
  const hasConfig = config.supabaseUrl && config.supabaseAnonKey;
  if (!hasConfig) {
    return {
      ok: false,
      message: "Supabase пока не настроен. Для локальной проверки откройте страницу с ?debug=1 и скачайте CSV."
    };
  }

  const endpoint = `${config.supabaseUrl.replace(/\/$/, "")}/rest/v1/${config.supabaseTable}`;
  try {
    const response = await fetchWithRetry(endpoint, {
      method: "POST",
      headers: buildSupabaseHeaders("return=minimal,resolution=ignore-duplicates"),
      body: JSON.stringify(rows.map(withResponseId)),
      keepalive: true
    }, onRetry, requestAttempts);

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

function buildSupabaseHeaders(prefer = "return=minimal") {
  const headers = {
    apikey: config.supabaseAnonKey,
    "Content-Type": "application/json",
    Prefer: prefer
  };

  if (!config.supabaseAnonKey.startsWith("sb_publishable_")) {
    headers.Authorization = `Bearer ${config.supabaseAnonKey}`;
  }

  return headers;
}

function withResponseId(row) {
  return {
    ...row,
    id: row.id || createResponseId(row.session_id, row.stimulus_order)
  };
}

function createResponseId(sessionId, stimulusOrder) {
  const orderHex = Number(stimulusOrder).toString(16).padStart(8, "0").slice(-8);
  return `${sessionId.slice(0, -8)}${orderHex}`;
}

async function fetchWithRetry(endpoint, options, onRetry, requestAttempts = config.supabaseRequestAttempts) {
  let lastError;

  for (let attempt = 1; attempt <= requestAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), config.supabaseRequestTimeoutMs);

    try {
      const response = await fetch(endpoint, { ...options, signal: controller.signal });
      if (response.ok || attempt === requestAttempts || (response.status < 500 && response.status !== 429)) {
        return response;
      }

      lastError = new Error(`Supabase вернул ошибку ${response.status}.`);
    } catch (error) {
      lastError = error;
    } finally {
      window.clearTimeout(timeoutId);
    }

    onRetry?.(attempt + 1, requestAttempts);
    await wait(Math.min(1000 * attempt, 5000));
  }

  throw lastError;
}

function startPendingSubmissionSync() {
  migrateLegacyFailedSubmissions();
  void syncPendingSubmissions();
  window.addEventListener("online", () => void syncPendingSubmissions());
  window.setInterval(() => void syncPendingSubmissions(), BACKGROUND_SYNC_INTERVAL_MS);
}

function syncPendingSubmissions({
  onlySessionId = "",
  requestAttempts = 1,
  updateStatus = false
} = {}) {
  const run = () => performPendingSubmissionSync({ onlySessionId, requestAttempts, updateStatus });
  pendingSubmissionSync = pendingSubmissionSync.then(run, run);
  return pendingSubmissionSync;
}

async function performPendingSubmissionSync({ onlySessionId, requestAttempts, updateStatus }) {
  const submissions = getPendingSubmissions()
    .filter((submission) => !onlySessionId || submission.sessionId === onlySessionId);

  if (submissions.length === 0) return { ok: true };

  for (const submission of submissions) {
    const onRetry = updateStatus
      ? (attempt, total) => {
        setSaveStatus(`Нет соединения с базой. Повторная попытка ${attempt} из ${total}...`);
      }
      : undefined;

    if (submission.session) {
      const sessionResult = await saveSessionToSupabase(submission.session, { requestAttempts, onRetry });
      if (!sessionResult.ok) return sessionResult;
    }

    if (submission.rows.length > 0) {
      const responseResult = await saveToSupabase(submission.rows, { requestAttempts, onRetry });
      if (!responseResult.ok) return responseResult;
    }

    clearSyncedSubmission(submission);
  }

  markCurrentSubmissionAsSynced();
  return { ok: true };
}

function queuePendingSubmission({ session = null, rows = [] }) {
  const sessionId = session?.session_id || rows[0]?.session_id;
  if (!sessionId) return false;

  const submissions = getPendingSubmissions();
  const current = submissions.find((submission) => submission.sessionId === sessionId);
  if (current) {
    if (session) current.session = session;
    current.rows = mergeRows(current.rows, rows);
    current.savedAt = new Date().toISOString();
  } else {
    submissions.push({
      sessionId,
      savedAt: new Date().toISOString(),
      session,
      rows: mergeRows([], rows)
    });
  }

  return writePendingSubmissions(submissions);
}

function clearPendingSession(sessionId) {
  updatePendingSubmission(sessionId, (submission) => {
    submission.session = null;
  });
}

function clearPendingRows(sessionId, rows) {
  const savedRowKeys = new Set(rows.map(getResponseKey));
  updatePendingSubmission(sessionId, (submission) => {
    submission.rows = submission.rows.filter((row) => !savedRowKeys.has(getResponseKey(row)));
  });
}

function clearSyncedSubmission(syncedSubmission) {
  const savedRowKeys = new Set(syncedSubmission.rows.map(getResponseKey));
  updatePendingSubmission(syncedSubmission.sessionId, (submission) => {
    if (syncedSubmission.session) submission.session = null;
    submission.rows = submission.rows.filter((row) => !savedRowKeys.has(getResponseKey(row)));
  });
}

function updatePendingSubmission(sessionId, update) {
  const submissions = getPendingSubmissions();
  const submission = submissions.find((item) => item.sessionId === sessionId);
  if (!submission) return;

  update(submission);
  writePendingSubmissions(
    submissions.filter((item) => item.session || item.rows.length > 0)
  );
}

function getPendingSubmissions() {
  try {
    const submissions = JSON.parse(localStorage.getItem(PENDING_SUBMISSIONS_KEY) || "[]");
    if (!Array.isArray(submissions)) return [];
    return submissions.map(normalizePendingSubmission).filter(Boolean);
  } catch {
    return [];
  }
}

function normalizePendingSubmission(submission) {
  const session = submission?.session || null;
  const rows = Array.isArray(submission?.rows) ? submission.rows : [];
  const sessionId = submission?.sessionId || session?.session_id || rows[0]?.session_id;
  if (!sessionId) return null;

  return {
    sessionId,
    savedAt: submission.savedAt || new Date().toISOString(),
    session,
    rows: mergeRows([], rows)
  };
}

function writePendingSubmissions(submissions) {
  try {
    localStorage.setItem(PENDING_SUBMISSIONS_KEY, JSON.stringify(submissions));
    return true;
  } catch {
    // Local storage can be disabled in private browsing modes.
    return false;
  }
}

function mergeRows(currentRows, newRows) {
  const rowsByKey = new Map(currentRows.map((row) => [getResponseKey(row), row]));
  newRows.forEach((row) => rowsByKey.set(getResponseKey(row), row));
  return [...rowsByKey.values()];
}

function getResponseKey(row) {
  return row.id || createResponseId(row.session_id, row.stimulus_order);
}

function migrateLegacyFailedSubmissions() {
  let failedSubmissions;
  try {
    failedSubmissions = JSON.parse(localStorage.getItem(LEGACY_FAILED_SUBMISSIONS_KEY) || "[]");
  } catch {
    failedSubmissions = [];
  }

  if (!Array.isArray(failedSubmissions)) return;
  failedSubmissions.forEach((submission) => {
    queuePendingSubmission({ rows: Array.isArray(submission.rows) ? submission.rows : [] });
  });

  try {
    localStorage.removeItem(LEGACY_FAILED_SUBMISSIONS_KEY);
  } catch {
    // Local storage can be disabled in private browsing modes.
  }
}

async function saveCurrentSubmissionToSupabase(session) {
  const onRetry = (attempt, total) => {
    setSaveStatus(`Нет соединения с базой. Повторная попытка ${attempt} из ${total}...`);
  };
  const sessionResult = await saveSessionToSupabase(session, {
    requestAttempts: config.supabaseRequestAttempts,
    onRetry
  });
  if (!sessionResult.ok) return sessionResult;

  return saveToSupabase(state.rows, {
    requestAttempts: config.supabaseRequestAttempts,
    onRetry
  });
}

function markCurrentSubmissionAsSynced() {
  if (state.phase !== "finish") return;
  const isStillPending = getPendingSubmissions()
    .some((submission) => submission.sessionId === state.sessionId);
  if (isStillPending) return;

  setSaveStatus("Результаты сохранены.");
  clearProgress();
}

function saveProgress() {
  if (!state.participant || !state.selectedSet || state.trials.length === 0) return;

  try {
    localStorage.setItem(ACTIVE_PROGRESS_KEY, JSON.stringify({
      savedAt: new Date().toISOString(),
      experimentStage,
      skipTextQuestionnaire,
      sessionId: state.sessionId,
      participant: state.participant,
      selectedSetId: state.selectedSet.id,
      trials: state.trials,
      rows: state.rows,
      surveyIndex: state.surveyIndex,
      questionnaireAnswers: state.questionnaireAnswers,
      phase: state.phase
    }));
  } catch {
    // Local storage can be disabled in private browsing modes.
  }
}

function canUseLocalStorage() {
  const testKey = "facetest_storage_test";
  try {
    localStorage.setItem(testKey, "1");
    localStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}

function saveSetupDraft() {
  try {
    localStorage.setItem(SETUP_DRAFT_KEY, JSON.stringify(
      Object.fromEntries(new FormData(els.participantForm))
    ));
  } catch {
    // Local storage can be disabled in private browsing modes.
  }
}

function restoreSetupDraft() {
  let draft;
  try {
    draft = JSON.parse(localStorage.getItem(SETUP_DRAFT_KEY) || "null");
  } catch {
    clearSetupDraft();
    return;
  }

  if (!draft) return;

  Object.entries(draft).forEach(([name, value]) => {
    const field = els.participantForm.elements.namedItem(name);
    if (!field) return;
    if (field.options && ![...field.options].some((option) => option.value === value)) return;
    field.value = value;
  });
}

function clearSetupDraft() {
  try {
    localStorage.removeItem(SETUP_DRAFT_KEY);
  } catch {
    // Local storage can be disabled in private browsing modes.
  }
}

function restoreProgress() {
  let progress;
  try {
    progress = JSON.parse(localStorage.getItem(ACTIVE_PROGRESS_KEY) || "null");
  } catch {
    clearProgress();
    return false;
  }

  if (!progress) return false;

  const selectedSet = state.photoSets.find((set) => set.id === progress.selectedSetId);
  const hasValidTrials = Array.isArray(progress.trials) && progress.trials.length > 0;
  const hasValidParticipant = progress.participant?.id && progress.participant?.identifier;
  if (!selectedSet || !hasValidTrials || !hasValidParticipant) {
    clearProgress();
    return false;
  }

  if (forcedSetId && forcedSetId !== selectedSet.id) return false;

  state.sessionId = progress.sessionId || createId();
  state.participant = progress.participant;
  state.selectedSet = selectedSet;
  state.trials = progress.trials;
  state.rows = Array.isArray(progress.rows) ? progress.rows : [];
  if (progress.experimentStage && progress.experimentStage !== experimentStage) {
    clearProgress();
    return false;
  }

  state.surveySections = skipTextQuestionnaire ? [] : getSurveySections();
  state.surveyIndex = Math.max(0, Math.min(Number(progress.surveyIndex) || 0, state.surveySections.length - 1));
  state.questionnaireAnswers = {
    ...getInitialQuestionnaireAnswers(),
    ...(progress.questionnaireAnswers || {})
  };

  showResetProgressButtons();

  if (progress.phase === "survey" && !skipTextQuestionnaire) {
    state.phase = "survey";
    renderSurveySection();
    showView("survey");
    return true;
  }

  if (progress.phase === "finish" || state.rows.length >= state.trials.length) {
    finishExperiment();
    return true;
  }

  state.phase = "ready";
  els.readyGroup.textContent = state.selectedSet.label;
  els.beginButton.textContent = state.rows.length > 0 ? "Продолжить демонстрацию" : "Начать демонстрацию";
  els.loadStatus.textContent = state.rows.length > 0
    ? `Прогресс восстановлен: отвечено ${state.rows.length} из ${state.trials.length}.`
    : "Стимулы будут подготовлены перед стартом.";
  saveProgress();
  showView("ready");
  return true;
}

function clearProgress() {
  try {
    localStorage.removeItem(ACTIVE_PROGRESS_KEY);
  } catch {
    // Local storage can be disabled in private browsing modes.
  }
}

function showResetProgressButtons() {
  document.querySelectorAll("[data-reset-progress]").forEach((button) => {
    button.classList.remove("hidden");
  });
}

function downloadCsv() {
  const questionnaireHeaders = Object.keys(state.questionnaireAnswers)
    .filter((questionId) => !questionId.startsWith("_"))
    .map((questionId) => `questionnaire_${questionId}`);
  const headers = [
    "id",
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
    "reaction_time_ms",
    "shown_at",
    "user_agent",
    "session_institution",
    "experiment_stage",
    "text_questionnaire_skipped",
    "questionnaire_answers",
    ...questionnaireHeaders
  ];

  const rows = state.rows.map((row) => ({
    ...row,
    session_institution: state.participant.institution,
    experiment_stage: experimentStage,
    text_questionnaire_skipped: skipTextQuestionnaire ? "true" : "false",
    questionnaire_answers: JSON.stringify(getSessionQuestionnaireAnswers()),
    ...Object.fromEntries(
      Object.entries(state.questionnaireAnswers)
        .filter(([questionId]) => !questionId.startsWith("_"))
        .map(([questionId, answer]) => [`questionnaire_${questionId}`, answer])
    )
  }));
  const lines = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))
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
    survey: els.surveyView,
    ready: els.readyView,
    experiment: els.experimentView,
    finish: els.finishView
  };

  Object.values(map).forEach((view) => view.classList.add("hidden"));
  map[viewName].classList.remove("hidden");
}

function clearStimulusTimers() {
  window.clearTimeout(state.stimulusTimerId);
  state.stimulusTimerId = null;
}

function getSetStimuli(set) {
  return set.stimuli || set.photos || [];
}

function renderStimulus(trial) {
  if (trial.type === "image") {
    els.responseHint.classList.remove("hidden");
    els.numberStimulus.classList.add("hidden");
    els.stimulusImage.classList.remove("hidden");
    els.stimulusImage.src = trial.src;
    return;
  }

  els.responseHint.classList.add("hidden");
  els.stimulusImage.classList.add("hidden");
  els.stimulusImage.removeAttribute("src");
  els.numberStimulus.classList.remove("hidden");
  els.numberStimulus.textContent = String(trial.value);
}

function clearStimulusDisplay() {
  els.responseHint.classList.add("hidden");
  els.stimulusImage.classList.add("hidden");
  els.stimulusImage.removeAttribute("src");
  els.numberStimulus.classList.add("hidden");
  els.numberStimulus.textContent = "";
}

function getKeyboardAnswer(event) {
  if (event.code === "KeyY") return "Y";
  if (event.code === "KeyN") return "N";

  const key = event.key.toLowerCase();
  if (key === "y" || key === "н") return "Y";
  if (key === "n" || key === "т") return "N";
  return null;
}

function getDeviceCheck() {
  if (!config.requireMinimumViewport) return { ok: true };

  const width = window.innerWidth;
  const height = window.innerHeight;

  if (!debugQueryMode && (width < config.minimumViewportWidth || height < config.minimumViewportHeight)) {
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
