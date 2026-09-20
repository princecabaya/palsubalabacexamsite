(() => {
  const cfg = window.EXAM_CONFIG || {};
  const db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY);
  const $ = (id) => document.getElementById(id);

  const examRows = $("examRows");
  const panel = $("examResultsPanel");
  if (!examRows || !panel) return;

  examRows.addEventListener("click", async (event) => {
    const button = event.target.closest(".exam-title-link");
    if (!button) return;

    const exam = {
      id: button.dataset.examId,
      code: button.dataset.examCode || "",
      title: button.dataset.examTitle || "Exam"
    };
    await openExamResults(exam);
  });

  $("closeExamResultsBtn")?.addEventListener("click", () => {
    panel.classList.add("hidden");
  });

  async function openExamResults(exam) {
    panel.classList.remove("hidden");
    $("examResultsTitle").textContent = exam.title;
    $("examResultsMeta").textContent = `${exam.code} • Loading student results…`;
    $("examStudentRows").innerHTML = `<tr><td colspan="8">Loading…</td></tr>`;

    const { data, error } = await db
      .from("attempts")
      .select(`
        id,status,started_at,submitted_at,score,max_score,
        students(student_no,full_name)
      `)
      .eq("exam_id", exam.id);

    if (error) {
      $("examResultsMeta").textContent = `${exam.code} • Could not load results`;
      $("examStudentRows").innerHTML = `<tr><td colspan="8">${escapeHtml(error.message)}</td></tr>`;
      return;
    }

    const rows = (data || []).map(a => {
      const score = numberOrNull(a.score);
      const maxScore = numberOrNull(a.max_score);
      const percentage = score !== null && maxScore !== null && maxScore > 0
        ? (score / maxScore) * 100
        : null;

      return {
        ...a,
        score_num: score,
        max_score_num: maxScore,
        percentage
      };
    });

    const submitted = rows.filter(r =>
      r.status === "submitted" &&
      r.percentage !== null
    );

    // Competition ranking: 1, 2, 2, 4 for ties.
    const ranked = [...submitted].sort((a, b) => {
      if (b.percentage !== a.percentage) return b.percentage - a.percentage;
      const aName = a.students?.full_name || "";
      const bName = b.students?.full_name || "";
      return aName.localeCompare(bName);
    });

    let previousPct = null;
    let previousRank = 0;
    const rankMap = new Map();
    ranked.forEach((row, index) => {
      let rank;
      if (previousPct !== null && nearlyEqual(row.percentage, previousPct)) {
        rank = previousRank;
      } else {
        rank = index + 1;
      }
      rankMap.set(row.id, rank);
      previousPct = row.percentage;
      previousRank = rank;
    });

    rows.sort((a, b) => {
      const ar = rankMap.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const br = rankMap.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      if (ar !== br) return ar - br;
      return (a.students?.full_name || "").localeCompare(b.students?.full_name || "");
    });

    const average = submitted.length
      ? submitted.reduce((sum, r) => sum + r.percentage, 0) / submitted.length
      : null;
    const highest = submitted.length
      ? Math.max(...submitted.map(r => r.percentage))
      : null;

    $("resultTakers").textContent = String(rows.length);
    $("resultSubmitted").textContent = String(rows.filter(r => r.status === "submitted").length);
    $("resultAverage").textContent = average === null ? "—" : `${formatPct(average)}%`;
    $("resultHighest").textContent = highest === null ? "—" : `${formatPct(highest)}%`;
    $("examResultsMeta").textContent = `${exam.code} • ${rows.length} student${rows.length === 1 ? "" : "s"} took this exam`;

    renderRows(rows, rankMap, exam);
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderRows(rows, rankMap, exam) {
    const tbody = $("examStudentRows");
    tbody.innerHTML = "";

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="8">No student has taken this exam yet.</td></tr>`;
      return;
    }

    for (const r of rows) {
      const rank = rankMap.get(r.id);
      const score = r.score_num === null
        ? "—"
        : `${trimNumber(r.score_num)}/${r.max_score_num === null ? "—" : trimNumber(r.max_score_num)}`;
      const percentage = r.percentage === null ? "—" : `${formatPct(r.percentage)}%`;

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><strong>${rank ?? "—"}</strong></td>
        <td><strong>${escapeHtml(r.students?.full_name || "Unknown")}</strong></td>
        <td>${escapeHtml(r.students?.student_no || "")}</td>
        <td>${escapeHtml(score)}</td>
        <td><strong>${escapeHtml(percentage)}</strong></td>
        <td><span class="badge ${r.status === "submitted" ? "ok" : "warn"}">${escapeHtml(r.status)}</span></td>
        <td>${fmt(r.submitted_at)}</td>
        <td><button type="button" class="danger-outline delete-attempt-btn">Delete Attempt</button></td>
      `;

      tr.querySelector(".delete-attempt-btn").addEventListener("click", async () => {
        await deleteAttempt(r, exam);
      });

      tbody.appendChild(tr);
    }
  }

  async function deleteAttempt(attempt, exam) {
    const studentName = attempt.students?.full_name || "this student";
    const studentNo = attempt.students?.student_no || "";

    const ok = confirm(
      `Delete the exam record for ${studentName}${studentNo ? ` (${studentNo})` : ""}?\n\nThis removes the attempt, saved answers, AI feedback, score, and proctoring events for this exam. The student will be able to take the exam again if it is published and open.`
    );
    if (!ok) return;

    const { data: sessionData } = await db.auth.getSession();
    if (!sessionData?.session) {
      alert("Your teacher session is no longer active. Please sign out and sign in again.");
      return;
    }

    const { data, error } = await db.rpc("admin_delete_attempt", {
      p_attempt_id: attempt.id
    });

    if (error) {
      alert(
        `Could not delete student exam record: ${error.message}\n\nRun supabase-fix-delete-attempt.sql in Supabase SQL Editor, then refresh the admin page.`
      );
      return;
    }

    if (data !== true) {
      alert("No attempt was deleted. It may already have been removed or the record no longer exists.");
      return;
    }

    await openExamResults(exam);
  }

  function numberOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function nearlyEqual(a, b) {
    return Math.abs(a - b) < 0.000001;
  }

  function formatPct(value) {
    return Number(value).toFixed(2).replace(/\.00$/, "");
  }

  function trimNumber(value) {
    return Number(value).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
  }

  function fmt(value) {
    return value ? new Date(value).toLocaleString() : "—";
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, c => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
    })[c]);
  }
})();