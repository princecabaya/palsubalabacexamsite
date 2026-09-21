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

  const safeDetails = (extra = {}) => ({
    visibility: document.visibilityState,
    fullscreen: !!document.fullscreenElement,
    online: navigator.onLine,
    page: location.pathname,
    ...extra
  });

  async function logEvent(type, details = {}) {
    if (!attempt?.attempt_token || submitted) return;
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

    msg.textContent = "Checking Student ID…";
    $("startBtn").disabled = true;

    const { data, error } = await db.rpc("preview_exam_identity", {
      p_exam_code: examCode,
      p_student_no: studentNo
    });

    $("startBtn").disabled = false;

    if (error || !data?.length) {
      msg.textContent = error?.message || "Could not verify the student identity.";
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
      confirmMsg.textContent = error?.message || "Could not start the exam.";
      return;
    }

    attempt = data[0];
    pendingIdentity = null;
    $("identityConfirmModal").classList.add("hidden");
    sessionStorage.setItem("exam_guard_token", attempt.attempt_token);
    await loadExam({ restored: false, savedResponses: [] });
    startCameraCaptureSchedule();
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

  function renderQuestions(savedResponses = []) {
    examForm.innerHTML = "";
    const savedByQuestion = new Map(
      (savedResponses || []).map(r => [String(r.question_id), r])
    );

    for (const q of questions) {
      const wrap = document.createElement("section");
      wrap.className = "question";
      wrap.dataset.questionId = q.question_id;

      const head = document.createElement("div");
      head.className = "q-head";
      head.innerHTML = `<span class="q-no">Question ${q.position}</span><span class="points">${q.points} point${q.points == 1 ? "" : "s"}</span>`;
      wrap.appendChild(head);

      const prompt = document.createElement("div");
      prompt.className = "prompt";
      prompt.textContent = q.prompt;
      wrap.appendChild(prompt);

      const state = document.createElement("div");
      state.className = "save-state";
      const saved = savedByQuestion.get(String(q.question_id));
      state.textContent = saved
        ? `Saved ${saved.saved_at ? new Date(saved.saved_at).toLocaleTimeString() : ""}`.trim()
        : "Not answered";

      if (q.question_type === "mcq") {
        const choices = Array.isArray(q.choices) ? q.choices : [];
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
          span.textContent = `${String.fromCharCode(65+i)}. ${choice}`;
          label.append(radio, span);
          wrap.appendChild(label);
        });
      } else {
        const ta = document.createElement("textarea");
        ta.rows = 5;
        ta.placeholder = "Type your answer here";
        if (saved) ta.value = String(saved.answer ?? "");
        let debounce;
        ta.addEventListener("input", () => {
          state.textContent = "Saving…";
          clearTimeout(debounce);
          debounce = setTimeout(() => saveAnswer(q.question_id, ta.value, state), 600);
        });
        wrap.appendChild(ta);
      }

      wrap.appendChild(state);
      examForm.appendChild(wrap);
    }
  }

  async function saveAnswer(questionId, answer, stateNode) {
    const { error } = await db.rpc("save_exam_response", {
      p_attempt_token: attempt.attempt_token,
      p_question_id: questionId,
      p_answer: answer
    });
    if (error) {
      stateNode.textContent = "Save failed — retry by changing the answer.";
      stateNode.style.color = "#b42318";
    } else {
      stateNode.textContent = `Saved ${new Date().toLocaleTimeString()}`;
      stateNode.style.color = "";
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
    await logEvent(auto ? "auto_submit_time_expired" : "student_submit_clicked");

    const { data, error } = await db.rpc("submit_exam", {
      p_attempt_token: attempt.attempt_token
    });

    if (error) {
      $("submitBtn").disabled = false;
      warn(`Submission failed: ${error.message}`);
      return;
    }

    submitted = true;
    clearInterval(timerHandle);
    stopCameraMonitoring();
    sessionStorage.removeItem("exam_guard_token");
    examView.classList.add("hidden");
    watermark.classList.remove("active");
    doneView.classList.remove("hidden");

    const row = data?.[0];
    $("doneText").textContent = row?.score == null
      ? "Your responses have been recorded."
      : `Your responses have been recorded. Auto-scored result: ${row.score}/${row.max_score}.`;

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
      sessionStorage.removeItem("exam_guard_token");
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
    msg.textContent = "";

    await loadExam({
      restored: true,
      savedResponses: savedResponses || []
    });

    try {
      await requestFrontCamera();
      startCameraCaptureSchedule();
    } catch (cameraError) {
      updateCameraStatus("Camera unavailable");
      warn("Your exam session was restored, but the front camera could not be restarted. Please allow camera access if prompted.");
      await logEvent("camera_unavailable_after_restore", {
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
