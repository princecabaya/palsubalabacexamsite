(() => {
  const db = window.ExamAdmin?.db;
  const $ = (id) => document.getElementById(id);
  if (!db || !$("studentsSection")) return;

  let students = [];
  let attemptsByStudent = new Map();
  let totalAttempts = 0;
  let bound = false;
  let loading = false;

  function bind() {
    if (bound) return;
    bound = true;

    $("enrollStudentBtn")?.addEventListener("click", enrollManual);
    $("reloadStudentsBtn")?.addEventListener("click", loadStudents);
    $("studentSearchBox")?.addEventListener("input", renderStudents);
    $("studentStatusFilter")?.addEventListener("change", renderStudents);
    $("importStudentsBtn")?.addEventListener("click", importStudentsExcel);
    $("downloadStudentTemplateBtn")?.addEventListener("click", downloadStudentTemplate);
  }

  async function loadStudents() {
    bind();
    if (loading) return;
    loading = true;
    setListStatus("Loading students…");

    const { data: sessionData } = await db.auth.getSession();
    if (!sessionData?.session?.user?.id) {
      loading = false;
      setListStatus("Teacher session not found. Please sign out and sign in again.", true);
      renderLoadError("Teacher session not found. Please sign out and sign in again.");
      return;
    }

    const { data: adminRows, error: adminError } = await db
      .from("exam_admins")
      .select("is_admin")
      .eq("user_id", sessionData.session.user.id)
      .limit(1);

    if (adminError || !adminRows?.[0]?.is_admin) {
      loading = false;
      const message = adminError
        ? `Administrator check failed: ${adminError.message}`
        : "This signed-in teacher account is not marked as an exam administrator.";
      setListStatus(message, true);
      renderLoadError(message);
      return;
    }

    const { data: studentRows, error: studentError } = await db
      .from("students")
      .select("id,student_no,full_name,active,created_at")
      .order("full_name", { ascending: true })
      .limit(5000);

    if (studentError) {
      loading = false;
      const message = `Could not load students: ${studentError.message}`;
      setListStatus(message, true);
      renderLoadError(message);
      return;
    }

    students = studentRows || [];

    const allAttempts = [];
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await db
        .from("attempts")
        .select("id,student_id,status,score,max_score,started_at,submitted_at,exams(title,code,owner_id)")
        .order("started_at", { ascending: false })
        .range(from, from + pageSize - 1);

      if (error) {
        setListStatus(`Students loaded, but exam history failed: ${error.message}`, true);
        break;
      }

      const page = data || [];
      const workspaceOwnerId = window.ExamAdmin?.getWorkspaceOwnerId?.();
      allAttempts.push(...page.filter(a =>
        !workspaceOwnerId || a.exams?.owner_id === workspaceOwnerId
      ));
      if (page.length < pageSize) break;
    }

    attemptsByStudent = new Map();
    for (const attempt of allAttempts) {
      if (!attemptsByStudent.has(attempt.student_id)) attemptsByStudent.set(attempt.student_id, []);
      attemptsByStudent.get(attempt.student_id).push(attempt);
    }
    totalAttempts = allAttempts.length;

    updateSummary();
    renderStudents();

    if (!students.length) {
      setListStatus("No student rows were returned from Supabase. Check the students table and administrator RLS policy.", true);
      renderLoadError("No student rows were returned from Supabase.");
    } else {
      setListStatus(`${students.length} student${students.length === 1 ? "" : "s"} loaded.`);
    }
    loading = false;
  }

  function renderLoadError(message) {
    const body = $("studentRosterRows");
    if (body) {
      body.innerHTML = `<tr><td colspan="7" class="student-load-error">${escapeHtml(message)}</td></tr>`;
    }
  }

  function updateSummary() {
    $("studentTotalCount").textContent = String(students.length);
    $("studentActiveCount").textContent = String(students.filter(s => s.active).length);
    $("studentInactiveCount").textContent = String(students.filter(s => !s.active).length);
    $("studentAttemptCount").textContent = String(totalAttempts);
  }

  function renderStudents() {
    const body = $("studentRosterRows");
    if (!body) return;

    const query = $("studentSearchBox")?.value?.trim().toLowerCase() || "";
    const filter = $("studentStatusFilter")?.value || "all";

    const filtered = students.filter(student => {
      if (filter === "active" && !student.active) return false;
      if (filter === "inactive" && student.active) return false;

      const history = attemptsByStudent.get(student.id) || [];
      const examText = history
        .map(a => `${a.exams?.title || ""} ${a.exams?.code || ""}`)
        .join(" ");

      const haystack = `${student.student_no} ${student.full_name} ${examText}`.toLowerCase();
      return !query || haystack.includes(query);
    });

    body.innerHTML = "";

    if (!filtered.length) {
      body.innerHTML = '<tr><td colspan="7">No students match this filter.</td></tr>';
      return;
    }

    for (const student of filtered) {
      const history = attemptsByStudent.get(student.id) || [];
      const last = history[0] || null;
      const tr = document.createElement("tr");
      if (!student.active) tr.classList.add("unenrolled-row");

      const recordsHtml = history.length
        ? history.slice(0, 5).map(formatAttemptRecord).join("") +
          (history.length > 5 ? `<div class="muted small-text">+${history.length - 5} more exam record${history.length - 5 === 1 ? "" : "s"}</div>` : "")
        : '<span class="muted">No exams yet</span>';

      tr.innerHTML = `
        <td><strong>${escapeHtml(student.student_no)}</strong></td>
        <td>${escapeHtml(student.full_name)}</td>
        <td><span class="badge ${student.active ? "ok" : "archived"}">${student.active ? "Enrolled" : "Unenrolled"}</span></td>
        <td><strong>${history.length}</strong></td>
        <td class="student-exam-records">${recordsHtml}</td>
        <td>${last ? `${escapeHtml(last.exams?.title || "Exam")}<br><span class="muted small-text">${fmt(last.submitted_at || last.started_at)}</span>` : "—"}</td>
        <td>
          <button type="button"
            class="${student.active ? "danger-outline" : "primary"} student-status-btn">
            ${student.active ? "Unenroll" : "Re-enroll"}
          </button>
        </td>
      `;

      tr.querySelector(".student-status-btn")?.addEventListener("click", async () => {
        await setStudentActive(student, !student.active);
      });

      body.appendChild(tr);
    }
  }

  function formatAttemptRecord(attempt) {
    const title = attempt.exams?.title || "Exam";
    const status = attempt.status || "unknown";
    let score = "";
    if (attempt.score !== null && attempt.score !== undefined) {
      score = ` • ${trimNumber(attempt.score)}/${attempt.max_score === null || attempt.max_score === undefined ? "—" : trimNumber(attempt.max_score)}`;
    }
    return `<div class="student-exam-line"><strong>${escapeHtml(title)}</strong><span class="muted"> • ${escapeHtml(status)}${escapeHtml(score)}</span></div>`;
  }

  async function enrollManual() {
    const idInput = $("studentEnrollId");
    const nameInput = $("studentEnrollName");
    const button = $("enrollStudentBtn");
    const studentNo = normalizeStudentId(idInput?.value || "");
    const fullName = String(nameInput?.value || "").trim();

    setEnrollMessage("");

    if (!studentNo || !fullName) {
      setEnrollMessage("Enter both Student ID and Full Name.", true);
      return;
    }

    button.disabled = true;

    const existing = students.find(s => normalizedIdKey(s.student_no) === normalizedIdKey(studentNo));
    let error;

    if (existing) {
      ({ error } = await db
        .from("students")
        .update({ student_no: studentNo, full_name: fullName, active: true })
        .eq("id", existing.id));
    } else {
      ({ error } = await db
        .from("students")
        .insert([{ student_no: studentNo, full_name: fullName, active: true }]));
    }

    button.disabled = false;

    if (error) {
      setEnrollMessage(`Could not enroll student: ${error.message}`, true);
      return;
    }

    idInput.value = "";
    nameInput.value = "";
    setEnrollMessage(`${fullName} (${studentNo}) is enrolled.`);
    await loadStudents();
  }

  async function setStudentActive(student, active) {
    const action = active ? "re-enroll" : "unenroll";
    const ok = confirm(
      active
        ? `Re-enroll ${student.full_name} (${student.student_no})?\n\nThe student will be able to start published exams again.`
        : `Unenroll ${student.full_name} (${student.student_no})?\n\nThe student will be blocked from starting new exams. Existing exam records will be kept.`
    );
    if (!ok) return;

    const { error } = await db
      .from("students")
      .update({ active })
      .eq("id", student.id);

    if (error) {
      alert(`Could not ${action} student: ${error.message}`);
      return;
    }

    await loadStudents();
  }

  async function importStudentsExcel() {
    const input = $("studentExcelFile");
    const button = $("importStudentsBtn");
    const file = input?.files?.[0];

    setImportMessage("");

    if (!file) {
      setImportMessage("Choose an Excel file first.", true);
      return;
    }
    if (!window.XLSX) {
      setImportMessage("The Excel library did not load. Refresh the dashboard and try again.", true);
      return;
    }

    button.disabled = true;

    try {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: false });
      const parsed = findStudentSheet(workbook);
      if (!parsed.rows.length) throw new Error("No valid student records were found.");

      const existingByNormalizedId = new Map(
        students.map(s => [normalizedIdKey(s.student_no), s])
      );

      const seen = new Set();
      const prepared = [];
      const errors = [];

      parsed.rows.forEach((row, index) => {
        const excelRow = row.__rowNumber || index + 2;
        const studentNo = normalizeStudentId(row.studentNo);
        const fullName = String(row.fullName || "").trim();

        if (!studentNo && !fullName) return;
        if (!studentNo) {
          errors.push(`Row ${excelRow}: Student ID is blank.`);
          return;
        }
        if (!fullName) {
          errors.push(`Row ${excelRow}: Full Name is blank.`);
          return;
        }

        const key = normalizedIdKey(studentNo);
        if (seen.has(key)) {
          errors.push(`Row ${excelRow}: duplicate Student ID ${studentNo}.`);
          return;
        }
        seen.add(key);

        prepared.push({ studentNo, fullName, existing: existingByNormalizedId.get(key) || null });
      });

      if (errors.length) {
        const preview = errors.slice(0, 8).join(" ");
        throw new Error(preview + (errors.length > 8 ? ` Plus ${errors.length - 8} more error(s).` : ""));
      }

      if (!prepared.length) throw new Error("No valid student records were found.");

      const okay = confirm(
        `Import ${prepared.length} student${prepared.length === 1 ? "" : "s"} from worksheet "${parsed.sheetName}"?\n\nExisting Student IDs will be updated and re-enrolled. New Student IDs will be added.`
      );
      if (!okay) {
        setImportMessage("Student import cancelled.");
        return;
      }

      let inserted = 0;
      let updated = 0;

      // Only normalized matches whose stored ID uses different punctuation need an individual update.
      const variantMatches = prepared.filter(
        x => x.existing && normalizeStudentId(x.existing.student_no) !== x.studentNo
      );

      for (const item of variantMatches) {
        const { error } = await db
          .from("students")
          .update({
            student_no: item.studentNo,
            full_name: item.fullName,
            active: true
          })
          .eq("id", item.existing.id);

        if (error) throw new Error(`Could not update ${item.studentNo}: ${error.message}`);
        updated += 1;
      }

      const variantIds = new Set(variantMatches.map(x => normalizedIdKey(x.studentNo)));
      const batchRows = prepared
        .filter(x => !variantIds.has(normalizedIdKey(x.studentNo)))
        .map(x => ({
          student_no: x.studentNo,
          full_name: x.fullName,
          active: true
        }));

      // Exact Student IDs are safely upserted in batches for much faster large-roster imports.
      for (let i = 0; i < batchRows.length; i += 200) {
        const chunk = batchRows.slice(i, i + 200);
        const existingKeys = new Set(
          chunk
            .map(x => normalizedIdKey(x.student_no))
            .filter(key => existingByNormalizedId.has(key))
        );

        const { error } = await db
          .from("students")
          .upsert(chunk, { onConflict: "student_no" });

        if (error) throw new Error(`Could not import students: ${error.message}`);

        updated += existingKeys.size;
        inserted += chunk.length - existingKeys.size;
      }

      input.value = "";
      setImportMessage(
        `Enrollment import complete: ${inserted} new, ${updated} updated/re-enrolled, ${prepared.length} total processed.`
      );
      await loadStudents();
    } catch (error) {
      console.error(error);
      setImportMessage(error?.message || "Could not import the student Excel file.", true);
    } finally {
      button.disabled = false;
    }
  }

  function findStudentSheet(workbook) {
    let best = null;

    for (const sheetName of workbook.SheetNames) {
      const worksheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(worksheet, {
        defval: "",
        raw: false,
        blankrows: false
      });
      if (!rows.length) continue;

      const headers = Object.keys(rows[0] || {});
      const map = mapStudentHeaders(headers);
      if (!map.studentNo) continue;

      const canMakeName = Boolean(map.fullName || (map.lastName && map.givenName));
      if (!canMakeName) continue;

      const normalizedRows = rows.map((row, index) => ({
        __rowNumber: index + 2,
        studentNo: read(row, map.studentNo),
        fullName: map.fullName
          ? read(row, map.fullName)
          : composeName(
              read(row, map.lastName),
              read(row, map.givenName),
              map.middleInitial ? read(row, map.middleInitial) : ""
            )
      }));

      const validCount = normalizedRows.filter(r => r.studentNo && r.fullName).length;
      if (!best || validCount > best.validCount) {
        best = { sheetName, rows: normalizedRows, validCount };
      }
    }

    if (!best) {
      throw new Error(
        "Could not find a student roster worksheet. Use Student ID + Full Name, or Student Number + Last Name + Given Name."
      );
    }
    return best;
  }

  function mapStudentHeaders(headers) {
    const normalized = new Map(headers.map(h => [normalizeHeader(h), h]));
    const pick = (aliases) => {
      for (const alias of aliases) {
        const actual = normalized.get(normalizeHeader(alias));
        if (actual) return actual;
      }
      return null;
    };

    return {
      studentNo: pick(["student id","student no","student no.","student number","student_no","id number","id no","id no."]),
      fullName: pick(["full name","student name","name","full_name"]),
      lastName: pick(["last name","surname","family name"]),
      givenName: pick(["given name","first name","given names"]),
      middleInitial: pick(["middle initial","m.i.","mi","middle name"])
    };
  }

  function composeName(last, given, middle) {
    const l = String(last || "").trim();
    const g = String(given || "").trim();
    let m = String(middle || "").trim();
    if (!l || !g) return "";
    if (m && !/[.]$/.test(m) && m.length <= 3) m += ".";
    return `${l}, ${g}${m ? " " + m : ""}`.trim();
  }

  function downloadStudentTemplate() {
    if (!window.XLSX) {
      setImportMessage("The Excel library did not load. Refresh and try again.", true);
      return;
    }

    const ws = XLSX.utils.aoa_to_sheet([
      ["Student ID", "Full Name"],
      ["2025-10-0038BL", "Onsong, Rosalyn U."]
    ]);
    ws["!cols"] = [{ wch: 22 }, { wch: 42 }];

    const info = XLSX.utils.aoa_to_sheet([
      ["Student Enrollment Import Template"],
      [""],
      ["Required columns", "Student ID and Full Name"],
      ["Alternative USG format", "Student Number, Last Name, Given Name, Middle Initial"],
      ["Behavior", "Existing IDs are updated/re-enrolled; new IDs are added."]
    ]);
    info["!cols"] = [{ wch: 24 }, { wch: 78 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Students");
    XLSX.utils.book_append_sheet(wb, info, "Instructions");
    XLSX.writeFile(wb, "Student_Enrollment_Template.xlsx");
  }

  function normalizeStudentId(value) {
    return String(value || "").trim().toUpperCase();
  }

  function normalizedIdKey(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function normalizeHeader(value) {
    return String(value || "")
      .replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function read(row, key) {
    return String(row?.[key] ?? "").trim();
  }

  function setEnrollMessage(text, error = false) {
    const node = $("studentEnrollMsg");
    if (!node) return;
    node.textContent = text || "";
    node.classList.toggle("error", error);
    node.classList.toggle("success", Boolean(text) && !error);
  }

  function setImportMessage(text, error = false) {
    const node = $("studentImportMsg");
    if (!node) return;
    node.textContent = text || "";
    node.classList.toggle("error", error);
    node.classList.toggle("success", Boolean(text) && !error);
  }

  function setListStatus(text, error = false) {
    const node = $("studentListStatus");
    if (!node) return;
    node.textContent = text || "";
    node.classList.toggle("error", error);
  }

  function fmt(value) {
    return value ? new Date(value).toLocaleString() : "—";
  }

  function trimNumber(value) {
    return Number(value).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, c => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
    })[c]);
  }

  bind();
  window.StudentAdmin = { loadStudents };

  $("tabStudentsBtn")?.addEventListener("click", () => {
    loadStudents();
  });

  db.auth.getSession().then(({ data }) => {
    if (data?.session) {
      // Preload the roster so the Students tab is ready immediately.
      loadStudents();
    }
  });
})();