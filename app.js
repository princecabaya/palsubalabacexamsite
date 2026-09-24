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
  const loginView = $("loginView");
  const examView = $("examView");
  const doneView = $("doneView");
  const examForm = $("examForm");
  const warningBar = $("warningBar");
  const watermark = $("watermark");

  let attempt = null;
  let questions = [];
  let timerHandle = null;
  let submitted = false;
  let suppressBlurUntil = 0;
  const queuedEvents = [];
  let pendingIdentity = null;
  let cameraStream = null;
  let cameraInterval = null;
  let cameraInitialTimeout = null;
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

  const restrictedFlagTypes = new Set([
    "copy_blocked","cut_blocked","paste_blocked","contextmenu_blocked","dragstart_blocked",
    "keyboard_shortcut_blocked","developer_tools_shortcut_attempt","reload_shortcut_blocked",
    "print_attempt","printscreen_key_detected","leave_or_reload_attempt","in_exam_link_navigation_blocked"
  ]);

  function clearExamBrowserState({ keepCurrentToken = false } = {}) {
    const currentToken = keepCurrentToken ? sessionStorage.getItem("exam_guard_token") : null;

    for (const storage of [sessionStorage, localStorage]) {
      const keys = [];
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (key && key.startsWith("exam_guard_")) keys.push(key);
      }
      keys.forEach(key => storage.removeItem(key));
    }

    if (keepCurrentToken && currentToken) {
      sessionStorage.setItem("exam_guard_token", currentToken);
    }
  }

  function currentAnswerForQuestion(questionId) {
    const wrap = examForm.querySelector(`[data-question-id="${CSS.escape(String(questionId))}"]`);
    if (!wrap) return "";

    const checked = wrap.querySelector('input[type="radio"]:checked');
    if (checked) return checked.value;

    const textarea = wrap.querySelector("textarea");
    if (textarea) return textarea.value;

    const textInput = wrap.querySelector('input[type="text"], input.short-response-input');
    if (textInput) return textInput.value;

    return "";
  }

  async function forceSaveAllCurrentAnswers() {
    const jobs = [];

    for (const q of questions) {
      const answer = currentAnswerForQuestion(q.question_id);
      const wrap = examForm.querySelector(`[data-question-id="${CSS.escape(String(q.question_id))}"]`);
      const state = wrap?.querySelector(".save-state");

      // Save even blank values so a deliberately cleared text response is reflected
      // in the database before scoring.
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

    // Capture once shortly after the examination begins, then approximately
    // every 60 seconds while the attempt remains active.
    cameraInitialTimeout = setTimeout(() => captureAndUploadProctorPhoto(), 2500);
    cameraInterval = setInterval(() => captureAndUploadProctorPhoto(), 60_000);
  }

  async function captureAndUploadProctorPhoto() {
    if (!attempt?.attempt_token || submitted || !cameraStream?.active || cameraCaptureBusy) return;

    const video = $("proctorCameraPreview");
    if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;

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
      await logEvent("camera_photo_saved", { capturedAt: data?.captured_at || null });
      setTimeout(() => {
        if (cameraStream?.active && !submitted) updateCameraStatus("Camera active");
      }, 1800);
    } catch (error) {
      console.warn("Proctor photo capture failed:", error);
      updateCameraStatus("Photo save failed");
      await logEvent("camera_photo_failed", {
        message: String(error?.message || error).slice(0, 300)
      });
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

  async function startSpeechMonitoring() {
    if (!attempt?.attempt_token || submitted || !microphoneStream?.active) return;

    stopSpeechAnalysisOnly();

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
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
    microphoneAnalyser.fftSize = 1024;
    microphoneAnalyser.smoothingTimeConstant = 0.35;
    source.connect(microphoneAnalyser);
    microphoneData = new Float32Array(microphoneAnalyser.fftSize);

    speechCandidateStartedAt = 0;
    speechActiveStartedAt = 0;
    speechLastLoudAt = 0;
    speechPeakRms = 0;
    microphoneNoiseFloor = 0.01;
    updateMicrophoneStatus("Listening locally");

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

      // Adapt slowly to ordinary room/background sound when no speech event is active.
      if (!speechActiveStartedAt && rms < 0.05) {
        microphoneNoiseFloor = microphoneNoiseFloor * 0.985 + rms * 0.015;
      }

      const threshold = Math.max(0.025, microphoneNoiseFloor * 2.8);
      const loud = rms >= threshold;

      if (loud) {
        speechPeakRms = Math.max(speechPeakRms, rms);
        speechLastLoudAt = now;

        if (!speechCandidateStartedAt) speechCandidateStartedAt = now;

        // Require sustained sound before treating it as a possible speech segment.
        if (!speechActiveStartedAt && now - speechCandidateStartedAt >= 1200) {
          speechActiveStartedAt = speechCandidateStartedAt;
          updateMicrophoneStatus("Possible speech detected");
        }
      } else {
        if (!speechActiveStartedAt && speechCandidateStartedAt && now - speechCandidateStartedAt > 450) {
          speechCandidateStartedAt = 0;
          speechPeakRms = 0;
        }

        // End a speech segment after a short quiet period.
        if (speechActiveStartedAt && now - speechLastLoudAt >= 900) {
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

    if (durationMs >= 1200) {
      logEvent("possible_speech_detected", {
        duration_seconds: Number((durationMs / 1000).toFixed(1)),
        peak_level: Number(speechPeakRms.toFixed(4)),
        detection: "local_audio_level_only"
      });
    }

    speechCandidateStartedAt = 0;
    speechActiveStartedAt = 0;
    speechLastLoudAt = 0;
    speechPeakRms = 0;

    if (microphoneStream?.active && !submitted) {
      updateMicrophoneStatus("Listening locally");
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
    updateMicrophoneStatus("Stopped");
  }

  async function enterFullscreen() {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      suppressBlurUntil = Date.now() + 1200;
      try { await document.documentElement.requestFullscreen(); } catch (_) {}
    }
  }

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

    msg.textContent = "Checking Student ID…";
    $("startBtn").disabled = true;

    const { data, error } = await db.rpc("preview_exam_identity", {
      p_exam_code: examCode,
      p_student_no: studentNo
    });

    $("startBtn").disabled = false;

    if (error || !data?.length) {
      const detail = String(error?.message || error?.details || error?.hint || "");
      if (/preview_exam_identity|function.*does not exist|schema cache|PGRST202/i.test(detail)) {
        msg.textContent = "Student identity confirmation is not installed in Supabase yet. Run supabase-upgrade-student-identity-confirmation.sql once in Supabase SQL Editor.";
      } else {
        msg.textContent = error?.message || "Could not verify the Exam Code and Student ID.";
      }
      return;
    }

    const identity = data[0];
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

  $("identityYesBtn").addEventListener("click", async () => {
    if (!pendingIdentity) return;

    const identity = { ...pendingIdentity };
    const confirmMsg = $("identityConfirmMsg");
    const yesBtn = $("identityYesBtn");
    const noBtn = $("identityNoBtn");

    confirmMsg.textContent = "";
    yesBtn.disabled = true;
    noBtn.disabled = true;

    try {
      confirmMsg.textContent = "Requesting front-camera permission…";
      await requestFrontCamera();
    } catch (cameraError) {
      confirmMsg.textContent = `Front-camera access is required for this examination. ${cameraError?.message || "Please allow camera access and try again."}`;
      yesBtn.disabled = false;
      noBtn.disabled = false;
      return;
    }

    try {
      confirmMsg.textContent = "Requesting microphone permission…";
      await requestMicrophone();
    } catch (microphoneError) {
      stopCameraMonitoring();
      confirmMsg.textContent = `Microphone access is required for speech-event detection during this examination. ${microphoneError?.message || "Please allow microphone access and try again."}`;
      yesBtn.disabled = false;
      noBtn.disabled = false;
      return;
    }

    confirmMsg.textContent = "";

    // This click is also the user gesture used for fullscreen.
    await enterFullscreen();

    const { data, error } = await db.rpc("start_exam", {
      p_exam_code: identity.examCode,
      p_student_no: identity.studentNo,
      p_user_agent: navigator.userAgent
    });

    yesBtn.disabled = false;
    noBtn.disabled = false;

    if (error || !data?.length) {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      stopCameraMonitoring();
      await stopMicrophoneMonitoring();
      confirmMsg.textContent = error?.message || "Could not start the exam.";
      return;
    }

    attempt = data[0];
    pendingIdentity = null;
    $("identityConfirmModal").classList.add("hidden");

    // A genuinely new/restarted attempt must not inherit stale browser state
    // from a prior deleted or submitted attempt.
    clearExamBrowserState();
    sessionStorage.setItem("exam_guard_token", attempt.attempt_token);
    resetExamFlagCounts();

    let existingResponses = [];
    const { data: savedOnStart, error: savedOnStartError } = await db.rpc("get_saved_exam_responses", {
      p_attempt_token: attempt.attempt_token
    });
    if (!savedOnStartError) existingResponses = savedOnStart || [];

    await loadExam({ restored: existingResponses.length > 0, savedResponses: existingResponses });
    startCameraCaptureSchedule();
    await startSpeechMonitoring();
  });

  async function loadExam({ restored = false, savedResponses = [] } = {}) {
    const { data, error } = await db.rpc("get_exam_questions", {
      p_attempt_token: attempt.attempt_token
    });
    if (error) {
      $("loginMsg").textContent = error.message;
      return;
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
  }

  function renderMathContent(element, text) {
    if (!element) return;
    element.textContent = text || "";
    element.classList.add("math-rendered");
    if (window.MathJax?.typesetPromise) {
      window.MathJax.typesetClear?.([element]);
      window.MathJax.typesetPromise([element]).catch(() => {});
    }
  }

  function renderQuestions(savedResponses = []) {
    examForm.innerHTML = "";
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

      const state = document.createElement("div");
      state.className = "save-state";
      const saved = savedByQuestion.get(String(q.question_id));
      state.textContent = saved
        ? `Saved ${saved.saved_at ? new Date(saved.saved_at).toLocaleTimeString() : ""}`.trim()
        : "Not answered";

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
          radio.addEventListener("change", () => saveAnswer(q.question_id, radio.value, state));

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
          if (saved) ta.value = String(saved.answer ?? "");
          let debounce;
          ta.addEventListener("input", () => {
            state.textContent = "Saving…";
            clearTimeout(debounce);
            debounce = setTimeout(() => saveAnswer(q.question_id, ta.value, state), 600);
          });
          wrap.appendChild(ta);
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
            const firstLevels = Array.isArray(q.rubric_criteria[0]?.levels) ? q.rubric_criteria[0].levels : [];
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
                const levels = Array.isArray(item?.levels) ? item.levels : [];
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

    const textarea = document.createElement("textarea");
    textarea.className = "math-solution-input";
    textarea.rows = 4;
    textarea.readOnly = true;
    textarea.inputMode = "none";
    textarea.placeholder = "Tap here, then use the mathematics keyboard below.";
    textarea.value = saved ? String(saved.answer ?? "") : "";

    const preview = document.createElement("div");
    preview.className = "math-solution-preview";
    const keyboard = document.createElement("div");
    keyboard.className = "math-virtual-keyboard hidden";

    const tabs = [
      { name: "123", keys: ["7","8","9","÷","4","5","6","×","1","2","3","−","0",".","=","+","<",">","≤","≥","(",")",","] },
      { name: "ABC", keys: ["a","b","c","d","e","f","g","h","i","j","k","l","m","n","o","p","q","r","s","t","u","v","w","x","y","z"] },
      { name: "αβγ", keys: ["α","β","γ","θ","λ","μ","σ","Δ","π"] },
      { name: "ƒ()", keys: ["x²","x^□","√□","|□|","frac","sin","cos","tan","log","ln","e","i","newline","⌫"] }
    ];

    const tabBar = document.createElement("div");
    tabBar.className = "math-keyboard-tabs";
    const keyArea = document.createElement("div");
    keyArea.className = "math-keyboard-keys";

    function latexForKey(key) {
      return ({
        "÷":"\\div ","×":"\\times ","−":"-","≤":"\\le ","≥":"\\ge ",
        "α":"\\alpha ","β":"\\beta ","γ":"\\gamma ","θ":"\\theta ","λ":"\\lambda ",
        "μ":"\\mu ","σ":"\\sigma ","Δ":"\\Delta ","π":"\\pi ",
        "x²":"x^2","x^□":"x^{}","√□":"\\sqrt{}","|□|":"\\left| \\right|",
        "frac":"\\frac{}{}","sin":"\\sin ","cos":"\\cos ","tan":"\\tan ",
        "log":"\\log ","ln":"\\ln ","newline":"\n"
      })[key] ?? key;
    }

    function insertToken(token) {
      const start = textarea.selectionStart ?? textarea.value.length;
      const end = textarea.selectionEnd ?? start;

      if (token === "⌫") {
        if (start === end && start > 0) {
          textarea.value = textarea.value.slice(0, start - 1) + textarea.value.slice(end);
          textarea.setSelectionRange(start - 1, start - 1);
        } else {
          textarea.value = textarea.value.slice(0, start) + textarea.value.slice(end);
          textarea.setSelectionRange(start, start);
        }
      } else {
        const value = latexForKey(token);
        textarea.value = textarea.value.slice(0, start) + value + textarea.value.slice(end);
        const next = start + value.length;
        textarea.setSelectionRange(next, next);
      }

      autosize();
      updatePreview();
      stateNode.textContent = "Saving…";
      clearTimeout(textarea._saveTimer);
      textarea._saveTimer = setTimeout(() => saveAnswer(question.question_id, textarea.value, stateNode), 500);
      textarea.focus({ preventScroll: true });
    }

    function renderKeys(index) {
      [...tabBar.children].forEach((button, i) => button.classList.toggle("active", i === index));
      keyArea.innerHTML = "";
      tabs[index].keys.forEach(key => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "math-key";
        button.textContent = key === "newline" ? "↵" : key;
        button.title = key === "newline" ? "New line" : key;
        button.addEventListener("mousedown", event => event.preventDefault());
        button.addEventListener("click", () => insertToken(key));
        keyArea.appendChild(button);
      });
    }

    tabs.forEach((tab, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = tab.name;
      button.addEventListener("mousedown", event => event.preventDefault());
      button.addEventListener("click", () => renderKeys(index));
      tabBar.appendChild(button);
    });

    function autosize() {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.max(110, textarea.scrollHeight + 6)}px`;
    }

    function updatePreview() {
      const value = textarea.value.trim();
      preview.textContent = value ? `\\[${value.replace(/\n/g, "\\\\")}\\]` : "Math preview";
      if (window.MathJax?.typesetPromise) {
        window.MathJax.typesetClear?.([preview]);
        window.MathJax.typesetPromise([preview]).catch(() => {});
      }
    }

    textarea.addEventListener("focus", () => keyboard.classList.remove("hidden"));
    container.addEventListener("focusout", event => {
      if (!container.contains(event.relatedTarget)) {
        setTimeout(() => keyboard.classList.add("hidden"), 120);
      }
    });

    keyboard.append(tabBar, keyArea);
    container.append(textarea, preview, keyboard);
    renderKeys(0);
    autosize();
    updatePreview();

    return { container, textarea };
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

  function startTimer() {
    const end = new Date(attempt.ends_at).getTime();
    const tick = () => {
      const ms = Math.max(0, end - Date.now());
      const total = Math.ceil(ms / 1000);
      const min = Math.floor(total / 60);
      const sec = total % 60;
      $("timer").textContent = `${String(min).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
      const fixedTimer = $("fixedRemainingTime");
      if (fixedTimer) fixedTimer.textContent = $("timer").textContent;
      if (ms <= 0) {
        clearInterval(timerHandle);
        submitExam(true);
      }
    };
    tick();
    timerHandle = setInterval(tick, 1000);
  }

  async function submitExam(auto = false) {
    if (!attempt || submitted) return;
    if (!auto && !confirm("Submit your exam now? You will not be able to change your answers afterward.")) return;

    $("submitBtn").disabled = true;
    const originalSubmitText = $("submitBtn").textContent;
    $("submitBtn").textContent = "Saving answers…";

    try {
      warn("Saving your latest answers before submission…");
      await forceSaveAllCurrentAnswers();
    } catch (saveError) {
      $("submitBtn").disabled = false;
      $("submitBtn").textContent = originalSubmitText;
      warn(`Could not save all answers. Please check your connection and submit again. ${saveError?.message || ""}`);
      return;
    }

    await logEvent(auto ? "auto_submit_time_expired" : "student_submit_clicked");

    $("submitBtn").textContent = "Submitting…";

    const { data, error } = await db.rpc("submit_exam", {
      p_attempt_token: attempt.attempt_token
    });

    if (error) {
      $("submitBtn").disabled = false;
      $("submitBtn").textContent = originalSubmitText;
      warn(`Submission failed: ${error.message}`);
      return;
    }

    await stopMicrophoneMonitoring();
    submitted = true;
    clearInterval(timerHandle);
    stopCameraMonitoring();
    clearExamBrowserState();
    examView.classList.add("hidden");
    watermark.classList.remove("active");
    doneView.classList.remove("hidden");
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
      $("doneText").textContent =
        `Your responses have been recorded. Provisional overall score: ${provisional.provisional_score}/${provisional.provisional_max_score}. Essay, Short Response, and Math Solver items are still subject to teacher review and approval.`;
    }

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
    const token = sessionStorage.getItem("exam_guard_token");
    if (!token) return;

    const msg = $("loginMsg");
    msg.textContent = "Restoring your saved exam session…";
    $("startBtn").disabled = true;

    const { data: resumeData, error: resumeError } = await db.rpc("resume_exam", {
      p_attempt_token: token
    });

    if (resumeError || !resumeData?.length) {
      clearExamBrowserState();
      $("startBtn").disabled = false;
      msg.textContent = "";
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
    msg.textContent = "";

    await loadExam({
      restored: true,
      savedResponses: savedResponses || []
    });

    try {
      await requestFrontCamera();
      startCameraCaptureSchedule();
      await requestMicrophone();
      await startSpeechMonitoring();
    } catch (cameraError) {
      updateCameraStatus("Camera unavailable");
      updateMicrophoneStatus("Microphone unavailable");
      warn("Your exam session was restored, but camera or microphone monitoring could not be restarted. Please allow access if prompted.");
      await logEvent("monitoring_device_unavailable_after_restore", {
        message: String(cameraError?.message || cameraError).slice(0, 300)
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

  window.addEventListener("beforeunload", (e) => {
    if (!attempt || submitted) return;
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
