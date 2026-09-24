(() => {
  const db = window.ExamAdmin?.db;
  const $ = (id) => document.getElementById(id);

  if (!db) {
    console.error("Shared authenticated admin client is unavailable.");
    return;
  }

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
        id,status,started_at,submitted_at,score,max_score,grading_status,provisional_score,provisional_max_score,
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
        provisional_score_num: numberOrNull(a.provisional_score),
        provisional_max_score_num: numberOrNull(a.provisional_max_score),
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

    const proctorOnly = Boolean(window.ExamAdmin?.isProctorForExam?.(exam.id));

    for (const r of rows) {
      const rank = rankMap.get(r.id);
      const approved = r.grading_status === "approved" || r.grading_status === "not_required";
      const score = approved
        ? (r.score_num === null ? "—" : `${trimNumber(r.score_num)}/${r.max_score_num === null ? "—" : trimNumber(r.max_score_num)}`)
        : (r.provisional_score_num === null
            ? (r.score_num === null ? "Pending review" : `${trimNumber(r.score_num)}/${r.max_score_num ?? "—"} + review`)
            : `${trimNumber(r.provisional_score_num)}/${trimNumber(r.provisional_max_score_num)} provisional`);
      const percentage = approved && r.percentage !== null ? `${formatPct(r.percentage)}%` : "Pending";

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><strong>${rank ?? "—"}</strong></td>
        <td><strong>${escapeHtml(r.students?.full_name || "Unknown")}</strong></td>
        <td>${escapeHtml(r.students?.student_no || "")}</td>
        <td>${escapeHtml(score)}</td>
        <td><strong>${escapeHtml(percentage)}</strong></td>
        <td><span class="badge ${r.status === "submitted" ? "ok" : "warn"}">${escapeHtml(r.status)}</span></td>
        <td>${fmt(r.submitted_at)}</td>
        <td class="action-cell">
          ${r.status === "submitted" && !proctorOnly && !approved ? '<button type="button" class="review-grading-btn">Review Scores</button>' : ""}
          ${r.status === "submitted" ? '<button type="button" class="result-pdf-btn">Result PDF</button>' : ""}
          ${proctorOnly ? '<span class="badge proctor">Proctor</span>' : '<button type="button" class="danger-outline delete-attempt-btn">Delete Attempt</button>'}
        </td>
      `;

      tr.querySelector(".review-grading-btn")?.addEventListener("click", async () => {
        await openGradingReview(r, exam);
      });

      tr.querySelector(".result-pdf-btn")?.addEventListener("click", async (event) => {
        await window.ExamReport?.generateTeacher(r.id, event.currentTarget);
      });

      tr.querySelector(".delete-attempt-btn")?.addEventListener("click", async () => {
        await deleteAttempt(r, exam);
      });

      tbody.appendChild(tr);
    }
  }

  let activeGradingAttempt = null;
  let activeGradingExam = null;

  async function openGradingReview(attempt, exam) {
    activeGradingAttempt = attempt;
    activeGradingExam = exam;
    const panel = $("gradingReviewPanel");
    const itemsNode = $("gradingReviewItems");
    const msg = $("gradingReviewMsg");
    if (!panel || !itemsNode) return;

    panel.classList.remove("hidden");
    $("gradingReviewTitle").textContent = `Review — ${attempt.students?.full_name || "Student"}`;
    $("gradingReviewMeta").textContent = `${attempt.students?.student_no || ""} • ${exam.title || ""}`;
    itemsNode.innerHTML = '<p class="muted">Loading constructed responses…</p>';
    if (msg) msg.textContent = "";

    const { data, error } = await db.rpc("admin_get_grading_review", {
      p_attempt_id: attempt.id
    });

    if (error) {
      itemsNode.innerHTML = `<p class="message-inline error">${escapeHtml(error.message)}</p>`;
      return;
    }

    const items = Array.isArray(data?.items) ? data.items : [];
    if (!items.length) {
      itemsNode.innerHTML = '<p class="muted">This attempt has no Essay, Short Response, or Math Solver items.</p>';
      $("approveGradingBtn").disabled = true;
      return;
    }

    $("approveGradingBtn").disabled = false;
    itemsNode.innerHTML = "";

    for (const item of items) {
      const article = document.createElement("article");
      article.className = "grading-review-card";
      article.dataset.questionId = item.question_id;
      const provisional = item.provisional_score == null ? "" : Number(item.provisional_score);
      const startingScore = item.teacher_score == null ? provisional : Number(item.teacher_score);

      article.innerHTML = `
        <div class="grading-review-head">
          <div>
            <strong>${escapeHtml(item.section_title || "Part 1")} • Question ${escapeHtml(item.position)}</strong>
            <span class="badge">${escapeHtml(formatQuestionType(item.question_type))}</span>
          </div>
          <strong>${escapeHtml(item.points)} pts</strong>
        </div>
        <div class="grading-review-prompt">${escapeHtml(item.prompt || "")}</div>
        <div class="grading-student-answer"><strong>Student response</strong><pre>${escapeHtml(item.student_answer || "(No response)")}</pre></div>
        ${item.reference_answer ? `<p><strong>Reference:</strong> ${escapeHtml(item.reference_answer)}</p>` : ""}
        <div class="provisional-grade">
          <strong>Provisional AI score:</strong>
          <span>${item.provisional_score == null ? "Not available" : `${escapeHtml(item.provisional_score)} / ${escapeHtml(item.points)}`}</span>
          <p class="muted">${escapeHtml(item.provisional_reason || "Teacher review required.")}</p>
        </div>
        <div class="form-grid compact grading-inputs">
          <label>Teacher score
            <input class="teacher-score-input" type="number" min="0" max="${escapeAttr(item.points)}" step="0.25" value="${Number.isFinite(startingScore) ? startingScore : ""}">
          </label>
          <label>Teacher comment
            <input class="teacher-comment-input" value="${escapeAttr(item.teacher_comment || "")}" placeholder="Optional comment">
          </label>
        </div>
      `;

      itemsNode.appendChild(article);
    }

    panel.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function formatQuestionType(type) {
    return ({
      essay: "Essay",
      short_response: "Short Response",
      math_solver: "Math Solver"
    })[type] || type || "Response";
  }

  async function approveCurrentGrading() {
    if (!activeGradingAttempt || !activeGradingExam) return;

    const cards = [...document.querySelectorAll("#gradingReviewItems .grading-review-card")];
    const scores = [];

    for (const card of cards) {
      const input = card.querySelector(".teacher-score-input");
      const comment = card.querySelector(".teacher-comment-input")?.value?.trim() || "";
      const max = Number(input.max);
      const score = Number(input.value);

      if (!Number.isFinite(score) || score < 0 || score > max) {
        $("gradingReviewMsg").textContent = `Enter a score from 0 to ${max} for every response.`;
        return;
      }

      scores.push({
        question_id: card.dataset.questionId,
        score,
        comment
      });
    }

    if (!confirm("Approve these teacher-reviewed scores as the student's final exam score?")) return;

    const button = $("approveGradingBtn");
    button.disabled = true;
    button.textContent = "Approving…";

    const { data, error } = await db.rpc("admin_approve_constructed_scores", {
      p_attempt_id: activeGradingAttempt.id,
      p_scores: scores
    });

    button.disabled = false;
    button.textContent = "Approve Final Scores";

    if (error) {
      $("gradingReviewMsg").textContent = error.message;
      return;
    }

    $("gradingReviewMsg").textContent = `Approved final score: ${data?.score ?? "—"}/${data?.max_score ?? "—"}.`;
    await openExamResults(activeGradingExam);
    window.ExamAdmin?.refreshAttempts?.();
  }

  $("approveGradingBtn")?.addEventListener("click", approveCurrentGrading);
  $("closeGradingReviewBtn")?.addEventListener("click", () => {
    $("gradingReviewPanel")?.classList.add("hidden");
  });

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

    const deleteButton = [...document.querySelectorAll(".delete-attempt-btn")]
      .find(btn => btn.closest("tr")?.querySelector("td:nth-child(3)")?.textContent?.trim() === studentNo);

    if (deleteButton) {
      deleteButton.disabled = true;
      deleteButton.textContent = "Deleting…";
    }

    const { data, error } = await db.rpc("admin_delete_attempt", {
      p_attempt_id: attempt.id
    });

    if (error) {
      if (deleteButton) {
        deleteButton.disabled = false;
        deleteButton.textContent = "Delete Attempt";
      }
      alert(
        `Could not delete student exam record: ${error.message}\n\nRun supabase-fix-admin-delete.sql in Supabase SQL Editor, then refresh the admin page.`
      );
      return;
    }

    if (data !== true) {
      if (deleteButton) {
        deleteButton.disabled = false;
        deleteButton.textContent = "Delete Attempt";
      }
      alert("No attempt was deleted. It may already have been removed or the record no longer exists.");
      return;
    }

    alert(`The exam record for ${studentName} was deleted successfully.`);
    await openExamResults(exam);
    window.ExamAdmin?.refreshAttempts?.();
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