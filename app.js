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

  async function enterFullscreen() {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      suppressBlurUntil = Date.now() + 1200;
      try { await document.documentElement.requestFullscreen(); } catch (_) {}
    }
  }

  $("startBtn").addEventListener("click", async () => {
    const examCode = $("examCode").value.trim();
    const studentNo = $("studentNo").value.trim();
    const studentName = $("studentName").value.trim();
    const consent = $("consentBox").checked;
    const msg = $("loginMsg");

    if (!examCode || !studentNo || !studentName) {
      msg.textContent = "Complete the exam code, student number, and full name.";
      return;
    }
    if (!consent) {
      msg.textContent = "Please acknowledge the monitoring notice before starting.";
      return;
    }

    msg.textContent = "";
    $("startBtn").disabled = true;

    // Fullscreen must be requested from a user gesture. The exam still works if
    // the browser/platform refuses it, but the refusal/exit is logged once started.
    await enterFullscreen();

    const { data, error } = await db.rpc("start_exam", {
      p_exam_code: examCode,
      p_student_no: studentNo,
      p_student_name: studentName,
      p_user_agent: navigator.userAgent
    });

    if (error || !data?.length) {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      msg.textContent = error?.message || "Could not start the exam.";
      $("startBtn").disabled = false;
      return;
    }

    attempt = data[0];
    sessionStorage.setItem("exam_guard_token", attempt.attempt_token);
    await loadExam();
  });

  async function loadExam() {
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

    renderQuestions();
    startTimer();
    await logEvent("exam_started", { userAgent: navigator.userAgent, screen: `${screen.width}x${screen.height}` });
  }

  function renderQuestions() {
    examForm.innerHTML = "";
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
      state.textContent = "Not answered";

      if (q.question_type === "mcq") {
        const choices = Array.isArray(q.choices) ? q.choices : [];
        choices.forEach((choice, i) => {
          const label = document.createElement("label");
          label.className = "choice";
          const radio = document.createElement("input");
          radio.type = "radio";
          radio.name = `q_${q.question_id}`;
          radio.value = String(choice);
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
    window.ExamAI?.generateFeedback(attempt.attempt_token);

    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

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
