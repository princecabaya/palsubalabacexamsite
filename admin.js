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
  let draftAutosaveTimer = null;
  let draftAutosaveInFlight = false;
  let draftAutosaveQueued = false;
  let draftLastFingerprint = "";
  let currentUserId = null;
  let currentTeacherProfile = null;
  let teacherWorkspaces = [];
  let activeWorkspaceOwnerId = null;
  let teacherManagementBound = false;
  const expandedAttemptExams = new Set();
  const expandedExamStatusGroups = new Set(["published","draft"]);
  const expandedAttemptStatusGroups = new Set(["active"]);
  let currentDetailAttempt = null;
  let teacherLivePeer = null;
  let teacherLiveSessionId = null;
  let teacherLivePollHandle = null;
  let groupLiveExam = null;
  const groupLivePeers = new Map();
  let groupLiveClosing = false;
  let currentProctorPhotos = [];
  let currentSpeechClips = [];
  let proctorAssignments = [];
  let proctorCandidates = [];
  const myProctoredExamIds = new Set();

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
    await loadProctorAssignments();
    await Promise.all([refreshAttempts(), loadExams()]);
    clearInterval(pollHandle);
    pollHandle = setInterval(refreshAttempts, 5000);
  }

  function bindTabs() {
    $("tabAttemptsBtn").onclick = () => activateTab("attempts");
    $("tabCreateBtn").onclick = () => activateTab("create");
    $("tabManageBtn").onclick = () => activateTab("manage");
    $("tabProctorsBtn").onclick = () => activateTab("proctors");
    $("tabStudentsBtn").onclick = () => activateTab("students");
    $("tabTeachersBtn").onclick = () => activateTab("teachers");
  }

  function activateTab(name) {
    const map = {
      attempts: { btn: $("tabAttemptsBtn"), section: $("attemptsSection") },
      create: { btn: $("tabCreateBtn"), section: $("createSection") },
      manage: { btn: $("tabManageBtn"), section: $("manageSection") },
      proctors: { btn: $("tabProctorsBtn"), section: $("proctorsSection") },
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
    if (name === "proctors") loadProctorManagement();
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
      closeAttemptDrawer();
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

  function isProctorForExam(examId) {
    return myProctoredExamIds.has(String(examId));
  }

  async function loadProctorAssignments() {
    myProctoredExamIds.clear();

    const { data, error } = await db.rpc("get_exam_proctor_assignments", {
      p_exam_id: null
    });

    if (error) {
      console.warn("Exam proctor assignments unavailable:", error);
      proctorAssignments = [];
      return;
    }

    proctorAssignments = data || [];
    for (const row of proctorAssignments) {
      if (row.teacher_user_id === currentUserId) {
        myProctoredExamIds.add(String(row.exam_id));
      }
    }
  }

  async function loadProctorManagement() {
    const msg = $("proctorManageMsg");
    if (msg) msg.textContent = "";

    await loadProctorAssignments();

    const [candidateResult, examResult] = await Promise.all([
      db.rpc("get_proctor_candidates"),
      db
        .from("exams")
        .select("id,title,code,status,archived,owner_id")
        .eq("status", "published")
        .eq("archived", false)
        .order("created_at", { ascending: false })
    ]);

    if (candidateResult.error) {
      if (msg) msg.textContent = candidateResult.error.message;
      return;
    }
    if (examResult.error) {
      if (msg) msg.textContent = examResult.error.message;
      return;
    }

    proctorCandidates = candidateResult.data || [];
    const isMain = currentTeacherProfile?.role === "main_admin";
    const ownerId = getActiveWorkspaceOwnerId() || currentUserId;
    const manageableExams = (examResult.data || []).filter(exam =>
      isMain ? exam.owner_id === ownerId : exam.owner_id === currentUserId
    );

    const examSelect = $("proctorExamSelect");
    examSelect.innerHTML = "";
    for (const exam of manageableExams) {
      const opt = document.createElement("option");
      opt.value = exam.id;
      opt.textContent = `${exam.title} (${exam.code})`;
      opt.dataset.ownerId = exam.owner_id || "";
      examSelect.appendChild(opt);
    }

    const teacherSelect = $("proctorTeacherSelect");
    teacherSelect.innerHTML = "";
    for (const teacher of proctorCandidates) {
      const opt = document.createElement("option");
      opt.value = teacher.user_id;
      opt.textContent = teacher.display_name || teacher.email || "Teacher";
      teacherSelect.appendChild(opt);
    }

    $("assignProctorBtn").disabled = !manageableExams.length || !proctorCandidates.length;
    renderProctorAssignments(manageableExams);
  }

  function renderProctorAssignments(manageableExams) {
    const rows = $("proctorAssignmentRows");
    rows.innerHTML = "";

    const manageableIds = new Set((manageableExams || []).map(e => String(e.id)));
    const visible = proctorAssignments.filter(a => manageableIds.has(String(a.exam_id)));

    if (!visible.length) {
      rows.innerHTML = '<tr><td colspan="6">No proctors are assigned to these published examinations.</td></tr>';
      return;
    }

    for (const assignment of visible) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><strong>${escapeHtml(assignment.exam_title || "Exam")}</strong></td>
        <td>${escapeHtml(assignment.exam_code || "")}</td>
        <td>${escapeHtml(assignment.teacher_name || assignment.teacher_email || "Teacher")}</td>
        <td>${escapeHtml(assignment.teacher_email || "")}</td>
        <td>${fmt(assignment.assigned_at)}</td>
        <td><button type="button" class="danger-outline remove-proctor-btn">Remove</button></td>
      `;

      tr.querySelector(".remove-proctor-btn").addEventListener("click", async () => {
        const name = assignment.teacher_name || assignment.teacher_email || "this teacher";
        if (!confirm(`Remove ${name} as proctor for "${assignment.exam_title}"?`)) return;

        const { data, error } = await db.rpc("remove_exam_proctor", {
          p_exam_id: assignment.exam_id,
          p_teacher_user_id: assignment.teacher_user_id
        });

        if (error) {
          alert(`Could not remove proctor: ${error.message}`);
          return;
        }
        if (data !== true) {
          alert("No proctor assignment was removed.");
          return;
        }

        await loadProctorManagement();
        await loadProctorAssignments();
      await Promise.all([refreshAttempts(), loadExams()]);
      if (!$("proctorsSection").classList.contains("hidden")) await loadProctorManagement();
      });

      rows.appendChild(tr);
    }
  }

  async function assignSelectedProctor() {
    const examId = $("proctorExamSelect")?.value;
    const teacherId = $("proctorTeacherSelect")?.value;
    const msg = $("proctorManageMsg");

    if (!examId || !teacherId) {
      if (msg) msg.textContent = "Choose a published examination and an authorized teacher.";
      return;
    }

    const btn = $("assignProctorBtn");
    btn.disabled = true;
    btn.textContent = "Assigning…";

    const { data, error } = await db.rpc("assign_exam_proctor", {
      p_exam_id: examId,
      p_teacher_user_id: teacherId
    });

    btn.disabled = false;
    btn.textContent = "Assign Proctor";

    if (error) {
      if (msg) msg.textContent = error.message;
      return;
    }
    if (data !== true) {
      if (msg) msg.textContent = "The proctor assignment was not saved.";
      return;
    }

    if (msg) msg.textContent = "Proctor assigned successfully.";
    await loadProctorManagement();
  }

  async function refreshAttempts() {
    const { data, error } = await db
      .from("attempts")
      .select(`
        id,status,started_at,submitted_at,score,max_score,active_session_id,session_locked_at,
        students(student_no,full_name),
        exams(id,code,title,owner_id,status,archived,archived_at)
      `)
      .order("started_at", { ascending: false })
      .limit(500);

    if (error) {
      $("lastRefresh").textContent = `Dashboard access error: ${error.message}`;
      return;
    }

    const workspaceOwnerId = getActiveWorkspaceOwnerId();
    const isMainAdmin = currentTeacherProfile?.role === "main_admin";
    attemptsCache = (data || []).filter(a => {
      if (isMainAdmin) {
        return !workspaceOwnerId || a.exams?.owner_id === workspaceOwnerId;
      }
      return a.exams?.owner_id === currentUserId || isProctorForExam(a.exams?.id);
    });

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
    "leave_or_reload_attempt","in_exam_link_navigation_blocked","possible_speech_detected"
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
          ownerId: attempt.exams?.owner_id || null,
          examStatus: attempt.exams?.status || "",
          archived: Boolean(attempt.exams?.archived),
          attempts: []
        });
      }
      groups.get(examKey).attempts.push(attempt);
    }

    const statusBuckets = {
      active: [],
      submitted: [],
      other: []
    };

    for (const group of groups.values()) {
      const activeCount = group.attempts.filter(a => a.status === "active").length;
      const submittedCount = group.attempts.filter(a => a.status === "submitted").length;
      group.activeCount = activeCount;
      group.submittedCount = submittedCount;
      group.totalSignals = group.attempts.reduce((sum, a) => sum + signalCount(a.id), 0);

      if (activeCount > 0) statusBuckets.active.push(group);
      else if (submittedCount === group.attempts.length && group.attempts.length > 0) statusBuckets.submitted.push(group);
      else statusBuckets.other.push(group);
    }

    const statusOrder = [
      { key:"active", label:"Active Exams", tone:"active", note:"Exams with at least one student currently taking the test" },
      { key:"submitted", label:"Fully Submitted", tone:"submitted", note:"All recorded attempts have been submitted" },
      { key:"other", label:"Other / Incomplete", tone:"other", note:"Expired, mixed, or other attempt states" }
    ];

    for (const status of statusOrder) {
      const bucket = statusBuckets[status.key];
      if (!bucket.length) continue;

      if (q) expandedAttemptStatusGroups.add(status.key);
      const statusExpanded = expandedAttemptStatusGroups.has(status.key);
      const totalAttempts = bucket.reduce((sum,g)=>sum+g.attempts.length,0);

      const statusRow = document.createElement("tr");
      statusRow.className = `status-group-row attempt-status-group ${status.tone}`;
      statusRow.innerHTML = `
        <td colspan="7">
          <button type="button" class="status-group-toggle" aria-expanded="${statusExpanded ? "true" : "false"}">
            <span class="status-group-chevron">${statusExpanded ? "▾" : "▸"}</span>
            <span class="status-group-label">
              <strong>${escapeHtml(status.label)}</strong>
              <small>${escapeHtml(status.note)}</small>
            </span>
            <span class="status-group-count">${bucket.length} exam${bucket.length===1?"":"s"} • ${totalAttempts} attempt${totalAttempts===1?"":"s"}</span>
          </button>
        </td>
      `;
      statusRow.querySelector(".status-group-toggle").addEventListener("click",()=>{
        if (expandedAttemptStatusGroups.has(status.key)) expandedAttemptStatusGroups.delete(status.key);
        else expandedAttemptStatusGroups.add(status.key);
        renderAttempts();
      });
      rows.appendChild(statusRow);

      if (!statusExpanded) continue;

      for (const group of bucket) {
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
                  • ${group.submittedCount} submitted
                  ${group.activeCount ? ` • ${group.activeCount} active` : ""}
                  • ${group.totalSignals} signal${group.totalSignals === 1 ? "" : "s"}
                </span>
              </button>
              <div class="attempt-group-actions">
                <button type="button" class="exam-excel-btn" title="Download this examination's attempt records as Excel">Excel</button>
                ${status.key === "active" && group.activeCount
                  ? '<button type="button" class="group-live-proctor-btn primary" title="Request live cameras from active students and open the multi-student proctoring page">Live Proctor</button>'
                  : ''}
                ${status.key === "active" && !group.archived && (currentTeacherProfile?.role === "main_admin" || group.ownerId === currentUserId)
                  ? '<button type="button" class="archive-active-exam-btn danger-outline" title="Close this exam to new entries while preserving all existing attempts and scores">Archive Exam</button>'
                  : ''}
                ${status.key === "active" && group.archived
                  ? '<span class="badge archived">Archived • active takers remain</span>'
                  : ''}
              </div>
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

        header.querySelector(".group-live-proctor-btn")?.addEventListener("click", async (event) => {
          event.stopPropagation();
          await openGroupLiveProctor(group, event.currentTarget);
        });

        header.querySelector(".archive-active-exam-btn")?.addEventListener("click", async (event) => {
          event.stopPropagation();
          await archiveActiveExamFromAttempts(group, event.currentTarget);
        });

        rows.appendChild(header);

        if (!expanded) continue;

        for (const a of group.attempts) {
          const tr = document.createElement("tr");
          tr.className = "clickable attempt-student-row";
          tr.dataset.attemptId = a.id;
          const signals = signalCount(a.id);
          const score = a.score == null ? "—" : `${a.score}/${a.max_score}`;
          tr.innerHTML = `
            <td data-label="Student"><strong>${escapeHtml(a.students?.full_name || "Unknown")}</strong><br><span class="muted">${escapeHtml(a.students?.student_no || "")}</span></td>
            <td data-label="Exam"><span class="muted">Student attempt</span></td>
            <td data-label="Status"><span class="badge ${a.status === "submitted" ? "ok" : "warn"}">${escapeHtml(a.status)}</span></td>
            <td data-label="Started">${fmt(a.started_at)}</td>
            <td data-label="Submitted">${fmt(a.submitted_at)}</td>
            <td data-label="Score">${escapeHtml(score)}</td>
            <td data-label="Signals"><span class="badge ${signals ? "warn" : "ok"}">${signals}</span></td>
          `;
          tr.addEventListener("click", () => openDetail(a));
          rows.appendChild(tr);
        }
      }
    }
  }

  async function archiveActiveExamFromAttempts(group, button) {
    if (!group?.key) return;

    const activeCount = Number(group.activeCount || 0);
    const submittedCount = Number(group.submittedCount || 0);

    const ok = confirm(
      `Archive "${group.title}" now?\n\n` +
      "This will immediately close the exam to NEW entries and move it to Archived / Trash.\n\n" +
      `Existing records will be preserved:\n• ${activeCount} active attempt${activeCount === 1 ? "" : "s"}\n• ${submittedCount} submitted attempt${submittedCount === 1 ? "" : "s"}\n• all answers, scores, AI feedback, and proctoring records\n\n` +
      "Students who already started the exam can continue their current attempt. No score will be changed or deleted."
    );
    if (!ok) return;

    const originalText = button?.textContent || "Archive Exam";
    if (button) {
      button.disabled = true;
      button.textContent = "Archiving…";
    }

    const { error } = await db
      .from("exams")
      .update({
        archived: true,
        archived_at: new Date().toISOString(),
        status: "closed"
      })
      .eq("id", group.key);

    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }

    if (error) {
      alert(`Could not archive this exam: ${error.message}`);
      return;
    }

    alert(
      `"${group.title}" has been archived.\n\nNew students can no longer enter it. Existing active takers may finish, and all previous results remain preserved.`
    );

    await Promise.all([refreshAttempts(), loadExams()]);
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
    currentDetailAttempt = a;
    currentProctorPhotos = [];
    document.querySelectorAll(".attempt-student-row.is-selected").forEach(row => row.classList.remove("is-selected"));
    const selectedRow = [...document.querySelectorAll(".attempt-student-row")].find(row => row.dataset.attemptId === a.id);
    selectedRow?.classList.add("is-selected");

    const panel = $("detailPanel");
    panel.classList.remove("hidden");
    requestAnimationFrame(() => panel.classList.add("open"));

    const summaryDetails = $("attemptSummary");
    if (summaryDetails && "open" in summaryDetails) summaryDetails.open = true;
    const savedDetails = $("savedResponsesSection");
    if (savedDetails && "open" in savedDetails) savedDetails.open = false;
    const restoreSavedBtn = $("restoreSavedResponsesBtn");
    if (restoreSavedBtn) restoreSavedBtn.classList.toggle("hidden", a.status !== "active");
    const remoteSubmitBtn = $("remoteSubmitSavedBtn");
    if (remoteSubmitBtn) remoteSubmitBtn.classList.toggle("hidden", a.status !== "active");
    const photoDetails = $("proctorPhotosSection");
    if (photoDetails && "open" in photoDetails) photoDetails.open = false;
    const speechDetails = $("speechClipsSection");
    if (speechDetails && "open" in speechDetails) speechDetails.open = false;
    const eventDetails = $("eventDetailsSection");
    if (eventDetails && "open" in eventDetails) eventDetails.open = false;
    $("detailTitle").textContent = a.students?.full_name || "Attempt";
    $("detailMeta").textContent = `${a.students?.student_no || ""} • ${a.exams?.title || ""} • ${a.status}`;

    const proctorOnly = isProctorForExam(a.exams?.id) && a.exams?.owner_id !== currentUserId;
    const reopenBtn = $("reopenAttemptBtn");
    if (reopenBtn) reopenBtn.classList.toggle("hidden", a.status !== "submitted" || proctorOnly);
    const permitEditBtn = $("permitEditAttemptBtn");
    if (permitEditBtn) permitEditBtn.classList.toggle("hidden", a.status !== "submitted" || proctorOnly);

    const liveCameraBtn = $("requestLiveCameraBtn");
    if (liveCameraBtn) liveCameraBtn.classList.toggle("hidden", a.status !== "active" || proctorOnly);

    const unlockBtn = $("unlockSessionBtn");
    if (unlockBtn) {
      unlockBtn.classList.toggle("hidden", a.status !== "active");
      unlockBtn.disabled = a.status !== "active" || !a.active_session_id;
      unlockBtn.textContent = a.active_session_id ? "Unlock Active Session" : "Session Already Unlocked";
      unlockBtn.title = a.active_session_id
        ? "Release this browser/device lock so the next browser session using this Student ID can resume the active attempt."
        : "This active attempt currently has no browser/device lock.";
    }

    const timeControls = $("timeExtensionControls");
    if (timeControls) {
      timeControls.classList.toggle("hidden", a.status !== "active" || proctorOnly);
    }

    $("proctorPhotoEvidenceActions")?.classList.toggle("hidden", proctorOnly);
    $("speechClipEvidenceActions")?.classList.toggle("hidden", proctorOnly);

    const messageSection = $("teacherMessageSection");
    if (messageSection && "open" in messageSection) messageSection.open = a.status === "active";
    const messageInput = $("teacherAttemptMessage");
    const messageButton = $("sendAttemptMessageBtn");
    const messageBadge = $("teacherMessageBadge");
    if (messageInput) {
      messageInput.disabled = a.status !== "active";
      messageInput.value = "";
      messageInput.placeholder = a.status === "active"
        ? "e.g. Please remain on the exam page. Multiple focus/speech signals have been detected."
        : "Messaging is available only while the student has an active exam attempt.";
    }
    if (messageButton) messageButton.disabled = a.status !== "active";
    if (messageBadge) {
      messageBadge.className = "badge " + (a.status === "active" ? "ok" : "");
      messageBadge.textContent = a.status === "active" ? "Live" : "Closed";
    }
    if ($("teacherMessageStatus")) $("teacherMessageStatus").textContent = "";

    await Promise.all([
      loadSavedResponses(a),
      loadProctorPhotos(a),
      loadSpeechClips(a),
      loadAttemptMessageHistory(a)
    ]);

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
    const eventCount = $("eventDetailsCount");
    if (eventCount) eventCount.textContent = `${events.length} event${events.length === 1 ? "" : "s"}`;
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

  async function loadAttemptMessageHistory(attempt) {
    const node = $("attemptMessageHistory");
    if (!node || !attempt?.id) return;

    node.innerHTML = '<p class="muted">Loading message history…</p>';

    const { data, error } = await db
      .from("attempt_messages")
      .select("id,message,created_at,sender_user_id")
      .eq("attempt_id", attempt.id)
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) {
      const missing = /attempt_messages|relation.*does not exist/i.test(String(error.message || ""));
      node.innerHTML = `<p class="muted">${escapeHtml(missing
        ? "Messaging is not installed yet. Run supabase-upgrade-attempt-messages.sql."
        : error.message)}</p>`;
      return;
    }

    if (!(data || []).length) {
      node.innerHTML = '<p class="muted">No teacher messages have been sent for this attempt.</p>';
      return;
    }

    node.innerHTML = "";
    (data || []).forEach(item => {
      const row = document.createElement("div");
      row.className = "attempt-message-history-item";
      row.innerHTML = `
        <div class="attempt-message-history-meta">${escapeHtml(fmt(item.created_at))}</div>
        <div>${escapeHtml(item.message || "")}</div>
      `;
      node.appendChild(row);
    });
  }

  async function sendCurrentAttemptMessage() {
    const attempt = currentDetailAttempt;
    const input = $("teacherAttemptMessage");
    const button = $("sendAttemptMessageBtn");
    const status = $("teacherMessageStatus");
    if (!attempt || !input || !button || !status) return;

    const message = input.value.trim();
    if (!message) {
      status.textContent = "Enter a message first.";
      status.classList.add("error");
      return;
    }
    if (message.length > 300) {
      status.textContent = "Message must be 300 characters or fewer.";
      status.classList.add("error");
      return;
    }

    button.disabled = true;
    status.classList.remove("error","success");
    status.textContent = "Sending…";

    const { data, error } = await db.rpc("admin_send_attempt_message", {
      p_attempt_id: attempt.id,
      p_message: message
    });

    button.disabled = attempt.status !== "active";

    if (error) {
      const missing = /admin_send_attempt_message|function.*does not exist|schema cache/i.test(String(error.message || ""));
      status.textContent = missing
        ? "Messaging is not installed yet. Run supabase-upgrade-attempt-messages.sql in Supabase SQL Editor."
        : error.message;
      status.classList.add("error");
      return;
    }

    input.value = "";
    status.textContent = "Message sent to the student's exam header.";
    status.classList.add("success");
    await loadAttemptMessageHistory(attempt);
  }

  async function sendTeacherLiveCameraMessage() {
    const attempt = currentDetailAttempt;
    const input = $("teacherLiveMessageInput");
    const button = $("sendTeacherLiveMessageBtn");
    const status = $("teacherLiveMessageStatus");
    if (!attempt || !input || !button || !status) return;

    if (attempt.status !== "active") {
      status.textContent = "Messaging is available only during an active attempt.";
      status.classList.add("error");
      return;
    }

    const message = input.value.trim();
    if (!message) {
      status.textContent = "Enter a message first.";
      status.classList.add("error");
      input.focus();
      return;
    }
    if (message.length > 300) {
      status.textContent = "Message must be 300 characters or fewer.";
      status.classList.add("error");
      return;
    }

    button.disabled = true;
    status.classList.remove("error","success");
    status.textContent = "Sending…";

    const { error } = await db.rpc("admin_send_attempt_message", {
      p_attempt_id: attempt.id,
      p_message: message
    });

    button.disabled = false;

    if (error) {
      const missing = /admin_send_attempt_message|function.*does not exist|schema cache/i.test(String(error.message || ""));
      status.textContent = missing
        ? "Messaging is not installed yet. Run supabase-upgrade-attempt-messages.sql."
        : error.message;
      status.classList.add("error");
      return;
    }

    input.value = "";
    status.textContent = "Message sent.";
    status.classList.add("success");

    const mainInput = $("teacherAttemptMessage");
    if (mainInput) mainInput.value = "";
    await loadAttemptMessageHistory(attempt);

    setTimeout(() => {
      if (status.textContent === "Message sent.") {
        status.textContent = "";
        status.classList.remove("success");
      }
    }, 3000);
  }

  function applyAttemptMessagePreset(event) {
    const button = event.target.closest(".message-preset");
    if (!button) return;
    const input = $("teacherAttemptMessage");
    if (!input || input.disabled) return;
    input.value = button.dataset.message || "";
    input.focus();
  }

  async function loadProctorPhotos(attempt) {
    const grid = $("proctorPhotoGrid");
    const note = $("proctorPhotosNote");
    const count = $("proctorPhotosCount");
    if (!grid || !note || !count) return;

    grid.innerHTML = '<p class="muted">Loading proctoring photos…</p>';
    count.textContent = "Loading…";
    currentProctorPhotos = [];
    updateProctorPhotoSelection();

    try {
      const { data, error } = await db.functions.invoke("list-proctor-photos", {
        body: { attempt_id: attempt.id }
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      const photos = data?.photos || [];
      currentProctorPhotos = photos;
      count.textContent = `${photos.length} photo${photos.length === 1 ? "" : "s"}`;

      if (!photos.length) {
        note.textContent = "No unexpired or preserved front-camera photos are currently available for this attempt.";
        grid.innerHTML = '<p class="muted">No photos available.</p>';
        updateProctorPhotoSelection();
        return;
      }

      const evidenceCount = photos.filter(p => p.evidence_saved).length;
      note.textContent = evidenceCount
        ? `${evidenceCount} preserved as evidence. Other photos follow the normal 24-hour retention.`
        : "Front-camera photos are private and normally expire after 7 days.";

      grid.innerHTML = "";

      for (const photo of photos) {
        const figure = document.createElement("figure");
        figure.className = "proctor-photo-card";
        figure.dataset.photoId = photo.id;
        figure.dataset.evidenceSaved = photo.evidence_saved ? "true" : "false";

        const selectLabel = document.createElement("label");
        selectLabel.className = "proctor-photo-select";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "proctor-photo-checkbox";
        checkbox.value = photo.id;
        checkbox.addEventListener("change", updateProctorPhotoSelection);
        const selectText = document.createElement("span");
        selectText.textContent = "Select";
        selectLabel.append(checkbox, selectText);

        const imgWrap = document.createElement("div");
        imgWrap.className = "proctor-photo-image-wrap";

        const img = document.createElement("img");
        img.src = photo.url;
        img.alt = `Proctoring photo captured ${fmt(photo.captured_at)}`;
        img.loading = "lazy";
        imgWrap.appendChild(img);

        if (photo.evidence_saved) {
          const badge = document.createElement("span");
          badge.className = "proctor-evidence-badge";
          badge.textContent = "Evidence";
          imgWrap.appendChild(badge);
        }

        const caption = document.createElement("figcaption");
        const retentionText = photo.evidence_saved
          ? `Preserved ${photo.evidence_saved_at ? fmt(photo.evidence_saved_at) : ""}`
          : `Expires ${fmt(photo.expires_at)}`;
        caption.innerHTML = `
          <strong>${escapeHtml(fmt(photo.captured_at))}</strong>
          <span>${escapeHtml(retentionText)}</span>
        `;

        figure.append(selectLabel, imgWrap, caption);
        grid.appendChild(figure);
      }

      updateProctorPhotoSelection();
    } catch (error) {
      console.warn("Could not load proctor photos:", error);
      count.textContent = "Unavailable";
      note.textContent = "Proctoring photos could not be loaded.";
      grid.innerHTML = `<p class="muted">${escapeHtml(error?.message || String(error))}</p>`;
      updateProctorPhotoSelection();
    }
  }

  function getSelectedProctorPhotoIds() {
    return [...document.querySelectorAll(".proctor-photo-checkbox:checked")]
      .map(input => input.value)
      .filter(Boolean);
  }

  function updateProctorPhotoSelection() {
    const selectedIds = getSelectedProctorPhotoIds();
    const selection = $("proctorPhotoSelection");
    const saveBtn = $("saveSelectedEvidenceBtn");
    const releaseBtn = $("releaseSelectedEvidenceBtn");

    if (selection) selection.textContent = `${selectedIds.length} selected`;

    const selectedPhotos = currentProctorPhotos.filter(p => selectedIds.includes(p.id));
    const hasUnsaved = selectedPhotos.some(p => !p.evidence_saved);
    const hasSaved = selectedPhotos.some(p => p.evidence_saved);

    if (saveBtn) saveBtn.disabled = !hasUnsaved;
    if (releaseBtn) releaseBtn.disabled = !hasSaved;
  }

  async function setSelectedPhotoEvidence(saved) {
    const ids = getSelectedProctorPhotoIds();
    if (!ids.length || !currentDetailAttempt) return;

    const targetIds = currentProctorPhotos
      .filter(p => ids.includes(p.id) && Boolean(p.evidence_saved) !== saved)
      .map(p => p.id);

    if (!targetIds.length) return;

    const action = saved ? "preserve" : "release";
    const message = saved
      ? `Preserve ${targetIds.length} selected photo${targetIds.length === 1 ? "" : "s"} as examination evidence? These photos will no longer be deleted by the normal 7-day cleanup until you release them.`
      : `Release ${targetIds.length} preserved photo${targetIds.length === 1 ? "" : "s"}? They will return to the normal retention policy and may be deleted by the next cleanup if already older than 7 days.`;

    if (!confirm(message)) return;

    const saveBtn = $("saveSelectedEvidenceBtn");
    const releaseBtn = $("releaseSelectedEvidenceBtn");
    if (saveBtn) saveBtn.disabled = true;
    if (releaseBtn) releaseBtn.disabled = true;

    const { data, error } = await db.rpc("set_proctor_photo_evidence", {
      p_photo_ids: targetIds,
      p_saved: saved
    });

    if (error) {
      alert(`Could not ${action} selected photo evidence: ${error.message}`);
      updateProctorPhotoSelection();
      return;
    }

    if (!data) {
      alert("No photos were updated. They may no longer be available.");
    }

    await loadProctorPhotos(currentDetailAttempt);
  }


  async function loadSpeechClips(attempt) {
    const list = $("speechClipList");
    const note = $("speechClipsNote");
    const count = $("speechClipsCount");
    if (!list || !note || !count) return;

    list.innerHTML = '<p class="muted">Loading speech clips…</p>';
    count.textContent = "Loading…";
    currentSpeechClips = [];
    updateSpeechClipSelection();

    try {
      const { data, error } = await db.functions.invoke("list-speech-clips", {
        body: { attempt_id: attempt.id }
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      const clips = data?.clips || [];
      currentSpeechClips = clips;
      count.textContent = `${clips.length} clip${clips.length === 1 ? "" : "s"}`;
      if ($("summarySpeechClips")) $("summarySpeechClips").textContent = String(clips.length);

      if (!clips.length) {
        note.textContent = "No unexpired or preserved triggered speech clips are available for this attempt.";
        list.innerHTML = '<p class="muted">No speech clips available.</p>';
        updateSpeechClipSelection();
        return;
      }

      const evidenceCount = clips.filter(c => c.evidence_saved).length;
      const completedCount = clips.filter(c => c.transcription_status === "completed").length;
      note.textContent = evidenceCount
        ? `${completedCount} transcribed • ${evidenceCount} preserved as evidence`
        : `${completedCount} transcribed • ordinary clips expire after 7 days`;

      list.innerHTML = "";

      for (const clip of clips) {
        const card = document.createElement("article");
        card.className = "speech-clip-card";
        card.dataset.clipId = clip.id;
        card.dataset.evidenceSaved = clip.evidence_saved ? "true" : "false";

        const selectLabel = document.createElement("label");
        selectLabel.className = "speech-clip-select";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "speech-clip-checkbox";
        checkbox.value = clip.id;
        checkbox.addEventListener("change", updateSpeechClipSelection);
        const selectText = document.createElement("span");
        selectText.textContent = "Select";
        selectLabel.append(checkbox, selectText);

        const head = document.createElement("div");
        head.className = "speech-clip-head";
        const duration = Number(clip.duration_seconds || 0);
        const statusLabel = clip.transcription_status === "completed"
          ? "Transcribed"
          : clip.transcription_status === "no_speech"
            ? "No clear speech"
            : clip.transcription_status === "failed"
              ? "Transcription failed"
              : "Transcribing";
        head.innerHTML = `
          <div>
            <strong>${escapeHtml(fmt(clip.captured_at))}</strong>
            <span>${escapeHtml(duration ? `${duration.toFixed(1)} sec` : "Short clip")} • ${escapeHtml(statusLabel)}</span>
          </div>
          ${clip.evidence_saved ? '<span class="proctor-evidence-badge speech-evidence-badge">Evidence</span>' : ""}
        `;

        const audio = document.createElement("audio");
        audio.controls = true;
        audio.preload = "none";
        audio.src = clip.url;

        const transcript = document.createElement("div");
        transcript.className = "speech-transcript";
        const transcriptText = String(clip.transcript || "").trim();
        if (clip.transcription_status === "completed" && transcriptText) {
          transcript.innerHTML = `
            <strong>Transcript</strong>
            <p>${escapeHtml(transcriptText)}</p>
            ${clip.transcription_language ? `<span class="muted">Detected language: ${escapeHtml(clip.transcription_language)}</span>` : ""}
          `;
        } else if (clip.transcription_status === "no_speech") {
          transcript.innerHTML = '<strong>Transcript</strong><p class="muted">No clear speech was recognized in this clip.</p>';
        } else if (clip.transcription_status === "failed") {
          transcript.innerHTML = `<strong>Transcript</strong><p class="muted">Transcription unavailable${clip.transcription_error ? `: ${escapeHtml(clip.transcription_error)}` : "."}</p>`;
        } else {
          transcript.innerHTML = '<strong>Transcript</strong><p class="muted">Transcription is pending.</p>';
        }

        const retention = document.createElement("div");
        retention.className = "speech-clip-retention muted";
        retention.textContent = clip.evidence_saved
          ? `Preserved as evidence${clip.evidence_saved_at ? ` • ${fmt(clip.evidence_saved_at)}` : ""}`
          : `Expires ${fmt(clip.expires_at)}`;

        card.append(selectLabel, head, audio, transcript, retention);
        list.appendChild(card);
      }

      updateSpeechClipSelection();
    } catch (error) {
      console.warn("Could not load speech clips:", error);
      count.textContent = "Unavailable";
      if ($("summarySpeechClips")) $("summarySpeechClips").textContent = "—";
      note.textContent = "Speech clips could not be loaded.";
      list.innerHTML = `<p class="muted">${escapeHtml(error?.message || String(error))}</p>`;
      updateSpeechClipSelection();
    }
  }

  function getSelectedSpeechClipIds() {
    return [...document.querySelectorAll(".speech-clip-checkbox:checked")]
      .map(input => input.value)
      .filter(Boolean);
  }

  function updateSpeechClipSelection() {
    const selectedIds = getSelectedSpeechClipIds();
    const selection = $("speechClipSelection");
    const saveBtn = $("saveSelectedSpeechEvidenceBtn");
    const releaseBtn = $("releaseSelectedSpeechEvidenceBtn");

    if (selection) selection.textContent = `${selectedIds.length} selected`;

    const selected = currentSpeechClips.filter(c => selectedIds.includes(c.id));
    if (saveBtn) saveBtn.disabled = !selected.some(c => !c.evidence_saved);
    if (releaseBtn) releaseBtn.disabled = !selected.some(c => c.evidence_saved);
  }

  async function setSelectedSpeechEvidence(saved) {
    const ids = getSelectedSpeechClipIds();
    if (!ids.length || !currentDetailAttempt) return;

    const targetIds = currentSpeechClips
      .filter(c => ids.includes(c.id) && Boolean(c.evidence_saved) !== saved)
      .map(c => c.id);
    if (!targetIds.length) return;

    const action = saved ? "preserve" : "release";
    const ok = confirm(saved
      ? `Preserve ${targetIds.length} selected speech clip${targetIds.length === 1 ? "" : "s"} as examination evidence? Preserved clips are excluded from normal cleanup until released.`
      : `Release ${targetIds.length} preserved speech clip${targetIds.length === 1 ? "" : "s"}? They will return to the normal 7-day retention policy.`
    );
    if (!ok) return;

    const saveBtn = $("saveSelectedSpeechEvidenceBtn");
    const releaseBtn = $("releaseSelectedSpeechEvidenceBtn");
    if (saveBtn) saveBtn.disabled = true;
    if (releaseBtn) releaseBtn.disabled = true;

    const { data, error } = await db.rpc("set_proctor_speech_evidence", {
      p_clip_ids: targetIds,
      p_saved: saved
    });

    if (error) {
      alert(`Could not ${action} selected speech evidence: ${error.message}`);
      updateSpeechClipSelection();
      return;
    }

    if (!data) alert("No speech clips were updated. They may no longer be available.");
    await loadSpeechClips(currentDetailAttempt);
  }


  async function waitForSavedResponseRestoreAck(attemptId, sentAt, { timeoutMs = 15000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    const afterIso = sentAt ? new Date(sentAt).toISOString() : new Date(Date.now() - 5000).toISOString();

    while (Date.now() < deadline) {
      const { data, error } = await db
        .from("proctor_events")
        .select("occurred_at,event_type,details")
        .eq("attempt_id", attemptId)
        .eq("event_type", "saved_responses_restored_to_browser")
        .gte("occurred_at", afterIso)
        .order("occurred_at", { ascending: false })
        .limit(1);

      if (!error && data?.length) return data[0];
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    return null;
  }

  async function restoreSavedResponsesToStudent() {
    const attempt = currentDetailAttempt;
    const button = $("restoreSavedResponsesBtn");
    const statusNode = $("restoreSavedResponsesStatus");

    if (!attempt || attempt.status !== "active") {
      alert("Saved answers can only be restored while the student's attempt is active.");
      return;
    }

    const studentName = attempt.students?.full_name || "this student";
    const ok = confirm(
      `Restore Supabase-saved answers to ${studentName}\'s active exam browser?\n\n` +
      "Only currently blank response fields will be refilled. Newer answers already visible on the student's screen will not be overwritten."
    );
    if (!ok) return;

    if (button) {
      button.disabled = true;
      button.textContent = "Sending restore…";
    }
    if (statusNode) statusNode.textContent = "";

    const { data, error } = await db.rpc("admin_restore_attempt_responses", {
      p_attempt_id: attempt.id
    });

    if (button) {
      button.disabled = false;
      button.textContent = "Restore Saved Answers to Student";
    }

    if (error) {
      if (statusNode) statusNode.textContent = error.message;
      alert(
        `Could not send restore command: ${error.message}\n\nRun supabase-upgrade-restore-saved-responses.sql once in Supabase SQL Editor, then refresh the dashboard.`
      );
      return;
    }

    const count = Number(data?.saved_response_count || 0);
    const sentAt = data?.created_at || new Date().toISOString();

    if (statusNode) {
      statusNode.textContent = "Restore sent • waiting for student browser…";
    }

    const ack = await waitForSavedResponseRestoreAck(attempt.id, sentAt);

    if (ack) {
      const restored = Number(ack?.details?.restored_count || 0);
      if (statusNode) {
        statusNode.textContent = `Restored on student browser • ${restored} field${restored === 1 ? "" : "s"} refilled`;
      }
      alert(
        `Restore confirmed on ${studentName}\'s browser.\n\n` +
        `${restored} blank response field${restored === 1 ? " was" : "s were"} refilled from the saved attempt.`
      );
      return;
    }

    if (statusNode) {
      statusNode.textContent = "No browser acknowledgment • refresh/reopen needed";
    }

    alert(
      `The restore command was stored for ${studentName}, but their current browser did not acknowledge it within 15 seconds.\n\n` +
      `${count} Supabase-saved response${count === 1 ? " is" : "s are"} available. ` +
      "This usually means the student opened the exam before the restore feature was deployed. " +
      "Have only this affected student refresh/reopen the same exam page; the saved responses will be loaded into the restored session."
    );
  }


  let currentRecoverySnapshot = null;
  let currentRecoveryQuestionMeta = new Map();

  async function loadAttemptRecoverySnapshot(attempt) {
    const button = $("viewRecoverySnapshotBtn");
    const info = $("recoverySnapshotInfo");
    currentRecoverySnapshot = null;
    currentRecoveryQuestionMeta = new Map();

    if (button) button.classList.add("hidden");
    if (info) {
      info.classList.add("hidden");
      info.innerHTML = "";
    }

    const { data, error } = await db.rpc("admin_get_attempt_recovery_snapshot", {
      p_attempt_id: attempt.id
    });

    if (error) {
      const missing = /admin_get_attempt_recovery_snapshot|function.*does not exist|schema cache|PGRST202/i.test(String(error.message || error));
      if (!missing && info) {
        info.classList.remove("hidden");
        info.textContent = "Recovery snapshot could not be loaded.";
      }
      return;
    }

    if (!data) return;

    currentRecoverySnapshot = data;
    const count = Number(data.answered_count || 0);

    if (button) {
      button.classList.remove("hidden");
      button.textContent = `View 7-Day Recovery Snapshot (${count})`;
    }

    if (info) {
      info.classList.remove("hidden");
      info.innerHTML = `
        <strong>Recovery snapshot available:</strong>
        ${escapeHtml(String(count))} answered item${count === 1 ? "" : "s"} •
        captured ${escapeHtml(fmt(data.created_at))} •
        expires ${escapeHtml(fmt(data.expires_at))}
      `;
    }
  }

  function showCurrentRecoverySnapshot() {
    if (!currentRecoverySnapshot) {
      alert("No recovery snapshot is currently available for this attempt.");
      return;
    }

    const answers = currentRecoverySnapshot.answers || {};
    const entries = Object.entries(answers)
      .filter(([,answer]) => String(answer ?? "").trim() !== "");

    const text = entries.length
      ? entries.map(([questionId, answer]) => {
          const q = currentRecoveryQuestionMeta.get(String(questionId));
          const label = q ? `Item ${q.position}: ${q.prompt || ""}` : `Question ${questionId}`;
          return `${label}\n${String(answer)}`;
        }).join("\n\n--------------------\n\n")
      : "No nonblank answers are stored in this snapshot.";

    const popup = window.open("", "_blank", "noopener,noreferrer,width=900,height=700");
    if (!popup) {
      alert("Popup was blocked. Allow popups for this site and try again.");
      return;
    }

    popup.document.write(`
      <!doctype html>
      <html><head><meta charset="utf-8"><title>Recovery Snapshot</title>
      <style>
        body{font-family:Arial,sans-serif;padding:24px;line-height:1.45}
        pre{white-space:pre-wrap;word-break:break-word;background:#f8fafc;padding:16px;border-radius:10px}
      </style></head>
      <body>
        <h1>7-Day Recovery Snapshot</h1>
        <p>Captured: ${escapeHtml(fmt(currentRecoverySnapshot.created_at))}</p>
        <p>Answered items: ${escapeHtml(String(currentRecoverySnapshot.answered_count || 0))}</p>
        <pre>${escapeHtml(text)}</pre>
      </body></html>
    `);
    popup.document.close();
  }

  async function teacherSaveRecoveredResponse(questionId, position) {
    const attempt = currentDetailAttempt;
    if (!attempt || attempt.status !== "active") {
      alert("Teacher recovery can only be saved while the attempt is active. Reopen the attempt first if it was already submitted.");
      return;
    }

    const answer = prompt(`Enter the recovered answer for Item ${position}.\n\nThis will be saved into the student\'s response record and included when they submit. It cannot overwrite an existing nonblank student answer.`);
    if (answer === null) return;
    if (!String(answer).trim()) {
      alert("Recovered answer cannot be blank.");
      return;
    }

    const ok = confirm(
      `Save this recovered answer for Item ${position}?\n\n` +
      "It will become part of the student\'s database responses. A later blank save from the student\'s phone will not erase it, but a new nonblank answer typed by the student can replace it."
    );
    if (!ok) return;

    const { data, error } = await db.rpc("admin_save_recovered_response", {
      p_attempt_id: attempt.id,
      p_question_id: questionId,
      p_answer: String(answer)
    });

    if (error) {
      alert(`Could not save recovered answer: ${error.message}\n\nRun supabase-upgrade-teacher-recovered-responses.sql once in Supabase SQL Editor, then refresh the dashboard.`);
      return;
    }

    alert(`Recovered answer saved for Item ${position}. It is now part of this attempt\'s database responses.`);
    await loadSavedResponses(attempt);
  }

  async function remoteSubmitSavedResponsesForStudent() {
    const attempt = currentDetailAttempt;
    if (!attempt) return;

    if (attempt.status !== "active") {
      alert("Remote submission is available only for an active attempt. Reopen the attempt first if it was already submitted or expired.");
      return;
    }

    const examId = attempt.exams?.id;
    if (!examId) {
      alert("Exam information is unavailable for this attempt.");
      return;
    }

    const [questionResult, responseResult] = await Promise.all([
      db.from("questions").select("id").eq("exam_id", examId),
      db.from("responses").select("question_id,answer").eq("attempt_id", attempt.id)
    ]);

    if (questionResult.error || responseResult.error) {
      alert(`Could not verify saved responses: ${questionResult.error?.message || responseResult.error?.message || "Unknown error"}`);
      return;
    }

    const total = (questionResult.data || []).length;
    const saved = (responseResult.data || []).filter(row => String(row.answer ?? "").trim() !== "").length;
    const studentName = attempt.students?.full_name || "this student";

    const ok = confirm(
      `Submit the currently saved Supabase responses for ${studentName}?\n\n` +
      `Saved responses: ${saved}/${total}\n\n` +
      "Only answers already stored in the database will be included. Any answer that exists only on the student\'s phone/browser and was never saved to Supabase cannot be included. This will finalize the attempt as submitted."
    );
    if (!ok) return;

    const button = $("remoteSubmitSavedBtn");
    if (button) {
      button.disabled = true;
      button.textContent = "Submitting saved responses…";
    }

    const { data, error } = await db.rpc("admin_submit_saved_attempt", {
      p_attempt_id: attempt.id
    });

    if (button) {
      button.disabled = false;
      button.textContent = "Submit Saved Responses for Student";
    }

    if (error) {
      alert(`Remote submission failed: ${error.message}\n\nRun supabase-upgrade-teacher-remote-submit.sql once in Supabase SQL Editor, then refresh the teacher dashboard.`);
      return;
    }

    alert(
      `${studentName}\'s attempt was submitted remotely.\n\n` +
      `Saved responses included: ${data?.saved_response_count ?? saved}/${data?.total_question_count ?? total}.\n` +
      "The action was recorded as a teacher remote submission."
    );

    await refreshAttempts();
    await loadExams();
    $("attemptDetail")?.classList.add("hidden");
    currentDetailAttempt = null;
  }

  async function loadSavedResponses(attempt) {
    const rows = $("savedResponseRows");
    const note = $("savedResponsesNote");
    const countBadge = $("savedResponsesCount");

    if (!rows || !note || !countBadge) return;

    rows.innerHTML = '<tr><td colspan="4">Loading saved responses…</td></tr>';
    countBadge.textContent = "Loading…";
    loadAttemptRecoverySnapshot(attempt);

    const examId = attempt.exams?.id;
    if (!examId) {
      rows.innerHTML = '<tr><td colspan="4">Exam information is unavailable.</td></tr>';
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
        .select("question_id,answer,saved_at,teacher_recovered,teacher_recovered_at")
        .eq("attempt_id", attempt.id)
    ]);

    if (questionResult.error || responseResult.error) {
      const message = questionResult.error?.message || responseResult.error?.message || "Could not load saved responses.";
      rows.innerHTML = `<tr><td colspan="4">${escapeHtml(message)}</td></tr>`;
      note.textContent = "Saved responses could not be loaded.";
      countBadge.textContent = "—";
      return;
    }

    const responsesByQuestion = new Map(
      (responseResult.data || []).map(r => [String(r.question_id), r])
    );

    const questions = questionResult.data || [];
    currentRecoveryQuestionMeta = new Map(questions.map(q => [String(q.id), q]));
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
      rows.innerHTML = '<tr><td colspan="4">No questions were found for this examination.</td></tr>';
      return;
    }

    for (const question of questions) {
      const saved = responsesByQuestion.get(String(question.id));
      const rawAnswer = String(saved?.answer ?? "").trim();
      const displayedAnswer = formatSavedResponseForTeacher(question, rawAnswer);

      const tr = document.createElement("tr");
      tr.className = rawAnswer ? "" : "unanswered-response-row";
      const teacherRecovered = Boolean(saved?.teacher_recovered);
      tr.innerHTML = `
        <td>
          <strong>Item ${escapeHtml(String(question.position))}</strong>
          <div class="saved-response-prompt">${escapeHtml(question.prompt || "")}</div>
        </td>
        <td>${displayedAnswer ? escapeHtml(displayedAnswer) : '<span class="muted">Unanswered</span>'}</td>
        <td>${saved?.saved_at ? fmt(saved.saved_at) : "—"}</td>
        <td>
          ${teacherRecovered
            ? `<span class="badge ok">Teacher recovered</span>${saved?.teacher_recovered_at ? `<div class="muted">${escapeHtml(fmt(saved.teacher_recovered_at))}</div>` : ""}`
            : (rawAnswer
              ? '<span class="muted">Student response present</span>'
              : (attempt.status === "active"
                ? `<button type="button" class="teacher-save-response-btn" data-question-id="${escapeAttr(question.id)}" data-position="${escapeAttr(question.position)}">Save Recovered Answer</button>`
                : '<span class="muted">Reopen attempt to recover</span>'))}
        </td>
      `;

      tr.querySelector(".teacher-save-response-btn")?.addEventListener("click", () => {
        teacherSaveRecoveredResponse(question.id, question.position);
      });

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
    const speechSignals = count("possible_speech_detected");
    const cameraSaved = count("camera_photo_saved");
    const cameraFailed = count("camera_photo_failed");
    const cameraNotReady = count("camera_photo_not_ready");
    const cameraUnavailable = countAny([
      "camera_monitoring_unavailable_at_start",
      "camera_monitoring_unavailable_after_restore",
      "camera_initial_photo_unavailable"
    ]);

    const cameraStatusNode = $("summaryCameraStatus");
    if (cameraStatusNode) {
      let cameraText = "No photo event";
      let cameraTitle = "No successful or failed camera-photo event was recorded.";

      if (cameraSaved > 0) {
        cameraText = `${cameraSaved} saved`;
        cameraTitle = `${cameraSaved} proctoring photo${cameraSaved === 1 ? " was" : "s were"} successfully saved.`;
      } else if (cameraUnavailable > 0) {
        cameraText = "Unavailable";
        cameraTitle = "Camera monitoring was unavailable for this attempt.";
      } else if (cameraFailed > 0) {
        cameraText = "Upload failed";
        cameraTitle = `${cameraFailed} camera upload failure${cameraFailed === 1 ? " was" : "s were"} recorded.`;
      } else if (cameraNotReady > 0) {
        cameraText = "Camera not ready";
        cameraTitle = `${cameraNotReady} capture attempt${cameraNotReady === 1 ? " occurred" : "s occurred"} before the camera video was ready.`;
      }

      cameraStatusNode.textContent = cameraText;
      cameraStatusNode.title = cameraTitle;
    }

    $("summaryTabHidden").textContent = String(tabHidden);
    $("summaryBlur").textContent = String(blur);
    $("summaryFullscreen").textContent = String(fullscreenExit);
    $("summaryRestricted").textContent = String(restricted);
    $("summarySpeech").textContent = String(speechSignals);

    const badge = $("summaryReviewBadge");
    const attentionSignals = tabHidden + blur + fullscreenExit + restricted + speechSignals;
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

    if (cameraSaved > 0) {
      narrative.push(`${cameraSaved} proctoring photo${cameraSaved === 1 ? " was" : "s were"} successfully saved for this attempt.`);
    } else if (cameraUnavailable > 0) {
      narrative.push("No proctoring photo was saved because camera monitoring was unavailable during this attempt.");
    } else if (cameraFailed > 0) {
      narrative.push(`No proctoring photo is currently available; ${cameraFailed} camera photo upload failure${cameraFailed === 1 ? " was" : "s were"} recorded.`);
    } else if (cameraNotReady > 0) {
      narrative.push("The camera capture scheduler ran, but the video was not ready during the recorded capture attempts.");
    } else {
      narrative.push("No camera-photo event was recorded for this attempt. Review the Proctoring Photos section and event log for additional context.");
    }

    if (speechSignals > 0) {
      narrative.push(
        `The microphone detected ${speechSignals} possible speech event${speechSignals === 1 ? "" : "s"}. The browser analyzes sound levels locally; it does not record audio and cannot determine who was speaking or what was said.`
      );
    } else {
      narrative.push("No possible speech event was recorded.");
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

  function collectExamDraftSnapshot() {
    const cards = [...$("questionBuilder").querySelectorAll(".question-card")];
    const questions = cards.map(card => {
      const question_type = card.querySelector(".q-type")?.value || "mcq";
      let choices = null;
      let correct_answer = "";
      let rubric_type = "analytic";
      let rubric_criteria = [];

      if (question_type === "mcq") {
        choices = [...card.querySelectorAll(".choice-input")].map(input => input.value);
        correct_answer = card.querySelector(".q-correct")?.value || "";
      } else if (question_type === "binary") {
        choices = [
          card.querySelector(".binary-choice-a")?.value || "",
          card.querySelector(".binary-choice-b")?.value || ""
        ];
        correct_answer = card.querySelector(".binary-correct")?.value || "";
      } else if (question_type === "short_response") {
        correct_answer = card.querySelector(".short-reference-answer")?.value || "";
      } else if (question_type === "math_solver") {
        correct_answer = card.querySelector(".math-reference-answer")?.value || "";
      } else if (question_type === "essay") {
        rubric_type = rubricMode(card);
        rubric_criteria = collectRubricCriteria(card);
      }

      const rawPoints = Number(card.querySelector(".q-points")?.value);
      const stimulus = currentStimulusFromCard(card);
      return {
        section_title: sectionTitleForCard(card),
        prompt: card.querySelector(".q-prompt")?.value || "",
        question_type,
        points: Number.isFinite(rawPoints) && rawPoints > 0 ? rawPoints : 1,
        choices,
        correct_answer,
        rubric_type,
        rubric_criteria,
        stimulus_type: stimulus.type,
        stimulus_payload: stimulus.payload
      };
    });

    return {
      title: $("examTitleInput")?.value || "",
      code: ($("examCodeInput")?.value || "").toUpperCase(),
      duration_minutes: Number($("durationInput")?.value) || 60,
      start_at: toIsoOrNull($("startAtInput")?.value || ""),
      end_at: toIsoOrNull($("endAtInput")?.value || ""),
      questions
    };
  }

  function draftHasMeaningfulContent(snapshot) {
    if (!snapshot) return false;
    if (String(snapshot.title || "").trim() || String(snapshot.code || "").trim()) return true;
    return (snapshot.questions || []).some(q => {
      if (String(q.prompt || "").trim() || String(q.correct_answer || "").trim()) return true;
      if (Array.isArray(q.choices) && q.choices.some(v => String(v || "").trim())) return true;
      if (Array.isArray(q.rubric_criteria) && q.rubric_criteria.length) return true;
      return false;
    });
  }

  function scheduleExamDraftAutosave() {
    clearTimeout(draftAutosaveTimer);
    draftAutosaveTimer = setTimeout(() => autosaveExamDraft(), 900);
  }

  async function autosaveExamDraft() {
    clearTimeout(draftAutosaveTimer);
    draftAutosaveTimer = null;

    const snapshot = collectExamDraftSnapshot();
    if (!draftHasMeaningfulContent(snapshot)) return;

    const fingerprint = JSON.stringify({
      owner: getActiveWorkspaceOwnerId(),
      exam: editingExamId,
      snapshot
    });
    if (fingerprint === draftLastFingerprint && editingExamId) return;

    if (draftAutosaveInFlight) {
      draftAutosaveQueued = true;
      return;
    }

    draftAutosaveInFlight = true;
    const wasNewDraft = !editingExamId;

    try {
      const { data, error } = await db.rpc("autosave_exam_draft", {
        p_exam_id: editingExamId,
        p_owner_id: getActiveWorkspaceOwnerId(),
        p_payload: snapshot
      });

      if (error) {
        const missingUpgrade = /autosave_exam_draft|does not exist|schema cache|PGRST202|draft_payload/i.test(String(error.message || ""));
        setCreateMessage(
          missingUpgrade
            ? "Automatic draft saving is not installed in Supabase yet. Run supabase-upgrade-autosaved-exam-drafts.sql once, then refresh the dashboard."
            : `Draft autosave failed: ${error.message}`,
          true
        );
        return;
      }

      const row = data?.[0];
      if (row?.exam_id) editingExamId = row.exam_id;
      draftLastFingerprint = JSON.stringify({
        owner: getActiveWorkspaceOwnerId(),
        exam: editingExamId,
        snapshot
      });

      const heading = $("examFormHeading");
      const intro = $("examFormIntro");
      const saveBtn = $("saveExamBtn");
      const cancelBtn = $("cancelEditExamBtn");
      if (heading) heading.textContent = snapshot.title?.trim()
        ? `Editing Draft — ${snapshot.title.trim()}`
        : "Editing Autosaved Draft";
      if (intro) intro.textContent = "Changes are saved automatically as a Draft. Publish only from Manage Exams when the paper is ready.";
      if (saveBtn) saveBtn.textContent = "Save Draft Now";
      if (cancelBtn) cancelBtn.classList.remove("hidden");

      setCreateMessage(
        `Draft autosaved${row?.saved_at ? ` at ${new Date(row.saved_at).toLocaleTimeString()}` : ""}. It will remain in Manage Exams until you delete it.`
      );

      if (wasNewDraft) {
        await loadExams();
      }
    } finally {
      draftAutosaveInFlight = false;
      if (draftAutosaveQueued) {
        draftAutosaveQueued = false;
        scheduleExamDraftAutosave();
      }
    }
  }

  function bindExamBuilder() {
    $("addQuestionBtn").addEventListener("click", () => addQuestionCard());
    $("addSectionBtn")?.addEventListener("click", () => addExamSection());
    $("clearExamFormBtn").addEventListener("click", clearExamForm);
    $("cancelEditExamBtn")?.addEventListener("click", clearExamForm);
    $("saveExamBtn").addEventListener("click", saveExam);
    $("generateCodeBtn").addEventListener("click", generateExamCode);
    $("reloadExamsBtn").addEventListener("click", loadExams);

    const createSection = $("createSection");
    createSection?.addEventListener("input", scheduleExamDraftAutosave);
    createSection?.addEventListener("change", scheduleExamDraftAutosave);

    const builder = $("questionBuilder");
    if (builder && !builder.dataset.draftObserverBound) {
      builder.dataset.draftObserverBound = "true";
      const observer = new MutationObserver(() => scheduleExamDraftAutosave());
      observer.observe(builder, { childList: true, subtree: true });
    }
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
    scheduleExamDraftAutosave();
  }

  function clearExamForm() {
    clearTimeout(draftAutosaveTimer);
    draftAutosaveTimer = null;
    draftAutosaveQueued = false;
    draftLastFingerprint = "";
    editingExamId = null;
    const heading = $("examFormHeading");
    const intro = $("examFormIntro");
    const saveBtn = $("saveExamBtn");
    const cancelBtn = $("cancelEditExamBtn");
    if (heading) heading.textContent = "Create a New Exam";
    if (intro) intro.textContent = "Begin entering the examination paper. Changes are automatically stored as a Draft and remain in Manage Exams until you delete them.";
    if (saveBtn) saveBtn.textContent = "Save Draft Now";
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

  function typesetMathElement(element) {
    if (!element || !window.MathJax?.typesetPromise) return;
    window.MathJax.typesetClear?.([element]);
    window.MathJax.typesetPromise([element]).catch(() => {});
  }

  function renderMathPreview(card) {
    const textarea = card.querySelector(".q-prompt");
    const preview = card.querySelector(".math-preview");
    if (!textarea || !preview) return;

    preview.textContent = textarea.value || "";
    typesetMathElement(preview);
  }

  function normalizeRubricCriteria(criteria, rubricType = "analytic") {
    if (!Array.isArray(criteria)) return [];

    if (rubricType === "holistic") {
      return criteria.map((item, index) => ({
        criterion: String(item?.criterion ?? item?.level ?? item?.name ?? `Level ${index + 1}`).trim(),
        description: String(item?.description ?? "").trim(),
        max_points: Number(item?.max_points ?? item?.points ?? item?.score ?? 0)
      })).filter(item => item.criterion || item.description || Number.isFinite(item.max_points));
    }

    return criteria.map((item, index) => {
      if (Array.isArray(item?.levels)) {
        return {
          criterion: String(item?.criterion ?? item?.name ?? `Criterion ${index + 1}`).trim(),
          levels: item.levels.map((level, levelIndex) => ({
            level: String(level?.level ?? level?.name ?? `Level ${levelIndex + 1}`).trim(),
            description: String(level?.description ?? "").trim(),
            points: Number(level?.points ?? level?.score ?? 0)
          }))
        };
      }

      // Backward compatibility for older analytic rubrics that had one descriptor
      // and one maximum point value per criterion.
      return {
        criterion: String(item?.criterion ?? item?.name ?? `Criterion ${index + 1}`).trim(),
        levels: [{
          level: "Maximum",
          description: String(item?.description ?? "").trim(),
          points: Number(item?.max_points ?? item?.points ?? 0)
        }]
      };
    }).filter(item => item.criterion || item.levels?.length);
  }

  function normalizeStimulusPayload(type, payload = {}) {
    const p = payload && typeof payload === "object" ? payload : {};
    if (type === "image") return {
      url: String(p.url || ""),
      path: String(p.path || ""),
      caption: String(p.caption || ""),
      alt: String(p.alt || "")
    };
    if (type === "graph") return {
      expression: String(p.expression || "x"),
      xmin: Number.isFinite(Number(p.xmin)) ? Number(p.xmin) : -5,
      xmax: Number.isFinite(Number(p.xmax)) ? Number(p.xmax) : 5,
      ymin: Number.isFinite(Number(p.ymin)) ? Number(p.ymin) : -5,
      ymax: Number.isFinite(Number(p.ymax)) ? Number(p.ymax) : 5,
      caption: String(p.caption || "")
    };
    if (type === "latex") return {
      latex: String(p.latex || ""),
      caption: String(p.caption || "")
    };
    return {};
  }

  function compileStimulusGraphExpression(source) {
    const raw = String(source || "").trim().toLowerCase();
    if (!raw) throw new Error("Enter a function.");
    let expr = raw.replace(/π/g,"pi").replace(/\^/g,"**");
    const allowedNames = ["sin","cos","tan","asin","acos","atan","sqrt","abs","exp","log","ln","floor","ceil","pi","e","x"];
    const scrubbed = expr.replace(/[a-z]+/g, name => allowedNames.includes(name) ? "" : "BAD");
    if (/BAD|[^0-9+\-*/().,\s*]/.test(scrubbed)) throw new Error("Use x, numbers, + − × ÷, powers, parentheses, and standard functions only.");
    expr = expr
      .replace(/\bln\b/g,"Math.log")
      .replace(/\blog\b/g,"Math.log10")
      .replace(/\bsin\b/g,"Math.sin").replace(/\bcos\b/g,"Math.cos").replace(/\btan\b/g,"Math.tan")
      .replace(/\basin\b/g,"Math.asin").replace(/\bacos\b/g,"Math.acos").replace(/\batan\b/g,"Math.atan")
      .replace(/\bsqrt\b/g,"Math.sqrt").replace(/\babs\b/g,"Math.abs").replace(/\bexp\b/g,"Math.exp")
      .replace(/\bfloor\b/g,"Math.floor").replace(/\bceil\b/g,"Math.ceil")
      .replace(/\bpi\b/g,"Math.PI").replace(/\be\b/g,"Math.E");
    const fn = new Function("x", `"use strict"; return (${expr});`);
    return x => {
      const y = Number(fn(x));
      return Number.isFinite(y) ? y : NaN;
    };
  }

  function drawStimulusGraph(canvas, payload) {
    const width = 640, height = 360, dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width*dpr; canvas.height = height*dpr;
    canvas.style.aspectRatio = "16 / 9";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,width,height);
    ctx.fillStyle = "#fff"; ctx.fillRect(0,0,width,height);

    const xmin=Number(payload.xmin), xmax=Number(payload.xmax), ymin=Number(payload.ymin), ymax=Number(payload.ymax);
    if (!(xmax>xmin) || !(ymax>ymin)) throw new Error("Graph maximums must be greater than minimums.");
    const px=x=>((x-xmin)/(xmax-xmin))*width;
    const py=y=>height-((y-ymin)/(ymax-ymin))*height;

    ctx.strokeStyle="#e5e7eb"; ctx.lineWidth=1;
    for(let i=0;i<=10;i++){ const x=i*width/10; ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,height);ctx.stroke(); }
    for(let i=0;i<=8;i++){ const y=i*height/8; ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(width,y);ctx.stroke(); }

    ctx.strokeStyle="#64748b"; ctx.lineWidth=1.5;
    if(xmin<=0&&xmax>=0){ const x0=px(0);ctx.beginPath();ctx.moveTo(x0,0);ctx.lineTo(x0,height);ctx.stroke(); }
    if(ymin<=0&&ymax>=0){ const y0=py(0);ctx.beginPath();ctx.moveTo(0,y0);ctx.lineTo(width,y0);ctx.stroke(); }

    const fn=compileStimulusGraphExpression(payload.expression);
    ctx.strokeStyle="#111827"; ctx.lineWidth=2.2; ctx.beginPath();
    let drawing=false;
    for(let i=0;i<=width;i++){
      const x=xmin+(i/width)*(xmax-xmin), y=fn(x), sy=py(y);
      if(!Number.isFinite(y)||sy<-height||sy>height*2){drawing=false;continue;}
      if(!drawing){ctx.moveTo(i,sy);drawing=true;} else ctx.lineTo(i,sy);
    }
    ctx.stroke();
    ctx.fillStyle="#475569"; ctx.font="13px sans-serif";
    ctx.fillText(`x: ${xmin} to ${xmax}`,10,height-10);
    ctx.fillText(`y: ${ymin} to ${ymax}`,width-105,height-10);
  }

  function currentStimulusFromCard(card) {
    const type = card.querySelector(".stimulus-type")?.value || "none";
    if (type === "image") return {
      type,
      payload: {
        url: card.dataset.stimulusImageUrl || "",
        path: card.dataset.stimulusImagePath || "",
        caption: card.querySelector(".stimulus-image-caption")?.value?.trim() || "",
        alt: card.querySelector(".stimulus-image-alt")?.value?.trim() || ""
      }
    };
    if (type === "graph") return {
      type,
      payload: {
        expression: card.querySelector(".stimulus-graph-expression")?.value?.trim() || "",
        xmin: Number(card.querySelector(".stimulus-xmin")?.value),
        xmax: Number(card.querySelector(".stimulus-xmax")?.value),
        ymin: Number(card.querySelector(".stimulus-ymin")?.value),
        ymax: Number(card.querySelector(".stimulus-ymax")?.value),
        caption: card.querySelector(".stimulus-graph-caption")?.value?.trim() || ""
      }
    };
    if (type === "latex") return {
      type,
      payload: {
        latex: card.querySelector(".stimulus-latex-source")?.value || "",
        caption: card.querySelector(".stimulus-latex-caption")?.value?.trim() || ""
      }
    };
    return { type:"none", payload:{} };
  }

  function refreshStimulusPreview(card) {
    const type = card.querySelector(".stimulus-type")?.value || "none";
    card.querySelectorAll(".stimulus-panel").forEach(node=>node.classList.add("hidden"));
    card.querySelector(`.stimulus-${type}-panel`)?.classList.remove("hidden");
    const preview=card.querySelector(".stimulus-preview");
    preview.innerHTML="";
    if(type==="none") return;

    const {payload}=currentStimulusFromCard(card);
    if(type==="image"){
      if(!payload.url){ preview.innerHTML='<p class="muted">Upload an image to preview the stimulus.</p>'; return; }
      const img=document.createElement("img"); img.src=payload.url; img.alt=payload.alt||"Question stimulus"; img.className="stimulus-preview-image";
      preview.appendChild(img);
    } else if(type==="graph"){
      const canvas=document.createElement("canvas"); canvas.className="stimulus-graph-canvas"; preview.appendChild(canvas);
      try { drawStimulusGraph(canvas,payload); } catch(error){ preview.innerHTML=`<p class="message-inline error">${escapeHtml(error.message)}</p>`; return; }
    } else if(type==="latex"){
      const div=document.createElement("div"); div.className="stimulus-latex-render math-rendered"; div.textContent=payload.latex||"Enter LaTeX above."; preview.appendChild(div);
      if(window.MathJax?.typesetPromise){ window.MathJax.typesetClear?.([div]); window.MathJax.typesetPromise([div]).catch(()=>{}); }
    }
    if(payload.caption){
      const cap=document.createElement("div"); cap.className="stimulus-caption"; cap.textContent=payload.caption; preview.appendChild(cap);
    }
  }

  async function uploadStimulusImage(card) {
    const file=card.querySelector(".stimulus-image-file")?.files?.[0];
    const status=card.querySelector(".stimulus-image-status");
    if(!file){ status.textContent="Choose a PNG, JPG, or WebP image first."; return; }
    if(file.size>5000000){ status.textContent="Image must be 5 MB or smaller."; return; }
    if(!["image/png","image/jpeg","image/webp"].includes(file.type)){ status.textContent="Use PNG, JPG, or WebP."; return; }
    const owner=getActiveWorkspaceOwnerId();
    if(!owner){ status.textContent="Teacher workspace is unavailable."; return; }
    const ext=file.type==="image/png"?"png":file.type==="image/webp"?"webp":"jpg";
    const path=`${owner}/${Date.now()}-${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}.${ext}`;
    status.textContent="Uploading image…";
    const {error}=await db.storage.from("exam-stimuli").upload(path,file,{contentType:file.type,upsert:false});
    if(error){ status.textContent=`Upload failed: ${error.message}. Run supabase-upgrade-question-stimuli.sql if needed.`; return; }
    const {data}=db.storage.from("exam-stimuli").getPublicUrl(path);
    card.dataset.stimulusImageUrl=data.publicUrl||"";
    card.dataset.stimulusImagePath=path;
    status.textContent="Image uploaded.";
    refreshStimulusPreview(card);
    scheduleExamDraftAutosave();
  }

  function addQuestionCard(prefill = null) {
    questionCounter += 1;
    const idx = questionCounter;
    const q = prefill || {
      prompt: "",
      question_type: "mcq",
      points: 1,
      choices: ["", "", "", ""],
      correct_answer: "",
      rubric_type: "analytic",
      rubric_criteria: [],
      stimulus_type: "none",
      stimulus_payload: {}
    };

    const card = document.createElement("section");
    card.className = "question-card";
    card.dataset.qid = String(idx);
    card.dataset.sectionTitle = q.section_title || "";
    const initialStimulusType = q.stimulus_type || "none";
    const initialStimulusPayload = normalizeStimulusPayload(initialStimulusType, q.stimulus_payload);
    if (initialStimulusType === "image") {
      card.dataset.stimulusImageUrl = initialStimulusPayload.url || "";
      card.dataset.stimulusImagePath = initialStimulusPayload.path || "";
    }
    card.innerHTML = `
      <div class="detail-head">
        <div>
          <h3>Question <span class="question-number"></span></h3>
          <p class="muted">Set the prompt, type, and answer key for this item.</p>
        </div>
        <button type="button" class="remove-question-btn">Remove</button>
      </div>

      <label>Question prompt
        <textarea class="q-prompt" rows="4" placeholder="Enter the question here">${escapeAttr(q.prompt)}</textarea>
      </label>
      <div class="math-preview" aria-label="Question math preview"></div>

      <section class="question-stimulus-builder">
        <div class="detail-head">
          <div>
            <h4>Item Stimulus <span class="muted">(optional)</span></h4>
            <p class="muted">Attach an image, generate a function graph, or show a separate LaTeX display before the answer area.</p>
          </div>
          <select class="stimulus-type" aria-label="Stimulus type">
            <option value="none">None</option>
            <option value="image">Image / Illustration</option>
            <option value="graph">Function Graph</option>
            <option value="latex">LaTeX Display</option>
          </select>
        </div>

        <div class="stimulus-panel stimulus-image-panel hidden">
          <div class="stimulus-upload-row">
            <input class="stimulus-image-file" type="file" accept="image/png,image/jpeg,image/webp">
            <button type="button" class="stimulus-upload-btn">Upload Image</button>
            <button type="button" class="stimulus-remove-image-btn">Remove</button>
          </div>
          <label>Caption
            <input class="stimulus-image-caption" placeholder="Optional figure caption">
          </label>
          <label>Alt text
            <input class="stimulus-image-alt" placeholder="Brief description of the image">
          </label>
          <div class="stimulus-image-status muted"></div>
        </div>

        <div class="stimulus-panel stimulus-graph-panel hidden">
          <div class="form-grid compact">
            <label>Function (y=f(x))
              <input class="stimulus-graph-expression" placeholder="e.g. x^2 - 4">
            </label>
            <label>x-min <input class="stimulus-xmin" type="number" step="any" value="-5"></label>
            <label>x-max <input class="stimulus-xmax" type="number" step="any" value="5"></label>
            <label>y-min <input class="stimulus-ymin" type="number" step="any" value="-5"></label>
            <label>y-max <input class="stimulus-ymax" type="number" step="any" value="5"></label>
          </div>
          <label>Caption
            <input class="stimulus-graph-caption" placeholder="Optional graph caption">
          </label>
        </div>

        <div class="stimulus-panel stimulus-latex-panel hidden">
          <label>LaTeX stimulus
            <textarea class="stimulus-latex-source" rows="4" placeholder="e.g. \\[\\begin{array}{c|ccc}x&1&2&3\\\\f(x)&2&4&6\\end{array}\\]"></textarea>
          </label>
          <label>Caption
            <input class="stimulus-latex-caption" placeholder="Optional caption">
          </label>
        </div>

        <div class="stimulus-preview"></div>
      </section>

      <div class="form-grid compact">
        <label>Question type
          <select class="q-type">
            <option value="mcq" ${q.question_type === "mcq" ? "selected" : ""}>Multiple Choice</option>
            <option value="binary" ${q.question_type === "binary" ? "selected" : ""}>Binary Response</option>
            <option value="short_response" ${q.question_type === "short_response" ? "selected" : ""}>Short Response</option>
            <option value="math_solver" ${q.question_type === "math_solver" ? "selected" : ""}>Math Solver</option>
            <option value="essay" ${(q.question_type === "essay" || q.question_type === "text") ? "selected" : ""}>Essay</option>
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
            <p class="muted">For multiple choice, add the answer options below. LaTeX is supported in option text.</p>
          </div>
          <button type="button" class="add-choice-btn">Add Choice</button>
        </div>
        <div class="choice-list"></div>
        <label>Correct answer
          <select class="q-correct"></select>
        </label>
      </div>

      <div class="binary-area hidden">
        <h4>Binary Response</h4>
        <p class="muted">Students will choose one of two responses.</p>
        <div class="form-grid compact">
          <label>First response
            <input class="binary-choice-a" value="${escapeAttr(Array.isArray(q.choices) && q.choices[0] ? q.choices[0] : "True")}">
          </label>
          <label>Second response
            <input class="binary-choice-b" value="${escapeAttr(Array.isArray(q.choices) && q.choices[1] ? q.choices[1] : "False")}">
          </label>
        </div>
        <label>Correct response
          <select class="binary-correct"></select>
        </label>
      </div>

      <div class="short-response-area hidden">
        <h4>Short Response</h4>
        <p class="muted">For one word, one phrase, or one sentence. The reference answer is used for provisional AI equivalence checking.</p>
        <label>Reference / correct answer
          <input class="short-reference-answer" placeholder="e.g. Jose P. Rizal" value="${escapeAttr(q.question_type === "short_response" ? (q.correct_answer || "") : "")}">
        </label>
      </div>

      <div class="math-solver-area hidden">
        <h4>Math Solver</h4>
        <p class="muted">Students will use the built-in mathematics keyboard and solution board. Enter the expected final answer or solution guide for provisional AI scoring.</p>
        <label>Expected final answer / solution guide
          <textarea class="math-reference-answer" rows="3" placeholder="e.g. x = 4, or describe the expected solution">${escapeAttr(q.question_type === "math_solver" ? (q.correct_answer || "") : "")}</textarea>
        </label>
      </div>

      <div class="essay-rubric-area hidden">
        <div class="rubric-head">
          <div>
            <h4>Essay Rubric</h4>
            <p class="muted rubric-mode-help">Analytic rubric: score each criterion separately, then add the criterion points.</p>
          </div>
          <span class="rubric-total">Total: <strong class="rubric-total-value">0</strong> points</span>
        </div>

        <label>Rubric type
          <select class="rubric-type">
            <option value="analytic" ${(q.rubric_type || "analytic") === "analytic" ? "selected" : ""}>Analytic Rubric</option>
            <option value="holistic" ${q.rubric_type === "holistic" ? "selected" : ""}>Holistic Rubric</option>
          </select>
        </label>

        <div class="analytic-rubric-builder">
          <div class="analytic-levels-head">
            <div>
              <h5>Levels of Performance</h5>
              <p class="muted">Set the level names and their scores. These levels become the columns of the analytic rubric.</p>
            </div>
            <button type="button" class="add-analytic-level-btn">Add Level</button>
          </div>
          <div class="analytic-levels-list"></div>
          <div class="analytic-matrix-wrap">
            <div class="analytic-matrix"></div>
          </div>
          <button type="button" class="add-analytic-criterion-btn">Add Criterion</button>
        </div>

        <div class="holistic-rubric-builder hidden">
          <div class="rubric-list"></div>
          <button type="button" class="add-rubric-btn">Add Criterion</button>
        </div>

        <div class="rubric-import-controls">
          <button type="button" class="download-rubric-template-btn">Download Rubric Template</button>
          <input class="rubric-excel-file" type="file" accept=".xlsx,.xls">
          <button type="button" class="import-rubric-btn">Import Rubric Excel</button>
        </div>
        <p class="muted rubric-excel-help"></p>
      </div>
    `;

    $("questionBuilder").appendChild(card);

    const stimulusTypeSelect = card.querySelector(".stimulus-type");
    stimulusTypeSelect.value = initialStimulusType;
    card.querySelector(".stimulus-image-caption").value = initialStimulusPayload.caption || "";
    card.querySelector(".stimulus-image-alt").value = initialStimulusPayload.alt || "";
    card.querySelector(".stimulus-graph-expression").value = initialStimulusPayload.expression || "x";
    card.querySelector(".stimulus-xmin").value = initialStimulusPayload.xmin ?? -5;
    card.querySelector(".stimulus-xmax").value = initialStimulusPayload.xmax ?? 5;
    card.querySelector(".stimulus-ymin").value = initialStimulusPayload.ymin ?? -5;
    card.querySelector(".stimulus-ymax").value = initialStimulusPayload.ymax ?? 5;
    card.querySelector(".stimulus-graph-caption").value = initialStimulusPayload.caption || "";
    card.querySelector(".stimulus-latex-source").value = initialStimulusPayload.latex || "";
    card.querySelector(".stimulus-latex-caption").value = initialStimulusPayload.caption || "";

    stimulusTypeSelect.addEventListener("change",()=>{ refreshStimulusPreview(card); scheduleExamDraftAutosave(); });
    card.querySelector(".stimulus-upload-btn").addEventListener("click",()=>uploadStimulusImage(card));
    card.querySelector(".stimulus-remove-image-btn").addEventListener("click",async()=>{
      const oldPath=card.dataset.stimulusImagePath||"";
      card.dataset.stimulusImageUrl=""; card.dataset.stimulusImagePath="";
      card.querySelector(".stimulus-image-file").value="";
      card.querySelector(".stimulus-image-status").textContent="Image removed from this question.";
      refreshStimulusPreview(card); scheduleExamDraftAutosave();
      if(oldPath){
        const {error}=await db.storage.from("exam-stimuli").remove([oldPath]);
        if(error) console.warn("Stimulus image cleanup failed:",error);
      }
    });
    card.querySelectorAll(".stimulus-panel input,.stimulus-panel textarea").forEach(input=>{
      input.addEventListener("input",()=>{ clearTimeout(card._stimulusTimer); card._stimulusTimer=setTimeout(()=>refreshStimulusPreview(card),180); });
    });

    const promptInput = card.querySelector(".q-prompt");
    let mathPreviewTimer = null;
    promptInput.addEventListener("input", () => {
      clearTimeout(mathPreviewTimer);
      mathPreviewTimer = setTimeout(() => renderMathPreview(card), 180);
    });

    const removeBtn = card.querySelector(".remove-question-btn");
    removeBtn.addEventListener("click", () => {
      if ($("questionBuilder").querySelectorAll(".question-card").length <= 1) {
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

    card.querySelector(".binary-choice-a").addEventListener("input", () => refreshBinaryAnswerOptions(card));
    card.querySelector(".binary-choice-b").addEventListener("input", () => refreshBinaryAnswerOptions(card));
    card.querySelector(".rubric-type").addEventListener("change", () => {
      initializeRubricForMode(card);
      updateRubricMode(card);
    });
    card.querySelector(".add-rubric-btn").addEventListener("click", () => addRubricRow(card));
    card.querySelector(".add-analytic-level-btn").addEventListener("click", () => addAnalyticLevel(card));
    card.querySelector(".add-analytic-criterion-btn").addEventListener("click", () => addAnalyticCriterion(card));
    card.querySelector(".download-rubric-template-btn").addEventListener("click", () => downloadRubricTemplate(card));
    card.querySelector(".import-rubric-btn").addEventListener("click", () => importRubricExcel(card));

    (Array.isArray(q.choices) && q.choices.length ? q.choices : ["", "", "", ""]).forEach(choice => addChoiceInput(card, choice));

    const rubricType = q.rubric_type === "holistic" ? "holistic" : "analytic";
    const rubric = normalizeRubricCriteria(q.rubric_criteria, rubricType);
    if (rubricType === "holistic") {
      if (rubric.length) rubric.forEach(item => addRubricRow(card, item));
      else addRubricRow(card);
    } else {
      initializeAnalyticRubric(card, rubric);
    }

    updateRubricMode(card);
    toggleQuestionMode(card);
    refreshCorrectAnswerOptions(card, q.correct_answer);
    refreshBinaryAnswerOptions(card, q.correct_answer);
    renderMathPreview(card);
    refreshStimulusPreview(card);
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

  function refreshBinaryAnswerOptions(card, desired = null) {
    const select = card.querySelector(".binary-correct");
    if (!select) return;
    const a = card.querySelector(".binary-choice-a").value.trim() || "True";
    const b = card.querySelector(".binary-choice-b").value.trim() || "False";
    const current = desired ?? select.value;

    select.innerHTML = "";
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "Select the correct response";
    select.appendChild(empty);

    [a, b].forEach(value => {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = value;
      if (value === current) opt.selected = true;
      select.appendChild(opt);
    });

    if (![a,b].includes(current)) select.value = "";
  }

  function rubricMode(card) {
    return card.querySelector(".rubric-type")?.value === "holistic" ? "holistic" : "analytic";
  }

  function defaultAnalyticLevels() {
    return [
      { level: "Excellent", points: 4 },
      { level: "Good", points: 3 },
      { level: "Fair", points: 2 },
      { level: "Needs Improvement", points: 1 }
    ];
  }

  function initializeRubricForMode(card) {
    const mode = rubricMode(card);

    if (mode === "analytic") {
      if (!card.querySelector(".analytic-level-row")) {
        initializeAnalyticRubric(card, []);
      }
    } else if (!card.querySelector(".rubric-row")) {
      addRubricRow(card);
    }
  }

  function initializeAnalyticRubric(card, criteria = []) {
    const levelList = card.querySelector(".analytic-levels-list");
    const matrix = card.querySelector(".analytic-matrix");
    levelList.innerHTML = "";
    matrix.innerHTML = "";

    let levels = [];
    if (criteria.length && Array.isArray(criteria[0]?.levels) && criteria[0].levels.length) {
      levels = criteria[0].levels.map(level => ({
        level: String(level.level || ""),
        points: Number(level.points || 0)
      }));
    } else {
      levels = defaultAnalyticLevels();
    }

    levels.forEach(level => addAnalyticLevel(card, level, false));

    if (criteria.length) {
      criteria.forEach(item => addAnalyticCriterion(card, item, false));
    } else {
      addAnalyticCriterion(card, { criterion: "Organization", levels: [] }, false);
    }

    renderAnalyticMatrix(card);
  }

  function addAnalyticLevel(card, level = null, rerender = true) {
    const list = card.querySelector(".analytic-levels-list");
    const row = document.createElement("div");
    row.className = "analytic-level-row";
    row.innerHTML = `
      <input class="analytic-level-name" placeholder="Level name" value="${escapeAttr(level?.level || "")}">
      <input class="analytic-level-points" type="number" min="0" step="0.25" placeholder="Score" value="${level && Number.isFinite(Number(level.points)) ? Number(level.points) : ""}">
      <button type="button" class="remove-analytic-level-btn">Remove</button>
    `;

    list.appendChild(row);

    row.querySelector(".analytic-level-name").addEventListener("input", () => renderAnalyticMatrix(card));
    row.querySelector(".analytic-level-points").addEventListener("input", () => {
      renderAnalyticMatrix(card);
      updateRubricTotal(card);
    });
    row.querySelector(".remove-analytic-level-btn").addEventListener("click", () => {
      if (list.children.length <= 2) {
        setCreateMessage("An analytic rubric needs at least two performance levels.", true);
        return;
      }
      preserveAnalyticDescriptions(card);
      row.remove();
      renderAnalyticMatrix(card);
      updateRubricTotal(card);
    });

    if (rerender) {
      preserveAnalyticDescriptions(card);
      renderAnalyticMatrix(card);
      updateRubricTotal(card);
    }
  }

  function currentAnalyticLevels(card) {
    return [...card.querySelectorAll(".analytic-level-row")].map((row, index) => ({
      key: row.dataset.levelKey || `level-${index}`,
      level: row.querySelector(".analytic-level-name").value.trim() || `Level ${index + 1}`,
      points: Number(row.querySelector(".analytic-level-points").value)
    }));
  }

  function preserveAnalyticDescriptions(card) {
    const matrix = card.querySelector(".analytic-matrix");
    if (!matrix) return;

    [...matrix.querySelectorAll(".analytic-criterion-row")].forEach(row => {
      const criterionId = row.dataset.criterionId;
      const state = analyticCriterionState(card, criterionId);
      if (!state) return;

      state.criterion = row.querySelector(".analytic-criterion-name")?.value?.trim() || "";
      state.descriptions = {};
      row.querySelectorAll(".analytic-level-description").forEach(input => {
        state.descriptions[input.dataset.levelIndex] = input.value;
      });
    });
  }

  function analyticState(card) {
    if (!card._analyticRubricState) {
      card._analyticRubricState = { criteria: [] };
    }
    return card._analyticRubricState;
  }

  function analyticCriterionState(card, id) {
    return analyticState(card).criteria.find(item => item.id === id);
  }

  function addAnalyticCriterion(card, item = null, rerender = true) {
    const state = analyticState(card);
    const id = `criterion-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const levels = currentAnalyticLevels(card);

    const descriptions = {};
    levels.forEach((level, index) => {
      const matching = Array.isArray(item?.levels)
        ? item.levels.find(l => String(l.level || "").trim().toLowerCase() === level.level.toLowerCase()) || item.levels[index]
        : null;
      descriptions[String(index)] = matching?.description || "";
    });

    state.criteria.push({
      id,
      criterion: item?.criterion || "",
      descriptions
    });

    if (rerender) {
      renderAnalyticMatrix(card);
      updateRubricTotal(card);
    }
  }

  function renderAnalyticMatrix(card) {
    preserveAnalyticDescriptions(card);

    const matrix = card.querySelector(".analytic-matrix");
    const levels = currentAnalyticLevels(card);
    const state = analyticState(card);

    if (!state.criteria.length) {
      addAnalyticCriterion(card, null, false);
    }

    matrix.innerHTML = "";

    const table = document.createElement("table");
    table.className = "analytic-rubric-table";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");

    const criteriaHead = document.createElement("th");
    criteriaHead.textContent = "Criteria / Level of Performance";
    headRow.appendChild(criteriaHead);

    levels.forEach(level => {
      const th = document.createElement("th");
      const name = document.createElement("strong");
      name.textContent = level.level;
      const score = document.createElement("span");
      score.className = "analytic-level-score";
      score.textContent = Number.isFinite(level.points) ? `${trimNumber(level.points)} pts` : "—";
      th.append(name, score);
      headRow.appendChild(th);
    });

    const actionHead = document.createElement("th");
    actionHead.textContent = "";
    headRow.appendChild(actionHead);
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");

    state.criteria.forEach((criterionState, criterionIndex) => {
      const tr = document.createElement("tr");
      tr.className = "analytic-criterion-row";
      tr.dataset.criterionId = criterionState.id;

      const nameTd = document.createElement("td");
      const nameInput = document.createElement("input");
      nameInput.className = "analytic-criterion-name";
      nameInput.placeholder = "Criterion";
      nameInput.value = criterionState.criterion || "";
      nameTd.appendChild(nameInput);
      tr.appendChild(nameTd);

      levels.forEach((level, levelIndex) => {
        const td = document.createElement("td");
        const textarea = document.createElement("textarea");
        textarea.className = "analytic-level-description";
        textarea.rows = 3;
        textarea.dataset.levelIndex = String(levelIndex);
        textarea.placeholder = `${level.level} description`;
        textarea.value = criterionState.descriptions?.[String(levelIndex)] || "";
        td.appendChild(textarea);
        tr.appendChild(td);
      });

      const actionTd = document.createElement("td");
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        if (state.criteria.length <= 1) {
          setCreateMessage("An analytic rubric needs at least one criterion.", true);
          return;
        }
        state.criteria = state.criteria.filter(item => item.id !== criterionState.id);
        renderAnalyticMatrix(card);
        updateRubricTotal(card);
      });
      actionTd.appendChild(remove);
      tr.appendChild(actionTd);

      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    matrix.appendChild(table);
    updateRubricTotal(card);
  }

  function collectAnalyticCriteria(card) {
    preserveAnalyticDescriptions(card);
    const levels = currentAnalyticLevels(card);
    const state = analyticState(card);

    return state.criteria.map(item => ({
      criterion: String(item.criterion || "").trim(),
      levels: levels.map((level, index) => ({
        level: level.level,
        description: String(item.descriptions?.[String(index)] || "").trim(),
        points: Number(level.points)
      }))
    }));
  }

  function updateRubricMode(card) {
    const mode = rubricMode(card);
    const help = card.querySelector(".rubric-mode-help");
    const excelHelp = card.querySelector(".rubric-excel-help");
    const analytic = card.querySelector(".analytic-rubric-builder");
    const holistic = card.querySelector(".holistic-rubric-builder");

    analytic.classList.toggle("hidden", mode !== "analytic");
    holistic.classList.toggle("hidden", mode !== "holistic");

    if (mode === "holistic") {
      if (help) help.textContent = "Holistic rubric: define each criterion, its description, and its maximum score. The student's score is entered during grading.";
      if (excelHelp) excelHelp.textContent = "Excel columns: Criteria, Description, Max Score.";
    } else {
      if (help) help.textContent = "Analytic rubric: each criterion is evaluated across the same levels of performance.";
      if (excelHelp) excelHelp.textContent = "Excel columns: Criterion, then one Description column for each performance level, with a matching Score column.";
      renderAnalyticMatrix(card);
    }

    updateRubricTotal(card);
  }

  function addRubricRow(card, item = null) {
    const list = card.querySelector(".rubric-list");
    const row = document.createElement("div");
    row.className = "rubric-row";
    const criterion = item?.criterion || item?.level || "";
    const description = item?.description || "";
    const maxPoints = Number(item?.max_points ?? item?.points ?? item?.score ?? 0);

    row.innerHTML = `
      <input class="rubric-criterion" placeholder="Criterion (e.g. Organization)" value="${escapeAttr(criterion)}">
      <input class="rubric-description" placeholder="Description (e.g. Able to organize thoughts and ideas)" value="${escapeAttr(description)}">
      <input class="rubric-max-points" type="number" min="0.25" step="0.25" placeholder="Max score" value="${maxPoints > 0 && item ? maxPoints : ""}">
      <button type="button" class="remove-rubric-btn">Remove</button>
    `;

    list.appendChild(row);
    row.querySelector(".rubric-max-points").addEventListener("input", () => updateRubricTotal(card));
    row.querySelector(".remove-rubric-btn").addEventListener("click", () => {
      if (list.children.length <= 1) {
        setCreateMessage("A holistic rubric needs at least one criterion.", true);
        return;
      }
      row.remove();
      updateRubricTotal(card);
    });
    updateRubricTotal(card);
  }

  function updateRubricTotal(card) {
    const mode = rubricMode(card);
    let total = 0;

    if (mode === "holistic") {
      const values = [...card.querySelectorAll(".rubric-max-points")]
        .map(input => Number(input.value))
        .filter(value => Number.isFinite(value) && value >= 0);
      total = values.reduce((sum, value) => sum + value, 0);
    } else {
      const levels = currentAnalyticLevels(card)
        .map(level => level.points)
        .filter(value => Number.isFinite(value) && value >= 0);
      const highestLevel = levels.length ? Math.max(...levels) : 0;
      const criteriaCount = analyticState(card).criteria.length;
      total = highestLevel * criteriaCount;
    }

    const totalNode = card.querySelector(".rubric-total-value");
    const totalLabel = card.querySelector(".rubric-total");
    const pointInput = card.querySelector(".q-points");

    if (totalNode) totalNode.textContent = trimNumber(total);
    if (totalLabel?.firstChild) {
      totalLabel.firstChild.textContent = "Total: ";
    }
    if (pointInput && card.querySelector(".q-type").value === "essay") {
      pointInput.value = total > 0 ? String(total) : "0";
    }
  }

  function collectRubricCriteria(card) {
    if (rubricMode(card) === "analytic") {
      return collectAnalyticCriteria(card);
    }

    return [...card.querySelectorAll(".rubric-row")].map(row => ({
      criterion: row.querySelector(".rubric-criterion").value.trim(),
      description: row.querySelector(".rubric-description").value.trim(),
      max_points: Number(row.querySelector(".rubric-max-points").value)
    }));
  }

  function downloadRubricTemplate(card) {
    if (!window.XLSX) {
      alert("Excel library is unavailable. Refresh the dashboard and try again.");
      return;
    }

    const mode = rubricMode(card);

    if (mode === "analytic") {
      const levels = currentAnalyticLevels(card);
      const headers = ["Criterion"];
      levels.forEach(level => {
        headers.push(`${level.level} Description`);
        headers.push(`${level.level} Score`);
      });

      const sample = ["Organization"];
      levels.forEach(level => {
        sample.push(`Descriptor for Organization at ${level.level}`);
        sample.push(level.points);
      });

      const sample2 = ["Balance"];
      levels.forEach(level => {
        sample2.push(`Descriptor for Balance at ${level.level}`);
        sample2.push(level.points);
      });

      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet([headers, sample, sample2]);
      ws["!cols"] = headers.map((_, i) => ({ wch: i === 0 ? 24 : (i % 2 ? 42 : 12) }));
      XLSX.utils.book_append_sheet(wb, ws, "Analytic Rubric");
      XLSX.writeFile(wb, "Analytic_Rubric_Template.xlsx");
      return;
    }

    const rows = [
      ["Criteria", "Description", "Max Score"],
      ["Organization", "Able to organize thoughts and ideas.", 20],
      ["Content", "Demonstrates appropriate and relevant content.", 20],
      ["Clarity", "Expresses ideas clearly and coherently.", 10]
    ];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{wch:24},{wch:65},{wch:14}];
    XLSX.utils.book_append_sheet(wb, ws, "Holistic Rubric");
    XLSX.writeFile(wb, "Holistic_Rubric_Template.xlsx");
  }

  async function importRubricExcel(card) {
    const input = card.querySelector(".rubric-excel-file");
    const file = input?.files?.[0];
    if (!file) {
      setCreateMessage("Choose a rubric Excel file first.", true);
      return;
    }
    if (!window.XLSX) {
      setCreateMessage("Excel reader is unavailable. Refresh the dashboard and try again.", true);
      return;
    }

    try {
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: "array" });
      const firstSheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: "" });
      const mode = rubricMode(card);

      if (mode === "analytic") {
        if (!rows.length) throw new Error("No analytic rubric rows were found.");

        const headers = Object.keys(rows[0]);
        const descriptionHeaders = headers.filter(header => / description$/i.test(header));
        if (!descriptionHeaders.length) {
          throw new Error("Analytic rubric needs columns such as Excellent Description and Excellent Score.");
        }

        const levels = descriptionHeaders.map(header => {
          const levelName = header.replace(/ description$/i, "").trim();
          const scoreHeader = headers.find(h => h.trim().toLowerCase() === `${levelName} score`.toLowerCase());
          if (!scoreHeader) throw new Error(`Missing "${levelName} Score" column.`);
          const firstScore = Number(rows[0][scoreHeader]);
          return { level: levelName, scoreHeader, descriptionHeader: header, points: firstScore };
        });

        for (const level of levels) {
          if (!Number.isFinite(level.points) || level.points < 0) {
            throw new Error(`The score for "${level.level}" must be a non-negative number.`);
          }
        }

        const criteria = rows.map(row => ({
          criterion: String(row["Criterion"] ?? row["Criteria"] ?? "").trim(),
          levels: levels.map(level => ({
            level: level.level,
            description: String(row[level.descriptionHeader] ?? "").trim(),
            points: Number(row[level.scoreHeader])
          }))
        })).filter(item => item.criterion);

        if (!criteria.length) throw new Error("No Criterion values were found.");

        card._analyticRubricState = { criteria: [] };
        const levelList = card.querySelector(".analytic-levels-list");
        levelList.innerHTML = "";
        levels.forEach(level => addAnalyticLevel(card, { level: level.level, points: level.points }, false));

        criteria.forEach(item => addAnalyticCriterion(card, item, false));
        renderAnalyticMatrix(card);
        updateRubricTotal(card);
        setCreateMessage(`${criteria.length} analytic rubric criteria imported successfully.`);
        return;
      }

      const parsed = rows.map(row => ({
        criterion: String(row["Criteria"] ?? row["Criterion"] ?? "").trim(),
        description: String(row["Description"] ?? row["Descriptor"] ?? "").trim(),
        max_points: Number(row["Max Score"] ?? row["Maximum Score"] ?? row["Max Points"] ?? row["Points"] ?? 0)
      })).filter(item => item.criterion || item.description || Number.isFinite(item.max_points));

      const invalid = parsed.find(item =>
        !item.criterion || !Number.isFinite(item.max_points) || item.max_points <= 0
      );
      if (!parsed.length || invalid) {
        throw new Error("Holistic rubric columns must be Criteria, Description, Max Score.");
      }

      const list = card.querySelector(".rubric-list");
      list.innerHTML = "";
      parsed.forEach(item => addRubricRow(card, item));
      updateRubricTotal(card);
      setCreateMessage(`${parsed.length} holistic criteria imported successfully.`);
    } catch (error) {
      setCreateMessage(`Could not import essay rubric: ${error?.message || error}`, true);
    }
  }


  function toggleQuestionMode(card) {
    const type = card.querySelector(".q-type").value;
    const mcqArea = card.querySelector(".mcq-area");
    const binaryArea = card.querySelector(".binary-area");
    const shortArea = card.querySelector(".short-response-area");
    const mathArea = card.querySelector(".math-solver-area");
    const essayArea = card.querySelector(".essay-rubric-area");
    const pointInput = card.querySelector(".q-points");

    mcqArea.classList.toggle("hidden", type !== "mcq");
    binaryArea.classList.toggle("hidden", type !== "binary");
    shortArea.classList.toggle("hidden", type !== "short_response");
    mathArea.classList.toggle("hidden", type !== "math_solver");
    essayArea.classList.toggle("hidden", type !== "essay");

    if (type === "essay") {
      pointInput.readOnly = true;
      updateRubricTotal(card);
    } else {
      pointInput.readOnly = false;
      if (!Number(pointInput.value) || Number(pointInput.value) <= 0) pointInput.value = "1";
    }

    if (type === "binary") refreshBinaryAnswerOptions(card);
  }

  function addExamSection(title = null) {
    const builder = $("questionBuilder");
    const existing = builder.querySelectorAll(".exam-part-divider").length;
    const sectionTitle = title || `Part ${existing + 2}`;

    const divider = document.createElement("section");
    divider.className = "exam-part-divider";
    divider.innerHTML = `
      <div>
        <span class="muted">Exam Section</span>
        <input class="exam-part-title" value="${escapeAttr(sectionTitle)}" aria-label="Section title">
      </div>
      <button type="button" class="remove-part-btn">Remove Section</button>
    `;
    builder.appendChild(divider);
    divider.querySelector(".remove-part-btn").addEventListener("click", () => {
      divider.remove();
      renumberQuestionCards();
    });

    addQuestionCard({ prompt:"", question_type:"mcq", points:1, choices:["","","",""], correct_answer:"", rubric_type:"analytic", rubric_criteria:[], section_title:sectionTitle });
    renumberQuestionCards();
  }

  function sectionTitleForCard(card) {
    let node = card.previousElementSibling;
    while (node) {
      if (node.classList?.contains("exam-part-divider")) {
        return node.querySelector(".exam-part-title")?.value?.trim() || "Part 2";
      }
      node = node.previousElementSibling;
    }
    return card.dataset.sectionTitle || "Part 1";
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

      if (current?.status === "published") {
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
        section_title: q.section_title || "Part 1",
        prompt: q.prompt,
        question_type: q.question_type,
        choices: q.choices,
        correct_answer: q.correct_answer,
        points: q.points,
        rubric_type: q.rubric_type,
        rubric_criteria: q.rubric_criteria,
        stimulus_type: q.stimulus_type || "none",
        stimulus_payload: q.stimulus_payload || {}
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
      setCreateMessage(`Draft "${title}" saved successfully.`);
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
      const rawMessage = String(examError.message || "");
      const isOwnershipRls = /row-level security|violates.*policy.*exams/i.test(rawMessage);
      setCreateMessage(
        isOwnershipRls
          ? "Exam save was blocked by the database ownership policy. Run supabase-upgrade-exam-owner-rls-fix.sql once in Supabase SQL Editor, refresh this dashboard, then save again. Main Admin may create exams in an authorized co-teacher workspace; regular teachers may create only in their own workspace."
          : `Exam save failed: ${rawMessage}`,
        true
      );
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
      points: q.points,
      rubric_type: q.rubric_type,
      rubric_criteria: q.rubric_criteria
    }));

    const { error: questionError } = await db
      .from("questions")
      .insert(questions);

    $("saveExamBtn").disabled = false;

    if (questionError) {
      setCreateMessage(`Exam created, but questions failed: ${questionError.message}`, true);
      return;
    }

    setCreateMessage(`Draft "${exam.title}" saved successfully with code ${exam.code}. Publish it from Manage Exams when ready.`);
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

    let questions = null;
    const draft = exam.status === "draft" && exam.draft_payload && typeof exam.draft_payload === "object"
      ? exam.draft_payload
      : null;

    if (draft && Array.isArray(draft.questions)) {
      questions = draft.questions;
    } else {
      const response = await db
        .from("questions")
        .select("id,position,section_title,prompt,question_type,choices,correct_answer,points,rubric_type,rubric_criteria,stimulus_type,stimulus_payload")
        .eq("exam_id", exam.id)
        .order("position", { ascending: true });

      if (response.error) {
        alert(`Could not load exam questions for editing: ${response.error.message}`);
        return;
      }
      questions = response.data || [];
    }

    editingExamId = exam.id;
    draftLastFingerprint = "";

    $("examTitleInput").value = draft?.title ?? exam.title ?? "";
    $("examCodeInput").value = draft?.code || exam.code || "";
    $("durationInput").value = draft?.duration_minutes || exam.duration_minutes || 60;
    $("statusInput").value = "draft";
    $("startAtInput").value = toLocalDateTimeInput(draft?.start_at ?? exam.start_at);
    $("endAtInput").value = toLocalDateTimeInput(draft?.end_at ?? exam.end_at);

    const heading = $("examFormHeading");
    const intro = $("examFormIntro");
    const saveBtn = $("saveExamBtn");
    const cancelBtn = $("cancelEditExamBtn");
    if (heading) heading.textContent = `Edit Examination — ${exam.title}`;
    if (intro) intro.textContent = "Changes are saved automatically as a Draft. Publish from Manage Exams only when the examination is ready.";
    if (saveBtn) saveBtn.textContent = "Save Draft Now";
    if (cancelBtn) cancelBtn.classList.remove("hidden");

    $("questionBuilder").innerHTML = "";
    questionCounter = 0;
    let previousSection = null;
    (questions || []).forEach((q, index) => {
      const section = q.section_title || "Part 1";
      if (index > 0 && section !== previousSection) {
        const divider = document.createElement("section");
        divider.className = "exam-part-divider";
        divider.innerHTML = `<div><span class="muted">Exam Section</span><input class="exam-part-title" value="${escapeAttr(section)}"></div><button type="button" class="remove-part-btn">Remove Section</button>`;
        $("questionBuilder").appendChild(divider);
        divider.querySelector(".remove-part-btn").addEventListener("click", () => divider.remove());
      }
      addQuestionCard(q);
      previousSection = section;
    });
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
    const status = "draft";
    const startAt = toIsoOrNull($("startAtInput").value);
    const endAt = toIsoOrNull($("endAtInput").value);

    if (!title) return fail("Enter the exam title.");
    if (!code) return fail("Enter the exam code.");
    if (!/^[A-Z0-9-]+$/.test(code)) return fail("Exam code may only contain A-Z, 0-9, and hyphens.");
    if (!duration || duration < 1 || duration > 600) return fail("Enter a valid duration between 1 and 600 minutes.");
    if (startAt && endAt && new Date(endAt) <= new Date(startAt)) return fail("End date/time must be later than start date/time.");

    const cards = [...$("questionBuilder").querySelectorAll(".question-card")];
    if (!cards.length) return fail("Add at least one question.");

    const questions = [];
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const prompt = card.querySelector(".q-prompt").value.trim();
      const question_type = card.querySelector(".q-type").value;
      let points = Number(card.querySelector(".q-points").value);

      if (!prompt) return fail(`Question ${i + 1} has no prompt.`);

      let choices = null;
      let correct_answer = null;
      let rubric_type = "analytic";
      let rubric_criteria = [];

      if (question_type === "mcq") {
        choices = [...card.querySelectorAll(".choice-input")]
          .map(i => i.value.trim())
          .filter(Boolean);

        if (choices.length < 2) return fail(`Question ${i + 1} needs at least two non-empty choices.`);

        const unique = new Set(choices.map(v => v.toLowerCase()));
        if (unique.size !== choices.length) return fail(`Question ${i + 1} has duplicate choices.`);

        correct_answer = card.querySelector(".q-correct").value.trim();
        if (!correct_answer) return fail(`Question ${i + 1} needs a correct answer.`);
      } else if (question_type === "binary") {
        const first = card.querySelector(".binary-choice-a").value.trim();
        const second = card.querySelector(".binary-choice-b").value.trim();
        if (!first || !second) return fail(`Question ${i + 1} needs two binary responses.`);
        if (first.toLowerCase() === second.toLowerCase()) return fail(`Question ${i + 1} has duplicate binary responses.`);
        choices = [first, second];
        correct_answer = card.querySelector(".binary-correct").value.trim();
        if (!correct_answer) return fail(`Question ${i + 1} needs a correct binary response.`);
      } else if (question_type === "short_response") {
        correct_answer = card.querySelector(".short-reference-answer").value.trim();
        if (!correct_answer) return fail(`Question ${i + 1} needs a reference answer for provisional verification.`);
      } else if (question_type === "math_solver") {
        correct_answer = card.querySelector(".math-reference-answer").value.trim();
        if (!correct_answer) return fail(`Question ${i + 1} needs an expected final answer or solution guide.`);
      } else if (question_type === "essay") {
        rubric_type = rubricMode(card);
        rubric_criteria = collectRubricCriteria(card);
        if (!rubric_criteria.length) return fail(`Question ${i + 1} needs at least one rubric row.`);

        if (rubric_type === "holistic") {
          for (const level of rubric_criteria) {
            if (!level.criterion) return fail(`Question ${i + 1} has a holistic criterion without a name.`);
            if (!Number.isFinite(level.max_points) || level.max_points <= 0) {
              return fail(`Question ${i + 1} has a holistic criterion without a positive maximum score.`);
            }
          }
          points = rubric_criteria.reduce((sum, item) => sum + item.max_points, 0);
        } else {
          for (const criterion of rubric_criteria) {
            if (!criterion.criterion) return fail(`Question ${i + 1} has an analytic criterion without a name.`);
            if (!Array.isArray(criterion.levels) || criterion.levels.length < 2) {
              return fail(`Question ${i + 1} analytic rubric needs at least two performance levels.`);
            }
            for (const level of criterion.levels) {
              if (!level.level) return fail(`Question ${i + 1} has an unnamed performance level.`);
              if (!Number.isFinite(level.points) || level.points < 0) {
                return fail(`Question ${i + 1} has an invalid analytic level score.`);
              }
            }
          }
          points = rubric_criteria.reduce((sum, criterion) => {
            const max = Math.max(...criterion.levels.map(level => level.points));
            return sum + max;
          }, 0);
        }
      }

      if (!points || points <= 0) return fail(`Question ${i + 1} must have a positive point value.`);

      const stimulus = currentStimulusFromCard(card);
      if (stimulus.type === "image" && !stimulus.payload.url) return fail(`Question ${i + 1} image stimulus has not been uploaded.`);
      if (stimulus.type === "graph") {
        try {
          compileStimulusGraphExpression(stimulus.payload.expression);
          if (!(stimulus.payload.xmax > stimulus.payload.xmin) || !(stimulus.payload.ymax > stimulus.payload.ymin)) {
            return fail(`Question ${i + 1} graph range is invalid.`);
          }
        } catch (error) {
          return fail(`Question ${i + 1} graph stimulus: ${error.message}`);
        }
      }
      if (stimulus.type === "latex" && !String(stimulus.payload.latex || "").trim()) return fail(`Question ${i + 1} LaTeX stimulus is empty.`);

      questions.push({
        section_title: sectionTitleForCard(card),
        prompt,
        question_type,
        points,
        choices,
        correct_answer,
        rubric_type,
        rubric_criteria,
        stimulus_type: stimulus.type,
        stimulus_payload: stimulus.payload
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
      .select("id, code, title, duration_minutes, status, start_at, end_at, archived, archived_at, owner_id, draft_payload, draft_updated_at, results_released, results_released_at")
      .order("created_at", { ascending: false });

    // Keep the dashboard usable before the one-time archive database upgrade is run.
    if (error && /archived|draft_payload|draft_updated_at/i.test(error.message || "")) {
      const fallback = await db
        .from("exams")
        .select("id, code, title, duration_minutes, status, start_at, end_at, owner_id, results_released, results_released_at")
        .order("created_at", { ascending: false });
      exams = (fallback.data || []).map(e => ({ ...e, archived: false, archived_at: null, draft_payload: null, draft_updated_at: null }));
      error = fallback.error;
    }

    if (error) {
      $("examRows").innerHTML = `<tr><td colspan="8">${escapeHtml(error.message)}</td></tr>`;
      return;
    }

    const workspaceOwnerId = getActiveWorkspaceOwnerId();
    const isMainAdmin = currentTeacherProfile?.role === "main_admin";
    examsCache = (exams || []).filter(e => {
      if (isMainAdmin) {
        return !workspaceOwnerId || e.owner_id === workspaceOwnerId;
      }
      return e.owner_id === currentUserId || isProctorForExam(e.id);
    });
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

    const buckets = {
      published: [],
      draft: [],
      closed: [],
      archived: []
    };

    for (const exam of examsCache) {
      if (exam.archived) buckets.archived.push(exam);
      else if (exam.status === "published") buckets.published.push(exam);
      else if (exam.status === "draft") buckets.draft.push(exam);
      else buckets.closed.push(exam);
    }

    const order = [
      { key:"published", label:"Published Exams", note:"Currently available or scheduled for students", tone:"published" },
      { key:"draft", label:"Draft Exams", note:"Still being prepared or awaiting publication", tone:"draft" },
      { key:"closed", label:"Closed Exams", note:"No longer accepting new exam attempts", tone:"closed" },
      { key:"archived", label:"Archived / Trash", note:"Kept for recovery; student data is preserved", tone:"archived" }
    ];

    for (const group of order) {
      const items = buckets[group.key];
      if (!items.length) continue;

      const expanded = expandedExamStatusGroups.has(group.key);
      const groupRow = document.createElement("tr");
      groupRow.className = `status-group-row exam-status-group ${group.tone}`;
      groupRow.innerHTML = `
        <td colspan="8">
          <button type="button" class="status-group-toggle" aria-expanded="${expanded ? "true" : "false"}">
            <span class="status-group-chevron">${expanded ? "▾" : "▸"}</span>
            <span class="status-group-label">
              <strong>${escapeHtml(group.label)}</strong>
              <small>${escapeHtml(group.note)}</small>
            </span>
            <span class="status-group-count">${items.length} exam${items.length===1?"":"s"}</span>
          </button>
        </td>
      `;
      groupRow.querySelector(".status-group-toggle").addEventListener("click",()=>{
        if (expandedExamStatusGroups.has(group.key)) expandedExamStatusGroups.delete(group.key);
        else expandedExamStatusGroups.add(group.key);
        renderExamRows(counts);
      });
      body.appendChild(groupRow);

      if (!expanded) continue;

      for (const exam of items) {
        const tr = document.createElement("tr");
        const draftQuestionCount = Array.isArray(exam.draft_payload?.questions) ? exam.draft_payload.questions.length : 0;
        const qCount = Math.max(counts[exam.id] || 0, draftQuestionCount);
        const archived = Boolean(exam.archived);
        tr.classList.toggle("archived-row", archived);
        tr.innerHTML = `
          <td data-label="Title">
            <button type="button" class="exam-title-link" data-exam-id="${escapeAttr(exam.id)}" data-exam-code="${escapeAttr(exam.code)}" data-exam-title="${escapeAttr(exam.title)}">${escapeHtml(exam.title)}</button>
            ${archived ? '<br><span class="badge archived">Archived</span>' : ''}
            ${isProctorForExam(exam.id) && exam.owner_id !== currentUserId ? '<br><span class="badge proctor">Proctor</span>' : ''}
          </td>
          <td data-label="Code">${escapeHtml(exam.code)}</td>
          <td data-label="Status"><span class="badge ${exam.status === "published" ? "ok" : "warn"}">${escapeHtml(exam.status)}</span></td>
          <td data-label="Duration">${escapeHtml(String(exam.duration_minutes))} min</td>
          <td data-label="Questions">${qCount}</td>
          <td data-label="Start">${fmt(exam.start_at)}</td>
          <td data-label="End">${fmt(exam.end_at)}</td>
          <td data-label="Actions" class="action-cell">
            ${isProctorForExam(exam.id) && exam.owner_id !== currentUserId ? `
              <button type="button" data-exam-action="preview">Preview Exam</button>
              <button type="button" data-exam-action="exam-pdf">Exam PDF</button>
              <span class="badge proctor">Proctor access</span>
            ` : archived ? `
              <button type="button" data-exam-action="preview">Preview Exam</button>
              <button type="button" data-exam-action="retake">Retake Exam</button>
              <button type="button" data-exam-action="restore">Restore</button>
            ` : `
              <button type="button" data-exam-action="preview">Preview Exam</button>
              <button type="button" data-exam-action="edit" ${exam.status === "published" ? 'disabled title="Published examinations cannot be edited"' : ""}>Edit Exam</button>
              ${exam.status === "published" ? '<button type="button" data-exam-action="exam-pdf">Exam PDF</button><button type="button" data-exam-action="extend-window">Extend Exam Window</button>' : ""}
              <button type="button" data-exam-action="toggle-results">${exam.results_released ? "Hide Student Results" : "Release Student Results"}</button>
              <button type="button" data-action="draft">Draft</button>
              <button type="button" data-action="published">Publish</button>
              <button type="button" data-action="closed">Close</button>
              <button type="button" data-exam-action="retake">Retake Exam</button>
              <button type="button" data-exam-action="archive">Move to Trash</button>
            `}
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
            if (action === "preview") await previewExam(exam);
            if (action === "edit") await editExam(exam);
            if (action === "exam-pdf") await window.ExamReport?.generateExamPdf(exam.id, btn);
            if (action === "extend-window") await extendExamWindow(exam);
            if (action === "toggle-results") await toggleExamResultsRelease(exam);
            if (action === "archive") await archiveExam(exam);
            if (action === "restore") await restoreExam(exam);
            if (action === "retake") await createRetakeExam(exam);
            if (action === "delete") await deleteExam(exam);
          });
        });

        body.appendChild(tr);

        const takerRow = document.createElement("tr");
        takerRow.className = "exam-takers-row hidden";
        takerRow.dataset.examTakersFor = exam.id;
        takerRow.innerHTML = `
          <td colspan="8">
            <div class="exam-takers-dropdown" id="examTakers-${escapeAttr(exam.id)}">
              <p class="muted">Click the exam title to load student takers.</p>
            </div>
          </td>
        `;
        body.appendChild(takerRow);
      }
    }
  }

  async function previewExam(exam) {
    const panel = $("examPreviewPanel");
    const questionsNode = $("examPreviewQuestions");
    if (!panel || !questionsNode) return;

    $("examPreviewTitle").textContent = exam.title || "Exam Preview";
    $("examPreviewMeta").textContent = `${exam.status || ""} • ${exam.code || ""}`;
    $("examPreviewExamTitle").textContent = exam.title || "";
    $("examPreviewExamCode").textContent = exam.code ? `Exam Code: ${exam.code}` : "";
    $("examPreviewDuration").textContent = `${exam.duration_minutes || 0} min`;
    questionsNode.innerHTML = '<p class="muted">Loading exam preview…</p>';

    const workspace = $("manageWorkspace");
    $("manageRightPane")?.classList.remove("hidden");
    $("gradingReviewPanel")?.classList.add("hidden");
    $("examResultsPanel")?.classList.add("hidden");
    workspace?.classList.remove("review-mode");
    workspace?.classList.add("preview-mode", "split-active");
    panel.classList.remove("hidden");

    if (exam.status === "draft" && Array.isArray(exam.draft_payload?.questions)) {
      const draftQuestions = exam.draft_payload.questions.map((q,index)=>({
        ...q,
        position: index + 1,
        section_title: q.section_title || "Part 1"
      }));
      renderExamPreviewQuestions(questionsNode, draftQuestions);
      return;
    }

    const { data: questions, error } = await db
      .from("questions")
      .select("id,position,section_title,prompt,question_type,choices,points,rubric_type,rubric_criteria,stimulus_type,stimulus_payload")
      .eq("exam_id", exam.id)
      .order("position", { ascending: true });

    if (error) {
      questionsNode.innerHTML = `<p class="message-inline error">${escapeHtml(error.message)}</p>`;
      return;
    }

    if ((!questions || questions.length === 0) && Array.isArray(exam.draft_payload?.questions)) {
      const fallbackQuestions = exam.draft_payload.questions.map((q,index)=>({
        ...q,
        position: index + 1,
        section_title: q.section_title || "Part 1"
      }));
      renderExamPreviewQuestions(questionsNode, fallbackQuestions);
      return;
    }

    renderExamPreviewQuestions(questionsNode, questions || []);
  }

  function buildTeacherStimulusPreview(q) {
    const type=q?.stimulus_type || "none";
    const payload=normalizeStimulusPayload(type,q?.stimulus_payload);
    if(type==="none") return null;
    const wrap=document.createElement("figure");
    wrap.className="item-stimulus item-stimulus-preview";
    if(type==="image" && payload.url){
      const img=document.createElement("img"); img.src=payload.url; img.alt=payload.alt||"Question stimulus"; img.className="item-stimulus-image"; wrap.appendChild(img);
    } else if(type==="graph"){
      const canvas=document.createElement("canvas"); canvas.className="stimulus-graph-canvas item-stimulus-graph"; wrap.appendChild(canvas);
      try{drawStimulusGraph(canvas,payload);}catch(error){const p=document.createElement("p");p.className="message-inline error";p.textContent=error.message;wrap.appendChild(p);}
    } else if(type==="latex" && payload.latex){
      const div=document.createElement("div");div.className="item-stimulus-latex math-rendered";div.textContent=payload.latex;wrap.appendChild(div);
    }
    if(payload.caption){const cap=document.createElement("figcaption");cap.textContent=payload.caption;wrap.appendChild(cap);}
    return wrap;
  }

  function renderExamPreviewQuestions(container, questions) {
    container.innerHTML = "";

    if (!questions.length) {
      container.innerHTML = '<p class="muted">This exam does not contain any questions yet.</p>';
      return;
    }

    let currentSection = null;

    for (const q of questions) {
      const sectionTitle = String(q.section_title || "Part 1").trim() || "Part 1";
      if (sectionTitle !== currentSection) {
        const heading = document.createElement("div");
        heading.className = "preview-section-heading";
        heading.textContent = sectionTitle;
        container.appendChild(heading);
        currentSection = sectionTitle;
      }

      const card = document.createElement("article");
      card.className = "preview-question-card";

      const head = document.createElement("div");
      head.className = "preview-question-head";
      head.innerHTML = `
        <strong>Question ${escapeHtml(q.position)}</strong>
        <span>${escapeHtml(q.points)} point${Number(q.points) === 1 ? "" : "s"}</span>
      `;
      card.appendChild(head);

      const prompt = document.createElement("div");
      prompt.className = "preview-question-prompt math-rendered";
      appendPreviewRichText(prompt, String(q.prompt || ""));
      card.appendChild(prompt);

      const stimulus = buildTeacherStimulusPreview(q);
      if (stimulus) card.appendChild(stimulus);

      if (q.question_type === "mcq" || q.question_type === "binary") {
        const choices = Array.isArray(q.choices) ? q.choices : [];
        const list = document.createElement("div");
        list.className = "preview-choice-list";

        choices.forEach((choice, index) => {
          const label = document.createElement("label");
          label.className = "preview-choice";
          const radio = document.createElement("input");
          radio.type = "radio";
          radio.disabled = true;
          const text = document.createElement("span");
          appendPreviewRichText(
            text,
            `${q.question_type === "mcq" ? String.fromCharCode(65 + index) + ". " : ""}${choice}`
          );
          label.append(radio, text);
          list.appendChild(label);
        });

        card.appendChild(list);
      } else if (q.question_type === "short_response") {
        const input = document.createElement("input");
        input.className = "preview-answer-input";
        input.placeholder = "Type your answer here";
        input.disabled = true;
        card.appendChild(input);
      } else if (q.question_type === "math_solver") {
        card.appendChild(buildMathSolverPreview());
      } else if (q.question_type === "essay" || q.question_type === "text") {
        const textarea = document.createElement("textarea");
        textarea.className = "preview-answer-textarea";
        textarea.rows = 7;
        textarea.placeholder = "Write your essay response here";
        textarea.disabled = true;
        card.appendChild(textarea);

        if (Array.isArray(q.rubric_criteria) && q.rubric_criteria.length) {
          card.appendChild(buildPreviewRubric(q));
        }
      }

      container.appendChild(card);
    }

    if (window.MathJax?.typesetPromise) {
      window.MathJax.typesetClear?.([container]);
      window.MathJax.typesetPromise([container]).catch(() => {});
    }
  }

  function appendPreviewRichText(parent, source) {
    const pattern = /\\(textit|emph|textbf|underline)\{([^{}]*)\}/g;
    let cursor = 0;
    let match;

    while ((match = pattern.exec(source)) !== null) {
      if (match.index > cursor) {
        parent.appendChild(document.createTextNode(source.slice(cursor, match.index)));
      }

      const tag = match[1] === "textbf" ? "strong" : (match[1] === "underline" ? "u" : "em");
      const node = document.createElement(tag);
      node.textContent = match[2];
      parent.appendChild(node);
      cursor = match.index + match[0].length;
    }

    if (cursor < source.length) {
      parent.appendChild(document.createTextNode(source.slice(cursor)));
    }
  }

  function buildMathSolverPreview() {
    const board=document.createElement("div");
    board.className="math-solver-board preview-math-solver";

    const solutionLabel=document.createElement("label");
    solutionLabel.className="math-answer-label";
    solutionLabel.textContent="Solution / working steps";

    const solution=document.createElement("textarea");
    solution.className="math-solution-input";
    solution.rows=4;
    solution.placeholder="Use the mathematics keyboard to show the solution.";
    solution.disabled=true;

    const finalLabel=document.createElement("label");
    finalLabel.className="math-answer-label math-final-label";
    finalLabel.textContent="Final answer";

    const finalAnswer=document.createElement("input");
    finalAnswer.className="math-final-answer-input";
    finalAnswer.placeholder="Final answer";
    finalAnswer.disabled=true;

    const preview=document.createElement("div");
    preview.className="math-solution-preview";
    preview.innerHTML='<div class="math-preview-working">Solution preview</div><div class="math-preview-final"><strong>Final answer: </strong>—</div>';

    const keyboard=document.createElement("div");
    keyboard.className="math-virtual-keyboard preview-keyboard";
    const tabs=document.createElement("div");
    tabs.className="math-keyboard-tabs";
    ["123","ABC","αβγ","ƒ()"].forEach((name,index)=>{
      const b=document.createElement("button"); b.type="button"; b.disabled=true; b.textContent=name;
      if(index===0)b.classList.add("active"); tabs.appendChild(b);
    });

    const keys=document.createElement("div");
    keys.className="math-keyboard-keys";
    ["7","8","9","÷","4","5","6","×","1","2","3","−","0",".","=","+","(",")","<",">","≤","≥",","].forEach(key=>{
      const b=document.createElement("button"); b.type="button"; b.disabled=true; b.className="math-key"; b.textContent=key; keys.appendChild(b);
    });

    const utility=document.createElement("div");
    utility.className="math-keyboard-utility";
    [["↶","Undo"],["↷","Redo"],["◀","Left"],["▶","Right"],["↵ Enter","New solution line"],["⌫","Backspace"],["Clear","Clear"],["ⓧ","Close keyboard"]].forEach(([label,title])=>{
      const b=document.createElement("button"); b.type="button"; b.disabled=true; b.className="math-utility-key"; b.textContent=label; b.title=title; utility.appendChild(b);
    });

    keyboard.append(tabs,keys,utility);
    board.append(solutionLabel,solution,finalLabel,finalAnswer,preview,keyboard);
    return board;
  }


  function buildPreviewRubric(question) {
    const details = document.createElement("details");
    details.className = "student-rubric preview-rubric";
    details.open = true;

    const summary = document.createElement("summary");
    summary.textContent = question.rubric_type === "holistic"
      ? "Holistic scoring rubric"
      : "Analytic scoring rubric";
    details.appendChild(summary);

    const wrap = document.createElement("div");
    wrap.className = "student-rubric-table-wrap";
    const table = document.createElement("table");

    if (question.rubric_type === "holistic") {
      table.innerHTML = "<thead><tr><th>Criteria (Max Score)</th><th>Description</th><th>Student Score</th></tr></thead>";
      const tbody = document.createElement("tbody");
      question.rubric_criteria.forEach(item => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${escapeHtml(item?.criterion || "")} (${escapeHtml(item?.max_points ?? 0)} pts)</td>
          <td>${escapeHtml(item?.description || "")}</td>
          <td>—</td>
        `;
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
    } else {
      const isMatrix = question.rubric_criteria.every(item =>
        Array.isArray(item?.levels) && item.levels.length >= 2
      );

      const looksLikeLegacyConvertedRubric = isMatrix &&
        question.rubric_criteria.every(item => {
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
        question.rubric_criteria.forEach(item => {
          const tr = document.createElement("tr");
          const levels = Array.isArray(item?.levels) ? item.levels : [];
          const legacyLevel = looksLikeLegacyConvertedRubric ? levels[0] : null;
          const maxPoints = legacyLevel
            ? Number(legacyLevel?.points ?? 0)
            : Number(item?.max_points ?? item?.points ?? 0);
          const description = legacyLevel
            ? String(legacyLevel?.description || "")
            : String(item?.description || "");

          tr.innerHTML = `
            <td>${escapeHtml(item?.criterion || "")} (${escapeHtml(maxPoints)} pts)</td>
            <td>${escapeHtml(description)}</td>
          `;
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
      } else {
        const levels = question.rubric_criteria[0].levels;
        const thead = document.createElement("thead");
        const hr = document.createElement("tr");
        const first = document.createElement("th");
        first.textContent = "Criteria / Level of Performance";
        hr.appendChild(first);

        levels.forEach(level => {
          const th = document.createElement("th");
          th.innerHTML = `<strong>${escapeHtml(level.level || "")}</strong><span class="rubric-level-points">${escapeHtml(level.points ?? 0)} pts</span>`;
          hr.appendChild(th);
        });

        thead.appendChild(hr);
        table.appendChild(thead);

        const tbody = document.createElement("tbody");
        question.rubric_criteria.forEach(item => {
          const tr = document.createElement("tr");
          const criterion = document.createElement("td");
          criterion.textContent = item.criterion || "";
          tr.appendChild(criterion);

          levels.forEach((headerLevel, index) => {
            const td = document.createElement("td");
            const rowLevels = Array.isArray(item.levels) ? item.levels : [];
            const match = rowLevels.find(level =>
              String(level?.level || "").toLowerCase() === String(headerLevel?.level || "").toLowerCase()
            ) || rowLevels[index];
            td.textContent = match?.description || "";
            tr.appendChild(td);
          });

          tbody.appendChild(tr);
        });

        table.appendChild(tbody);
      }
    }

    wrap.appendChild(table);
    details.appendChild(wrap);
    return details;
  }

  $("closeExamPreviewBtn")?.addEventListener("click", () => {
    $("examPreviewPanel")?.classList.add("hidden");
    const workspace = $("manageWorkspace");
    workspace?.classList.remove("preview-mode", "split-active");
    if ($("gradingReviewPanel")?.classList.contains("hidden")) {
      $("manageRightPane")?.classList.add("hidden");
    }
  });

  async function updateExamStatus(examId, status) {
    if (status === "published") {
      const { data, error } = await db.rpc("admin_publish_exam_from_draft", {
        p_exam_id: examId
      });

      if (error) {
        const missing = /admin_publish_exam_from_draft|function.*does not exist|schema cache|PGRST202/i
          .test(String(error.message || error));
        alert(
          missing
            ? "Publishing could not synchronize the latest autosaved draft. Run supabase-upgrade-publish-draft-materialization.sql once in Supabase SQL Editor, refresh the dashboard, then publish again."
            : `Could not publish examination: ${error.message}`
        );
        return;
      }

      alert(`Exam published successfully with ${data?.question_count ?? "the saved"} question(s).`);
      await loadExams();
      return;
    }

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

  function nextRetakeIdentity(exam) {
    const originalCode = String(exam?.code || "EXAM").trim().toUpperCase();
    const rootCode = originalCode.replace(/-R\d+$/i, "");
    const existingCodes = new Set((examsCache || []).map(item => String(item.code || "").toUpperCase()));

    let number = 2;
    let code = `${rootCode}-R${number}`;
    while (existingCodes.has(code)) {
      number += 1;
      code = `${rootCode}-R${number}`;
    }

    const originalTitle = String(exam?.title || "Examination").trim();
    const rootTitle = originalTitle.replace(/\s*\(Retake\s+\d+\)$/i, "");
    return {
      number,
      code,
      title: `${rootTitle} (Retake ${number})`
    };
  }

  async function toggleExamResultsRelease(exam) {
    if (!exam?.id) return;
    const release = !Boolean(exam.results_released);
    const message = release
      ? `Release scores, correct answers, and detailed results for "${exam.title}" to students?`
      : `Hide student scores and detailed results again for "${exam.title}"?`;
    if (!confirm(message)) return;

    const { error } = await db.rpc("admin_set_exam_results_released", {
      p_exam_id: exam.id,
      p_released: release
    });

    if (error) {
      alert(`Could not ${release ? "release" : "hide"} student results: ${error.message}\n\nRun supabase-upgrade-result-release-control.sql once in Supabase SQL Editor, then refresh the dashboard.`);
      return;
    }

    alert(release
      ? "Student results are now released. Students can use View Result to see their score and detailed report."
      : "Student results are hidden again.");
    await loadExams();
  }

  async function extendExamWindow(exam) {
    if (!exam?.id) return;
    if (exam.status !== "published") {
      alert("Only a published examination can have its live exam window extended.");
      return;
    }

    const currentEnd = exam.end_at ? new Date(exam.end_at) : null;
    const defaultValue = currentEnd && Number.isFinite(currentEnd.getTime())
      ? toLocalDateTimeInput(currentEnd.toISOString())
      : "";

    const entered = prompt(
      `Extend "${exam.title}" until what new closing date/time?\n\n` +
      "Use the local date/time format shown in the exam editor (for example, 2026-09-30T12:00).",
      defaultValue
    );
    if (entered === null) return;

    const newEndIso = toIsoOrNull(String(entered).trim());
    if (!newEndIso) {
      alert("Enter a valid new closing date and time.");
      return;
    }

    const newEnd = new Date(newEndIso);
    if (currentEnd && newEnd <= currentEnd) {
      alert("The new closing time must be later than the current closing time.");
      return;
    }

    const ok = confirm(
      `Extend the whole exam window to ${newEnd.toLocaleString()}?\n\n` +
      "This applies to all students. The exam duration will also be increased automatically when necessary so active students can continue until the new closing time."
    );
    if (!ok) return;

    const { data, error } = await db.rpc("admin_extend_exam_window", {
      p_exam_id: exam.id,
      p_new_end_at: newEndIso
    });

    if (error) {
      alert(`Could not extend the exam window: ${error.message}\n\nRun supabase-upgrade-extend-exam-window.sql once in Supabase SQL Editor, then refresh the dashboard.`);
      return;
    }

    const nextDuration = Number(data?.new_duration_minutes || exam.duration_minutes || 0);
    alert(
      `Exam window extended successfully.\n\nNew closing time: ${newEnd.toLocaleString()}\nNew duration: ${nextDuration} minutes.\n\nActive student timers will pick up the new deadline automatically.`
    );
    await loadExams();
    await refreshAttempts();
  }

  async function createRetakeExam(exam) {
    if (!exam?.id) return;

    const identity = nextRetakeIdentity(exam);
    const ok = confirm(
      `Create a new retake copy of "${exam.title}"?\n\n` +
      `New title: ${identity.title}\n` +
      `New code: ${identity.code}\n\n` +
      "The original exam, student takers, answers, scores, and proctoring records will NOT be changed or deleted. " +
      "The copy will be created as a Draft with no opening or closing schedule."
    );
    if (!ok) return;

    let sourceQuestions = null;

    // Draft exams may contain newer unsaved/autosaved question content in draft_payload.
    if (exam.status === "draft" && Array.isArray(exam.draft_payload?.questions)) {
      sourceQuestions = exam.draft_payload.questions.map((q, index) => ({
        position: index + 1,
        section_title: q.section_title || "Part 1",
        prompt: q.prompt || "",
        question_type: q.question_type || "mcq",
        choices: Array.isArray(q.choices) ? q.choices : (q.choices || null),
        correct_answer: q.correct_answer ?? null,
        points: Number(q.points) || 1,
        rubric_type: q.rubric_type || "analytic",
        rubric_criteria: Array.isArray(q.rubric_criteria) ? q.rubric_criteria : [],
        stimulus_type: q.stimulus_type || "none",
        stimulus_payload: q.stimulus_payload || {}
      }));
    } else {
      const { data, error } = await db
        .from("questions")
        .select("position,section_title,prompt,question_type,choices,correct_answer,points,rubric_type,rubric_criteria,stimulus_type,stimulus_payload")
        .eq("exam_id", exam.id)
        .order("position", { ascending: true });

      if (error) {
        alert(`Could not copy the exam questions: ${error.message}`);
        return;
      }
      sourceQuestions = data || [];
    }

    if (!sourceQuestions.length) {
      const continueEmpty = confirm(
        "This examination currently has no questions. Create an empty retake draft anyway?"
      );
      if (!continueEmpty) return;
    }

    const newExamRow = {
      code: identity.code,
      title: identity.title,
      owner_id: exam.owner_id || getActiveWorkspaceOwnerId(),
      duration_minutes: Number(exam.duration_minutes) || 60,
      status: "draft",
      start_at: null,
      end_at: null,
      archived: false,
      archived_at: null
    };

    const { data: createdRows, error: createError } = await db
      .from("exams")
      .insert([newExamRow])
      .select("id,code,title,owner_id")
      .limit(1);

    if (createError) {
      const raw = String(createError.message || "");
      alert(
        /duplicate key|unique.*code/i.test(raw)
          ? "That retake code already exists. Refresh Manage Exams and try again so a new retake number can be generated."
          : `Could not create the retake exam: ${raw}`
      );
      return;
    }

    const created = createdRows?.[0];
    if (!created?.id) {
      alert("The retake exam could not be created.");
      return;
    }

    if (sourceQuestions.length) {
      const copiedQuestions = sourceQuestions.map((q, index) => ({
        exam_id: created.id,
        position: index + 1,
        section_title: q.section_title || "Part 1",
        prompt: q.prompt || "",
        question_type: q.question_type || "mcq",
        choices: q.choices ?? null,
        correct_answer: q.correct_answer ?? null,
        points: Number(q.points) || 1,
        rubric_type: q.rubric_type || "analytic",
        rubric_criteria: q.rubric_criteria || [],
        stimulus_type: q.stimulus_type || "none",
        stimulus_payload: q.stimulus_payload || {}
      }));

      const { error: questionError } = await db
        .from("questions")
        .insert(copiedQuestions);

      if (questionError) {
        // Do not silently leave a broken partial copy.
        await db.from("exams").delete().eq("id", created.id);
        alert(`The retake exam could not copy its questions, so the partial copy was removed.\n\n${questionError.message}`);
        return;
      }
    }

    await loadExams();

    const createdExam = examsCache.find(item => item.id === created.id);
    alert(
      `Retake exam created successfully.\n\n` +
      `Title: ${identity.title}\n` +
      `Code: ${identity.code}\n\n` +
      "It is saved as a Draft. The original exam and all previous student results remain unchanged."
    );

    if (createdExam) {
      await editExam(createdExam);
    }
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
    // Safety fallback for older cached dashboard builds:
    // "Delete" now performs a recoverable soft delete by archiving the exam.
    const ok = confirm(
      `Move "${exam.title}" to Trash?\n\nThe exam, questions, student attempts, responses, scores, AI feedback, and proctoring records will all be kept. You can restore it later.`
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
      alert(`Could not move exam to Trash: ${error.message}`);
      return;
    }

    alert("Exam moved to Trash. No student data was deleted.");
    await loadExams();
  }

  async function permitEditingAfterSubmission() {
    const a = currentDetailAttempt;
    if (!a || a.status !== "submitted") return;

    const studentName = a.students?.full_name || "this student";
    const entered = prompt(
      `How many minutes should ${studentName} be allowed to edit the submitted attempt?`,
      "30"
    );
    if (entered === null) return;

    const minutes = Number.parseInt(String(entered).trim(), 10);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 240) {
      alert("Enter a number from 1 to 240 minutes.");
      return;
    }

    const ok = confirm(
      `Permit ${studentName} to edit the submitted exam for ${minutes} minute${minutes === 1 ? "" : "s"}?\n\n` +
      "Their existing submitted answers will be preserved and loaded back. Individually submitted essays will be unlocked. The student must submit the exam again when finished."
    );
    if (!ok) return;

    const button = $("permitEditAttemptBtn");
    if (button) {
      button.disabled = true;
      button.textContent = "Granting permission…";
    }

    const { data, error } = await db.rpc("admin_permit_submitted_attempt_edit", {
      p_attempt_id: a.id,
      p_minutes: minutes
    });

    if (button) {
      button.disabled = false;
      button.textContent = "Permit Editing After Submission";
    }

    if (error) {
      alert(`Could not grant editing permission: ${error.message}\n\nRun supabase-upgrade-edit-after-submission.sql once in Supabase SQL Editor, then refresh the dashboard.`);
      return;
    }

    const until = data?.permitted_until ? new Date(data.permitted_until) : null;
    alert(
      `${studentName} may now edit the submitted attempt${until ? ` until ${until.toLocaleString()}` : ""}.\n\n` +
      "Ask the student to enter the same Exam Code and Student ID. Their previous answers will load for editing, and they must submit again when finished."
    );

    closeAttemptDrawer();
    await refreshAttempts();
  }

  function waitForTeacherIceGathering(pc, timeoutMs = 8000) {
    if (!pc || pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise(resolve => {
      const done = () => {
        pc.removeEventListener("icegatheringstatechange", check);
        clearTimeout(timer);
        resolve();
      };
      const check = () => { if (pc.iceGatheringState === "complete") done(); };
      const timer = setTimeout(done, timeoutMs);
      pc.addEventListener("icegatheringstatechange", check);
    });
  }

  function setTeacherLiveCameraStatus(message) {
    const node = $("teacherLiveCameraStatus");
    if (node) node.textContent = message;
  }

  function stopTeacherLiveCameraLocal() {
    clearInterval(teacherLivePollHandle);
    teacherLivePollHandle = null;
    try { teacherLivePeer?.close(); } catch (_) {}
    teacherLivePeer = null;
    const video = $("teacherLiveCameraVideo");
    if (video) video.srcObject = null;
    $("teacherLiveCameraPlaceholder")?.classList.remove("hidden");
  }

  async function endTeacherLiveCamera({ notifyServer = true } = {}) {
    const sessionId = teacherLiveSessionId;
    teacherLiveSessionId = null;
    stopTeacherLiveCameraLocal();
    $("teacherLiveCameraModal")?.classList.add("hidden");
    if (notifyServer && sessionId) {
      await db.rpc("admin_end_live_camera", { p_session_id: sessionId });
    }
  }

  async function pollTeacherLiveCameraSession() {
    if (!teacherLiveSessionId || !teacherLivePeer) return;
    const { data, error } = await db.rpc("admin_get_live_camera_session", {
      p_session_id: teacherLiveSessionId
    });
    if (error || !data) return;

    const status = String(data.status || "");
    if (status === "requested") {
      setTeacherLiveCameraStatus("Request sent. Waiting for the student page to receive and accept it…");
    } else if (status === "accepted" && data.answer_sdp && !teacherLivePeer.currentRemoteDescription) {
      try {
        await teacherLivePeer.setRemoteDescription({ type:"answer", sdp:data.answer_sdp });
        setTeacherLiveCameraStatus("Student accepted. Establishing the live video connection…");
      } catch (error) {
        setTeacherLiveCameraStatus(`Student accepted, but WebRTC setup failed: ${error?.message || error}`);
      }
    } else if (status === "accepted" && teacherLivePeer.currentRemoteDescription) {
      if (teacherLivePeer.connectionState !== "connected") {
        setTeacherLiveCameraStatus("Student accepted. Waiting for the peer-to-peer video connection…");
      }
    } else if (status === "declined") {
      setTeacherLiveCameraStatus("Student declined the live camera request.");
      setTimeout(() => endTeacherLiveCamera({ notifyServer:false }), 1800);
    } else if (status === "expired") {
      setTeacherLiveCameraStatus("Live camera request expired.");
      setTimeout(() => endTeacherLiveCamera({ notifyServer:false }), 1800);
    } else if (status === "ended") {
      setTeacherLiveCameraStatus("Live camera session ended.");
      setTimeout(() => endTeacherLiveCamera({ notifyServer:false }), 1200);
    }
  }

  function groupLiveCardId(attemptId) {
    return "group-live-card-" + attemptId;
  }

  function renderGroupLiveCard(attempt) {
    const grid = $("groupLiveProctorGrid");
    if (!grid || !attempt?.id) return null;
    let card = document.getElementById(groupLiveCardId(attempt.id));
    if (card) return card;
    card = document.createElement("article");
    card.id = groupLiveCardId(attempt.id);
    card.className = "group-live-student-card";
    card.dataset.attemptId = attempt.id;
    const studentName = escapeHtml(attempt.students?.full_name || "Student");
    const studentNo = escapeHtml(attempt.students?.student_no || "");
    card.innerHTML = '<div class="group-live-student-head"><div><strong>' + studentName + '</strong><span>' + studentNo + '</span></div><span class="badge warn group-live-status">Requesting…</span></div>' +
      '<div class="group-live-video-stage"><video autoplay playsinline></video><div class="group-live-video-placeholder">Waiting for student to allow live camera…</div></div>' +
      '<div class="group-live-student-message"><textarea rows="2" maxlength="300" placeholder="Message this student…"></textarea><button type="button" class="primary group-live-send-student">Send</button></div>' +
      '<span class="message-inline group-live-student-message-status" role="status"></span>';
    const sendBtn = card.querySelector(".group-live-send-student");
    const input = card.querySelector("textarea");
    sendBtn?.addEventListener("click", () => sendGroupLiveStudentMessage(attempt.id));
    input?.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendGroupLiveStudentMessage(attempt.id); }
    });
    grid.appendChild(card);
    return card;
  }

  function setGroupLiveCardStatus(attemptId, text, tone = "warn") {
    const badge = document.getElementById(groupLiveCardId(attemptId))?.querySelector(".group-live-status");
    if (!badge) return;
    badge.className = "badge " + tone + " group-live-status";
    badge.textContent = text;
  }

  async function pollGroupLiveSession(attemptId) {
    const entry = groupLivePeers.get(attemptId);
    if (!entry?.sessionId || !entry.pc) return;
    const { data, error } = await db.rpc("admin_get_live_camera_session", { p_session_id: entry.sessionId });
    if (error || !data) { setGroupLiveCardStatus(attemptId, "Request error", "warn"); return; }
    const status = String(data.status || "");
    if (status === "requested") { setGroupLiveCardStatus(attemptId, "Waiting for student", "warn"); return; }
    if (status === "accepted" && data.answer_sdp && !entry.pc.currentRemoteDescription) {
      try { await entry.pc.setRemoteDescription({ type:"answer", sdp:data.answer_sdp }); setGroupLiveCardStatus(attemptId, "Connecting…", "warn"); }
      catch (error) { console.warn("Group live remote description failed:", error); setGroupLiveCardStatus(attemptId, "Connection failed", "warn"); }
      return;
    }
    if (status === "accepted" && entry.pc.currentRemoteDescription && entry.pc.connectionState !== "connected") { setGroupLiveCardStatus(attemptId, "Connecting…", "warn"); return; }
    if (status === "connected") { setGroupLiveCardStatus(attemptId, "Live", "ok"); return; }
    if (["declined","expired","ended","failed"].includes(status)) {
      clearInterval(entry.pollHandle); entry.pollHandle = null;
      setGroupLiveCardStatus(attemptId, status === "declined" ? "Declined" : status === "expired" ? "Expired" : "Ended", status === "declined" ? "warn" : "");
      document.getElementById(groupLiveCardId(attemptId))?.querySelector(".group-live-video-placeholder")?.classList.remove("hidden");
    }
  }

  async function startGroupLiveStudent(attempt) {
    if (!attempt?.id || attempt.status !== "active") return;
    const existing = groupLivePeers.get(attempt.id);
    if (existing?.pc && ["connecting","connected"].includes(existing.pc.connectionState)) return;
    if (existing?.sessionId) {
      clearInterval(existing.pollHandle); try { existing.pc?.close(); } catch (_) {}
      try { await db.rpc("admin_end_live_camera", { p_session_id: existing.sessionId }); } catch (_) {}
      groupLivePeers.delete(attempt.id);
    }
    const card = renderGroupLiveCard(attempt);
    const video = card?.querySelector("video");
    const placeholder = card?.querySelector(".group-live-video-placeholder");
    setGroupLiveCardStatus(attempt.id, "Preparing…", "warn");
    try {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
      const entry = { attempt, pc, sessionId:null, pollHandle:null };
      groupLivePeers.set(attempt.id, entry);
      pc.addTransceiver("video", { direction:"recvonly" });
      pc.addEventListener("track", event => {
        const stream = event.streams?.[0] || new MediaStream([event.track]);
        if (video) { video.srcObject = stream; video.play().catch(()=>{}); }
        placeholder?.classList.add("hidden");
        setGroupLiveCardStatus(attempt.id, "Live", "ok");
        if (entry.sessionId) db.rpc("admin_mark_live_camera_connected", { p_session_id: entry.sessionId }).catch(()=>{});
      });
      pc.addEventListener("connectionstatechange", () => {
        if (pc.connectionState === "connected") setGroupLiveCardStatus(attempt.id, "Live", "ok");
        else if (pc.connectionState === "failed") setGroupLiveCardStatus(attempt.id, "Connection failed", "warn");
        else if (pc.connectionState === "disconnected") setGroupLiveCardStatus(attempt.id, "Disconnected", "warn");
      });
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForTeacherIceGathering(pc);
      const { data, error } = await db.rpc("admin_request_live_camera", { p_attempt_id: attempt.id, p_offer_sdp: pc.localDescription?.sdp || offer.sdp });
      if (error) throw error;
      entry.sessionId = data?.id || null;
      if (!entry.sessionId) throw new Error("Live camera request did not return a session ID.");
      setGroupLiveCardStatus(attempt.id, "Waiting for student", "warn");
      entry.pollHandle = setInterval(() => pollGroupLiveSession(attempt.id).catch(()=>{}), 1800);
      await pollGroupLiveSession(attempt.id);
    } catch (error) {
      console.warn("Group live camera request failed:", error);
      setGroupLiveCardStatus(attempt.id, "Request failed", "warn");
      const status = card?.querySelector(".group-live-student-message-status");
      if (status) { status.textContent = String(error?.message || error); status.classList.add("error"); }
    }
  }

  async function openGroupLiveProctor(group, button = null) {
    const activeAttempts = (group?.attempts || []).filter(a => a.status === "active");
    if (!activeAttempts.length) { alert("There are no active students in this examination."); return; }
    await closeGroupLiveProctor({ notifyServer:true });
    groupLiveExam = { id:group.key, title:group.title, code:group.code, attempts:activeAttempts };
    const panel = $("groupLiveProctorPanel");
    const grid = $("groupLiveProctorGrid");
    const meta = $("groupLiveProctorMeta");
    const title = $("groupLiveProctorTitle");
    if (title) title.textContent = group.title || "Live Proctoring";
    if (meta) meta.textContent = activeAttempts.length + " active student" + (activeAttempts.length === 1 ? "" : "s") + " • " + (group.code || "");
    if (grid) grid.innerHTML = "";
    if ($("groupBroadcastMessage")) $("groupBroadcastMessage").value = "";
    if ($("groupBroadcastStatus")) { $("groupBroadcastStatus").textContent = ""; $("groupBroadcastStatus").classList.remove("error","success"); }
    panel?.classList.remove("hidden");
    activeAttempts.forEach(renderGroupLiveCard);
    const originalText = button?.textContent || "";
    if (button) { button.disabled = true; button.textContent = "Requesting…"; }
    const batchSize = 4;
    for (let i = 0; i < activeAttempts.length; i += batchSize) {
      await Promise.allSettled(activeAttempts.slice(i, i + batchSize).map(startGroupLiveStudent));
    }
    if (button) { button.disabled = false; button.textContent = originalText || "Live Proctor"; }
  }

  async function refreshGroupLiveRequests() {
    if (!groupLiveExam) return;
    const btn = $("refreshGroupLiveBtn");
    if (btn) { btn.disabled = true; btn.textContent = "Refreshing…"; }
    try {
      const activeNow = attemptsCache.filter(a => a.status === "active" && String(a.exams?.id || "") === String(groupLiveExam.id));
      groupLiveExam.attempts = activeNow;
      const activeIds = new Set(activeNow.map(a => a.id));
      for (const [attemptId, entry] of Array.from(groupLivePeers.entries())) {
        if (!activeIds.has(attemptId)) {
          clearInterval(entry.pollHandle); try { entry.pc?.close(); } catch (_) {}
          if (entry.sessionId) db.rpc("admin_end_live_camera", { p_session_id: entry.sessionId }).catch(()=>{});
          groupLivePeers.delete(attemptId); document.getElementById(groupLiveCardId(attemptId))?.remove();
        }
      }
      for (const attempt of activeNow) {
        renderGroupLiveCard(attempt);
        const entry = groupLivePeers.get(attempt.id);
        if (!entry || ["failed","closed","disconnected"].includes(entry.pc?.connectionState || "")) await startGroupLiveStudent(attempt);
      }
      if ($("groupLiveProctorMeta")) $("groupLiveProctorMeta").textContent = activeNow.length + " active student" + (activeNow.length === 1 ? "" : "s") + " • " + (groupLiveExam.code || "");
    } finally { if (btn) { btn.disabled = false; btn.textContent = "Refresh Requests"; } }
  }

  async function closeGroupLiveProctor({ notifyServer = true } = {}) {
    if (groupLiveClosing) return;
    groupLiveClosing = true;
    try {
      const jobs = [];
      for (const entry of groupLivePeers.values()) {
        clearInterval(entry.pollHandle); try { entry.pc?.close(); } catch (_) {}
        if (notifyServer && entry.sessionId) jobs.push(db.rpc("admin_end_live_camera", { p_session_id: entry.sessionId }).catch(()=>{}));
      }
      groupLivePeers.clear();
      if (jobs.length) await Promise.allSettled(jobs);
    } finally {
      groupLiveExam = null; $("groupLiveProctorPanel")?.classList.add("hidden");
      if ($("groupLiveProctorGrid")) $("groupLiveProctorGrid").innerHTML = "";
      groupLiveClosing = false;
    }
  }

  async function sendGroupLiveStudentMessage(attemptId) {
    const entry = groupLivePeers.get(attemptId);
    const attempt = entry?.attempt || groupLiveExam?.attempts?.find(a => a.id === attemptId);
    const card = document.getElementById(groupLiveCardId(attemptId));
    const input = card?.querySelector("textarea");
    const button = card?.querySelector(".group-live-send-student");
    const status = card?.querySelector(".group-live-student-message-status");
    if (!attempt || !input || !button || !status) return;
    const message = input.value.trim();
    if (!message) { status.textContent = "Enter a message first."; status.classList.add("error"); return; }
    button.disabled = true; status.classList.remove("error","success"); status.textContent = "Sending…";
    const { error } = await db.rpc("admin_send_attempt_message", { p_attempt_id:attempt.id, p_message:message });
    button.disabled = false;
    if (error) { status.textContent = error.message; status.classList.add("error"); return; }
    input.value = ""; status.textContent = "Message sent."; status.classList.add("success");
    setTimeout(() => { if (status.textContent === "Message sent.") { status.textContent = ""; status.classList.remove("success"); } }, 2500);
  }

  async function sendGroupBroadcastMessage() {
    if (!groupLiveExam) return;
    const input = $("groupBroadcastMessage"); const button = $("sendGroupBroadcastBtn"); const status = $("groupBroadcastStatus");
    if (!input || !button || !status) return;
    const message = input.value.trim();
    if (!message) { status.textContent = "Enter a message first."; status.classList.add("error"); return; }
    const activeAttempts = (groupLiveExam.attempts || []).filter(a => a.status === "active");
    if (!activeAttempts.length) { status.textContent = "No active students are available."; status.classList.add("error"); return; }
    button.disabled = true; status.classList.remove("error","success"); status.textContent = "Sending to " + activeAttempts.length + " students…";
    const results = await Promise.allSettled(activeAttempts.map(a => db.rpc("admin_send_attempt_message", { p_attempt_id:a.id, p_message:message })));
    let sent = 0, failed = 0;
    for (const result of results) { if (result.status === "fulfilled" && !result.value?.error) sent += 1; else failed += 1; }
    button.disabled = false; if (sent) input.value = "";
    status.textContent = failed ? ("Sent to " + sent + "; " + failed + " failed.") : ("Message sent to all " + sent + " active students.");
    status.classList.add(failed ? "error" : "success");
  }

  async function requestTeacherLiveCamera() {
    const attempt = currentDetailAttempt;
    if (!attempt || attempt.status !== "active") {
      alert("Live camera can only be requested for an active attempt.");
      return;
    }

    await endTeacherLiveCamera({ notifyServer:true });

    const modal = $("teacherLiveCameraModal");
    const video = $("teacherLiveCameraVideo");
    const placeholder = $("teacherLiveCameraPlaceholder");
    modal?.classList.remove("hidden");
    placeholder?.classList.remove("hidden");
    const liveMessageInput = $("teacherLiveMessageInput");
    const liveMessageStatus = $("teacherLiveMessageStatus");
    if (liveMessageInput) liveMessageInput.value = "";
    if (liveMessageStatus) {
      liveMessageStatus.textContent = "";
      liveMessageStatus.classList.remove("error","success");
    }
    setTeacherLiveCameraStatus("Preparing secure peer-to-peer request…");

    try {
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
      });
      teacherLivePeer = pc;

      pc.addTransceiver("video", { direction:"recvonly" });
      pc.addEventListener("track", event => {
        const stream = event.streams?.[0] || new MediaStream([event.track]);
        if (video) {
          video.srcObject = stream;
          video.play().catch(()=>{});
        }
        placeholder?.classList.add("hidden");
        setTeacherLiveCameraStatus("Live camera connected.");
        if (teacherLiveSessionId) {
          db.rpc("admin_mark_live_camera_connected", { p_session_id: teacherLiveSessionId }).catch(()=>{});
        }
      });
      pc.addEventListener("connectionstatechange", () => {
        if (pc.connectionState === "failed") setTeacherLiveCameraStatus("Live connection failed. Try requesting again.");
        if (pc.connectionState === "disconnected") setTeacherLiveCameraStatus("Live connection interrupted.");
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForTeacherIceGathering(pc);

      const { data, error } = await db.rpc("admin_request_live_camera", {
        p_attempt_id: attempt.id,
        p_offer_sdp: pc.localDescription?.sdp || offer.sdp
      });
      if (error) throw error;

      teacherLiveSessionId = data?.id || null;
      if (!teacherLiveSessionId) throw new Error("Live camera session could not be created.");

      setTeacherLiveCameraStatus("Waiting for the student to allow live camera viewing…");
      teacherLivePollHandle = setInterval(() => pollTeacherLiveCameraSession().catch(()=>{}), 1200);
      pollTeacherLiveCameraSession().catch(()=>{});
    } catch (error) {
      stopTeacherLiveCameraLocal();
      setTeacherLiveCameraStatus(`Could not start live camera request: ${error?.message || error}`);
    }
  }

  async function reopenCurrentAttempt() {
    const a = currentDetailAttempt;
    if (!a || a.status !== "submitted") return;

    const studentName = a.students?.full_name || "this student";
    const ok = confirm(
      `Reopen the submitted attempt for ${studentName}?\n\nThe submitted score and submission time will be cleared, but the student's saved answers will be kept. The student can enter the same Exam Code and Student ID again and continue with the original remaining time.`
    );
    if (!ok) return;

    const btn = $("reopenAttemptBtn");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Reopening…";
    }

    const { data, error } = await db.rpc("admin_reopen_attempt", {
      p_attempt_id: a.id
    });

    if (btn) {
      btn.disabled = false;
      btn.textContent = "Reopen & Continue";
    }

    if (error) {
      alert(`Could not reopen attempt: ${error.message}\n\nRun supabase-upgrade-attempt-recovery.sql in Supabase SQL Editor, then refresh the dashboard.`);
      return;
    }

    if (data !== true) {
      alert("The attempt was not reopened. It may no longer be submitted.");
      return;
    }

    alert(`${studentName}'s attempt is open again. Their saved answers were kept.`);
    closeAttemptDrawer();
    await refreshAttempts();
  }

  async function extendCurrentAttemptTime(minutes) {
    const attempt = currentDetailAttempt;
    if (!attempt || attempt.status !== "active") {
      alert("Time can only be added to an active exam attempt.");
      return;
    }

    const amount = Number(minutes);
    if (!Number.isInteger(amount) || amount < 1 || amount > 240) {
      alert("Enter a whole number of minutes between 1 and 240.");
      return;
    }

    const studentName = attempt.students?.full_name || "this student";
    const ok = confirm(
      `Add ${amount} minute${amount === 1 ? "" : "s"} to ${studentName}'s current exam attempt?\n\n` +
      "Only this student's deadline will change. Their answers, score, session, and other students are unaffected."
    );
    if (!ok) return;

    const buttons = [
      $("add30MinBtn"),
      $("add60MinBtn"),
      $("addCustomTimeBtn")
    ].filter(Boolean);

    buttons.forEach(btn => btn.disabled = true);

    const { data, error } = await db.rpc("admin_extend_attempt_time", {
      p_attempt_id: attempt.id,
      p_minutes: amount
    });

    buttons.forEach(btn => btn.disabled = false);

    if (error) {
      alert(
        `Could not add time: ${error.message}\n\nRun supabase-upgrade-attempt-time-extension.sql once in Supabase SQL Editor, then refresh the dashboard.`
      );
      return;
    }

    const row = Array.isArray(data) ? data[0] : null;
    const newEnd = row?.ends_at ? new Date(row.ends_at) : null;

    alert(
      `${amount} minute${amount === 1 ? "" : "s"} added for ${studentName}.` +
      (newEnd && !Number.isNaN(newEnd.getTime())
        ? `\n\nNew deadline: ${newEnd.toLocaleString()}`
        : "") +
      "\n\nThe student's timer will update automatically within about 10 seconds."
    );

    await refreshAttempts();

    // Keep the drawer open on the same student's refreshed attempt if possible.
    const refreshed = attemptsCache.find(item => item.id === attempt.id);
    if (refreshed) currentDetailAttempt = refreshed;
  }

  async function unlockCurrentAttemptSession() {
    const attempt = currentDetailAttempt;
    if (!attempt || attempt.status !== "active") return;

    const studentName = attempt.students?.full_name || "this student";
    const studentNo = attempt.students?.student_no || "";

    const ok = confirm(
      `Unlock the active browser session for ${studentName}${studentNo ? ` (${studentNo})` : ""}?\n\nThis does not delete answers, score, timer, or the attempt. It only releases the browser/device lock. The next browser session that enters this same Exam Code and Student ID will claim the active attempt.`
    );
    if (!ok) return;

    const button = $("unlockSessionBtn");
    if (button) {
      button.disabled = true;
      button.textContent = "Unlocking…";
    }

    const { data, error } = await db.rpc("admin_unlock_attempt_session", {
      p_attempt_id: attempt.id
    });

    if (error) {
      if (button) {
        button.disabled = false;
        button.textContent = "Unlock Active Session";
      }
      alert(`Could not unlock the active session: ${error.message}\n\nRun supabase-upgrade-active-session-lock.sql in Supabase SQL Editor, then refresh the dashboard.`);
      return;
    }

    if (data !== true) {
      alert("No active session lock was released. The attempt may no longer be active or may already be unlocked.");
    } else {
      attempt.active_session_id = null;
      attempt.session_locked_at = null;
      alert("Active session unlocked. The student's saved answers and remaining exam time were preserved.");
    }

    if (button) {
      button.disabled = true;
      button.textContent = "Session Already Unlocked";
    }

    await refreshAttempts();
  }

  async function resetCurrentAttempt() {
    const a = currentDetailAttempt;
    if (!a) return;

    const studentName = a.students?.full_name || "this student";
    const studentNo = a.students?.student_no || "";
    const ok = confirm(
      `RESET the exam attempt for ${studentName}${studentNo ? ` (${studentNo})` : ""}?\n\nThis permanently removes the score, saved responses, AI feedback, proctoring events, and attempt record. The student will start a completely new attempt. This cannot be undone.`
    );
    if (!ok) return;

    const btn = $("resetAttemptBtn");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Resetting…";
    }

    const { data, error } = await db.rpc("admin_reset_attempt", {
      p_attempt_id: a.id
    });

    if (btn) {
      btn.disabled = false;
      btn.textContent = "Reset for Retake";
    }

    if (error) {
      alert(`Could not reset attempt: ${error.message}\n\nRun supabase-upgrade-attempt-recovery.sql in Supabase SQL Editor, then refresh the dashboard.`);
      return;
    }

    if (data !== true) {
      alert("No attempt was reset. It may already have been removed.");
      return;
    }

    alert(`${studentName}'s attempt was reset. They can now take the examination again from the beginning.`);
    closeAttemptDrawer();
    await refreshAttempts();
  }

  function closeAttemptDrawer() {
    const panel = $("detailPanel");
    if (!panel || panel.classList.contains("hidden")) return;
    panel.classList.remove("open");
    setTimeout(() => panel.classList.add("hidden"), 180);
  }

  $("saveSelectedEvidenceBtn")?.addEventListener("click", () => setSelectedPhotoEvidence(true));
  $("releaseSelectedEvidenceBtn")?.addEventListener("click", () => setSelectedPhotoEvidence(false));
  $("saveSelectedSpeechEvidenceBtn")?.addEventListener("click", () => setSelectedSpeechEvidence(true));
  $("releaseSelectedSpeechEvidenceBtn")?.addEventListener("click", () => setSelectedSpeechEvidence(false));

  $("assignProctorBtn")?.addEventListener("click", assignSelectedProctor);
  $("reloadProctorsBtn")?.addEventListener("click", loadProctorManagement);

  $("searchBox").addEventListener("input", renderAttempts);
  $("sendAttemptMessageBtn")?.addEventListener("click", sendCurrentAttemptMessage);
  $("restoreSavedResponsesBtn")?.addEventListener("click", restoreSavedResponsesToStudent);
  $("remoteSubmitSavedBtn")?.addEventListener("click", remoteSubmitSavedResponsesForStudent);
  $("viewRecoverySnapshotBtn")?.addEventListener("click", showCurrentRecoverySnapshot);
  $("teacherMessageSection")?.addEventListener("click", applyAttemptMessagePreset);

  $("refreshBtn").addEventListener("click", refreshAttempts);
  $("requestLiveCameraBtn")?.addEventListener("click", requestTeacherLiveCamera);
  $("closeTeacherLiveCameraBtn")?.addEventListener("click", () => endTeacherLiveCamera({ notifyServer:true }));
  $("closeGroupLiveProctorBtn")?.addEventListener("click", () => closeGroupLiveProctor({ notifyServer:true }));
  $("refreshGroupLiveBtn")?.addEventListener("click", refreshGroupLiveRequests);
  $("sendGroupBroadcastBtn")?.addEventListener("click", sendGroupBroadcastMessage);
  $("groupBroadcastMessage")?.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendGroupBroadcastMessage();
    }
  });
  $("sendTeacherLiveMessageBtn")?.addEventListener("click", sendTeacherLiveCameraMessage);
  $("teacherLiveMessageInput")?.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendTeacherLiveCameraMessage();
    }
  });
  $("reopenAttemptBtn")?.addEventListener("click", reopenCurrentAttempt);
  $("permitEditAttemptBtn")?.addEventListener("click", permitEditingAfterSubmission);
  $("unlockSessionBtn")?.addEventListener("click", unlockCurrentAttemptSession);
  $("add30MinBtn")?.addEventListener("click", () => extendCurrentAttemptTime(30));
  $("add60MinBtn")?.addEventListener("click", () => extendCurrentAttemptTime(60));
  $("addCustomTimeBtn")?.addEventListener("click", () => {
    const raw = prompt("How many minutes would you like to add?\n\nEnter 1 to 240 minutes.", "30");
    if (raw === null) return;
    const minutes = Number(String(raw).trim());
    extendCurrentAttemptTime(minutes);
  });
  $("resetAttemptBtn")?.addEventListener("click", resetCurrentAttempt);
  $("closeDetail").addEventListener("click", closeAttemptDrawer);
  $("signOutBtn").addEventListener("click", async () => {
    clearInterval(pollHandle);
    await closeGroupLiveProctor({ notifyServer:true });
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
    getWorkspaceOwnerId: getActiveWorkspaceOwnerId,
    isProctorForExam
  };

  // Public hooks used by the Excel importer. This reuses the same validated
  // question-builder UI instead of maintaining a second import-only format.
  window.ExamBuilder = {
    replaceQuestions(questionList) {
      $("questionBuilder").innerHTML = "";
      questionCounter = 0;
      let lastSection = "Part 1";
      (questionList || []).forEach((q, index) => {
        const section = q.section_title || "Part 1";
        if (index > 0 && section !== lastSection) {
          const divider = document.createElement("section");
          divider.className = "exam-part-divider";
          divider.innerHTML = `<div><span class="muted">Exam Section</span><input class="exam-part-title" value="${escapeAttr(section)}"></div><button type="button" class="remove-part-btn">Remove Section</button>`;
          $("questionBuilder").appendChild(divider);
          divider.querySelector(".remove-part-btn").addEventListener("click", () => divider.remove());
        }
        addQuestionCard({ ...q, section_title: section });
        lastSection = section;
      });
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
