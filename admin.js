(() => {
  const cfg = window.EXAM_CONFIG || {};
  const db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY);
  const $ = (id) => document.getElementById(id);

  let attemptsCache = [];
  let eventsByAttempt = new Map();
  let pollHandle = null;
  let examsCache = [];
  let questionCounter = 0;
  let editingExamId = null;
  let currentUserId = null;
  let currentTeacherProfile = null;
  let teacherWorkspaces = [];
  let activeWorkspaceOwnerId = null;
  let teacherManagementBound = false;
  const expandedAttemptExams = new Set();

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

    await initializeTeacherWorkspace();
    await Promise.all([refreshAttempts(), loadExams()]);
    clearInterval(pollHandle);
    pollHandle = setInterval(refreshAttempts, 5000);
  }

  function bindTabs() {
    $("tabAttemptsBtn").onclick = () => activateTab("attempts");
    $("tabCreateBtn").onclick = () => activateTab("create");
    $("tabManageBtn").onclick = () => activateTab("manage");
    $("tabStudentsBtn").onclick = () => activateTab("students");
    $("tabTeachersBtn").onclick = () => activateTab("teachers");
  }

  function activateTab(name) {
    const map = {
      attempts: { btn: $("tabAttemptsBtn"), section: $("attemptsSection") },
      create: { btn: $("tabCreateBtn"), section: $("createSection") },
      manage: { btn: $("tabManageBtn"), section: $("manageSection") },
      students: { btn: $("tabStudentsBtn"), section: $("studentsSection") },
      teachers: { btn: $("tabTeachersBtn"), section: $("teachersSection") }
    };

    Object.values(map).forEach(({btn, section}) => {
      btn.classList.remove("active");
      section.classList.add("hidden");
    });

    map[name].btn.classList.add("active");
    map[name].section.classList.remove("hidden");

    if (name === "manage") loadExams();
    if (name === "students") window.StudentAdmin?.loadStudents?.();
    if (name === "teachers") loadTeacherAccessList();
  }

  async function initializeTeacherWorkspace() {
    const { data: sessionData } = await db.auth.getSession();
    currentUserId = sessionData?.session?.user?.id || null;
    if (!currentUserId) return;

    const { data, error } = await db.rpc("get_teacher_workspaces");
    if (error) {
      console.warn("Teacher workspace setup unavailable:", error);
      activeWorkspaceOwnerId = currentUserId;
      return;
    }

    teacherWorkspaces = data || [];
    currentTeacherProfile = teacherWorkspaces.find(t => t.user_id === currentUserId) || null;
    activeWorkspaceOwnerId = currentUserId;

    const isMainAdmin = currentTeacherProfile?.role === "main_admin";
    $("teacherWorkspaceBar")?.classList.toggle("hidden", !isMainAdmin);
    $("tabTeachersBtn")?.classList.toggle("hidden", !isMainAdmin);

    if (!isMainAdmin) return;

    const select = $("teacherWorkspaceSelect");
    select.innerHTML = "";

    for (const teacher of teacherWorkspaces.filter(t => t.is_admin)) {
      const option = document.createElement("option");
      option.value = teacher.user_id;
      option.textContent = teacher.user_id === currentUserId
        ? `${teacher.display_name || teacher.email || "Main Admin"} — My Dashboard`
        : `${teacher.display_name || teacher.email || "Teacher"} — Support View`;
      select.appendChild(option);
    }

    select.value = activeWorkspaceOwnerId;
    updateWorkspaceNote();

    select.onchange = async () => {
      activeWorkspaceOwnerId = select.value || currentUserId;
      editingExamId = null;
      clearExamForm();
      $("examResultsPanel")?.classList.add("hidden");
      $("detailPanel")?.classList.add("hidden");
      updateWorkspaceNote();
      await Promise.all([
        refreshAttempts(),
        loadExams(),
        window.StudentAdmin?.loadStudents?.()
      ]);
    };

    bindTeacherManagement();
  }

  function updateWorkspaceNote() {
    const teacher = teacherWorkspaces.find(t => t.user_id === activeWorkspaceOwnerId);
    const note = $("teacherWorkspaceNote");
    if (!note) return;

    if (!teacher || activeWorkspaceOwnerId === currentUserId) {
      note.textContent = "You are viewing your Main Admin examination workspace.";
      return;
    }

    note.textContent = `Support view: ${teacher.display_name || teacher.email}. Exams you create while this workspace is selected will belong to this teacher.`;
  }

  function getActiveWorkspaceOwnerId() {
    return activeWorkspaceOwnerId || currentUserId;
  }

  function bindTeacherManagement() {
    if (teacherManagementBound) return;
    teacherManagementBound = true;
    $("reloadTeachersBtn")?.addEventListener("click", loadTeacherAccessList);
    $("authorizeTeacherBtn")?.addEventListener("click", authorizeTeacher);
  }

  async function loadTeacherAccessList() {
    if (currentTeacherProfile?.role !== "main_admin") return;

    const { data, error } = await db
      .from("exam_admins")
      .select("user_id,email,display_name,role,is_admin,created_at")
      .order("display_name", { ascending: true });

    const tbody = $("teacherRows");
    if (!tbody) return;
    tbody.innerHTML = "";

    if (error) {
      tbody.innerHTML = `<tr><td colspan="5">${escapeHtml(error.message)}</td></tr>`;
      return;
    }

    for (const teacher of data || []) {
      const tr = document.createElement("tr");
      const isMain = teacher.role === "main_admin";
      tr.innerHTML = `
        <td><strong>${escapeHtml(teacher.display_name || "—")}</strong></td>
        <td>${escapeHtml(teacher.email || "—")}</td>
        <td><span class="badge ${isMain ? "ok" : ""}">${isMain ? "Main Admin" : "Teacher"}</span></td>
        <td><span class="badge ${teacher.is_admin ? "ok" : "archived"}">${teacher.is_admin ? "Enabled" : "Disabled"}</span></td>
        <td class="action-cell">
          ${!isMain && teacher.is_admin ? '<button type="button" class="open-teacher-workspace-btn">Open Workspace</button>' : ""}
          ${!isMain ? `<button type="button" class="${teacher.is_admin ? "danger-outline" : "primary"} toggle-teacher-access-btn">${teacher.is_admin ? "Disable Access" : "Enable Access"}</button>` : ""}
        </td>
      `;

      tr.querySelector(".open-teacher-workspace-btn")?.addEventListener("click", async () => {
        const select = $("teacherWorkspaceSelect");
        if (select) {
          select.value = teacher.user_id;
          select.dispatchEvent(new Event("change"));
          activateTab("manage");
        }
      });

      tr.querySelector(".toggle-teacher-access-btn")?.addEventListener("click", async () => {
        const enabled = !teacher.is_admin;
        const ok = confirm(`${enabled ? "Enable" : "Disable"} dashboard access for ${teacher.display_name || teacher.email}?`);
        if (!ok) return;

        const { error: toggleError } = await db.rpc("main_admin_set_teacher_access", {
          p_user_id: teacher.user_id,
          p_enabled: enabled
        });

        if (toggleError) {
          alert(`Could not change teacher access: ${toggleError.message}`);
          return;
        }

        await initializeTeacherWorkspace();
        await loadTeacherAccessList();
      });

      tbody.appendChild(tr);
    }
  }

  async function authorizeTeacher() {
    if (currentTeacherProfile?.role !== "main_admin") return;

    const email = $("teacherEmailInput")?.value?.trim() || "";
    const displayName = $("teacherNameInput")?.value?.trim() || "";
    const msg = $("teacherAccessMsg");

    msg.textContent = "";
    msg.classList.remove("error", "success");

    if (!email) {
      msg.textContent = "Enter the teacher's Supabase Authentication email.";
      msg.classList.add("error");
      return;
    }

    $("authorizeTeacherBtn").disabled = true;
    const { error } = await db.rpc("main_admin_add_teacher", {
      p_email: email,
      p_display_name: displayName || null
    });
    $("authorizeTeacherBtn").disabled = false;

    if (error) {
      msg.textContent = error.message;
      msg.classList.add("error");
      return;
    }

    msg.textContent = "Teacher access enabled.";
    msg.classList.add("success");
    $("teacherEmailInput").value = "";
    $("teacherNameInput").value = "";

    await initializeTeacherWorkspace();
    await loadTeacherAccessList();
  }

  async function refreshAttempts() {
    const { data, error } = await db
      .from("attempts")
      .select(`
        id,status,started_at,submitted_at,score,max_score,
        students(student_no,full_name),
        exams(id,code,title,owner_id)
      `)
      .order("started_at", { ascending: false })
      .limit(500);

    if (error) {
      $("lastRefresh").textContent = `Dashboard access error: ${error.message}`;
      return;
    }

    attemptsCache = (data || []).filter(a =>
      !getActiveWorkspaceOwnerId() || a.exams?.owner_id === getActiveWorkspaceOwnerId()
    );

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

    if (!filtered.length) {
      rows.innerHTML = '<tr><td colspan="7">No attempts match this search.</td></tr>';
      return;
    }

    const groups = new Map();
    for (const attempt of filtered) {
      const examKey = attempt.exams?.id || attempt.exams?.code || attempt.exams?.title || "unknown-exam";
      if (!groups.has(examKey)) {
        groups.set(examKey, {
          key: examKey,
          title: attempt.exams?.title || "Untitled Exam",
          code: attempt.exams?.code || "",
          attempts: []
        });
      }
      groups.get(examKey).attempts.push(attempt);
    }

    for (const group of groups.values()) {
      const submittedCount = group.attempts.filter(a => a.status === "submitted").length;
      const activeCount = group.attempts.filter(a => a.status === "active").length;
      const totalSignals = group.attempts.reduce((sum, a) => sum + signalCount(a.id), 0);

      if (q) expandedAttemptExams.add(group.key);
      const expanded = expandedAttemptExams.has(group.key);

      const header = document.createElement("tr");
      header.className = "attempt-exam-group";
      header.innerHTML = `
        <td colspan="7">
          <div class="attempt-group-bar">
            <button type="button" class="attempt-group-toggle" aria-expanded="${expanded ? "true" : "false"}">
              <span class="attempt-group-chevron">${expanded ? "▾" : "▸"}</span>
              <span class="attempt-group-title">
                <strong>${escapeHtml(group.title)}</strong>
                <span class="muted">${escapeHtml(group.code)}</span>
              </span>
              <span class="attempt-group-summary">
                ${group.attempts.length} attempt${group.attempts.length === 1 ? "" : "s"}
                • ${submittedCount} submitted
                ${activeCount ? ` • ${activeCount} active` : ""}
                • ${totalSignals} signal${totalSignals === 1 ? "" : "s"}
              </span>
            </button>
            <button type="button" class="exam-excel-btn" title="Download this examination's attempt records as Excel">Excel</button>
          </div>
        </td>
      `;

      header.querySelector(".attempt-group-toggle").addEventListener("click", () => {
        if (expandedAttemptExams.has(group.key)) expandedAttemptExams.delete(group.key);
        else expandedAttemptExams.add(group.key);
        renderAttempts();
      });

      header.querySelector(".exam-excel-btn").addEventListener("click", async (event) => {
        event.stopPropagation();
        await exportExamAttemptsExcel(group.key, group.title, group.code, event.currentTarget);
      });

      rows.appendChild(header);

      if (!expanded) continue;

      for (const a of group.attempts) {
        const tr = document.createElement("tr");
        tr.className = "clickable attempt-student-row";
        const signals = signalCount(a.id);
        const score = a.score == null ? "—" : `${a.score}/${a.max_score}`;
        tr.innerHTML = `
          <td><strong>${escapeHtml(a.students?.full_name || "Unknown")}</strong><br><span class="muted">${escapeHtml(a.students?.student_no || "")}</span></td>
          <td><span class="muted">Student attempt</span></td>
          <td><span class="badge ${a.status === "submitted" ? "ok" : "warn"}">${escapeHtml(a.status)}</span></td>
          <td>${fmt(a.started_at)}</td>
          <td>${fmt(a.submitted_at)}</td>
          <td>${escapeHtml(score)}</td>
          <td><span class="badge ${signals ? "warn" : "ok"}">${signals}</span></td>
        `;
        tr.addEventListener("click", () => openDetail(a));
        rows.appendChild(tr);
      }
    }
  }

  async function exportExamAttemptsExcel(examId, examTitle, examCode, button) {
    if (!window.XLSX) {
      alert("Excel export library is unavailable. Refresh the dashboard and try again.");
      return;
    }

    const oldText = button?.textContent || "Excel";
    if (button) {
      button.disabled = true;
      button.textContent = "Preparing…";
    }

    try {
      const { data: attempts, error: attemptError } = await db
        .from("attempts")
        .select(`
          id,status,started_at,submitted_at,score,max_score,
          students(student_no,full_name)
        `)
        .eq("exam_id", examId)
        .order("started_at", { ascending: true });

      if (attemptError) throw attemptError;

      const attemptRows = attempts || [];
      const attemptIds = attemptRows.map(a => a.id);

      const { data: questions, error: questionError } = await db
        .from("questions")
        .select("id,position,question_type,choices")
        .eq("exam_id", examId)
        .order("position", { ascending: true });

      if (questionError) throw questionError;

      let responses = [];
      let signalEvents = [];

      if (attemptIds.length) {
        const responseResult = await db
          .from("responses")
          .select("attempt_id,question_id,answer")
          .in("attempt_id", attemptIds);

        if (responseResult.error) throw responseResult.error;
        responses = responseResult.data || [];

        const eventResult = await db
          .from("proctor_events")
          .select("attempt_id,event_type")
          .in("attempt_id", attemptIds);

        if (eventResult.error) throw eventResult.error;
        signalEvents = eventResult.data || [];
      }

      const responseMap = new Map();
      for (const response of responses) {
        responseMap.set(
          `${response.attempt_id}::${response.question_id}`,
          response.answer == null ? "" : String(response.answer)
        );
      }

      const flaggedByAttempt = new Map();
      for (const event of signalEvents) {
        if (!suspiciousTypes.has(event.event_type)) continue;
        flaggedByAttempt.set(
          event.attempt_id,
          (flaggedByAttempt.get(event.attempt_id) || 0) + 1
        );
      }

      const questionList = questions || [];
      const itemHeaders = questionList.map(q => `Item ${q.position}`);
      const headers = [
        "Student Number",
        "Student Name",
        "Status",
        "Score",
        "Time Taken",
        "Time Submitted",
        "Flagged Signals",
        ...itemHeaders
      ];

      const records = attemptRows.map(a => {
        const row = {
          "Student Number": a.students?.student_no || "",
          "Student Name": a.students?.full_name || "",
          "Status": a.status || "",
          "Score": a.score == null
            ? ""
            : `${trimNumber(Number(a.score))}/${a.max_score == null ? "" : trimNumber(Number(a.max_score))}`,
          "Time Taken": formatExcelDuration(a.started_at, a.submitted_at),
          "Time Submitted": a.submitted_at ? new Date(a.submitted_at) : "",
          "Flagged Signals": flaggedByAttempt.get(a.id) || 0
        };

        for (const question of questionList) {
          const answer = responseMap.get(`${a.id}::${question.id}`) ?? "";
          row[`Item ${question.position}`] = getOptionLetter(question, answer);
        }

        return row;
      });

      const ws = XLSX.utils.json_to_sheet(records, {
        header: headers,
        skipHeader: false
      });

      // Keep timestamps as real Excel dates where available.
      for (let index = 0; index < records.length; index += 1) {
        const excelRow = index + 2;
        const cell = ws[`F${excelRow}`];
        if (cell && cell.v instanceof Date) {
          cell.t = "d";
          cell.z = "yyyy-mm-dd hh:mm AM/PM";
        }
      }

      const itemColumnWidth = 10;
      ws["!cols"] = [
        { wch: 18 },
        { wch: 30 },
        { wch: 12 },
        { wch: 12 },
        { wch: 16 },
        { wch: 23 },
        { wch: 16 },
        ...questionList.map(() => ({ wch: itemColumnWidth }))
      ];

      if (headers.length) {
        ws["!autofilter"] = {
          ref: `A1:${XLSX.utils.encode_col(headers.length - 1)}${Math.max(1, records.length + 1)}`
        };
      }

      const infoRows = [
        ["Examination", examTitle || ""],
        ["Exam Code", examCode || ""],
        ["Generated", new Date()],
        ["Attempts", records.length],
        ["Note", "Item columns show the option letter selected by the student. Blank means unanswered. Text-response items contain the saved response text."]
      ];
      const infoSheet = XLSX.utils.aoa_to_sheet(infoRows);
      infoSheet["!cols"] = [{ wch: 18 }, { wch: 90 }];

      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, ws, "Attempt Records");
      XLSX.utils.book_append_sheet(workbook, infoSheet, "Exam Info");

      const safeName = safeExcelFilename(examCode || examTitle || "Exam");
      XLSX.writeFile(workbook, `${safeName}_Attempt_Records.xlsx`, {
        compression: true
      });
    } catch (error) {
      console.error("Excel export error:", error);
      alert(`Could not generate Excel file: ${error?.message || error}`);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = oldText;
      }
    }
  }

  function getOptionLetter(question, answer) {
    const value = String(answer ?? "").trim();
    if (!value) return "";

    if (question.question_type !== "mcq") {
      return value;
    }

    const choices = Array.isArray(question.choices) ? question.choices : [];
    const normalized = value.toLocaleLowerCase();

    const index = choices.findIndex(choice =>
      String(choice ?? "").trim().toLocaleLowerCase() === normalized
    );

    if (index < 0) return "";
    return excelOptionLabel(index);
  }

  function excelOptionLabel(index) {
    let n = Number(index) + 1;
    let label = "";
    while (n > 0) {
      n -= 1;
      label = String.fromCharCode(65 + (n % 26)) + label;
      n = Math.floor(n / 26);
    }
    return label;
  }

  function formatExcelDuration(startedAt, submittedAt) {
    if (!startedAt) return "";
    if (!submittedAt) return "Not submitted";

    const start = new Date(startedAt).getTime();
    const end = new Date(submittedAt).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "";

    let seconds = Math.floor((end - start) / 1000);
    const hours = Math.floor(seconds / 3600);
    seconds -= hours * 3600;
    const minutes = Math.floor(seconds / 60);
    seconds -= minutes * 60;

    if (hours > 0) {
      return `${hours}h ${String(minutes).padStart(2,"0")}m ${String(seconds).padStart(2,"0")}s`;
    }
    return `${minutes}m ${String(seconds).padStart(2,"0")}s`;
  }

  function safeExcelFilename(value) {
    return String(value || "Exam")
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80) || "Exam";
  }

  async function openDetail(a) {
    $("detailPanel").classList.remove("hidden");
    const savedDetails = $("savedResponsesSection");
    if (savedDetails && "open" in savedDetails) savedDetails.open = false;
    $("detailTitle").textContent = a.students?.full_name || "Attempt";
    $("detailMeta").textContent = `${a.students?.student_no || ""} • ${a.exams?.title || ""} • ${a.status}`;

    await loadSavedResponses(a);

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

    const events = data || [];
    renderAttemptSummary(a, events);

    for (const e of events) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${fmt(e.occurred_at)}</td>
        <td>${escapeHtml(e.event_type)}</td>
        <td class="event-json">${escapeHtml(JSON.stringify(e.details || {}, null, 2))}</td>`;
      rows.appendChild(tr);
    }
  }

  async function loadSavedResponses(attempt) {
    const rows = $("savedResponseRows");
    const note = $("savedResponsesNote");
    const countBadge = $("savedResponsesCount");

    if (!rows || !note || !countBadge) return;

    rows.innerHTML = '<tr><td colspan="3">Loading saved responses…</td></tr>';
    countBadge.textContent = "Loading…";

    const examId = attempt.exams?.id;
    if (!examId) {
      rows.innerHTML = '<tr><td colspan="3">Exam information is unavailable.</td></tr>';
      note.textContent = "Could not identify the examination for this attempt.";
      countBadge.textContent = "0 answered";
      return;
    }

    const [questionResult, responseResult] = await Promise.all([
      db
        .from("questions")
        .select("id,position,prompt,question_type,choices")
        .eq("exam_id", examId)
        .order("position", { ascending: true }),
      db
        .from("responses")
        .select("question_id,answer,saved_at")
        .eq("attempt_id", attempt.id)
    ]);

    if (questionResult.error || responseResult.error) {
      const message = questionResult.error?.message || responseResult.error?.message || "Could not load saved responses.";
      rows.innerHTML = `<tr><td colspan="3">${escapeHtml(message)}</td></tr>`;
      note.textContent = "Saved responses could not be loaded.";
      countBadge.textContent = "—";
      return;
    }

    const responsesByQuestion = new Map(
      (responseResult.data || []).map(r => [String(r.question_id), r])
    );

    const questions = questionResult.data || [];
    const answered = questions.filter(q => {
      const r = responsesByQuestion.get(String(q.id));
      return r && String(r.answer ?? "").trim() !== "";
    }).length;

    if (attempt.status === "submitted") {
      note.textContent = "These are the responses saved in Supabase for the submitted examination.";
    } else if (attempt.status === "expired") {
      note.textContent = "These responses were autosaved before the examination attempt expired. They were not submitted.";
    } else {
      note.textContent = "These responses are currently autosaved in Supabase. The student has not submitted the examination yet.";
    }

    countBadge.textContent = `${answered}/${questions.length} answered`;
    rows.innerHTML = "";

    if (!questions.length) {
      rows.innerHTML = '<tr><td colspan="3">No questions were found for this examination.</td></tr>';
      return;
    }

    for (const question of questions) {
      const saved = responsesByQuestion.get(String(question.id));
      const rawAnswer = String(saved?.answer ?? "").trim();
      const displayedAnswer = formatSavedResponseForTeacher(question, rawAnswer);

      const tr = document.createElement("tr");
      tr.className = rawAnswer ? "" : "unanswered-response-row";
      tr.innerHTML = `
        <td>
          <strong>Item ${escapeHtml(String(question.position))}</strong>
          <div class="saved-response-prompt">${escapeHtml(question.prompt || "")}</div>
        </td>
        <td>${displayedAnswer ? escapeHtml(displayedAnswer) : '<span class="muted">Unanswered</span>'}</td>
        <td>${saved?.saved_at ? fmt(saved.saved_at) : "—"}</td>
      `;
      rows.appendChild(tr);
    }
  }

  function formatSavedResponseForTeacher(question, answer) {
    if (!answer) return "";

    if (question.question_type !== "mcq") {
      return answer;
    }

    const choices = Array.isArray(question.choices) ? question.choices : [];
    const normalized = answer.trim().toLocaleLowerCase();
    const index = choices.findIndex(choice =>
      String(choice ?? "").trim().toLocaleLowerCase() === normalized
    );

    if (index < 0) return answer;

    const letter = excelOptionLabel(index);
    return `${letter}. ${answer}`;
  }

  function renderAttemptSummary(attempt, events) {
    const count = (type) => events.filter(e => e.event_type === type).length;
    const countAny = (types) => events.filter(e => types.includes(e.event_type)).length;

    const score = numberOrNull(attempt.score);
    const maxScore = numberOrNull(attempt.max_score);
    const percent = score !== null && maxScore !== null && maxScore > 0
      ? (score / maxScore) * 100
      : null;

    $("summaryScore").textContent = score === null
      ? "—"
      : `${trimNumber(score)}/${maxScore === null ? "—" : trimNumber(maxScore)}`;
    $("summaryPercent").textContent = percent === null ? "—" : `${formatPercent(percent)}%`;
    $("summaryDuration").textContent = formatDuration(attempt.started_at, attempt.submitted_at);

    const startedEvent = [...events].reverse().find(e => e.event_type === "exam_started");
    const device = describeDevice(startedEvent?.details || {});
    $("summaryDevice").textContent = device.label;
    $("summaryDevice").title = device.full;

    const tabHidden = count("tab_or_window_hidden");
    const blur = count("window_blur");
    const fullscreenExit = count("fullscreen_exit");
    const restricted = countAny([
      "copy_blocked","cut_blocked","paste_blocked","contextmenu_blocked","dragstart_blocked",
      "keyboard_shortcut_blocked","developer_tools_shortcut_attempt","reload_shortcut_blocked",
      "print_attempt","printscreen_key_detected","leave_or_reload_attempt","in_exam_link_navigation_blocked"
    ]);

    $("summaryTabHidden").textContent = String(tabHidden);
    $("summaryBlur").textContent = String(blur);
    $("summaryFullscreen").textContent = String(fullscreenExit);
    $("summaryRestricted").textContent = String(restricted);

    const badge = $("summaryReviewBadge");
    const attentionSignals = tabHidden + blur + fullscreenExit + restricted;
    badge.className = "badge " + (attentionSignals > 0 ? "warn" : "ok");
    badge.textContent = attentionSignals > 0 ? "Review signals present" : "No review signals recorded";

    const narrative = [];
    if (attempt.status === "submitted") {
      narrative.push(
        `The attempt was submitted${attempt.submitted_at ? " at " + new Date(attempt.submitted_at).toLocaleTimeString() : ""}.`
      );
    } else {
      narrative.push(`The current attempt status is "${attempt.status}".`);
    }

    if (percent !== null) {
      narrative.push(`The auto-scored result is ${trimNumber(score)} out of ${trimNumber(maxScore)} (${formatPercent(percent)}%).`);
    }

    if (tabHidden > 0) {
      narrative.push(
        `The exam page became hidden ${tabHidden} time${tabHidden === 1 ? "" : "s"}. This usually means the student switched away from the page, minimized it, or the browser/app moved to the background; the system cannot determine the exact destination.`
      );
    } else {
      narrative.push("No tab/window-hidden event was recorded.");
    }

    if (blur > 0) {
      narrative.push(
        `The exam window lost focus ${blur} time${blur === 1 ? "" : "s"}. Blur can happen for several reasons and should be reviewed together with nearby events.`
      );
    }

    if (fullscreenExit > 0) {
      narrative.push(`Fullscreen was exited ${fullscreenExit} time${fullscreenExit === 1 ? "" : "s"} after being active.`);
    } else if (startedEvent?.details?.fullscreen === false) {
      narrative.push("The session began without fullscreen active on this device/browser.");
    }

    if (restricted > 0) {
      narrative.push(`${restricted} restricted-action attempt${restricted === 1 ? " was" : "s were"} recorded, such as copy/paste, print/screenshot-key, reload, developer-tools, or navigation attempts.`);
    } else {
      narrative.push("No restricted copy/paste, print, screenshot-key, reload, developer-tools, or navigation attempt was recorded.");
    }

    $("summaryNarrative").innerHTML = narrative.map(t => `<p>${escapeHtml(t)}</p>`).join("");
  }

  function describeDevice(details) {
    const ua = String(details?.userAgent || "");
    const screenSize = String(details?.screen || "");
    let label = "Unknown device";

    if (/iPhone/i.test(ua)) label = "iPhone";
    else if (/iPad/i.test(ua)) label = "iPad";
    else if (/Android/i.test(ua)) label = "Android device";
    else if (/Windows/i.test(ua)) label = "Windows PC";
    else if (/Macintosh|Mac OS X/i.test(ua)) label = "Mac";
    else if (/Linux/i.test(ua)) label = "Linux device";

    let browser = "";
    if (/CriOS/i.test(ua)) browser = "Chrome";
    else if (/FxiOS/i.test(ua)) browser = "Firefox";
    else if (/EdgiOS|Edg\//i.test(ua)) browser = "Edge";
    else if (/Safari/i.test(ua) && /Version\//i.test(ua)) browser = "Safari";
    else if (/Chrome/i.test(ua)) browser = "Chrome";
    else if (/Firefox/i.test(ua)) browser = "Firefox";

    const short = [label, browser].filter(Boolean).join(" • ") + (screenSize ? ` • ${screenSize}` : "");
    return { label: short || "Unknown device", full: ua || "No user-agent recorded" };
  }

  function formatDuration(startedAt, submittedAt) {
    if (!startedAt) return "—";
    const start = new Date(startedAt).getTime();
    const end = submittedAt ? new Date(submittedAt).getTime() : Date.now();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "—";

    const totalSeconds = Math.round((end - start) / 1000);
    const min = Math.floor(totalSeconds / 60);
    const sec = totalSeconds % 60;
    if (min <= 0) return `${sec}s`;
    return `${min}m ${sec}s`;
  }

  function numberOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function trimNumber(value) {
    return Number(value).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
  }

  function formatPercent(value) {
    return Number(value).toFixed(2).replace(/\.00$/, "");
  }

  function bindExamBuilder() {
    $("addQuestionBtn").addEventListener("click", () => addQuestionCard());
    $("clearExamFormBtn").addEventListener("click", clearExamForm);
    $("cancelEditExamBtn")?.addEventListener("click", clearExamForm);
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
    editingExamId = null;
    const heading = $("examFormHeading");
    const intro = $("examFormIntro");
    const saveBtn = $("saveExamBtn");
    const cancelBtn = $("cancelEditExamBtn");
    if (heading) heading.textContent = "Create a New Exam";
    if (intro) intro.textContent = "This lets you create an exam directly from the teacher dashboard without using SQL.";
    if (saveBtn) saveBtn.textContent = "Save Exam";
    if (cancelBtn) cancelBtn.classList.add("hidden");

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
      refreshChoiceOrderControls(card);
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
      <span class="choice-order-label" aria-hidden="true"></span>
      <input class="choice-input" placeholder="Choice text" value="${escapeAttr(value)}">
      <div class="choice-move-controls">
        <button type="button" class="choice-up-btn" title="Move option up" aria-label="Move option up">↑ Up</button>
        <button type="button" class="choice-down-btn" title="Move option down" aria-label="Move option down">↓ Down</button>
      </div>
      <button type="button" class="remove-choice-btn">Remove</button>
    `;
    list.appendChild(row);

    row.querySelector(".choice-input").addEventListener("input", () => refreshCorrectAnswerOptions(card));

    row.querySelector(".choice-up-btn").addEventListener("click", () => {
      const previous = row.previousElementSibling;
      if (!previous) return;
      const selectedAnswer = card.querySelector(".q-correct").value;
      list.insertBefore(row, previous);
      refreshCorrectAnswerOptions(card, selectedAnswer);
      refreshChoiceOrderControls(card);
    });

    row.querySelector(".choice-down-btn").addEventListener("click", () => {
      const next = row.nextElementSibling;
      if (!next) return;
      const selectedAnswer = card.querySelector(".q-correct").value;
      list.insertBefore(next, row);
      refreshCorrectAnswerOptions(card, selectedAnswer);
      refreshChoiceOrderControls(card);
    });

    row.querySelector(".remove-choice-btn").addEventListener("click", () => {
      const rows = card.querySelectorAll(".choice-row");
      if (rows.length <= 2) {
        setCreateMessage("A multiple-choice item should have at least two choices.", true);
        return;
      }
      row.remove();
      refreshCorrectAnswerOptions(card);
      refreshChoiceOrderControls(card);
    });

    refreshChoiceOrderControls(card);
  }

  function refreshChoiceOrderControls(card) {
    const rows = [...card.querySelectorAll(".choice-row")];
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

    rows.forEach((row, index) => {
      const label = row.querySelector(".choice-order-label");
      const up = row.querySelector(".choice-up-btn");
      const down = row.querySelector(".choice-down-btn");

      if (label) label.textContent = letters[index] || String(index + 1);
      if (up) up.disabled = index === 0;
      if (down) down.disabled = index === rows.length - 1;
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

    if (editingExamId) {
      const current = examsCache.find(e => e.id === editingExamId);
      if (!current) {
        $("saveExamBtn").disabled = false;
        setCreateMessage("The exam being edited could not be found. Reload Existing Exams and try again.", true);
        return;
      }

      if (current.status === "published") {
        $("saveExamBtn").disabled = false;
        setCreateMessage("Published examinations cannot be edited. Change the exam status before editing.", true);
        return;
      }

      const { error: examUpdateError } = await db
        .from("exams")
        .update(payload.exam)
        .eq("id", editingExamId);

      if (examUpdateError) {
        $("saveExamBtn").disabled = false;
        setCreateMessage(`Exam update failed: ${examUpdateError.message}`, true);
        return;
      }

      const { error: deleteQuestionsError } = await db
        .from("questions")
        .delete()
        .eq("exam_id", editingExamId);

      if (deleteQuestionsError) {
        $("saveExamBtn").disabled = false;
        setCreateMessage(`Exam details were updated, but old questions could not be replaced: ${deleteQuestionsError.message}`, true);
        return;
      }

      const questions = payload.questions.map((q, i) => ({
        exam_id: editingExamId,
        position: i + 1,
        prompt: q.prompt,
        question_type: q.question_type,
        choices: q.choices,
        correct_answer: q.correct_answer,
        points: q.points
      }));

      const { error: questionUpdateError } = await db
        .from("questions")
        .insert(questions);

      $("saveExamBtn").disabled = false;

      if (questionUpdateError) {
        setCreateMessage(`Exam updated, but replacement questions failed: ${questionUpdateError.message}`, true);
        return;
      }

      const title = payload.exam.title;
      setCreateMessage(`Exam "${title}" updated successfully.`);
      clearExamForm();
      await loadExams();
      activateTab("manage");
      return;
    }

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

  async function editExam(exam) {
    if (!exam) return;

    if (exam.status === "published") {
      alert("Published examinations cannot be edited. Close the examination or return it to Draft status before editing.");
      return;
    }

    const { data: questions, error } = await db
      .from("questions")
      .select("id,position,prompt,question_type,choices,correct_answer,points")
      .eq("exam_id", exam.id)
      .order("position", { ascending: true });

    if (error) {
      alert(`Could not load exam questions for editing: ${error.message}`);
      return;
    }

    editingExamId = exam.id;

    $("examTitleInput").value = exam.title || "";
    $("examCodeInput").value = exam.code || "";
    $("durationInput").value = exam.duration_minutes || 60;
    $("statusInput").value = exam.status || "draft";
    $("startAtInput").value = toLocalDateTimeInput(exam.start_at);
    $("endAtInput").value = toLocalDateTimeInput(exam.end_at);

    const heading = $("examFormHeading");
    const intro = $("examFormIntro");
    const saveBtn = $("saveExamBtn");
    const cancelBtn = $("cancelEditExamBtn");
    if (heading) heading.textContent = `Edit Examination — ${exam.title}`;
    if (intro) intro.textContent = "Update the examination details and questions. Published examinations are locked from editing.";
    if (saveBtn) saveBtn.textContent = "Update Exam";
    if (cancelBtn) cancelBtn.classList.remove("hidden");

    $("questionBuilder").innerHTML = "";
    questionCounter = 0;
    (questions || []).forEach(q => addQuestionCard(q));
    if (!questions?.length) addQuestionCard();
    renumberQuestionCards();

    activateTab("create");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function toLocalDateTimeInput(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const pad = n => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
        owner_id: getActiveWorkspaceOwnerId(),
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
      .select("id, code, title, duration_minutes, status, start_at, end_at, archived, archived_at, owner_id")
      .order("created_at", { ascending: false });

    // Keep the dashboard usable before the one-time archive database upgrade is run.
    if (error && /archived/i.test(error.message || "")) {
      const fallback = await db
        .from("exams")
        .select("id, code, title, duration_minutes, status, start_at, end_at, owner_id")
        .order("created_at", { ascending: false });
      exams = (fallback.data || []).map(e => ({ ...e, archived: false, archived_at: null }));
      error = fallback.error;
    }

    if (error) {
      $("examRows").innerHTML = `<tr><td colspan="8">${escapeHtml(error.message)}</td></tr>`;
      return;
    }

    examsCache = (exams || []).filter(e =>
      !getActiveWorkspaceOwnerId() || e.owner_id === getActiveWorkspaceOwnerId()
    );
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
            <button type="button" data-exam-action="edit" ${exam.status === "published" ? "disabled title=\"Published examinations cannot be edited\"" : ""}>Edit Exam</button>
            ${exam.status === "published" ? '<button type="button" data-exam-action="exam-pdf">Exam PDF</button>' : ""}
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
          if (action === "edit") await editExam(exam);
          if (action === "exam-pdf") await window.ExamReport?.generateExamPdf(exam.id, btn);
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
    loadExams,
    editExam,
    getWorkspaceOwnerId: getActiveWorkspaceOwnerId
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
