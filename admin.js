(() => {
  const cfg = window.EXAM_CONFIG || {};
  const db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY);
  const $ = (id) => document.getElementById(id);

  let attemptsCache = [];
  let eventsByAttempt = new Map();
  let pollHandle = null;
  let examsCache = [];
  let questionCounter = 0;

  async function checkSession() {
    const { data } = await db.auth.getSession();
    if (data.session) {
      await showDashboard();
    }
  }

  $("adminLoginBtn").addEventListener("click", async () => {
    $("adminLoginBtn").disabled = true;
    $("adminLoginMsg").textContent = "";
    const { error } = await db.auth.signInWithPassword({
      email: $("adminEmail").value.trim(),
      password: $("adminPassword").value
    });
    $("adminLoginBtn").disabled = false;
    if (error) {
      $("adminLoginMsg").textContent = error.message;
      return;
    }
    await showDashboard();
  });

  async function showDashboard() {
    $("adminLogin").classList.add("hidden");
    $("dashboard").classList.remove("hidden");
    bindTabs();
    bindExamBuilder();
    clearExamForm();
    if (!$("questionBuilder").children.length) addQuestionCard();

    await Promise.all([refreshAttempts(), loadExams()]);
    clearInterval(pollHandle);
    pollHandle = setInterval(refreshAttempts, 5000);
  }

  function bindTabs() {
    $("tabAttemptsBtn").onclick = () => activateTab("attempts");
    $("tabCreateBtn").onclick = () => activateTab("create");
    $("tabManageBtn").onclick = () => activateTab("manage");
  }

  function activateTab(name) {
    const map = {
      attempts: { btn: $("tabAttemptsBtn"), section: $("attemptsSection") },
      create: { btn: $("tabCreateBtn"), section: $("createSection") },
      manage: { btn: $("tabManageBtn"), section: $("manageSection") }
    };

    Object.values(map).forEach(({btn, section}) => {
      btn.classList.remove("active");
      section.classList.add("hidden");
    });

    map[name].btn.classList.add("active");
    map[name].section.classList.remove("hidden");

    if (name === "manage") loadExams();
  }

  async function refreshAttempts() {
    const { data, error } = await db
      .from("attempts")
      .select(`
        id,status,started_at,submitted_at,score,max_score,
        students(student_no,full_name),
        exams(code,title)
      `)
      .order("started_at", { ascending: false })
      .limit(500);

    if (error) {
      $("lastRefresh").textContent = `Dashboard access error: ${error.message}`;
      return;
    }

    attemptsCache = data || [];

    const ids = attemptsCache.map(a => a.id);
    eventsByAttempt = new Map();
    if (ids.length) {
      const { data: ev } = await db
        .from("proctor_events")
        .select("attempt_id,event_type")
        .in("attempt_id", ids)
        .order("occurred_at", { ascending: false });
      for (const e of ev || []) {
        if (!eventsByAttempt.has(e.attempt_id)) eventsByAttempt.set(e.attempt_id, []);
        eventsByAttempt.get(e.attempt_id).push(e);
      }
    }

    renderAttempts();
    $("lastRefresh").textContent = `Updated ${new Date().toLocaleTimeString()}`;
  }

  const suspiciousTypes = new Set([
    "tab_or_window_hidden","window_blur","fullscreen_exit","copy_blocked","cut_blocked",
    "paste_blocked","contextmenu_blocked","print_attempt","printscreen_key_detected",
    "keyboard_shortcut_blocked","developer_tools_shortcut_attempt","reload_shortcut_blocked",
    "leave_or_reload_attempt","in_exam_link_navigation_blocked"
  ]);

  function signalCount(attemptId) {
    return (eventsByAttempt.get(attemptId) || []).filter(e => suspiciousTypes.has(e.event_type)).length;
  }

  function renderAttempts() {
    const q = $("searchBox").value.trim().toLowerCase();
    const rows = $("attemptRows");
    rows.innerHTML = "";

    const filtered = attemptsCache.filter(a => {
      const s = `${a.students?.full_name || ""} ${a.students?.student_no || ""} ${a.exams?.title || ""} ${a.exams?.code || ""}`.toLowerCase();
      return !q || s.includes(q);
    });

    for (const a of filtered) {
      const tr = document.createElement("tr");
      tr.className = "clickable";
      const signals = signalCount(a.id);
      const score = a.score == null ? "—" : `${a.score}/${a.max_score}`;
      tr.innerHTML = `
        <td><strong>${escapeHtml(a.students?.full_name || "Unknown")}</strong><br><span class="muted">${escapeHtml(a.students?.student_no || "")}</span></td>
        <td>${escapeHtml(a.exams?.title || "")}<br><span class="muted">${escapeHtml(a.exams?.code || "")}</span></td>
        <td><span class="badge ${a.status === "submitted" ? "ok" : "warn"}">${escapeHtml(a.status)}</span></td>
        <td>${fmt(a.started_at)}</td>
        <td>${fmt(a.submitted_at)}</td>
        <td>${score}</td>
        <td><span class="badge ${signals ? "warn" : "ok"}">${signals}</span></td>`;
      tr.addEventListener("click", () => openDetail(a));
      rows.appendChild(tr);
    }
  }

  async function openDetail(a) {
    $("detailPanel").classList.remove("hidden");
    $("detailTitle").textContent = a.students?.full_name || "Attempt";
    $("detailMeta").textContent = `${a.students?.student_no || ""} • ${a.exams?.title || ""} • ${a.status}`;

    const { data, error } = await db
      .from("proctor_events")
      .select("occurred_at,event_type,details")
      .eq("attempt_id", a.id)
      .order("occurred_at", { ascending: false })
      .limit(1000);

    const rows = $("eventRows");
    rows.innerHTML = "";
    if (error) {
      rows.innerHTML = `<tr><td colspan="3">${escapeHtml(error.message)}</td></tr>`;
      return;
    }

    for (const e of data || []) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${fmt(e.occurred_at)}</td>
        <td>${escapeHtml(e.event_type)}</td>
        <td class="event-json">${escapeHtml(JSON.stringify(e.details || {}, null, 2))}</td>`;
      rows.appendChild(tr);
    }
  }

  function bindExamBuilder() {
    $("addQuestionBtn").addEventListener("click", () => addQuestionCard());
    $("clearExamFormBtn").addEventListener("click", clearExamForm);
    $("saveExamBtn").addEventListener("click", saveExam);
    $("generateCodeBtn").addEventListener("click", generateExamCode);
    $("reloadExamsBtn").addEventListener("click", loadExams);
  }

  function generateExamCode() {
    const title = $("examTitleInput").value.trim();
    if (!title) {
      setCreateMessage("Enter an exam title first.", true);
      return;
    }
    const code = title.toUpperCase()
      .replace(/[^A-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-+/g, "-")
      .slice(0, 40);
    $("examCodeInput").value = code;
  }

  function clearExamForm() {
    $("examTitleInput").value = "";
    $("examCodeInput").value = "";
    $("durationInput").value = "60";
    $("statusInput").value = "draft";
    $("startAtInput").value = "";
    $("endAtInput").value = "";
    $("questionBuilder").innerHTML = "";
    questionCounter = 0;
    addQuestionCard();
    setCreateMessage("");
  }

  function addQuestionCard(prefill = null) {
    questionCounter += 1;
    const idx = questionCounter;
    const q = prefill || {
      prompt: "",
      question_type: "mcq",
      points: 1,
      choices: ["", "", "", ""],
      correct_answer: ""
    };

    const card = document.createElement("section");
    card.className = "question-card";
    card.dataset.qid = String(idx);
    card.innerHTML = `
      <div class="detail-head">
        <div>
          <h3>Question <span class="question-number"></span></h3>
          <p class="muted">Set the prompt, type, and answer key for this item.</p>
        </div>
        <button type="button" class="remove-question-btn">Remove</button>
      </div>

      <label>Question prompt
        <textarea class="q-prompt" rows="4" placeholder="Enter the full question here">${escapeAttr(q.prompt)}</textarea>
      </label>

      <div class="form-grid compact">
        <label>Question type
          <select class="q-type">
            <option value="mcq" ${q.question_type === "mcq" ? "selected" : ""}>Multiple Choice</option>
            <option value="text" ${q.question_type === "text" ? "selected" : ""}>Text / Essay</option>
          </select>
        </label>

        <label>Points
          <input class="q-points" type="number" min="0.25" step="0.25" value="${q.points}">
        </label>
      </div>

      <div class="mcq-area">
        <div class="detail-head">
          <div>
            <h4>Choices</h4>
            <p class="muted">For multiple choice, add the answer options below.</p>
          </div>
          <button type="button" class="add-choice-btn">Add Choice</button>
        </div>
        <div class="choice-list"></div>
        <label>Correct answer
          <select class="q-correct"></select>
        </label>
      </div>
    `;

    $("questionBuilder").appendChild(card);

    const removeBtn = card.querySelector(".remove-question-btn");
    removeBtn.addEventListener("click", () => {
      if ($("questionBuilder").children.length <= 1) {
        setCreateMessage("At least one question is required.", true);
        return;
      }
      card.remove();
      renumberQuestionCards();
    });

    const typeSelect = card.querySelector(".q-type");
    const addChoiceBtn = card.querySelector(".add-choice-btn");
    addChoiceBtn.addEventListener("click", () => {
      addChoiceInput(card, "");
      refreshCorrectAnswerOptions(card);
    });
    typeSelect.addEventListener("change", () => toggleQuestionMode(card));

    (Array.isArray(q.choices) && q.choices.length ? q.choices : ["", "", "", ""]).forEach(choice => addChoiceInput(card, choice));
    toggleQuestionMode(card);
    refreshCorrectAnswerOptions(card, q.correct_answer);
    renumberQuestionCards();
  }

  function addChoiceInput(card, value = "") {
    const list = card.querySelector(".choice-list");
    const row = document.createElement("div");
    row.className = "choice-row";
    row.innerHTML = `
      <input class="choice-input" placeholder="Choice text" value="${escapeAttr(value)}">
      <button type="button" class="remove-choice-btn">Remove</button>
    `;
    list.appendChild(row);

    row.querySelector(".choice-input").addEventListener("input", () => refreshCorrectAnswerOptions(card));
    row.querySelector(".remove-choice-btn").addEventListener("click", () => {
      const rows = card.querySelectorAll(".choice-row");
      if (rows.length <= 2) {
        setCreateMessage("A multiple-choice item should have at least two choices.", true);
        return;
      }
      row.remove();
      refreshCorrectAnswerOptions(card);
    });
  }

  function refreshCorrectAnswerOptions(card, desired = null) {
    const select = card.querySelector(".q-correct");
    const current = desired ?? select.value;
    const values = [...card.querySelectorAll(".choice-input")]
      .map(i => i.value.trim())
      .filter(Boolean);

    select.innerHTML = "";
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = values.length ? "Select the correct answer" : "Enter choices first";
    select.appendChild(empty);

    values.forEach(v => {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v;
      if (v === current) opt.selected = true;
      select.appendChild(opt);
    });
    if (!values.includes(current)) select.value = "";
  }

  function toggleQuestionMode(card) {
    const type = card.querySelector(".q-type").value;
    const mcqArea = card.querySelector(".mcq-area");
    if (type === "text") mcqArea.classList.add("hidden");
    else mcqArea.classList.remove("hidden");
  }

  function renumberQuestionCards() {
    [...$("questionBuilder").children].forEach((card, i) => {
      const span = card.querySelector(".question-number");
      if (span) span.textContent = String(i + 1);
    });
  }

  async function saveExam() {
    setCreateMessage("");
    const payload = collectExamForm();
    if (!payload.ok) {
      setCreateMessage(payload.message, true);
      return;
    }

    $("saveExamBtn").disabled = true;

    const { data: examRows, error: examError } = await db
      .from("exams")
      .insert([payload.exam])
      .select("id, code, title")
      .limit(1);

    if (examError) {
      $("saveExamBtn").disabled = false;
      setCreateMessage(`Exam save failed: ${examError.message}`, true);
      return;
    }

    const exam = examRows?.[0];
    const questions = payload.questions.map((q, i) => ({
      exam_id: exam.id,
      position: i + 1,
      prompt: q.prompt,
      question_type: q.question_type,
      choices: q.choices,
      correct_answer: q.correct_answer,
      points: q.points
    }));

    const { error: questionError } = await db
      .from("questions")
      .insert(questions);

    $("saveExamBtn").disabled = false;

    if (questionError) {
      setCreateMessage(`Exam created, but questions failed: ${questionError.message}`, true);
      return;
    }

    setCreateMessage(`Exam "${exam.title}" saved successfully with code ${exam.code}.`);
    clearExamForm();
    await loadExams();
    activateTab("manage");
  }

  function collectExamForm() {
    const title = $("examTitleInput").value.trim();
    const code = $("examCodeInput").value.trim().toUpperCase();
    const duration = Number($("durationInput").value);
    const status = $("statusInput").value;
    const startAt = toIsoOrNull($("startAtInput").value);
    const endAt = toIsoOrNull($("endAtInput").value);

    if (!title) return fail("Enter the exam title.");
    if (!code) return fail("Enter the exam code.");
    if (!/^[A-Z0-9-]+$/.test(code)) return fail("Exam code may only contain A-Z, 0-9, and hyphens.");
    if (!duration || duration < 1 || duration > 600) return fail("Enter a valid duration between 1 and 600 minutes.");
    if (startAt && endAt && new Date(endAt) <= new Date(startAt)) return fail("End date/time must be later than start date/time.");

    const cards = [...$("questionBuilder").children];
    if (!cards.length) return fail("Add at least one question.");

    const questions = [];
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const prompt = card.querySelector(".q-prompt").value.trim();
      const question_type = card.querySelector(".q-type").value;
      const points = Number(card.querySelector(".q-points").value);

      if (!prompt) return fail(`Question ${i + 1} has no prompt.`);
      if (!points || points <= 0) return fail(`Question ${i + 1} must have a positive point value.`);

      let choices = null;
      let correct_answer = null;

      if (question_type === "mcq") {
        choices = [...card.querySelectorAll(".choice-input")]
          .map(i => i.value.trim())
          .filter(Boolean);

        if (choices.length < 2) return fail(`Question ${i + 1} needs at least two non-empty choices.`);

        const unique = new Set(choices.map(v => v.toLowerCase()));
        if (unique.size !== choices.length) return fail(`Question ${i + 1} has duplicate choices.`);

        correct_answer = card.querySelector(".q-correct").value.trim();
        if (!correct_answer) return fail(`Question ${i + 1} needs a correct answer.`);
      }

      questions.push({
        prompt,
        question_type,
        points,
        choices,
        correct_answer
      });
    }

    return {
      ok: true,
      exam: {
        title,
        code,
        duration_minutes: duration,
        status,
        start_at: startAt,
        end_at: endAt
      },
      questions
    };
  }

  function fail(message) {
    return { ok: false, message };
  }

  function toIsoOrNull(value) {
    if (!value) return null;
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  function setCreateMessage(message, isError = false) {
    const node = $("createExamMsg");
    node.textContent = message || "";
    node.classList.toggle("error", !!isError);
    node.classList.toggle("success", !!message && !isError);
  }

  async function loadExams() {
    let { data: exams, error } = await db
      .from("exams")
      .select("id, code, title, duration_minutes, status, start_at, end_at, archived, archived_at")
      .order("created_at", { ascending: false });

    // Keep the dashboard usable before the one-time archive database upgrade is run.
    if (error && /archived/i.test(error.message || "")) {
      const fallback = await db
        .from("exams")
        .select("id, code, title, duration_minutes, status, start_at, end_at")
        .order("created_at", { ascending: false });
      exams = (fallback.data || []).map(e => ({ ...e, archived: false, archived_at: null }));
      error = fallback.error;
    }

    if (error) {
      $("examRows").innerHTML = `<tr><td colspan="8">${escapeHtml(error.message)}</td></tr>`;
      return;
    }

    examsCache = exams || [];
    const ids = examsCache.map(e => e.id);

    let counts = {};
    if (ids.length) {
      const { data: qs } = await db
        .from("questions")
        .select("exam_id")
        .in("exam_id", ids);

      for (const q of qs || []) {
        counts[q.exam_id] = (counts[q.exam_id] || 0) + 1;
      }
    }

    renderExamRows(counts);
  }

  function renderExamRows(counts) {
    const body = $("examRows");
    body.innerHTML = "";

    if (!examsCache.length) {
      body.innerHTML = `<tr><td colspan="8">No exams found.</td></tr>`;
      return;
    }

    for (const exam of examsCache) {
      const tr = document.createElement("tr");
      const qCount = counts[exam.id] || 0;
      const archived = Boolean(exam.archived);
      tr.classList.toggle("archived-row", archived);
      tr.innerHTML = `
        <td>
          <button type="button" class="exam-title-link" data-exam-id="${escapeAttr(exam.id)}" data-exam-code="${escapeAttr(exam.code)}" data-exam-title="${escapeAttr(exam.title)}">${escapeHtml(exam.title)}</button>
          ${archived ? '<br><span class="badge archived">Archived</span>' : ''}
        </td>
        <td>${escapeHtml(exam.code)}</td>
        <td><span class="badge ${exam.status === "published" ? "ok" : "warn"}">${escapeHtml(exam.status)}</span></td>
        <td>${escapeHtml(String(exam.duration_minutes))} min</td>
        <td>${qCount}</td>
        <td>${fmt(exam.start_at)}</td>
        <td>${fmt(exam.end_at)}</td>
        <td class="action-cell">
          ${archived ? `
            <button type="button" data-exam-action="restore">Restore</button>
          ` : `
            <button type="button" data-action="draft">Draft</button>
            <button type="button" data-action="published">Publish</button>
            <button type="button" data-action="closed">Close</button>
            <button type="button" data-exam-action="archive">Archive</button>
          `}
          <button type="button" class="danger-outline" data-exam-action="delete">Delete</button>
        </td>
      `;

      tr.querySelectorAll("button[data-action]").forEach(btn => {
        btn.addEventListener("click", async () => {
          await updateExamStatus(exam.id, btn.dataset.action);
        });
      });

      tr.querySelectorAll("button[data-exam-action]").forEach(btn => {
        btn.addEventListener("click", async () => {
          const action = btn.dataset.examAction;
          if (action === "archive") await archiveExam(exam);
          if (action === "restore") await restoreExam(exam);
          if (action === "delete") await deleteExam(exam);
        });
      });

      body.appendChild(tr);
    }
  }

  async function updateExamStatus(examId, status) {
    const { error } = await db
      .from("exams")
      .update({ status })
      .eq("id", examId);

    if (error) {
      alert(`Could not update exam status: ${error.message}`);
      return;
    }
    await loadExams();
  }

  async function archiveExam(exam) {
    const ok = confirm(
      `Archive "${exam.title}"?\n\nThe exam and all student results will be kept, but the exam will be closed and marked archived.`
    );
    if (!ok) return;

    const { error } = await db
      .from("exams")
      .update({
        archived: true,
        archived_at: new Date().toISOString(),
        status: "closed"
      })
      .eq("id", exam.id);

    if (error) {
      alert(
        `Could not archive exam: ${error.message}\n\nIf this mentions the archived column, run supabase-upgrade-archive-delete.sql in Supabase SQL Editor.`
      );
      return;
    }
    await loadExams();
  }

  async function restoreExam(exam) {
    const ok = confirm(
      `Restore "${exam.title}"?\n\nIt will return as a draft. You can publish it again when ready.`
    );
    if (!ok) return;

    const { error } = await db
      .from("exams")
      .update({
        archived: false,
        archived_at: null,
        status: "draft"
      })
      .eq("id", exam.id);

    if (error) {
      alert(`Could not restore exam: ${error.message}`);
      return;
    }
    await loadExams();
  }

  async function deleteExam(exam) {
    const ok = confirm(
      `PERMANENTLY DELETE "${exam.title}"?\n\nThis will also delete its questions, every student's attempt, saved answers, AI feedback, and proctoring events. This cannot be undone.`
    );
    if (!ok) return;

    const second = confirm(
      `Final confirmation: delete exam code "${exam.code}" and all associated records?`
    );
    if (!second) return;

    const { data, error } = await db.rpc("admin_delete_exam", {
      p_exam_id: exam.id
    });

    if (error) {
      alert(
        `Could not delete exam: ${error.message}\n\nRun supabase-fix-admin-delete.sql in Supabase SQL Editor, then refresh this page.`
      );
      return;
    }

    if (data !== true) {
      alert("No exam was deleted. It may already have been removed.");
      return;
    }

    alert(`Exam "${exam.title}" was deleted successfully.`);
    $("examResultsPanel")?.classList.add("hidden");
    await Promise.all([loadExams(), refreshAttempts()]);
  }

  $("searchBox").addEventListener("input", renderAttempts);
  $("refreshBtn").addEventListener("click", refreshAttempts);
  $("closeDetail").addEventListener("click", () => $("detailPanel").classList.add("hidden"));
  $("signOutBtn").addEventListener("click", async () => {
    clearInterval(pollHandle);
    await db.auth.signOut();
    location.reload();
  });

  function fmt(value) {
    return value ? new Date(value).toLocaleString() : "—";
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, c => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
    })[c]);
  }

  function escapeAttr(value) {
    return String(value).replace(/[&<>"']/g, c => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
    })[c]);
  }

  // Shared authenticated admin client/hooks for companion dashboard scripts.
  window.ExamAdmin = {
    db,
    refreshAttempts,
    loadExams
  };

  // Public hooks used by the Excel importer. This reuses the same validated
  // question-builder UI instead of maintaining a second import-only format.
  window.ExamBuilder = {
    replaceQuestions(questionList) {
      $("questionBuilder").innerHTML = "";
      questionCounter = 0;
      (questionList || []).forEach(q => addQuestionCard(q));
      if (!questionList?.length) addQuestionCard();
      renumberQuestionCards();
    },
    appendQuestions(questionList) {
      (questionList || []).forEach(q => addQuestionCard(q));
      renumberQuestionCards();
    },
    setMessage(message, isError = false) {
      setCreateMessage(message, isError);
    }
  };

  checkSession();
})();
