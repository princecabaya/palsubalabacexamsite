(() => {
  const cfg = window.EXAM_CONFIG || {};
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_PUBLISHABLE_KEY ||
      cfg.SUPABASE_URL.includes("YOUR-PROJECT")) {
    alert("Configure config.js with your Supabase URL and publishable key.");
  }

  const db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });

  const $ = (id) => document.getElementById(id);

  function isIOSBrowser() {
    const ua = navigator.userAgent || "";
    return /iPad|iPhone|iPod/i.test(ua) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }

  function updateMobileMonitoringCapabilityNote() {
    const note = $("mobileMonitoringNote");
    if (!note) return;
    if (isIOSBrowser()) {
      note.textContent = "iPhone/iPad note: Safari does not expose system screenshot events to webpages. Screenshot detection is unavailable; focus, restricted actions, camera, and microphone monitoring remain active.";
      note.classList.remove("hidden");
      note.title = "System screenshots taken with the iPhone buttons cannot be reliably detected by Safari.";
    } else {
      note.classList.add("hidden");
      note.textContent = "";
    }
  }
  function setPreflightStatus(key, state, detail = "") {
    const row = document.querySelector(`[data-preflight="${key}"]`);
    if (!row) return;
    row.dataset.state = state;
    const icon = row.querySelector(".preflight-icon");
    const detailNode = row.querySelector(".preflight-detail");
    const iconMap = { ready:"✓", checking:"…", warning:"!", error:"×", idle:"○" };
    if (icon) icon.textContent = iconMap[state] || "○";
    if (detailNode) detailNode.textContent = detail || "";
  }

  function resetPreflightStatus() {
    [
      ["exam","idle","Waiting"],
      ["student","idle","Waiting"],
      ["camera","idle","Not checked"],
      ["microphone","idle","Not checked"],
      ["session","idle","Not checked"]
    ].forEach(([key,state,detail]) => setPreflightStatus(key,state,detail));
  }

  function explainStartError(message = "") {
    const text = String(message || "");
    if (/not published|invalid.*exam code/i.test(text)) {
      return "The exam code is invalid, archived, or not yet published by the teacher.";
    }
    if (/not opened yet/i.test(text)) return "The exam exists, but its opening time has not started yet.";
    if (/already closed/i.test(text)) return "The exam closing time has already passed.";
    if (/active student record|student id/i.test(text)) return "This Student ID is not currently active in the exam roster.";
    if (/another browser|another device|locked/i.test(text)) {
      return "This Student ID already has an active session lock. Ask the teacher to use Unlock Active Session, then try again.";
    }
    if (/expired/i.test(text)) return "The previous attempt has expired. Ask the teacher to reset the attempt if a retake is intended.";
    if (/already submitted/i.test(text)) return "This student has already submitted this exam. A teacher reset is required for a retake.";
    return text || "The exam could not be started.";
  }

  const loginView = $("loginView");
  const examView = $("examView");
  const doneView = $("doneView");
  const examForm = $("examForm");
  const warningBar = $("warningBar");
  const watermark = $("watermark");

  let attempt = null;
  let questions = [];
  let timerHandle = null;
  let timerSyncHandle = null;
  let timerDeadlineMs = null;
  let timerExpiryCheckInFlight = false;
  let submitted = false;
  let attemptMessagePollHandle = null;
  let pendingRestoreMessage = null;
  let lastAttemptMessageAt = null;
  let suppressBlurUntil = 0;
  const queuedEvents = [];
  let pendingIdentity = null;
  let cameraStream = null;
  let cameraInterval = null;
  let cameraInitialTimeout = null;
  let cameraInitialRetryCount = 0;
  let cameraCaptureBusy = false;
  let microphoneStream = null;
  let microphoneAudioContext = null;
  let microphoneAnalyser = null;
  let microphoneMonitorFrame = null;
  let microphoneData = null;
  let speechCandidateStartedAt = 0;
  let speechActiveStartedAt = 0;
  let speechLastLoudAt = 0;
  let speechPeakRms = 0;
  let microphoneNoiseFloor = 0.01;
  let examFlagCounts = { restricted: 0, focus: 0, speech: 0 };
  let speechFlagTimer = null;
  const pendingAnswerSaves = new Map();
  const submittedEssayQuestionIds = new Set();

  let flexCameraStream = null;
  let flexRenderFrame = null;
  let flexRecorder = null;
  let flexRecordedChunks = [];
  let flexRecordingTimer = null;
  let flexMediaBlob = null;
  let flexMediaFileName = "";
  let flexScoreText = "—";
  let flexExamTitle = "Exam";
  let flexStudentName = "";
  let completionAudioContext = null;
  let completionAudioPrimed = false;

  const restrictedFlagTypes = new Set([
    "copy_blocked","cut_blocked","paste_blocked","contextmenu_blocked","dragstart_blocked",
    "keyboard_shortcut_blocked","developer_tools_shortcut_attempt","reload_shortcut_blocked",
    "print_attempt","printscreen_key_detected","leave_or_reload_attempt","in_exam_link_navigation_blocked"
  ]);

  function clearExamBrowserState({ keepCurrentToken = false, keepDeviceSession = true } = {}) {
    const currentToken = keepCurrentToken ? sessionStorage.getItem("exam_guard_token") : null;
    const currentDeviceSession = keepDeviceSession ? sessionStorage.getItem("exam_device_session_id") : null;

    for (const storage of [sessionStorage, localStorage]) {
      const keys = [];
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (
          key &&
          key.startsWith("exam_guard_") &&
          !key.startsWith("exam_guard_recovery_")
        ) keys.push(key);
      }
      keys.forEach(key => storage.removeItem(key));
    }

    if (keepCurrentToken && currentToken) {
      sessionStorage.setItem("exam_guard_token", currentToken);
    }
    if (keepDeviceSession && currentDeviceSession) {
      sessionStorage.setItem("exam_device_session_id", currentDeviceSession);
    }
  }

  cleanupExpiredRecoverySnapshots();

  function getExamDeviceSessionId() {
    const key = "exam_device_session_id";
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    // Device identity should survive tab closure/reopening in the same browser.
    // Prefer localStorage, but migrate an older sessionStorage value when present.
    let value = null;
    try {
      value = localStorage.getItem(key) || sessionStorage.getItem(key);
    } catch (_) {
      value = sessionStorage.getItem(key);
    }

    if (value && uuidPattern.test(value)) {
      try { localStorage.setItem(key, value); } catch (_) {}
      try { sessionStorage.setItem(key, value); } catch (_) {}
      return value;
    }

    if (crypto?.randomUUID) {
      value = crypto.randomUUID();
    } else {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
      value = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    }

    try { localStorage.setItem(key, value); } catch (_) {}
    try { sessionStorage.setItem(key, value); } catch (_) {}
    return value;
  }

  function currentAnswerForQuestion(questionId) {
    const wrap = examForm.querySelector(`[data-question-id="${CSS.escape(String(questionId))}"]`);
    if (!wrap) return "";

    const checked = wrap.querySelector('input[type="radio"]:checked');
    if (checked) return checked.value;

    const mathBoard = wrap.querySelector(".math-solver-board");
    if (mathBoard) {
      const solution = mathBoard.querySelector(".math-solution-input")?.value || "";
      const finalAnswer = mathBoard.querySelector(".math-final-answer-input")?.value || "";
      return `Solution:\n${solution}\nFinal Answer:\n${finalAnswer}`;
    }

    const textarea = wrap.querySelector("textarea");
    if (textarea) return textarea.value;

    const textInput = wrap.querySelector('input[type="text"], input.short-response-input');
    if (textInput) return textInput.value;

    return "";
  }

  const RECOVERY_SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

  function recoverySnapshotKey(token = attempt?.attempt_token) {
    return token ? `exam_guard_recovery_${token}` : "";
  }

  function cleanupExpiredRecoverySnapshots() {
    try {
      const now = Date.now();
      const keys = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key?.startsWith("exam_guard_recovery_")) keys.push(key);
      }
      keys.forEach(key => {
        try {
          const parsed = JSON.parse(localStorage.getItem(key) || "null");
          const expiresAt = Number(parsed?.expires_at || 0);
          if (!expiresAt || expiresAt <= now) localStorage.removeItem(key);
        } catch (_) {
          localStorage.removeItem(key);
        }
      });
    } catch (_) {}
  }

  function buildCurrentAnswerSnapshot() {
    const answers = {};
    let answeredCount = 0;
    for (const q of questions) {
      const answer = String(currentAnswerForQuestion(q.question_id) ?? "");
      answers[String(q.question_id)] = answer;
      if (answer.trim() !== "") answeredCount += 1;
    }
    return {
      attempt_token: attempt?.attempt_token || "",
      exam_title: attempt?.exam_title || "",
      student_name: attempt?.student_name || "",
      student_no: attempt?.student_no || "",
      answers,
      answered_count: answeredCount,
      captured_at: Date.now(),
      expires_at: Date.now() + RECOVERY_SNAPSHOT_RETENTION_MS
    };
  }

  function saveLocalRecoverySnapshot(snapshot) {
    if (!snapshot?.attempt_token) return false;
    try {
      localStorage.setItem(recoverySnapshotKey(snapshot.attempt_token), JSON.stringify(snapshot));
      return true;
    } catch (_) {
      return false;
    }
  }

  async function saveServerRecoverySnapshot(snapshot) {
    if (!snapshot?.attempt_token) return { available:false, saved:false };
    const { data, error } = await db.rpc("save_attempt_recovery_snapshot", {
      p_attempt_token: snapshot.attempt_token,
      p_answers: snapshot.answers
    });
    if (error) {
      const missingFunction = /save_attempt_recovery_snapshot|function.*does not exist|schema cache|PGRST202/i.test(String(error.message || error));
      return { available:!missingFunction, saved:false, error };
    }
    return { available:true, saved:true, data };
  }

  function normalizedAnswer(value) {
    return String(value ?? "").replace(/\r\n/g, "\n").trim();
  }

  async function verifyAnswersSaved(snapshot, { retry = true } = {}) {
    if (!snapshot?.attempt_token) return { available:false, verified:false, mismatches:[] };

    const fetchState = () => db.rpc("get_attempt_saved_response_state", {
      p_attempt_token: snapshot.attempt_token
    });

    let { data, error } = await fetchState();
    if (error) {
      const missingFunction = /get_attempt_saved_response_state|function.*does not exist|schema cache|PGRST202/i.test(String(error.message || error));
      return { available:!missingFunction, verified:false, mismatches:[], error };
    }

    const compare = rows => {
      const saved = new Map((rows || []).map(row => [String(row.question_id), normalizedAnswer(row.answer)]));
      const mismatches = [];
      for (const [questionId, answer] of Object.entries(snapshot.answers || {})) {
        const expected = normalizedAnswer(answer);
        if (!expected) continue;
        if (saved.get(String(questionId)) !== expected) mismatches.push(String(questionId));
      }
      return mismatches;
    };

    let mismatches = compare(data);
    if (mismatches.length && retry) {
      for (const questionId of mismatches) {
        const answer = snapshot.answers[questionId];
        const wrap = examForm.querySelector(`[data-question-id="${CSS.escape(String(questionId))}"]`);
        const state = wrap?.querySelector(".save-state");
        try { await saveAnswer(questionId, answer, state, { quiet:true }); } catch (_) {}
      }
      await Promise.all([...pendingAnswerSaves.values()]);
      const second = await fetchState();
      if (!second.error) {
        data = second.data;
        error = null;
        mismatches = compare(data);
      } else {
        error = second.error;
      }
    }

    return { available:true, verified:!error && mismatches.length === 0, mismatches, error };
  }

  function localDraftKey(questionId) {
    return attempt?.attempt_token
      ? `exam_guard_draft_${attempt.attempt_token}_${questionId}`
      : "";
  }

  function saveLocalDraft(questionId, answer) {
    const key = localDraftKey(questionId);
    if (!key) return;
    try {
      localStorage.setItem(key, JSON.stringify({
        answer: String(answer ?? ""),
        saved_at: Date.now()
      }));
    } catch (_) {}
  }

  function loadLocalDraft(questionId) {
    const key = localDraftKey(questionId);
    if (!key) return null;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.answer !== "string") return null;
      return parsed;
    } catch (_) {
      return null;
    }
  }

  function clearLocalDraftsForAttempt(token = attempt?.attempt_token) {
    if (!token) return;
    const prefix = `exam_guard_draft_${token}_`;
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key?.startsWith(prefix)) keys.push(key);
      }
      keys.forEach(key => localStorage.removeItem(key));
    } catch (_) {}
  }

  function emergencySnapshotCurrentAnswers() {
    if (!attempt?.attempt_token || submitted || !examForm) return;
    for (const q of questions) {
      saveLocalDraft(q.question_id, currentAnswerForQuestion(q.question_id));
    }
  }

  async function forceSaveAllCurrentAnswers() {
    const jobs = [];

    for (const q of questions) {
      if (q.question_type === "essay" && submittedEssayQuestionIds.has(String(q.question_id))) {
        continue;
      }

      const answer = currentAnswerForQuestion(q.question_id);
      const wrap = examForm.querySelector(`[data-question-id="${CSS.escape(String(q.question_id))}"]`);
      const state = wrap?.querySelector(".save-state");

      // Save even blank values so a deliberately cleared text response is reflected
      // in the database before scoring. Individually submitted essays are skipped.
      jobs.push(saveAnswer(q.question_id, answer, state, { quiet: true }));
    }

    await Promise.all(jobs);

    // Also wait for any earlier change-triggered save that may still be in flight.
    await Promise.all([...pendingAnswerSaves.values()]);
  }

  function flagStorageKey() {
    return attempt?.attempt_token ? `exam_guard_flags_${attempt.attempt_token}` : "";
  }

  function saveExamFlagCounts() {
    const key = flagStorageKey();
    if (!key) return;
    sessionStorage.setItem(key, JSON.stringify(examFlagCounts));
  }

  function loadExamFlagCounts() {
    const key = flagStorageKey();
    examFlagCounts = { restricted: 0, focus: 0, speech: 0 };
    if (key) {
      try {
        const saved = JSON.parse(sessionStorage.getItem(key) || "{}");
        examFlagCounts.restricted = Number(saved.restricted || 0);
        examFlagCounts.focus = Number(saved.focus || 0);
        examFlagCounts.speech = Number(saved.speech || 0);
      } catch (_) {}
    }
    updateExamFlagBar();
  }

  function resetExamFlagCounts() {
    examFlagCounts = { restricted: 0, focus: 0, speech: 0 };
    saveExamFlagCounts();
    updateExamFlagBar();
  }

  function updateExamFlagBar() {
    const restricted = $("restrictedFlagCount");
    const restrictedChip = restricted?.closest(".flag-chip");
    if (restrictedChip && isIOSBrowser()) {
      restrictedChip.title = "Restricted actions detected by the browser. System screenshot button presses are not detectable by iPhone/iPad Safari.";
    }
    const focus = $("focusFlagCount");
    const speech = $("speechFlagCount");
    if (restricted) restricted.textContent = String(examFlagCounts.restricted);
    if (focus) focus.textContent = String(examFlagCounts.focus);
    if (speech) speech.textContent = String(examFlagCounts.speech);
  }

  function flashSpeechWarning() {
    const chip = $("speechFlagChip");
    const label = $("speechFlagLabel");
    if (!chip || !label) return;

    chip.classList.add("speech-alert");
    label.textContent = "Silent please";
    warn("Silent please — possible speech was detected.");

    clearTimeout(speechFlagTimer);
    speechFlagTimer = setTimeout(() => {
      chip.classList.remove("speech-alert");
      label.textContent = "Speech";
    }, 5000);
  }

  function countFlagForEvent(type) {
    let changed = false;

    if (restrictedFlagTypes.has(type)) {
      examFlagCounts.restricted += 1;
      changed = true;
    } else if (type === "window_blur" || type === "fullscreen_exit") {
      examFlagCounts.focus += 1;
      changed = true;
    } else if (type === "possible_speech_detected") {
      examFlagCounts.speech += 1;
      changed = true;
      flashSpeechWarning();
    }

    if (changed) {
      saveExamFlagCounts();
      updateExamFlagBar();
    }
  }

  const safeDetails = (extra = {}) => ({
    visibility: document.visibilityState,
    fullscreen: !!document.fullscreenElement,
    online: navigator.onLine,
    page: location.pathname,
    ...extra
  });

  async function logEvent(type, details = {}) {
    if (!attempt?.attempt_token || submitted) return;
    countFlagForEvent(type);
    const payload = {
      p_attempt_token: attempt.attempt_token,
      p_event_type: type,
      p_details: safeDetails(details)
    };
    const { error } = await db.rpc("log_proctor_event", payload);
    if (error) queuedEvents.push(payload);
  }

  async function flushEvents() {
    while (queuedEvents.length) {
      const payload = queuedEvents[0];
      const { error } = await db.rpc("log_proctor_event", payload);
      if (error) return;
      queuedEvents.shift();
    }
  }

  function warn(message) {
    warningBar.textContent = message;
    warningBar.classList.remove("hidden");
    clearTimeout(warn._t);
    warn._t = setTimeout(() => warningBar.classList.add("hidden"), 5000);
  }

  async function requestFrontCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser does not support front-camera access.");
    }

    if (cameraStream?.active) return cameraStream;

    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "user" },
        width: { ideal: 640 },
        height: { ideal: 480 }
      },
      audio: false
    });

    cameraStream = stream;
    const preview = $("proctorCameraPreview");
    if (preview) {
      preview.srcObject = stream;
      try { await preview.play(); } catch (_) {}
    }
    updateCameraStatus("Camera active");
    return stream;
  }

  function updateCameraStatus(text) {
    const node = $("cameraStatus");
    if (node) node.textContent = text;
  }

  function stopCameraMonitoring() {
    clearInterval(cameraInterval);
    clearTimeout(cameraInitialTimeout);
    cameraInterval = null;
    cameraInitialTimeout = null;
    cameraInitialRetryCount = 0;
    cameraCaptureBusy = false;

    for (const track of cameraStream?.getTracks?.() || []) {
      try { track.stop(); } catch (_) {}
    }
    cameraStream = null;

    const preview = $("proctorCameraPreview");
    if (preview) preview.srcObject = null;
    updateCameraStatus("Stopped");
  }

  function startCameraCaptureSchedule() {
    if (!attempt?.attempt_token || submitted || !cameraStream?.active) return;

    clearInterval(cameraInterval);
    clearTimeout(cameraInitialTimeout);
    cameraInitialRetryCount = 0;

    const tryInitialCapture = async () => {
      if (!attempt?.attempt_token || submitted || !cameraStream?.active) return;

      const saved = await captureAndUploadProctorPhoto({ source: "initial" });
      if (saved) {
        cameraInitialRetryCount = 0;
        return;
      }

      cameraInitialRetryCount += 1;
      if (cameraInitialRetryCount >= 6) {
        await logEvent("camera_initial_photo_unavailable", {
          retries: cameraInitialRetryCount,
          message: "No initial proctor photo could be saved after repeated retries."
        });
        updateCameraStatus("Camera active • photo retry failed");
        return;
      }

      updateCameraStatus(`Retrying photo ${cameraInitialRetryCount}/6…`);
      cameraInitialTimeout = setTimeout(tryInitialCapture, 5000);
    };

    // Start shortly after the exam opens. If the video is not ready yet or the
    // upload fails, retry every 5 seconds up to 6 times.
    cameraInitialTimeout = setTimeout(tryInitialCapture, 2500);

    // Continue normal periodic capture every 60 seconds.
    cameraInterval = setInterval(() => {
      captureAndUploadProctorPhoto({ source: "scheduled" });
    }, 60_000);
  }

  async function captureAndUploadProctorPhoto({ source = "scheduled" } = {}) {
    if (!attempt?.attempt_token || submitted || !cameraStream?.active || cameraCaptureBusy) return false;

    const video = $("proctorCameraPreview");
    if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
      await logEvent("camera_photo_not_ready", { source });
      return false;
    }

    cameraCaptureBusy = true;
    updateCameraStatus("Saving photo…");

    try {
      const maxWidth = 480;
      const scale = Math.min(1, maxWidth / video.videoWidth);
      const width = Math.max(240, Math.round(video.videoWidth * scale));
      const height = Math.max(180, Math.round(video.videoHeight * scale));

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) throw new Error("Camera image could not be prepared.");

      ctx.drawImage(video, 0, 0, width, height);
      const imageBase64 = canvas.toDataURL("image/jpeg", 0.58);

      const { data, error } = await db.functions.invoke("capture-proctor-photo", {
        body: {
          attempt_token: attempt.attempt_token,
          image_base64: imageBase64
        }
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      updateCameraStatus("Photo saved");
      await logEvent("camera_photo_saved", {
        capturedAt: data?.captured_at || null,
        source
      });
      setTimeout(() => {
        if (cameraStream?.active && !submitted) updateCameraStatus("Camera active");
      }, 1800);
      return true;
    } catch (error) {
      console.warn("Proctor photo capture failed:", error);
      updateCameraStatus("Photo save failed");
      await logEvent("camera_photo_failed", {
        message: String(error?.message || error).slice(0, 300),
        source
      });
      return false;
    } finally {
      cameraCaptureBusy = false;
    }
  }

  async function requestMicrophone() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser does not support microphone access.");
    }

    if (microphoneStream?.active) return microphoneStream;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    });

    microphoneStream = stream;
    updateMicrophoneStatus("Microphone active");
    return stream;
  }

  function updateMicrophoneStatus(text) {
    const node = $("microphoneStatus");
    if (node) node.textContent = text;
  }

  function updateMicrophoneLevel(rms = 0, threshold = 0.025) {
    const fill = $("microphoneLevelFill");
    const marker = $("microphoneThresholdMarker");
    const label = $("microphoneLevelLabel");
    if (!fill || !marker || !label) return;

    const normalized = Math.max(0, Math.min(1, rms / 0.12));
    const thresholdNormalized = Math.max(0.04, Math.min(0.96, threshold / 0.12));

    fill.style.width = `${(normalized * 100).toFixed(1)}%`;
    marker.style.left = `${(thresholdNormalized * 100).toFixed(1)}%`;

    let text = "Low";
    if (rms >= threshold * 1.65) text = "High";
    else if (rms >= threshold) text = "Good";

    label.textContent = text;
    label.dataset.level = text.toLowerCase();
    fill.dataset.level = text.toLowerCase();
  }

  function resetMicrophoneLevel() {
    const fill = $("microphoneLevelFill");
    const marker = $("microphoneThresholdMarker");
    const label = $("microphoneLevelLabel");
    if (fill) {
      fill.style.width = "0%";
      fill.dataset.level = "idle";
    }
    if (marker) marker.style.left = "25%";
    if (label) {
      label.textContent = "Idle";
      label.dataset.level = "idle";
    }
  }

  async function startSpeechMonitoring() {
    if (!attempt?.attempt_token || submitted || !microphoneStream?.active) return;

    stopSpeechAnalysisOnly();

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
      resetMicrophoneLevel();
      updateMicrophoneStatus("Analysis unsupported");
      await logEvent("microphone_analysis_unavailable");
      return;
    }

    microphoneAudioContext = new AudioContextCtor();
    try {
      if (microphoneAudioContext.state === "suspended") {
        await microphoneAudioContext.resume();
      }
    } catch (_) {}

    const source = microphoneAudioContext.createMediaStreamSource(microphoneStream);
    microphoneAnalyser = microphoneAudioContext.createAnalyser();
    const iosAudio = isIOSBrowser();
    microphoneAnalyser.fftSize = iosAudio ? 2048 : 1024;
    microphoneAnalyser.smoothingTimeConstant = iosAudio ? 0.2 : 0.35;
    source.connect(microphoneAnalyser);
    microphoneData = new Float32Array(microphoneAnalyser.fftSize);

    speechCandidateStartedAt = 0;
    speechActiveStartedAt = 0;
    speechLastLoudAt = 0;
    speechPeakRms = 0;
    microphoneNoiseFloor = isIOSBrowser() ? 0.006 : 0.01;
    updateMicrophoneStatus(isIOSBrowser() ? "Listening • iPhone tuned" : "Listening locally");

    const monitor = () => {
      if (!microphoneAnalyser || !microphoneStream?.active || submitted) return;

      microphoneAnalyser.getFloatTimeDomainData(microphoneData);
      let sum = 0;
      for (let i = 0; i < microphoneData.length; i += 1) {
        const sample = microphoneData[i];
        sum += sample * sample;
      }
      const rms = Math.sqrt(sum / microphoneData.length);
      const now = performance.now();

      const iosAudio = isIOSBrowser();

      // Adapt slowly to ordinary room/background sound when no speech event is active.
      // iOS Safari often reports lower RMS levels after its built-in processing,
      // so use a lower floor and a gentler multiplier on iPhone/iPad.
      const calibrationCeiling = iosAudio ? 0.035 : 0.05;
      if (!speechActiveStartedAt && rms < calibrationCeiling) {
        const smoothing = iosAudio ? 0.025 : 0.015;
        microphoneNoiseFloor = microphoneNoiseFloor * (1 - smoothing) + rms * smoothing;
      }

      const threshold = iosAudio
        ? Math.max(0.011, microphoneNoiseFloor * 1.85)
        : Math.max(0.025, microphoneNoiseFloor * 2.8);
      updateMicrophoneLevel(rms, threshold);
      const loud = rms >= threshold;

      if (loud) {
        speechPeakRms = Math.max(speechPeakRms, rms);
        speechLastLoudAt = now;

        if (!speechCandidateStartedAt) speechCandidateStartedAt = now;

        // Require sustained sound before treating it as a possible speech segment.
        // iPhone/iPad uses a shorter window because Safari's audio processing can
        // attenuate speech more aggressively.
        const activationMs = isIOSBrowser() ? 650 : 1200;
        if (!speechActiveStartedAt && now - speechCandidateStartedAt >= activationMs) {
          speechActiveStartedAt = speechCandidateStartedAt;
          updateMicrophoneStatus("Possible speech detected");
        }
      } else {
        const candidateResetMs = isIOSBrowser() ? 300 : 450;
        if (!speechActiveStartedAt && speechCandidateStartedAt && now - speechCandidateStartedAt > candidateResetMs) {
          speechCandidateStartedAt = 0;
          speechPeakRms = 0;
        }

        // End a speech segment after a short quiet period.
        const releaseMs = isIOSBrowser() ? 650 : 900;
        if (speechActiveStartedAt && now - speechLastLoudAt >= releaseMs) {
          finishSpeechSegment(now);
        }
      }

      microphoneMonitorFrame = requestAnimationFrame(monitor);
    };

    microphoneMonitorFrame = requestAnimationFrame(monitor);
  }

  function finishSpeechSegment(now = performance.now()) {
    if (!speechActiveStartedAt) return;

    const endedAt = Math.max(speechLastLoudAt || now, speechActiveStartedAt);
    const durationMs = Math.max(0, endedAt - speechActiveStartedAt);

    const minimumDurationMs = isIOSBrowser() ? 650 : 1200;
    if (durationMs >= minimumDurationMs) {
      logEvent("possible_speech_detected", {
        duration_seconds: Number((durationMs / 1000).toFixed(1)),
        peak_level: Number(speechPeakRms.toFixed(4)),
        detection: isIOSBrowser() ? "local_audio_level_ios_tuned" : "local_audio_level_only"
      });
    }

    speechCandidateStartedAt = 0;
    speechActiveStartedAt = 0;
    speechLastLoudAt = 0;
    speechPeakRms = 0;

    if (microphoneStream?.active && !submitted) {
      updateMicrophoneStatus(isIOSBrowser() ? "Listening • iPhone tuned" : "Listening locally");
    }
  }

  function stopSpeechAnalysisOnly() {
    if (microphoneMonitorFrame) cancelAnimationFrame(microphoneMonitorFrame);
    microphoneMonitorFrame = null;
    microphoneAnalyser = null;
    microphoneData = null;

    if (microphoneAudioContext) {
      try { microphoneAudioContext.close(); } catch (_) {}
    }
    microphoneAudioContext = null;
  }

  async function stopMicrophoneMonitoring() {
    finishSpeechSegment();
    stopSpeechAnalysisOnly();

    for (const track of microphoneStream?.getTracks?.() || []) {
      try { track.stop(); } catch (_) {}
    }
    microphoneStream = null;
    resetMicrophoneLevel();
    updateMicrophoneStatus("Stopped");
  }

  async function enterFullscreen() {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      suppressBlurUntil = Date.now() + 1200;
      try { await document.documentElement.requestFullscreen(); } catch (_) {}
    }
  }

  $("viewResultBtn")?.addEventListener("click", async () => {
    const examCode = $("examCode").value.trim();
    const studentNo = $("studentNo").value.trim();
    const msg = $("loginMsg");

    if (!examCode || !studentNo) {
      msg.textContent = "Enter the Exam Code and Student ID to view the latest result.";
      return;
    }

    const button = $("viewResultBtn");
    button.disabled = true;
    msg.textContent = "Loading latest submitted result…";

    const { data, error } = await db.rpc("get_student_exam_result", {
      p_exam_code: examCode,
      p_student_no: studentNo
    });

    button.disabled = false;

    if (error || !data) {
      msg.textContent = error?.message || "No submitted result was found.";
      return;
    }

    loginView.classList.add("hidden");
    examView.classList.add("hidden");
    doneView.classList.remove("hidden");
    $("doneText").textContent = data.grading_status === "approved"
      ? "Your latest teacher-approved score is shown below."
      : "Your latest submitted result is shown below. Some constructed-response scores may still be awaiting teacher review.";
    $("aiFeedbackPanel")?.classList.add("hidden");
    window.ExamReport?.showStudentReport?.(data);
    updateFlexScoreContext({
      score: data.score ?? null,
      maxScore: data.max_score ?? null,
      examTitle: data.exam_title || "",
      studentName: data.student_name || ""
    });
  });

  function updateFlexScoreContext({ score = null, maxScore = null, examTitle = "", studentName = "" } = {}) {
    flexScoreText = (score === null || score === undefined || maxScore === null || maxScore === undefined)
      ? "Score pending"
      : `${score}/${maxScore}`;

    flexExamTitle = examTitle || flexExamTitle || "Exam";
    flexStudentName = studentName || flexStudentName || "";

    const scoreNode = $("flexLiveScore");
    if (scoreNode) scoreNode.textContent = flexScoreText;

    const messageNode = $("flexLiveMessage");
    if (messageNode && score !== null && maxScore !== null && Number(score) === Number(maxScore)) {
      messageNode.textContent = "Perfect score! 🎉";
    }

    const panel = $("flexScorePanel");
    if (panel) panel.classList.remove("hidden");
  }

  function stopFlexCamera() {
    if (flexRenderFrame) cancelAnimationFrame(flexRenderFrame);
    flexRenderFrame = null;
    clearTimeout(flexRecordingTimer);
    flexRecordingTimer = null;
    if (flexRecorder && flexRecorder.state !== "inactive") {
      try { flexRecorder.stop(); } catch (_) {}
    }
    flexRecorder = null;
    for (const track of flexCameraStream?.getTracks?.() || []) {
      try { track.stop(); } catch (_) {}
    }
    flexCameraStream = null;
    const video = $("flexCameraVideo");
    if (video) video.srcObject = null;
    $("flexCameraStage")?.classList.add("hidden");
    $("flexCaptureActions")?.classList.add("hidden");
  }

  function flexCanvasSize(video) {
    const width = video.videoWidth || 720;
    const height = video.videoHeight || 1280;
    return { width, height };
  }

    function drawRoundedRect(ctx, x, y, w, h, r, fill, stroke = null) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
  }

  function drawFlexEdgeConfetti(ctx, width, height) {
    const pieces = 42;
    const colors = [
      "#ff4d6d", "#06d6a0", "#4cc9f0", "#f72585",
      "#f9c74f", "#8338ec", "#fb5607", "#80ed99"
    ];

    const safeFaceLeft = width * 0.22;
    const safeFaceRight = width * 0.78;
    const safeFaceTop = height * 0.18;
    const safeFaceBottom = height * 0.78;

    const t = performance.now() / 1000;

    for (let i = 0; i < pieces; i++) {
      let x, y;
      const edgeZone = i % 4;

      if (edgeZone === 0) {
        x = Math.random() * width;
        y = Math.random() * safeFaceTop;
      } else if (edgeZone === 1) {
        x = Math.random() * safeFaceLeft;
        y = Math.random() * height;
      } else if (edgeZone === 2) {
        x = safeFaceRight + Math.random() * (width - safeFaceRight);
        y = Math.random() * height;
      } else {
        x = Math.random() * width;
        y = safeFaceBottom + Math.random() * (height - safeFaceBottom);
      }

      ctx.save();
      ctx.translate(x, y + Math.sin(t + i) * 4);
      ctx.rotate((t * 0.8 + i) % Math.PI);
      ctx.fillStyle = colors[i % colors.length];
      ctx.fillRect(-4, -8, 8, 16);
      ctx.restore();
    }
  }

  function drawFlexVignette(ctx, width, height) {
    const g = ctx.createRadialGradient(
      width / 2, height / 2, width * 0.18,
      width / 2, height / 2, width * 0.78
    );
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,0.18)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);
  }

  function drawFlexFrame() {
    const video = $("flexCameraVideo");
    const canvas = $("flexCameraCanvas");
    if (!video || !canvas || !flexCameraStream?.active) return;

    if (video.readyState >= 2) {
      const { width, height } = flexCanvasSize(video);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, width, height);

      // Draw selfie with mild enhancement
      ctx.save();
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
      ctx.filter = "brightness(1.08) contrast(1.06) saturate(1.04)";
      ctx.drawImage(video, 0, 0, width, height);
      ctx.restore();
      ctx.filter = "none";

      // Slight dark overlay to reduce distracting background
      const shade = ctx.createLinearGradient(0, 0, 0, height);
      shade.addColorStop(0, "rgba(0,0,0,0.08)");
      shade.addColorStop(1, "rgba(0,0,0,0.18)");
      ctx.fillStyle = shade;
      ctx.fillRect(0, 0, width, height);

      // Decorative confetti at edges only
      drawFlexEdgeConfetti(ctx, width, height);

      const message = $("flexMessageSelect")?.value || "I made it! 🎉";
      const scoreText = flexScoreText || "—";
      const subtitle =
        scoreText.includes("/") && !scoreText.includes("pending")
          ? "Great job!"
          : "Exam complete";

      // Safe top spacing for notch/edge
      const topInset = Math.max(22, height * 0.045);

      // Badge sizes
      const messageFont = Math.max(28, Math.round(width * 0.055));
      const scoreFont = Math.max(46, Math.round(width * 0.09));
      const subFont = Math.max(18, Math.round(width * 0.032));

      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      // Message badge
      ctx.font = `800 ${messageFont}px system-ui, sans-serif`;
      const msgWidth = ctx.measureText(message).width;
      const msgBoxW = msgWidth + 42;
      const msgBoxH = messageFont + 20;
      const msgBoxX = (width - msgBoxW) / 2;
      const msgBoxY = topInset;

      drawRoundedRect(ctx, msgBoxX, msgBoxY, msgBoxW, msgBoxH, 18, "rgba(0,0,0,0.34)");
      ctx.fillStyle = "#ffffff";
      ctx.fillText(message, width / 2, msgBoxY + msgBoxH / 2 + 1);

      // Score badge
      ctx.font = `900 ${scoreFont}px system-ui, sans-serif`;
      const scoreWidth = ctx.measureText(scoreText).width;
      ctx.font = `700 ${subFont}px system-ui, sans-serif`;
      const subWidth = ctx.measureText(subtitle).width;

      const scoreBoxW = Math.max(scoreWidth, subWidth) + 54;
      const scoreBoxH = scoreFont + subFont + 36;
      const scoreBoxX = (width - scoreBoxW) / 2;
      const scoreBoxY = msgBoxY + msgBoxH + 14;

      drawRoundedRect(ctx, scoreBoxX, scoreBoxY, scoreBoxW, scoreBoxH, 22, "rgba(255,255,255,0.18)", "rgba(255,255,255,0.32)");

      ctx.fillStyle = "#ffffff";
      ctx.font = `900 ${scoreFont}px system-ui, sans-serif`;
      ctx.fillText(scoreText, width / 2, scoreBoxY + scoreFont * 0.6);

      ctx.font = `700 ${subFont}px system-ui, sans-serif`;
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.fillText(subtitle, width / 2, scoreBoxY + scoreFont + 16);

      // Framing guide near bottom
      ctx.font = `600 ${Math.max(16, Math.round(width * 0.025))}px system-ui, sans-serif`;
      drawRoundedRect(
        ctx,
        width * 0.17,
        height - Math.max(54, height * 0.1),
        width * 0.66,
        34,
        16,
        "rgba(0,0,0,0.26)"
      );
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.fillText(
        "Center your face below the score badge",
        width / 2,
        height - Math.max(37, height * 0.082)
      );

      // Soft vignette
      drawFlexVignette(ctx, width, height);
    }

    flexRenderFrame = requestAnimationFrame(drawFlexFrame);
  }


  async function startFlexCamera() {
    const status = $("flexStatus");
    const panel = $("flexScorePanel");
    if (panel && "open" in panel) panel.open = true;
    try {
      stopFlexCamera();
      flexCameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "user" }, width: { ideal: 720 }, height: { ideal: 1280 } },
        audio: false
      });
      const video = $("flexCameraVideo");
      video.srcObject = flexCameraStream;
      await video.play();
      $("flexCameraStage")?.classList.remove("hidden");
      $("flexCaptureActions")?.classList.remove("hidden");
      $("flexMediaResult")?.classList.add("hidden");
      $("flexPhotoPreview")?.classList.add("hidden");
      $("flexVideoPreview")?.classList.add("hidden");
      if (status) status.textContent = "";
      drawFlexFrame();
    } catch (error) {
      if (status) status.textContent = `Could not open the front camera: ${error?.message || error}`;
      $("flexMediaResult")?.classList.remove("hidden");
    }
  }

  function makeFlexFileName(ext) {
    const exam = String(flexExamTitle || "Exam").replace(/[^a-z0-9]+/gi,"-").replace(/^-|-$/g,"").slice(0,40) || "Exam";
    return `Flex-Score-${exam}-${Date.now()}.${ext}`;
  }

  function canvasToBlob(canvas, type = "image/png", quality = 0.95) {
    return new Promise(resolve => canvas.toBlob(resolve, type, quality));
  }

  async function captureFlexPhoto() {
    const canvas = $("flexCameraCanvas");
    if (!canvas) return;
    const blob = await canvasToBlob(canvas, "image/png");
    if (!blob) return;
    flexMediaBlob = blob;
    flexMediaFileName = makeFlexFileName("png");
    const url = URL.createObjectURL(blob);
    const img = $("flexPhotoPreview");
    const vid = $("flexVideoPreview");
    if (vid?.src) URL.revokeObjectURL(vid.src);
    if (img?.src) URL.revokeObjectURL(img.src);
    if (img) { img.src=url; img.classList.remove("hidden"); }
    vid?.classList.add("hidden");
    $("flexMediaResult")?.classList.remove("hidden");
    stopFlexCamera();
    $("flexStatus").textContent = "Photo ready. Use Share / Save to Phone, or Download.";
  }

  function bestVideoMimeType() {
    const types = ["video/mp4;codecs=h264","video/webm;codecs=vp9","video/webm;codecs=vp8","video/webm"];
    return types.find(type => window.MediaRecorder?.isTypeSupported?.(type)) || "";
  }

  async function startFlexVideo() {
    const canvas = $("flexCameraCanvas");
    if (!canvas || !window.MediaRecorder || !canvas.captureStream) {
      $("flexStatus").textContent = "Video capture is not supported by this browser. You can still take a photo.";
      $("flexMediaResult")?.classList.remove("hidden");
      return;
    }
    flexRecordedChunks = [];
    const stream = canvas.captureStream(30);
    const mimeType = bestVideoMimeType();
    try {
      flexRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch (error) {
      $("flexStatus").textContent = "Video recording could not start on this device.";
      $("flexMediaResult")?.classList.remove("hidden");
      return;
    }
    flexRecorder.ondataavailable = event => { if (event.data?.size) flexRecordedChunks.push(event.data); };
    flexRecorder.onstop = () => {
      const type = flexRecorder?.mimeType || mimeType || "video/webm";
      flexMediaBlob = new Blob(flexRecordedChunks,{type});
      const ext = type.includes("mp4") ? "mp4" : "webm";
      flexMediaFileName = makeFlexFileName(ext);
      const url = URL.createObjectURL(flexMediaBlob);
      const vid = $("flexVideoPreview");
      const img = $("flexPhotoPreview");
      if (vid?.src) URL.revokeObjectURL(vid.src);
      if (img?.src) URL.revokeObjectURL(img.src);
      if (vid) { vid.src=url; vid.classList.remove("hidden"); }
      img?.classList.add("hidden");
      $("flexMediaResult")?.classList.remove("hidden");
      stopFlexCamera();
      $("flexVideoBtn")?.classList.remove("hidden");
      $("flexStopVideoBtn")?.classList.add("hidden");
      $("flexStatus").textContent = "Video ready. Use Share / Save to Phone, or Download.";
    };
    flexRecorder.start(250);
    $("flexVideoBtn")?.classList.add("hidden");
    $("flexStopVideoBtn")?.classList.remove("hidden");
    $("flexStatus").textContent = "Recording…";
    $("flexMediaResult")?.classList.remove("hidden");
    flexRecordingTimer = setTimeout(()=>stopFlexVideo(),10000);
  }

  function stopFlexVideo() {
    clearTimeout(flexRecordingTimer);
    flexRecordingTimer = null;
    if (flexRecorder && flexRecorder.state !== "inactive") {
      flexRecorder.stop();
    }
  }

  async function shareFlexMedia() {
    if (!flexMediaBlob) return;
    const file = new File([flexMediaBlob], flexMediaFileName, {type:flexMediaBlob.type});
    const status = $("flexStatus");
    if (navigator.canShare?.({files:[file]}) && navigator.share) {
      try {
        await navigator.share({
          files:[file],
          title:"My exam score",
          text:`${$("flexMessageSelect")?.value || "I made it!"} ${flexScoreText}`
        });
        status.textContent = "Share sheet opened. Choose Photos/Gallery, Files, or another app.";
        return;
      } catch (error) {
        if (error?.name === "AbortError") return;
      }
    }
    downloadFlexMedia();
    status.textContent = "Your browser cannot share files directly, so the media was downloaded instead.";
  }

  function downloadFlexMedia() {
    if (!flexMediaBlob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(flexMediaBlob);
    a.download = flexMediaFileName || "Flex-Score";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href),2000);
  }

  function bindFlexScoreControls() {
    $("flexStartCameraBtn")?.addEventListener("click", startFlexCamera);
    $("flexCloseCameraBtn")?.addEventListener("click", stopFlexCamera);
    $("flexPhotoBtn")?.addEventListener("click", captureFlexPhoto);
    $("flexVideoBtn")?.addEventListener("click", startFlexVideo);
    $("flexStopVideoBtn")?.addEventListener("click", stopFlexVideo);
    $("flexShareBtn")?.addEventListener("click", shareFlexMedia);
    $("flexDownloadBtn")?.addEventListener("click", downloadFlexMedia);
    $("flexRetakeBtn")?.addEventListener("click", ()=>{
      $("flexMediaResult")?.classList.add("hidden");
      $("flexPhotoPreview")?.classList.add("hidden");
      $("flexVideoPreview")?.classList.add("hidden");
      if (!flexCameraStream?.active) startFlexCamera();
    });
    $("flexMessageSelect")?.addEventListener("change",()=>{
      const msg=$("flexLiveMessage");
      if(msg) msg.textContent=$("flexMessageSelect").value;
    });
  }

  bindFlexScoreControls();

  $("clearSiteDataBtn")?.addEventListener("click", async () => {
    const ok = confirm(
      "Delete this exam site's local browser data on this device? This clears local/session storage, site caches, accessible cookies, and saved browser-side exam state. It does not delete exam records stored in Supabase."
    );
    if (!ok) return;

    try {
      clearExamBrowserState({ keepDeviceSession: false });

      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch (_) {}

      if (window.caches?.keys) {
        const names = await caches.keys();
        await Promise.all(names.map(name => caches.delete(name)));
      }

      if (navigator.serviceWorker?.getRegistrations) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map(registration => registration.unregister()));
      }

      document.cookie.split(";").forEach(cookie => {
        const eqPos = cookie.indexOf("=");
        const name = (eqPos > -1 ? cookie.slice(0, eqPos) : cookie).trim();
        if (!name) return;
        document.cookie = `${name}=; Max-Age=0; path=/; SameSite=Lax`;
      });

      if (indexedDB?.databases) {
        const databases = await indexedDB.databases();
        for (const database of databases) {
          if (database?.name) indexedDB.deleteDatabase(database.name);
        }
      }

      $("loginMsg").textContent = "Local site data was cleared. The page will reload.";
      setTimeout(() => location.reload(), 700);
    } catch (error) {
      $("loginMsg").textContent = `Some local site data could not be cleared: ${error?.message || error}`;
    }
  });

  resetPreflightStatus();

  $("startBtn").addEventListener("click", async () => {
    const examCode = $("examCode").value.trim();
    const studentNo = $("studentNo").value.trim();
    const consent = $("consentBox").checked;
    const msg = $("loginMsg");

    if (!examCode || !studentNo) {
      msg.textContent = "Complete the exam code and Student ID.";
      return;
    }
    if (!consent) {
      msg.textContent = "Please acknowledge the monitoring notice before starting.";
      return;
    }

    if (!attempt) {
      // Remove stale data from older completed/deleted attempts before checking a new login.
      clearExamBrowserState();
    }

    msg.textContent = "Checking Exam Code and Student ID…";
    setPreflightStatus("exam","checking","Checking");
    setPreflightStatus("student","checking","Checking");
    setPreflightStatus("camera","idle","Not checked");
    setPreflightStatus("microphone","idle","Not checked");
    setPreflightStatus("session","idle","Not checked");
    $("startBtn").disabled = true;

    const { data, error } = await db.rpc("preview_exam_identity", {
      p_exam_code: examCode,
      p_student_no: studentNo
    });

    $("startBtn").disabled = false;

    if (error || !data?.length) {
      const detail = String(error?.message || error?.details || error?.hint || "");

      if (/preview_exam_identity|function.*does not exist|schema cache|PGRST202/i.test(detail)) {
        // Backward-compatible mode for live databases that have not yet installed
        // the identity-preview RPC. The actual start_exam RPC still validates
        // the exam code and Student ID server-side.
        setPreflightStatus("exam","warning","Will verify when starting");
        setPreflightStatus("student","warning","Will verify when starting");
        pendingIdentity = {
          examCode,
          studentNo,
          studentName: studentNo,
          examTitle: examCode
        };

        msg.textContent = "";
        $("identityStudentName").textContent = studentNo;
        $("identityStudentNo").textContent = studentNo;
        $("identityExamTitle").textContent = examCode;
        $("identityConfirmQuestion").textContent = `Proceed with Student ID ${studentNo}?`;
        $("identityConfirmMsg").textContent = "The server will verify your Exam Code and Student ID when you start.";
        $("identityConfirmModal").classList.remove("hidden");
        $("identityYesBtn").focus();
        return;
      }

      setPreflightStatus("exam","error","Unavailable");
      setPreflightStatus("student","error","Not verified");
      msg.textContent = explainStartError(error?.message || detail || "Could not verify the Exam Code and Student ID.");
      return;
    }

    const identity = data[0];
    setPreflightStatus("exam","ready","Published and open");
    setPreflightStatus("student","ready", identity.student_name || "Verified");
    pendingIdentity = {
      examCode,
      studentNo: identity.student_no || studentNo,
      studentName: identity.student_name || "",
      examTitle: identity.exam_title || ""
    };

    msg.textContent = "";
    $("identityStudentName").textContent = pendingIdentity.studentName;
    $("identityStudentNo").textContent = pendingIdentity.studentNo;
    $("identityExamTitle").textContent = pendingIdentity.examTitle;
    $("identityConfirmQuestion").textContent = `Are you really ${pendingIdentity.studentName}?`;
    $("identityConfirmMsg").textContent = "";
    $("identityConfirmModal").classList.remove("hidden");
    $("identityYesBtn").focus();
  });

  $("identityNoBtn").addEventListener("click", () => {
    pendingIdentity = null;
    $("identityConfirmModal").classList.add("hidden");
    $("studentNo").focus();
    $("studentNo").select();
    $("loginMsg").textContent = "Please enter your own Student ID.";
  });

  function hideTeacherLiveMessage() {
    $("teacherLiveMessage")?.classList.add("hidden");
  }

  function showTeacherLiveMessage(item) {
    if (!item?.message) return;
    const banner = $("teacherLiveMessage");
    if (!banner) return;
    $("teacherLiveMessageText").textContent = item.message;
    $("teacherLiveMessageTime").textContent = item.created_at
      ? "Sent " + new Date(item.created_at).toLocaleTimeString()
      : "Just now";
    banner.classList.remove("hidden");
    banner.classList.remove("teacher-message-arrive");
    void banner.offsetWidth;
    banner.classList.add("teacher-message-arrive");
    if (navigator.vibrate) {
      try { navigator.vibrate([100,60,100]); } catch (_) {}
    }
  }

  function showRestoreAnswersPrompt(item) {
    pendingRestoreMessage = item || null;
    const modal = $("restoreAnswersModal");
    if (!modal) return;

    const textNode = $("restoreAnswersText");
    if (textNode) {
      textNode.textContent =
        "Your teacher found saved responses from this exam attempt. Do you want to restore them into blank answer fields now?";
    }

    modal.classList.remove("hidden");
    if (navigator.vibrate) {
      try { navigator.vibrate([120,70,120]); } catch (_) {}
    }
  }

  function hideRestoreAnswersPrompt() {
    $("restoreAnswersModal")?.classList.add("hidden");
    pendingRestoreMessage = null;
  }

  async function restoreSavedResponsesIntoCurrentForm() {
    if (!attempt?.attempt_token || submitted || !examForm) return 0;

    const { data, error } = await db.rpc("get_saved_exam_responses", {
      p_attempt_token: attempt.attempt_token
    });
    if (error) {
      warn("Your teacher requested answer restoration, but the saved responses could not be loaded. Please inform your teacher.");
      return 0;
    }

    let restoredCount = 0;

    for (const row of data || []) {
      const questionId = String(row.question_id || "");
      const savedAnswer = String(row.answer ?? "");
      if (!questionId || !savedAnswer.trim()) continue;

      const wrap = examForm.querySelector(`[data-question-id="${CSS.escape(questionId)}"]`);
      if (!wrap) continue;

      // Never overwrite something the student currently sees in the answer field.
      const visibleAnswer = currentAnswerForQuestion(questionId);
      if (String(visibleAnswer ?? "").trim()) continue;

      // If this browser has a newer local draft, prefer that draft over the older
      // server copy. Otherwise use the Supabase-saved answer the teacher requested.
      const localDraft = loadLocalDraft(questionId);
      const answerToRestore = localDraft?.answer?.trim()
        ? String(localDraft.answer)
        : savedAnswer;

      const radioInputs = [...wrap.querySelectorAll('input[type="radio"]')];
      if (radioInputs.length) {
        const match = radioInputs.find(input => String(input.value) === answerToRestore);
        if (match) {
          match.checked = true;
          restoredCount += 1;
        }
      } else {
        const mathBoard = wrap.querySelector(".math-solver-board");
        if (mathBoard) {
          const parsed = parseSavedMathResponse(answerToRestore);
          const solution = mathBoard.querySelector(".math-solution-input");
          const finalAnswer = mathBoard.querySelector(".math-final-answer-input");
          if (solution) solution.value = parsed.solution;
          if (finalAnswer) finalAnswer.value = parsed.finalAnswer;
          restoredCount += 1;
        } else {
          const field = wrap.querySelector("textarea, input.short-response-input, input[type='text']");
          if (field) {
            field.value = answerToRestore;
            restoredCount += 1;
          }
        }
      }

      if (restoredCount > 0) {
        saveLocalDraft(questionId, answerToRestore);
        const state = wrap.querySelector(".save-state");
        if (state) {
          state.textContent = localDraft?.answer?.trim()
            ? "Recovered browser draft"
            : "Restored from saved attempt";
          state.style.color = "";
        }
      }
    }

    if (restoredCount > 0) {
      warn(`${restoredCount} saved response${restoredCount === 1 ? " was" : "s were"} restored. Please review your answers before submitting.`);
      await logEvent("saved_responses_restored_to_browser", {
        restored_count: restoredCount
      });
    } else {
      warn("Your teacher sent a restore request, but no blank answers needed restoration.");
    }

    return restoredCount;
  }

  async function pollAttemptMessages({ initial = false } = {}) {
    if (!attempt?.attempt_token || submitted) return;

    const { data, error } = await db.rpc("get_attempt_messages", {
      p_attempt_token: attempt.attempt_token,
      p_after: initial ? null : lastAttemptMessageAt
    });

    if (error) {
      if (/get_attempt_messages|function.*does not exist|schema cache/i.test(String(error.message || ""))) {
        clearInterval(attemptMessagePollHandle);
        attemptMessagePollHandle = null;
      }
      return;
    }

    const messages = Array.isArray(data) ? data : [];
    if (!messages.length) return;

    for (const item of messages) {
      if (item.message_type === "restore_saved_responses") {
        showRestoreAnswersPrompt(item);
      }
    }

    const latest = messages[messages.length - 1];
    lastAttemptMessageAt = latest.created_at || lastAttemptMessageAt;
    showTeacherLiveMessage(latest);
  }

  function startAttemptMessagePolling() {
    clearInterval(attemptMessagePollHandle);
    lastAttemptMessageAt = null;
    hideTeacherLiveMessage();
    if (!attempt?.attempt_token || submitted) return;
    pollAttemptMessages({ initial: true });
    attemptMessagePollHandle = setInterval(() => pollAttemptMessages(), 3000);
  }

  function stopAttemptMessagePolling() {
    clearInterval(attemptMessagePollHandle);
    attemptMessagePollHandle = null;
  }

  $("dismissTeacherMessageBtn")?.addEventListener("click", hideTeacherLiveMessage);

  $("acceptRestoreAnswersBtn")?.addEventListener("click", async () => {
    const button = $("acceptRestoreAnswersBtn");
    if (button) {
      button.disabled = true;
      button.textContent = "Restoring…";
    }

    const restored = await restoreSavedResponsesIntoCurrentForm();

    if (button) {
      button.disabled = false;
      button.textContent = "Yes, Restore My Answers";
    }

    hideRestoreAnswersPrompt();

    if (restored > 0) {
      showTeacherLiveMessage({
        message: `${restored} saved response${restored === 1 ? " was" : "s were"} restored. Please review your answers before submitting.`,
        created_at: new Date().toISOString()
      });
    }
  });

  $("declineRestoreAnswersBtn")?.addEventListener("click", async () => {
    const declinedMessage = pendingRestoreMessage;
    hideRestoreAnswersPrompt();
    warn("Restore skipped. You can ask your teacher to send it again if needed.");
    await logEvent("saved_responses_restore_declined", {
      message_id: declinedMessage?.message_id || null
    });
  });

  $("identityYesBtn").addEventListener("click", async () => {
    if (!pendingIdentity) return;

    const identity = { ...pendingIdentity };
    const confirmMsg = $("identityConfirmMsg");
    const yesBtn = $("identityYesBtn");
    const noBtn = $("identityNoBtn");

    confirmMsg.textContent = "";
    yesBtn.disabled = true;
    noBtn.disabled = true;

    // Start the server-side exam session first. Browser monitoring is important,
    // but a temporary permission/API issue must not prevent a valid student
    // from entering the examination.
    setPreflightStatus("session","checking","Checking exam and session");
    confirmMsg.textContent = "Starting exam session…";

    const deviceSession = getExamDeviceSessionId();
    let startResult = await db.rpc("start_exam", {
      p_exam_code: identity.examCode,
      p_student_no: identity.studentNo,
      p_user_agent: navigator.userAgent,
      p_device_session: deviceSession
    });

    // Backward compatibility for a live database that still has the older
    // 3-argument start_exam signature.
    if (startResult.error && /start_exam|function.*does not exist|schema cache|PGRST202/i.test(String(startResult.error.message || ""))) {
      startResult = await db.rpc("start_exam", {
        p_exam_code: identity.examCode,
        p_student_no: identity.studentNo,
        p_user_agent: navigator.userAgent
      });
    }

    const { data, error } = startResult;

    if (error || !data?.length) {
      yesBtn.disabled = false;
      noBtn.disabled = false;
      const rawStartError = error?.message || "Could not start the exam.";
      setPreflightStatus("session","error", explainStartError(rawStartError));
      confirmMsg.textContent = explainStartError(rawStartError);
      return;
    }

    setPreflightStatus("session","ready","Session ready");
    attempt = data[0];

    // Fullscreen is best-effort. iOS browsers may not provide the Fullscreen API.
    try {
      await enterFullscreen();
    } catch (_) {}

    // Monitoring permissions are now best-effort and visible in the preflight.
    try {
      setPreflightStatus("camera","checking","Requesting permission");
      confirmMsg.textContent = "Starting front-camera monitoring…";
      await requestFrontCamera();
      setPreflightStatus("camera","ready","Ready");
    } catch (cameraError) {
      setPreflightStatus("camera","warning","Unavailable");
      await logEvent("camera_monitoring_unavailable_at_start", {
        message: String(cameraError?.message || cameraError).slice(0,300)
      });
    }

    try {
      setPreflightStatus("microphone","checking","Requesting permission");
      confirmMsg.textContent = "Starting microphone monitoring…";
      await requestMicrophone();
      setPreflightStatus("microphone","ready","Ready");
    } catch (microphoneError) {
      setPreflightStatus("microphone","warning","Unavailable");
      resetMicrophoneLevel();
      updateMicrophoneStatus("Microphone unavailable");
      await logEvent("microphone_monitoring_unavailable_at_start", {
        message: String(microphoneError?.message || microphoneError).slice(0,300)
      });
    }

    confirmMsg.textContent = "";

    pendingIdentity = null;
    $("identityConfirmModal").classList.add("hidden");

    // A genuinely new/restarted attempt must not inherit stale browser state
    // from a prior deleted or submitted attempt.
    clearExamBrowserState({ keepDeviceSession: true });
    sessionStorage.setItem("exam_guard_token", attempt.attempt_token);
    try { localStorage.setItem("exam_guard_token", attempt.attempt_token); } catch (_) {}
    resetExamFlagCounts();
    updateMobileMonitoringCapabilityNote();
    startAttemptMessagePolling();

    let existingResponses = [];
    const { data: savedOnStart, error: savedOnStartError } = await db.rpc("get_saved_exam_responses", {
      p_attempt_token: attempt.attempt_token
    });
    if (!savedOnStartError) existingResponses = savedOnStart || [];

    const examLoaded = await loadExam({ restored: existingResponses.length > 0, savedResponses: existingResponses });
    if (!examLoaded) return;
    if (cameraStream?.active) startCameraCaptureSchedule();
    if (microphoneStream?.active) await startSpeechMonitoring();
  });

  async function loadExam({ restored = false, savedResponses = [] } = {}) {
    const { data, error } = await db.rpc("get_exam_questions", {
      p_attempt_token: attempt.attempt_token
    });
    if (error) {
      const detail = String(error?.message || error?.details || error?.hint || "");
      if (/get_exam_questions|function.*does not exist|schema cache|PGRST202/i.test(detail)) {
        $("loginMsg").textContent = "Your exam session started, but the live Supabase question API is not compatible with this site version. Your attempt is preserved. Please inform the teacher/admin.";
      } else {
        $("loginMsg").textContent = `Your exam session started, but the questions could not be loaded: ${error.message || "Unknown error"}. Refresh this page once to restore the same attempt.`;
      }
      setPreflightStatus("session","warning","Session started • question loading failed");
      $("startBtn").disabled = false;
      return false;
    }

    questions = data || [];
    loginView.classList.add("hidden");
    examView.classList.remove("hidden");
    $("examTitle").textContent = attempt.exam_title;
    $("studentLabel").textContent = `${attempt.student_name} • ${attempt.student_no}`;
    watermark.textContent = Array(18).fill(`${attempt.student_name}  ${attempt.student_no}`).join("     ");
    watermark.classList.add("active");

    renderQuestions(savedResponses);
    startTimer();

    if (restored) {
      warn("Your saved exam session has been restored.");
      await logEvent("exam_session_restored", {
        userAgent: navigator.userAgent,
        screen: `${screen.width}x${screen.height}`,
        savedResponses: savedResponses.length
      });
    } else {
      await logEvent("exam_started", {
        userAgent: navigator.userAgent,
        screen: `${screen.width}x${screen.height}`
      });
    }

    return true;
  }

  function renderMathContent(element, text) {
    if (!element) return;
    element.replaceChildren();
    element.classList.add("math-rendered");

    appendLatexRichText(element, String(text || ""));

    if (window.MathJax?.typesetPromise) {
      window.MathJax.typesetClear?.([element]);
      window.MathJax.typesetPromise([element]).catch(() => {});
    }
  }

  function appendLatexRichText(parent, source) {
    const commandPattern = /\\(textit|emph|textbf|underline)\{([^{}]*)\}/g;
    let cursor = 0;
    let match;

    while ((match = commandPattern.exec(source)) !== null) {
      if (match.index > cursor) {
        parent.appendChild(document.createTextNode(source.slice(cursor, match.index)));
      }

      const tag = match[1] === "textbf"
        ? "strong"
        : (match[1] === "underline" ? "u" : "em");
      const node = document.createElement(tag);
      node.textContent = match[2];
      parent.appendChild(node);
      cursor = match.index + match[0].length;
    }

    if (cursor < source.length) {
      parent.appendChild(document.createTextNode(source.slice(cursor)));
    }
  }

  function compileStudentGraphExpression(source) {
    const raw=String(source||"").trim().toLowerCase();
    if(!raw) throw new Error("Graph expression is empty.");
    let expr=raw.replace(/π/g,"pi").replace(/\^/g,"**");
    const allowed=["sin","cos","tan","asin","acos","atan","sqrt","abs","exp","log","ln","floor","ceil","pi","e","x"];
    const scrubbed=expr.replace(/[a-z]+/g,name=>allowed.includes(name)?"":"BAD");
    if(/BAD|[^0-9+\-*/().,\s*]/.test(scrubbed)) throw new Error("Unsupported graph expression.");
    expr=expr
      .replace(/\bln\b/g,"Math.log").replace(/\blog\b/g,"Math.log10")
      .replace(/\bsin\b/g,"Math.sin").replace(/\bcos\b/g,"Math.cos").replace(/\btan\b/g,"Math.tan")
      .replace(/\basin\b/g,"Math.asin").replace(/\bacos\b/g,"Math.acos").replace(/\batan\b/g,"Math.atan")
      .replace(/\bsqrt\b/g,"Math.sqrt").replace(/\babs\b/g,"Math.abs").replace(/\bexp\b/g,"Math.exp")
      .replace(/\bfloor\b/g,"Math.floor").replace(/\bceil\b/g,"Math.ceil")
      .replace(/\bpi\b/g,"Math.PI").replace(/\be\b/g,"Math.E");
    const fn=new Function("x",`"use strict";return (${expr});`);
    return x=>{const y=Number(fn(x));return Number.isFinite(y)?y:NaN;};
  }

  function drawStudentStimulusGraph(canvas,payload={}) {
    const width=640,height=360,dpr=Math.min(window.devicePixelRatio||1,2);
    canvas.width=width*dpr;canvas.height=height*dpr;canvas.style.aspectRatio="16 / 9";
    const ctx=canvas.getContext("2d");ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.fillStyle="#fff";ctx.fillRect(0,0,width,height);
    const xmin=Number(payload.xmin),xmax=Number(payload.xmax),ymin=Number(payload.ymin),ymax=Number(payload.ymax);
    if(!(xmax>xmin)||!(ymax>ymin)) throw new Error("Invalid graph range.");
    const px=x=>((x-xmin)/(xmax-xmin))*width,py=y=>height-((y-ymin)/(ymax-ymin))*height;
    ctx.strokeStyle="#e5e7eb";ctx.lineWidth=1;
    for(let i=0;i<=10;i++){const x=i*width/10;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,height);ctx.stroke();}
    for(let i=0;i<=8;i++){const y=i*height/8;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(width,y);ctx.stroke();}
    ctx.strokeStyle="#64748b";ctx.lineWidth=1.5;
    if(xmin<=0&&xmax>=0){const x0=px(0);ctx.beginPath();ctx.moveTo(x0,0);ctx.lineTo(x0,height);ctx.stroke();}
    if(ymin<=0&&ymax>=0){const y0=py(0);ctx.beginPath();ctx.moveTo(0,y0);ctx.lineTo(width,y0);ctx.stroke();}
    const fn=compileStudentGraphExpression(payload.expression);
    ctx.strokeStyle="#111827";ctx.lineWidth=2.2;ctx.beginPath();let drawing=false;
    for(let i=0;i<=width;i++){const x=xmin+(i/width)*(xmax-xmin),y=fn(x),sy=py(y);if(!Number.isFinite(y)||sy<-height||sy>height*2){drawing=false;continue;}if(!drawing){ctx.moveTo(i,sy);drawing=true;}else ctx.lineTo(i,sy);}
    ctx.stroke();
    ctx.fillStyle="#475569";ctx.font="13px sans-serif";
    ctx.fillText(`x: ${xmin} to ${xmax}`,10,height-10);
    ctx.fillText(`y: ${ymin} to ${ymax}`,width-105,height-10);
  }

  function buildQuestionStimulus(q) {
    const type=String(q?.stimulus_type||"none");
    const payload=q?.stimulus_payload&&typeof q.stimulus_payload==="object"?q.stimulus_payload:{};
    if(type==="none") return null;
    const figure=document.createElement("figure");figure.className="item-stimulus";
    if(type==="image"&&payload.url){
      const img=document.createElement("img");img.src=payload.url;img.alt=String(payload.alt||"Question stimulus");img.className="item-stimulus-image";figure.appendChild(img);
    }else if(type==="graph"){
      const canvas=document.createElement("canvas");canvas.className="item-stimulus-graph stimulus-graph-canvas";figure.appendChild(canvas);
      try{drawStudentStimulusGraph(canvas,payload);}catch(error){const p=document.createElement("p");p.className="message-inline error";p.textContent="Graph stimulus could not be displayed.";figure.appendChild(p);}
    }else if(type==="latex"&&payload.latex){
      const div=document.createElement("div");div.className="item-stimulus-latex math-rendered";div.textContent=String(payload.latex);figure.appendChild(div);
      if(window.MathJax?.typesetPromise){window.MathJax.typesetClear?.([div]);window.MathJax.typesetPromise([div]).catch(()=>{});}
    }else{
      return null;
    }
    if(payload.caption){const cap=document.createElement("figcaption");cap.textContent=String(payload.caption);figure.appendChild(cap);}
    return figure;
  }

  function renderQuestions(savedResponses = []) {
    examForm.innerHTML = "";
    submittedEssayQuestionIds.clear();
    const savedByQuestion = new Map(
      (savedResponses || []).map(r => [String(r.question_id), r])
    );

    let currentSectionTitle = null;

    for (const q of questions) {
      const sectionTitle = String(q.section_title || "Part 1").trim() || "Part 1";
      if (sectionTitle !== currentSectionTitle) {
        const sectionHeading = document.createElement("section");
        sectionHeading.className = "student-exam-section-heading";
        sectionHeading.textContent = sectionTitle;
        examForm.appendChild(sectionHeading);
        currentSectionTitle = sectionTitle;
      }

      const wrap = document.createElement("section");
      wrap.className = "question";
      wrap.dataset.questionId = q.question_id;

      const head = document.createElement("div");
      head.className = "q-head";
      const pointLabel = q.question_type === "essay"
        ? `${q.points} rubric point${q.points == 1 ? "" : "s"}`
        : `${q.points} point${q.points == 1 ? "" : "s"}`;
      head.innerHTML = `<span class="q-no">Question ${q.position}</span><span class="points">${pointLabel}</span>`;
      wrap.appendChild(head);

      const prompt = document.createElement("div");
      prompt.className = "prompt";
      renderMathContent(prompt, q.prompt);
      wrap.appendChild(prompt);

      const stimulus = buildQuestionStimulus(q);
      if (stimulus) wrap.appendChild(stimulus);

      const state = document.createElement("div");
      state.className = "save-state";
      const saved = savedByQuestion.get(String(q.question_id));
      const essayAlreadySubmitted = q.question_type === "essay" && Boolean(saved?.essay_submitted_at);
      if (essayAlreadySubmitted) submittedEssayQuestionIds.add(String(q.question_id));

      state.textContent = essayAlreadySubmitted
        ? `Essay submitted ${new Date(saved.essay_submitted_at).toLocaleTimeString()}`
        : (saved
          ? `Saved ${saved.saved_at ? new Date(saved.saved_at).toLocaleTimeString() : ""}`.trim()
          : "Not answered");

      if (q.question_type === "mcq" || q.question_type === "binary") {
        const choices = Array.isArray(q.choices) && q.choices.length
          ? q.choices
          : (q.question_type === "binary" ? ["True", "False"] : []);

        choices.forEach((choice, i) => {
          const label = document.createElement("label");
          label.className = "choice";
          const radio = document.createElement("input");
          radio.type = "radio";
          radio.name = `q_${q.question_id}`;
          radio.value = String(choice);
          if (saved && String(saved.answer ?? "") === radio.value) {
            radio.checked = true;
          }
          radio.addEventListener("change", () => {
            saveLocalDraft(q.question_id, radio.value);
            saveAnswer(q.question_id, radio.value, state);
          });

          const span = document.createElement("span");
          const prefix = q.question_type === "mcq" ? `${String.fromCharCode(65+i)}. ` : "";
          renderMathContent(span, `${prefix}${choice}`);

          label.append(radio, span);
          wrap.appendChild(label);
        });
      } else {
        let ta;

        if (q.question_type === "math_solver") {
          const solver = createMathSolverBoard(q, saved, state);
          ta = solver.textarea;
          wrap.appendChild(solver.container);
        } else {
          ta = document.createElement(q.question_type === "short_response" ? "input" : "textarea");
          if (q.question_type !== "short_response") {
            ta.rows = q.question_type === "essay" ? 9 : 5;
          }
          ta.className = q.question_type === "short_response" ? "short-response-input" : "";
          ta.placeholder = q.question_type === "essay"
            ? "Write your essay response here"
            : "Type your answer here";
          const localDraft = loadLocalDraft(q.question_id);
          if (essayAlreadySubmitted && saved) {
            ta.value = String(saved.answer ?? "");
            ta.readOnly = true;
            ta.classList.add("essay-submitted-response");
          } else if (localDraft) {
            ta.value = localDraft.answer;
            state.textContent = "Recovered local draft";
          } else if (saved) {
            ta.value = String(saved.answer ?? "");
          }

          let debounce;
          ta.addEventListener("input", () => {
            if (q.question_type === "essay" && submittedEssayQuestionIds.has(String(q.question_id))) return;
            saveLocalDraft(q.question_id, ta.value);
            state.textContent = "Saving…";
            clearTimeout(debounce);
            debounce = setTimeout(() => saveAnswer(q.question_id, ta.value, state), 350);
          });
          wrap.appendChild(ta);

          if (q.question_type === "essay") {
            const essayActions = document.createElement("div");
            essayActions.className = "essay-submit-actions";

            const essaySubmitBtn = document.createElement("button");
            essaySubmitBtn.type = "button";
            essaySubmitBtn.className = "essay-submit-btn";

            if (essayAlreadySubmitted) {
              essaySubmitBtn.textContent = "Submitted ✓";
              essaySubmitBtn.disabled = true;
            } else {
              essaySubmitBtn.textContent = "Submit This Essay";
              essaySubmitBtn.addEventListener("click", () => {
                submitSingleEssay(q, ta, state, essaySubmitBtn);
              });
            }

            const essayNote = document.createElement("span");
            essayNote.className = "muted essay-submit-note";
            essayNote.textContent = essayAlreadySubmitted
              ? "This essay is locked and already included in your exam attempt."
              : "Submit this essay when finished. It will be saved and locked immediately.";

            essayActions.append(essaySubmitBtn, essayNote);
            wrap.appendChild(essayActions);
          }
        }

        if (q.question_type === "essay" && Array.isArray(q.rubric_criteria) && q.rubric_criteria.length) {
          const rubric = document.createElement("details");
          rubric.className = "student-rubric";
          const summary = document.createElement("summary");
          const holistic = q.rubric_type === "holistic";
          summary.textContent = holistic ? "View holistic scoring rubric" : "View analytic scoring rubric";
          rubric.appendChild(summary);

          const tableWrap = document.createElement("div");
          tableWrap.className = "student-rubric-table-wrap";
          const table = document.createElement("table");

          if (holistic) {
            table.innerHTML = "<thead><tr><th>Criteria (Max Score)</th><th>Description</th><th>Student Score</th></tr></thead>";
            const tbody = document.createElement("tbody");
            q.rubric_criteria.forEach(item => {
              const tr = document.createElement("tr");
              const criterion = document.createElement("td");
              const maxScore = Number(item?.max_points ?? 0);
              criterion.textContent = `${String(item?.criterion || "")} (${maxScore} point${maxScore === 1 ? "" : "s"})`;
              const description = document.createElement("td");
              description.textContent = String(item?.description || "");
              const score = document.createElement("td");
              score.textContent = "—";
              tr.append(criterion, description, score);
              tbody.appendChild(tr);
            });
            table.appendChild(tbody);
          } else {
            const isMatrix = q.rubric_criteria.every(item =>
              Array.isArray(item?.levels) && item.levels.length >= 2
            );

            const looksLikeLegacyConvertedRubric = isMatrix &&
              q.rubric_criteria.every(item => {
                const levels = Array.isArray(item?.levels) ? item.levels : [];
                if (levels.length !== 2) return false;
                const firstName = String(levels[0]?.level || "").trim().toLowerCase();
                const secondName = String(levels[1]?.level || "").trim().toLowerCase();
                const secondPoints = Number(levels[1]?.points ?? 0);
                return firstName === "maximum" &&
                  (/^level\s*2$/.test(secondName) || secondName === "") &&
                  secondPoints === 0;
              });

            if (!isMatrix || looksLikeLegacyConvertedRubric) {
              table.classList.add("flat-criteria-table");
              table.innerHTML = "<thead><tr><th>Criterion (Max Score)</th><th>Description</th></tr></thead>";
              const tbody = document.createElement("tbody");

              q.rubric_criteria.forEach(item => {
                const tr = document.createElement("tr");
                const levels = Array.isArray(item?.levels) ? item.levels : [];
                const legacyLevel = looksLikeLegacyConvertedRubric ? levels[0] : null;
                const maxPoints = legacyLevel
                  ? Number(legacyLevel?.points ?? 0)
                  : Number(item?.max_points ?? item?.points ?? 0);

                const criterion = document.createElement("td");
                criterion.textContent = `${String(item?.criterion || "")}${maxPoints ? ` (${maxPoints} pts)` : ""}`;

                const description = document.createElement("td");
                description.textContent = legacyLevel
                  ? String(legacyLevel?.description || "")
                  : String(item?.description || "");

                tr.append(criterion, description);
                tbody.appendChild(tr);
              });

              table.appendChild(tbody);
            } else {
              const firstLevels = q.rubric_criteria[0].levels;
              const thead = document.createElement("thead");
              const headerRow = document.createElement("tr");
              const criteriaHead = document.createElement("th");
              criteriaHead.textContent = "Criteria / Level of Performance";
              headerRow.appendChild(criteriaHead);

              firstLevels.forEach(level => {
                const th = document.createElement("th");
                const title = document.createElement("strong");
                title.textContent = String(level?.level || "");
                const points = document.createElement("span");
                points.className = "rubric-level-points";
                points.textContent = Number.isFinite(Number(level?.points)) ? `${level.points} pts` : "";
                th.append(title, points);
                headerRow.appendChild(th);
              });

              thead.appendChild(headerRow);
              table.appendChild(thead);

              const tbody = document.createElement("tbody");
              q.rubric_criteria.forEach(item => {
                const tr = document.createElement("tr");
                const criterion = document.createElement("td");
                criterion.textContent = String(item?.criterion || "");
                tr.appendChild(criterion);

                firstLevels.forEach((headerLevel, index) => {
                  const td = document.createElement("td");
                  const levels = item.levels;
                  const match = levels.find(level =>
                    String(level?.level || "").trim().toLowerCase() === String(headerLevel?.level || "").trim().toLowerCase()
                  ) || levels[index];
                  td.textContent = String(match?.description || "");
                  tr.appendChild(td);
                });

                tbody.appendChild(tr);
              });

              table.appendChild(tbody);
            }
          }

          tableWrap.appendChild(table);
          rubric.appendChild(tableWrap);
          wrap.appendChild(rubric);
        }
      }

      wrap.appendChild(state);
      examForm.appendChild(wrap);
    }
  }

  function createMathSolverBoard(question, saved, stateNode) {
    const container = document.createElement("div");
    container.className = "math-solver-board";

    const savedText = saved ? String(saved.answer ?? "") : "";
    const parsedSaved = parseSavedMathResponse(savedText);

    const solutionLabel = document.createElement("label");
    solutionLabel.className = "math-answer-label";
    solutionLabel.textContent = "Solution / working steps";

    const solution = document.createElement("textarea");
    solution.className = "math-solution-input";
    solution.rows = 4;
    solution.readOnly = true;
    solution.inputMode = "none";
    solution.placeholder = "Tap here, then use the mathematics keyboard below.";
    solution.value = parsedSaved.solution;

    const finalLabel = document.createElement("label");
    finalLabel.className = "math-answer-label math-final-label";
    finalLabel.textContent = "Final answer";

    const finalAnswer = document.createElement("input");
    finalAnswer.type = "text";
    finalAnswer.className = "math-final-answer-input";
    finalAnswer.readOnly = true;
    finalAnswer.inputMode = "none";
    finalAnswer.placeholder = "Tap here and enter only the final answer.";
    finalAnswer.value = parsedSaved.finalAnswer;

    const preview = document.createElement("div");
    preview.className = "math-solution-preview";

    const keyboard = document.createElement("div");
    keyboard.className = "math-virtual-keyboard hidden";

    const tabBar = document.createElement("div");
    tabBar.className = "math-keyboard-tabs math-keyboard-tabs-reference";

    const keyArea = document.createElement("div");
    keyArea.className = "math-keyboard-layout";

    let activeInput = solution;
    let alphabetShift = false;
    let alphabetGreek = false;
    let activeKeyboardTab = "123";

    const keyboardTabs = [
      { id:"123", label:"123" },
      { id:"fx", label:"f(x)" },
      { id:"abc", label:"ABC" },
      { id:"symbols", label:"#&¬" }
    ];

    const layouts = {
      "123": [
        [
          {label:"x",token:"x"},{label:"y",token:"y"},{label:"π",token:"π"},{label:"e",token:"e"},
          {label:"7",token:"7"},{label:"8",token:"8"},{label:"9",token:"9"},{label:"×",token:"×"},{label:"÷",token:"÷"}
        ],
        [
          {label:"□²",token:"square"},{label:"□^□",token:"power"},{label:"√□",token:"sqrt"},{label:"|□|",token:"abs"},
          {label:"4",token:"4"},{label:"5",token:"5"},{label:"6",token:"6"},{label:"+",token:"+"},{label:"−",token:"−"}
        ],
        [
          {label:"<",token:"<"},{label:">",token:">"},{label:"□/□",token:"frac"},{label:"a⁄b",token:"frac"},
          {label:"1",token:"1"},{label:"2",token:"2"},{label:"3",token:"3"},{label:"=",token:"="},{label:"⌫",action:"backspace",utility:true}
        ],
        [
          {label:"ans",token:"ans",utility:true},{label:",",token:","},{label:"(",token:"("},{label:")",token:")"},
          {label:"0",token:"0"},{label:".",token:"."},{label:"‹",action:"left",utility:true},{label:"›",action:"right",utility:true},{label:"↵",action:"enter",utility:true}
        ]
      ],
      fx: [
        [
          {label:"sin",token:"sin"},{label:"cos",token:"cos"},{label:"tan",token:"tan"},
          {label:"%",token:"%"},{label:"!",token:"!"},{label:"$",token:"$"},{label:"°",token:"degree"}
        ],
        [
          {label:"sin⁻¹",token:"asin"},{label:"cos⁻¹",token:"acos"},{label:"tan⁻¹",token:"atan"},
          {label:"{",token:"{"},{label:"}",token:"}"},{label:"≤",token:"≤"},{label:"≥",token:"≥"}
        ],
        [
          {label:"ln",token:"ln"},{label:"log₁₀",token:"log10"},{label:"logₐ",token:"logbase"},
          {label:"d/dx",token:"derivative"},{label:"∫",token:"integral"},{label:"i",token:"i"},{label:"⌫",action:"backspace",utility:true}
        ],
        [
          {label:"e^□",token:"epower"},{label:"10^□",token:"tenpower"},{label:"ⁿ√□",token:"nthroot"},
          {label:"□₍□₎",token:"subscript"},{label:"‹",action:"left",utility:true},{label:"›",action:"right",utility:true},{label:"↵",action:"enter",utility:true}
        ]
      ],
      abc: [],
      symbols: [
        [
          {label:"∞",token:"∞"},{label:"≟",token:"neq"},{label:"≠",token:"neq"},{label:"∧",token:"and"},{label:"∨",token:"or"},
          {label:"¬",token:"not"},{label:"⊗",token:"otimes"},{label:"[",token:"["},{label:"]",token:"]"}
        ],
        [
          {label:"∥",token:"parallel"},{label:"⊥",token:"perp"},{label:"∈",token:"in"},{label:"⊂",token:"subset"},{label:"⊆",token:"subseteq"},
          {label:"∠",token:"angle"},{label:"→",token:"to"},{label:"⌈□⌉",token:"ceil"},{label:"⌊□⌋",token:"floor"}
        ],
        [
          {label:"(•)",token:"bulletparen"},{label:"(:)",token:"colonparen"},{label:"(⋮)",token:"vdotsparen"},{label:"\\",token:"backslash"},
          {label:"&",token:"&"},{label:"@",token:"@"},{label:"#",token:"#"},{label:"$",token:"$"},{label:"⌫",action:"backspace",utility:true}
        ],
        [
          {label:";",token:";"},{label:":",token:":"},{label:"'",token:"'"},{label:'"',token:'"'},{label:"′",token:"prime"},{label:"″",token:"doubleprime"},
          {label:"‹",action:"left",utility:true},{label:"›",action:"right",utility:true},{label:"↵",action:"enter",utility:true}
        ]
      ]
    };

    const undoStack = [];
    const redoStack = [];

    function combinedAnswer() {
      return `Solution:\n${solution.value}\nFinal Answer:\n${finalAnswer.value}`;
    }

    function saveCombined() {
      stateNode.textContent = "Saving…";
      clearTimeout(container._saveTimer);
      container._saveTimer = setTimeout(
        () => saveAnswer(question.question_id, combinedAnswer(), stateNode),
        500
      );
    }

    function snapshot() {
      undoStack.push({
        target: activeInput === finalAnswer ? "final" : "solution",
        solution: solution.value,
        finalAnswer: finalAnswer.value,
        start: activeInput.selectionStart ?? activeInput.value.length,
        end: activeInput.selectionEnd ?? activeInput.value.length
      });
      if (undoStack.length > 60) undoStack.shift();
      redoStack.length = 0;
    }

    function restore(entry) {
      if (!entry) return;
      solution.value = entry.solution;
      finalAnswer.value = entry.finalAnswer;
      activeInput = entry.target === "final" ? finalAnswer : solution;
      activeInput.focus({ preventScroll:true });
      activeInput.setSelectionRange(entry.start, entry.end);
      afterEdit();
    }

    function tokenTemplate(token) {
      const map = {
        "÷":"\\div ","×":"\\times ","−":"-","≤":"\\le ","≥":"\\ge ",
        "π":"\\pi ","∞":"\\infty ","degree":"^{\\circ}",
        "square":"^{2}","power":"^{__CARET__}","sqrt":"\\sqrt{__CARET__}",
        "abs":"\\left|__CARET__\\right|","frac":"\\frac{__CARET__}{}",
        "sin":"\\sin\\left(__CARET__\\right)","cos":"\\cos\\left(__CARET__\\right)","tan":"\\tan\\left(__CARET__\\right)",
        "asin":"\\sin^{-1}\\left(__CARET__\\right)","acos":"\\cos^{-1}\\left(__CARET__\\right)","atan":"\\tan^{-1}\\left(__CARET__\\right)",
        "ln":"\\ln\\left(__CARET__\\right)","log10":"\\log_{10}\\left(__CARET__\\right)",
        "logbase":"\\log_{__CARET__}\\left(\\right)",
        "derivative":"\\frac{d}{dx}\\left(__CARET__\\right)",
        "integral":"\\int __CARET__ \\, dx","epower":"e^{__CARET__}","tenpower":"10^{__CARET__}",
        "nthroot":"\\sqrt[__CARET__]{}","subscript":"_{__CARET__}",
        "neq":"\\ne ","and":"\\land ","or":"\\lor ","not":"\\neg ","otimes":"\\otimes ",
        "parallel":"\\parallel ","perp":"\\perp ","in":"\\in ","subset":"\\subset ","subseteq":"\\subseteq ",
        "angle":"\\angle ","to":"\\to ","ceil":"\\left\\lceil __CARET__ \\right\\rceil",
        "floor":"\\left\\lfloor __CARET__ \\right\\rfloor",
        "bulletparen":"(\\bullet)","colonparen":"(:)","vdotsparen":"(\\vdots)",
        "backslash":"\\backslash ","prime":"^{\\prime}","doubleprime":"^{\\prime\\prime}",
        "ans":"\\mathrm{ans}","newline":"\n"
      };
      return map[token] ?? token;
    }

    function afterEdit() {
      autosize();
      updatePreview();
      saveCombined();
    }

    function insertToken(token) {
      if (token === "newline" && activeInput === finalAnswer) {
        activeInput = solution;
        solution.focus({ preventScroll:true });
      }

      snapshot();
      const start = activeInput.selectionStart ?? activeInput.value.length;
      const end = activeInput.selectionEnd ?? start;
      const template = tokenTemplate(token);
      const marker = "__CARET__";
      const markerIndex = template.indexOf(marker);
      const value = markerIndex >= 0 ? template.replace(marker, "") : template;

      activeInput.value = activeInput.value.slice(0,start) + value + activeInput.value.slice(end);
      const next = markerIndex >= 0 ? start + markerIndex : start + value.length;
      activeInput.focus({ preventScroll:true });
      activeInput.setSelectionRange(next,next);
      afterEdit();
    }

    function backspace() {
      snapshot();
      let start = activeInput.selectionStart ?? activeInput.value.length;
      const end = activeInput.selectionEnd ?? start;
      if (start === end && start > 0) {
        activeInput.value = activeInput.value.slice(0,start-1) + activeInput.value.slice(end);
        start -= 1;
      } else {
        activeInput.value = activeInput.value.slice(0,start) + activeInput.value.slice(end);
      }
      activeInput.focus({ preventScroll:true });
      activeInput.setSelectionRange(start,start);
      afterEdit();
    }

    function moveCursor(delta) {
      const pos = activeInput.selectionStart ?? activeInput.value.length;
      const next = Math.max(0,Math.min(activeInput.value.length,pos+delta));
      activeInput.focus({ preventScroll:true });
      activeInput.setSelectionRange(next,next);
    }

    function undo() {
      const previous = undoStack.pop();
      if (!previous) return;
      redoStack.push({
        target: activeInput === finalAnswer ? "final" : "solution",
        solution:solution.value,
        finalAnswer:finalAnswer.value,
        start:activeInput.selectionStart ?? activeInput.value.length,
        end:activeInput.selectionEnd ?? activeInput.value.length
      });
      restore(previous);
    }

    function redo() {
      const next = redoStack.pop();
      if (!next) return;
      undoStack.push({
        target: activeInput === finalAnswer ? "final" : "solution",
        solution:solution.value,
        finalAnswer:finalAnswer.value,
        start:activeInput.selectionStart ?? activeInput.value.length,
        end:activeInput.selectionEnd ?? activeInput.value.length
      });
      restore(next);
    }

    function closeKeyboard() {
      keyboard.classList.add("hidden");
      activeInput.blur();
      updatePreview();
      saveCombined();
      stateNode.textContent = "Saved";
    }

    function alphabetRows() {
      const latin = alphabetShift
        ? ["Q","W","E","R","T","Y","U","I","O","P","A","S","D","F","G","H","J","K","L","Z","X","C","V","B","N","M"]
        : ["q","w","e","r","t","y","u","i","o","p","a","s","d","f","g","h","j","k","l","z","x","c","v","b","n","m"];
      const greek = ["α","β","γ","δ","ε","ζ","η","θ","ι","κ","λ","μ","ν","ξ","ο","π","ρ","σ","τ","υ","φ","χ","ψ","ω"];
      const letters = alphabetGreek ? greek : latin;

      return [
        letters.slice(0,10).map(ch=>({label:ch,token:ch})),
        letters.slice(10,19).map(ch=>({label:ch,token:ch})),
        [
          {label:"⇧",action:"shift",utility:true},
          ...letters.slice(19).map(ch=>({label:ch,token:ch})),
          {label:"⌫",action:"backspace",utility:true}
        ],
        [
          {label:alphabetGreek ? "ABC" : "αβγ",action:"alphabet",utility:true},
          {label:",",token:","},{label:"(",token:"("},{label:")",token:")"},
          {label:"space",token:" ",wide:true,blank:true},
          {label:"‹",action:"left",utility:true},{label:"›",action:"right",utility:true},{label:"↵",action:"enter",utility:true}
        ]
      ];
    }

    function performKeyAction(key) {
      if (key.action === "backspace") return backspace();
      if (key.action === "left") return moveCursor(-1);
      if (key.action === "right") return moveCursor(1);
      if (key.action === "enter") return insertToken("newline");
      if (key.action === "undo") return undo();
      if (key.action === "redo") return redo();
      if (key.action === "close") return closeKeyboard();
      if (key.action === "shift") {
        alphabetShift = !alphabetShift;
        return renderKeyboard("abc");
      }
      if (key.action === "alphabet") {
        alphabetGreek = !alphabetGreek;
        alphabetShift = false;
        return renderKeyboard("abc");
      }
      insertToken(key.token ?? key.label);
    }

    function renderKeyboard(tabId = activeKeyboardTab) {
      activeKeyboardTab = tabId;
      [...tabBar.querySelectorAll(".math-keyboard-tab")].forEach(button => {
        button.classList.toggle("active", button.dataset.tab === tabId);
      });

      keyArea.innerHTML = "";
      const rows = tabId === "abc" ? alphabetRows() : layouts[tabId];

      rows.forEach((row, rowIndex) => {
        const rowNode = document.createElement("div");
        rowNode.className = `math-keyboard-row math-keyboard-row-${tabId} math-keyboard-row-index-${rowIndex}`;

        row.forEach(key => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "math-key";
          if (key.utility) button.classList.add("math-key-utility");
          if (key.wide) button.classList.add("math-key-wide");
          if (key.blank) button.classList.add("math-key-space");
          button.textContent = key.blank ? "" : key.label;
          button.title = key.label === "⌫" ? "Backspace"
            : key.label === "‹" ? "Move cursor left"
            : key.label === "›" ? "Move cursor right"
            : key.label === "↵" ? "New solution line"
            : key.label;
          button.addEventListener("mousedown", event => event.preventDefault());
          button.addEventListener("click", () => performKeyAction(key));
          rowNode.appendChild(button);
        });

        keyArea.appendChild(rowNode);
      });
    }

    keyboardTabs.forEach(tab => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "math-keyboard-tab";
      button.dataset.tab = tab.id;
      button.textContent = tab.label;
      button.addEventListener("mousedown", event => event.preventDefault());
      button.addEventListener("click", () => renderKeyboard(tab.id));
      tabBar.appendChild(button);
    });

    const menuButton = document.createElement("button");
    menuButton.type = "button";
    menuButton.className = "math-keyboard-menu";
    menuButton.textContent = "•••";
    menuButton.title = "Keyboard actions";
    menuButton.addEventListener("mousedown", event => event.preventDefault());
    menuButton.addEventListener("click", () => {
      const shouldUndo = confirm("Keyboard actions:\nOK = Undo last edit\nCancel = Close keyboard");
      if (shouldUndo) undo();
      else closeKeyboard();
    });
    tabBar.appendChild(menuButton);

    function autosize() {
      solution.style.height="auto";
      solution.style.height=`${Math.max(110,solution.scrollHeight+8)}px`;
    }

    function renderMathLines(value) {
      const lines=String(value||"").split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
      if (!lines.length) return "";
      return lines.length>1
        ? `\\[\\begin{gathered}${lines.join(" \\\\ ")}\\end{gathered}\\]`
        : `\\[${lines[0]}\\]`;
    }

    function updatePreview() {
      const working = renderMathLines(solution.value);
      const final = finalAnswer.value.trim();

      preview.innerHTML="";
      const workingWrap=document.createElement("div");
      workingWrap.className="math-preview-working";
      workingWrap.textContent=working || "Solution preview";

      const finalWrap=document.createElement("div");
      finalWrap.className="math-preview-final";
      const label=document.createElement("strong");
      label.textContent="Final answer: ";
      const math=document.createElement("span");
      math.textContent=final ? `\\(${final}\\)` : "—";
      finalWrap.append(label,math);
      preview.append(workingWrap,finalWrap);

      if (window.MathJax?.typesetPromise) {
        window.MathJax.typesetClear?.([preview]);
        window.MathJax.typesetPromise([preview]).catch(()=>{});
      }
    }

    [solution,finalAnswer].forEach(input=>{
      input.addEventListener("focus",()=>{
        activeInput=input;
        keyboard.classList.remove("hidden");
      });
    });

    keyboard.append(tabBar,keyArea);
    container.append(solutionLabel,solution,finalLabel,finalAnswer,preview,keyboard);
    renderKeyboard("123");
    autosize();
    updatePreview();

    return { container, textarea:solution };
  }

  function parseSavedMathResponse(value) {
    const text=String(value||"");
    const match=text.match(/^Solution:\n([\s\S]*?)\nFinal Answer:\n([\s\S]*)$/);
    if (match) {
      return { solution:match[1] || "", finalAnswer:match[2] || "" };
    }

    const lines=text.split(/\r?\n/);
    return {
      solution:text,
      finalAnswer:lines.length ? lines[lines.length-1].trim() : ""
    };
  }


  async function submitSingleEssay(question, textarea, stateNode, button) {
    if (!attempt?.attempt_token || submitted) return;
    const questionId = String(question?.question_id || "");
    if (!questionId || submittedEssayQuestionIds.has(questionId)) return;

    const answer = String(textarea?.value ?? "");
    if (!answer.trim()) {
      warn("Write your essay response before submitting this item.");
      textarea?.focus();
      return;
    }

    const ok = confirm(
      `Submit Question ${question.position} now?\n\nThis essay will be saved and locked. You can continue answering the remaining questions afterward.`
    );
    if (!ok) return;

    if (button) {
      button.disabled = true;
      button.textContent = "Submitting essay…";
    }
    if (stateNode) stateNode.textContent = "Submitting essay…";

    saveLocalDraft(questionId, answer);

    const { data, error } = await db.rpc("submit_essay_response", {
      p_attempt_token: attempt.attempt_token,
      p_question_id: question.question_id,
      p_answer: answer
    });

    if (error) {
      if (button) {
        button.disabled = false;
        button.textContent = "Submit This Essay";
      }
      if (stateNode) {
        stateNode.textContent = "Essay submission failed — try again.";
        stateNode.style.color = "#b42318";
      }
      const missing = /submit_essay_response|function.*does not exist|schema cache|PGRST202/i.test(String(error.message || error));
      warn(missing
        ? "Per-essay submission is not active in Supabase yet. Please inform your teacher."
        : `Could not submit this essay: ${error.message}`);
      return;
    }

    submittedEssayQuestionIds.add(questionId);
    if (textarea) {
      textarea.readOnly = true;
      textarea.classList.add("essay-submitted-response");
    }
    if (button) {
      button.disabled = true;
      button.textContent = "Submitted ✓";
    }

    const submittedAt = data?.submitted_at ? new Date(data.submitted_at) : new Date();
    if (stateNode) {
      stateNode.textContent = `Essay submitted ${submittedAt.toLocaleTimeString()}`;
      stateNode.style.color = "";
    }

    await logEvent("essay_submit_confirmed_in_browser", {
      question_id: question.question_id,
      position: question.position
    });

    warn(`Question ${question.position} essay submitted successfully. You may continue with the remaining questions.`);
  }

  async function saveAnswer(questionId, answer, stateNode, { quiet = false } = {}) {
    if (!attempt?.attempt_token || submitted) return;

    if (stateNode && !quiet) {
      stateNode.textContent = "Saving…";
    }

    const savePromise = (async () => {
      const { error } = await db.rpc("save_exam_response", {
        p_attempt_token: attempt.attempt_token,
        p_question_id: questionId,
        p_answer: answer
      });

      if (error) {
        if (stateNode) {
          stateNode.textContent = "Save failed — retry by changing the answer.";
          stateNode.style.color = "#b42318";
        }
        throw error;
      }

      if (stateNode) {
        stateNode.textContent = `Saved ${new Date().toLocaleTimeString()}`;
        stateNode.style.color = "";
      }
      saveLocalDraft(questionId, answer);
    })();

    pendingAnswerSaves.set(String(questionId), savePromise);

    try {
      await savePromise;
    } finally {
      if (pendingAnswerSaves.get(String(questionId)) === savePromise) {
        pendingAnswerSaves.delete(String(questionId));
      }
    }
  }

  async function syncAttemptDeadline({ announce = false } = {}) {
    if (!attempt?.attempt_token || submitted) return false;

    const { data, error } = await db.rpc("get_attempt_time_state", {
      p_attempt_token: attempt.attempt_token
    });

    if (error || !data?.length) return false;

    const nextEnd = new Date(data[0].ends_at).getTime();
    if (!Number.isFinite(nextEnd)) return false;

    const previousEnd = timerDeadlineMs;
    timerDeadlineMs = nextEnd;
    attempt.ends_at = data[0].ends_at;

    if (announce && previousEnd && nextEnd > previousEnd + 1000) {
      const addedMinutes = Math.round((nextEnd - previousEnd) / 60000);
      warn(`Your teacher added approximately ${addedMinutes} minute${addedMinutes === 1 ? "" : "s"} to your exam time.`);
    }

    return true;
  }

  function startTimer() {
    clearInterval(timerHandle);
    clearInterval(timerSyncHandle);

    timerDeadlineMs = new Date(attempt.ends_at).getTime();
    timerExpiryCheckInFlight = false;

    const tick = async () => {
      const ms = Math.max(0, timerDeadlineMs - Date.now());
      const total = Math.ceil(ms / 1000);
      const min = Math.floor(total / 60);
      const sec = total % 60;

      $("timer").textContent = `${String(min).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
      const fixedTimer = $("fixedRemainingTime");
      if (fixedTimer) fixedTimer.textContent = $("timer").textContent;

      if (ms <= 0 && !timerExpiryCheckInFlight) {
        timerExpiryCheckInFlight = true;

        // Re-check the authoritative server deadline before auto-submitting.
        // This prevents a student from being submitted at the old deadline if
        // the teacher granted extra time moments earlier.
        const updated = await syncAttemptDeadline({ announce: true });
        const stillExpired = !updated || timerDeadlineMs <= Date.now();

        timerExpiryCheckInFlight = false;

        if (stillExpired) {
          clearInterval(timerHandle);
          clearInterval(timerSyncHandle);
          submitExam(true);
        }
      }
    };

    tick();
    timerHandle = setInterval(tick, 1000);

    // Live-sync the deadline while the attempt is open.
    timerSyncHandle = setInterval(() => {
      syncAttemptDeadline({ announce: true });
    }, 10_000);
  }

  async function primeCompletionAudio() {
    if (completionAudioPrimed) return;
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return;
    try {
      completionAudioContext = completionAudioContext || new AudioContextCtor();
      if (completionAudioContext.state === "suspended") await completionAudioContext.resume();
      const gain = completionAudioContext.createGain();
      gain.gain.value = 0.0001;
      gain.connect(completionAudioContext.destination);
      const osc = completionAudioContext.createOscillator();
      osc.frequency.value = 220;
      osc.connect(gain);
      osc.start();
      osc.stop(completionAudioContext.currentTime + 0.02);
      completionAudioPrimed = true;
    } catch (_) {}
  }

  function playCompletionApplause() {
    const ctx = completionAudioContext;
    if (!ctx || ctx.state === "closed") return;
    const now = ctx.currentTime;

    function clap(at, strength = 1) {
      const duration = 0.09;
      const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * duration), ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) {
        const decay = Math.pow(1 - i / data.length, 2.8);
        data[i] = (Math.random() * 2 - 1) * decay;
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;

      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = 1650 + Math.random() * 650;
      filter.Q.value = 0.75;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.23 * strength, at + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);

      source.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);
      source.start(at);
      source.stop(at + duration + 0.02);
    }

    try {
      if (ctx.state === "suspended") ctx.resume();
      const pattern = [0,0.11,0.23,0.38,0.53,0.69,0.86,1.05,1.25,1.48,1.72];
      pattern.forEach((offset,index) => {
        clap(now + offset, 0.78 + (index % 3) * 0.08);
        if (index % 2 === 0) clap(now + offset + 0.035, 0.48);
      });
    } catch (_) {}
  }

  function launchCompletionConfetti() {
    document.querySelector(".exam-completion-confetti")?.remove();

    const layer = document.createElement("div");
    layer.className = "exam-completion-confetti";
    layer.setAttribute("aria-hidden","true");

    const symbols = ["🎉","🎊","✨","⭐","💯","👏"];
    for (let i = 0; i < 90; i++) {
      const piece = document.createElement("span");
      piece.className = "exam-confetti-piece";
      piece.textContent = symbols[i % symbols.length];
      piece.style.left = `${Math.random() * 100}%`;
      piece.style.animationDelay = `${Math.random() * 0.45}s`;
      piece.style.animationDuration = `${2.3 + Math.random() * 1.7}s`;
      piece.style.setProperty("--confetti-drift", `${-90 + Math.random() * 180}px`);
      piece.style.setProperty("--confetti-rotate", `${180 + Math.random() * 720}deg`);
      piece.style.fontSize = `${14 + Math.random() * 20}px`;
      layer.appendChild(piece);
    }

    document.body.appendChild(layer);
    setTimeout(() => layer.remove(), 4600);
  }

  function celebrateExamCompletion() {
    launchCompletionConfetti();
    playCompletionApplause();
  }

  async function submitExam(auto = false) {
    if (!attempt || submitted) return;
    if (!auto && !confirm("Submit your exam now? You will not be able to change your answers afterward.")) return;

    if (!auto) await primeCompletionAudio();

    $("submitBtn").disabled = true;
    const originalSubmitText = $("submitBtn").textContent;
    $("submitBtn").textContent = "Protecting answers…";

    const recoverySnapshot = buildCurrentAnswerSnapshot();
    const localSnapshotSaved = saveLocalRecoverySnapshot(recoverySnapshot);
    const serverSnapshot = await saveServerRecoverySnapshot(recoverySnapshot);

    $("submitBtn").textContent = "Saving answers…";

    try {
      warn("Saving and verifying your latest answers before submission…");
      await forceSaveAllCurrentAnswers();
    } catch (saveError) {
      $("submitBtn").disabled = false;
      $("submitBtn").textContent = originalSubmitText;
      warn(`Could not save all answers. Your recovery copy was kept. Please check your connection and submit again. ${saveError?.message || ""}`);
      return;
    }

    const verification = await verifyAnswersSaved(recoverySnapshot, { retry:true });

    if (verification.available && !verification.verified) {
      $("submitBtn").disabled = false;
      $("submitBtn").textContent = originalSubmitText;
      const mismatchCount = verification.mismatches.length;
      warn(
        `Submission stopped for safety: ${mismatchCount || "some"} answered item${mismatchCount === 1 ? "" : "s"} did not match the Supabase saved copy. ` +
        "Your recovery snapshot is retained. Check your connection and press Submit again."
      );
      await logEvent("submission_verification_blocked", {
        expected_answered: recoverySnapshot.answered_count,
        mismatch_count: mismatchCount,
        local_snapshot_saved: localSnapshotSaved,
        server_snapshot_saved: Boolean(serverSnapshot.saved)
      });
      return;
    }

    await logEvent(auto ? "auto_submit_time_expired" : "student_submit_clicked", {
      expected_answered: recoverySnapshot.answered_count,
      verification_available: Boolean(verification.available),
      verification_passed: Boolean(verification.verified),
      local_snapshot_saved: localSnapshotSaved,
      server_snapshot_saved: Boolean(serverSnapshot.saved)
    });

    $("submitBtn").textContent = "Submitting…";

    let submitResult = await db.rpc("submit_exam_verified", {
      p_attempt_token: attempt.attempt_token,
      p_expected_nonblank: recoverySnapshot.answered_count
    });

    if (
      submitResult.error &&
      /submit_exam_verified|function.*does not exist|schema cache|PGRST202/i.test(String(submitResult.error.message || submitResult.error))
    ) {
      submitResult = await db.rpc("submit_exam", {
        p_attempt_token: attempt.attempt_token
      });
    }

    const { data, error } = submitResult;

    if (error) {
      $("submitBtn").disabled = false;
      $("submitBtn").textContent = originalSubmitText;
      warn(`Submission failed: ${error.message}`);
      return;
    }

    await stopMicrophoneMonitoring();
    submitted = true;
    const completedAttemptToken = attempt?.attempt_token || "";
    // Keep the dedicated 7-day recovery snapshot, but clear the older per-question draft keys.
    clearLocalDraftsForAttempt(completedAttemptToken);
    try {
      sessionStorage.removeItem("exam_guard_token");
      localStorage.removeItem("exam_guard_token");
    } catch (_) {}
    stopAttemptMessagePolling();
    clearInterval(timerHandle);
    clearInterval(timerSyncHandle);
    timerSyncHandle = null;
    stopCameraMonitoring();
    clearExamBrowserState();
    examView.classList.add("hidden");
    watermark.classList.remove("active");
    doneView.classList.remove("hidden");
    celebrateExamCompletion();
    const fixedTimer = $("fixedRemainingTime");
    if (fixedTimer) fixedTimer.textContent = "00:00";

    const row = data?.[0];
    $("doneText").textContent = row?.score == null
      ? "Your responses have been recorded."
      : `Your responses have been recorded. Objective auto-score: ${row.score}/${row.max_score}. Constructed responses, if any, still require teacher approval.`;

    // Generate a provisional score for constructed-response items. This never
    // becomes the final grade until the teacher reviews and approves it.
    const provisional = await window.ExamAI?.gradeConstructed?.(attempt.attempt_token);
    if (provisional?.grading_status === "pending_review") {
      if (provisional.provisional_score !== null && provisional.provisional_score !== undefined) {
        $("doneText").textContent =
          `Your responses have been recorded. Provisional overall score: ${provisional.provisional_score}/${provisional.provisional_max_score}. Essay, Short Response, and Math Solver items are still subject to teacher review and approval.`;
      } else {
        $("doneText").textContent =
          "Your responses have been recorded. Free local checks were completed. Any unresolved Essay, Short Response, or Math Solver items will be reviewed by your teacher before the final result is approved.";
      }
    }

    updateFlexScoreContext({
      score: provisional?.provisional_score ?? row?.score ?? null,
      maxScore: provisional?.provisional_max_score ?? row?.max_score ?? null,
      examTitle: attempt?.exam_title || "",
      studentName: attempt?.student_name || ""
    });

    // AI feedback is generated server-side so no Gemini/API secret is exposed in GitHub.
    // The feedback helper fails gracefully if the Edge Function has not been deployed yet.
    window.ExamAI?.generateFeedback(attempt.attempt_token, {
      score: row?.score ?? null,
      maxScore: row?.max_score ?? null
    });

    window.ExamReport?.enableStudent(attempt.attempt_token);

    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  async function restoreSavedAttempt() {
    const token = sessionStorage.getItem("exam_guard_token") || localStorage.getItem("exam_guard_token");
    if (!token) return;
    try { sessionStorage.setItem("exam_guard_token", token); } catch (_) {}

    const msg = $("loginMsg");
    msg.textContent = "Restoring your saved exam session…";
    $("startBtn").disabled = true;

    const { data: resumeData, error: resumeError } = await db.rpc("resume_exam", {
      p_attempt_token: token,
      p_device_session: getExamDeviceSessionId()
    });

    if (resumeError || !resumeData?.length) {
      sessionStorage.removeItem("exam_guard_token");
      try { localStorage.removeItem("exam_guard_token"); } catch (_) {}
      $("startBtn").disabled = false;
      msg.textContent = resumeError?.message?.includes("locked to another browser or device")
        ? resumeError.message
        : "";
      return;
    }

    const { data: savedResponses, error: responseError } = await db.rpc("get_saved_exam_responses", {
      p_attempt_token: token
    });

    if (responseError) {
      $("startBtn").disabled = false;
      msg.textContent = `Could not restore saved answers: ${responseError.message}`;
      return;
    }

    attempt = resumeData[0];
    submitted = false;
    loadExamFlagCounts();
    updateMobileMonitoringCapabilityNote();
    startAttemptMessagePolling();
    msg.textContent = "";

    const restoredLoaded = await loadExam({
      restored: true,
      savedResponses: savedResponses || []
    });

    if (!restoredLoaded) {
      $("startBtn").disabled = false;
      return;
    }

    try {
      await requestFrontCamera();
      startCameraCaptureSchedule();
    } catch (cameraError) {
      updateCameraStatus("Camera unavailable");
      await logEvent("camera_monitoring_unavailable_after_restore", {
        message: String(cameraError?.message || cameraError).slice(0,300)
      });
    }

    try {
      await requestMicrophone();
      await startSpeechMonitoring();
    } catch (microphoneError) {
      resetMicrophoneLevel();
      updateMicrophoneStatus("Microphone unavailable");
      await logEvent("microphone_monitoring_unavailable_after_restore", {
        message: String(microphoneError?.message || microphoneError).slice(0,300)
      });
    }
  }

  // A normal browser refresh keeps sessionStorage for the same tab.
  // Restore the active server-side attempt and its saved answers immediately.
  restoreSavedAttempt();

  $("submitBtn").addEventListener("click", () => submitExam(false));

  // Proctoring signals.
  document.addEventListener("visibilitychange", () => {
    if (!attempt || submitted) return;
    if (document.hidden) emergencySnapshotCurrentAnswers();
    logEvent(document.hidden ? "tab_or_window_hidden" : "tab_or_window_visible", {
      state: document.visibilityState
    });
    if (!document.hidden) flushEvents();
  });

  window.addEventListener("blur", () => {
    if (!attempt || submitted || Date.now() < suppressBlurUntil) return;
    logEvent("window_blur");
  });

  window.addEventListener("focus", () => {
    if (!attempt || submitted) return;
    logEvent("window_focus");
    flushEvents();
  });

  document.addEventListener("fullscreenchange", () => {
    if (!attempt || submitted) return;
    if (!document.fullscreenElement) {
      logEvent("fullscreen_exit");
      warn("Fullscreen was exited. This event has been recorded.");
    } else {
      logEvent("fullscreen_enter");
    }
  });

  ["copy", "cut", "paste", "contextmenu", "dragstart"].forEach(type => {
    document.addEventListener(type, (e) => {
      if (!attempt || submitted) return;
      e.preventDefault();
      logEvent(`${type}_blocked`, {
        target: e.target?.tagName || null
      });
      warn(`${type[0].toUpperCase()+type.slice(1)} is disabled during the exam.`);
    }, true);
  });

  document.addEventListener("keydown", (e) => {
    if (!attempt || submitted) return;
    const key = e.key;
    const ctrl = e.ctrlKey || e.metaKey;

    if (key === "PrintScreen") {
      // Some browsers/OSes do not deliver this key event. Logging it is best-effort only.
      logEvent("printscreen_key_detected");
      warn("A screenshot-key attempt was detected and recorded.");
    }

    if (ctrl && ["c","x","v","p","s"].includes(key.toLowerCase())) {
      e.preventDefault();
      logEvent("keyboard_shortcut_blocked", { key: `${e.metaKey ? "Meta" : "Ctrl"}+${key}` });
      warn("That keyboard shortcut is disabled during the exam.");
    }

    if (key === "F12" || (ctrl && e.shiftKey && ["i","j","c"].includes(key.toLowerCase()))) {
      e.preventDefault();
      logEvent("developer_tools_shortcut_attempt", { key });
      warn("Developer-tools shortcuts are disabled during the exam.");
    }

    if (key === "F5" || (ctrl && key.toLowerCase() === "r")) {
      e.preventDefault();
      logEvent("reload_shortcut_blocked", { key });
      warn("Reload is disabled during the exam.");
    }
  }, true);

  window.addEventListener("beforeprint", () => {
    if (attempt && !submitted) logEvent("print_attempt");
  });

  window.addEventListener("pagehide", () => {
    if (!attempt || submitted) return;
    emergencySnapshotCurrentAnswers();
  });

  // Keep an active exam on the current history entry. This protects against
  // accidental browser Back gestures/taps without trapping the student after submission.
  try {
    history.replaceState({ examGuard: true }, "", location.href);
    history.pushState({ examGuard: true }, "", location.href);
  } catch (_) {}

  window.addEventListener("popstate", () => {
    if (!attempt || submitted) return;
    emergencySnapshotCurrentAnswers();
    try { history.pushState({ examGuard: true }, "", location.href); } catch (_) {}
    warn("Back navigation is disabled during the exam. Your latest answers were kept.");
    forceSaveAllCurrentAnswers().catch(() => {});
    logEvent("back_navigation_blocked");
  });

  window.addEventListener("beforeunload", (e) => {
    if (!attempt || submitted) return;
    emergencySnapshotCurrentAnswers();
    logEvent("leave_or_reload_attempt");
    e.preventDefault();
    e.returnValue = "";
  });

  window.addEventListener("offline", () => {
    if (attempt && !submitted) warn("Internet connection lost. Do not close the exam.");
  });
  window.addEventListener("online", () => {
    if (attempt && !submitted) {
      warn("Internet connection restored.");
      flushEvents();
    }
  });

  // Prevent accidental external navigation originating from links inside the exam.
  document.addEventListener("click", (e) => {
    if (!attempt || submitted) return;
    const a = e.target.closest?.("a[href]");
    if (!a) return;
    const target = new URL(a.href, location.href);
    if (target.origin !== location.origin || target.pathname !== location.pathname) {
      e.preventDefault();
      logEvent("in_exam_link_navigation_blocked", { attemptedUrl: target.href });
      warn("Leaving the exam through a link is disabled.");
    }
  }, true);
})();
