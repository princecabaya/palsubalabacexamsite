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
        id,attempt_token,status,started_at,submitted_at,score,max_score,grading_status,provisional_score,provisional_max_score,
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
      (r.grading_status === "approved" || r.grading_status === "not_required") &&
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
          ${r.status === "submitted" && !proctorOnly ? `<button type="button" class="review-grading-btn">${approved ? "Review / Edit Scores" : "Review Scores"}</button>` : ""}
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
    $("approveGradingBtn").disabled = true;
    if (msg) msg.textContent = "";

    let items = [];
    let rpcError = null;

    const rpcResult = await db.rpc("admin_get_grading_review", {
      p_attempt_id: attempt.id
    });

    if (rpcResult.error) {
      rpcError = rpcResult.error;
    } else if (Array.isArray(rpcResult.data?.items)) {
      items = rpcResult.data.items;
    }

    // Fallback: manual grading must never depend on Gemini or the report RPC.
    // Read the exam questions/responses directly if the RPC returned no items.
    if (!items.length) {
      const fallback = await loadConstructedItemsDirectly(attempt, exam);

      if (fallback.error) {
        const reason = rpcError?.message || fallback.error.message || "Could not load constructed responses.";
        itemsNode.innerHTML = `<p class="message-inline error">${escapeHtml(reason)}</p>`;
        $("gradingAiStatus").textContent = "Manual review could not be loaded.";
        return;
      }

      items = fallback.items;
    }

    if (!items.length) {
      itemsNode.innerHTML = '<p class="muted">No Essay, Short Response, or Math Solver items were found in this exam.</p>';
      $("gradingAiStatus").textContent = rpcError
        ? `Review RPC warning: ${rpcError.message}`
        : "No constructed-response grading is required.";
      $("approveGradingBtn").disabled = true;
      return;
    }

    renderGradingItems(items);
    $("approveGradingBtn").disabled = false;

    const hasAi = items.some(item => item.provisional_score !== null && item.provisional_score !== undefined);
    $("gradingAiStatus").textContent = hasAi
      ? "Provisional AI scores are available. Review and edit them before approval."
      : "No provisional AI scores are available. You can score manually or click Try AI Provisional Scoring.";

    panel.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function loadConstructedItemsDirectly(attempt, exam) {
    const { data: questions, error: questionError } = await db
      .from("questions")
      .select("id,position,section_title,prompt,question_type,correct_answer,points,rubric_type,rubric_criteria")
      .eq("exam_id", exam.id)
      .in("question_type", ["essay","text","short_response","math_solver"])
      .order("position", { ascending: true });

    if (questionError) return { items: [], error: questionError };

    const questionIds = (questions || []).map(q => q.id);
    let responses = [];

    if (questionIds.length) {
      const responseResult = await db
        .from("responses")
        .select("question_id,answer,provisional_score,provisional_reason,teacher_score,teacher_comment,review_status")
        .eq("attempt_id", attempt.id)
        .in("question_id", questionIds);

      if (responseResult.error) return { items: [], error: responseResult.error };
      responses = responseResult.data || [];
    }

    const responseMap = new Map(responses.map(row => [row.question_id, row]));

    const items = (questions || []).map(q => {
      const response = responseMap.get(q.id) || {};
      return {
        question_id: q.id,
        position: q.position,
        section_title: q.section_title || "Part 1",
        prompt: q.prompt,
        question_type: q.question_type === "text" ? "essay" : q.question_type,
        points: Number(q.points || 0),
        reference_answer: q.correct_answer,
        rubric_type: q.rubric_type,
        rubric_criteria: q.rubric_criteria,
        student_answer: response.answer || "",
        provisional_score: response.provisional_score ?? null,
        provisional_reason: response.provisional_reason || "",
        teacher_score: response.teacher_score ?? null,
        teacher_comment: response.teacher_comment || "",
        review_status: response.review_status || "pending"
      };
    });

    return { items, error: null };
  }

  function renderGradingItems(items) {
    const itemsNode = $("gradingReviewItems");
    itemsNode.innerHTML = "";

    for (const item of items) {
      const article = document.createElement("article");
      article.className = "grading-review-card";
      article.dataset.questionId = item.question_id;
      const provisional = item.provisional_score == null ? null : Number(item.provisional_score);
      const teacher = item.teacher_score == null ? null : Number(item.teacher_score);
      const startingScore = Number.isFinite(teacher)
        ? teacher
        : (Number.isFinite(provisional) ? provisional : "");

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
        <div class="form-grid compact grading-inputs">
          <label>Teacher score
            <input class="teacher-score-input" type="number" min="0" max="${escapeAttr(item.points)}" step="0.25" value="${startingScore}">
          </label>
          <label>Teacher comment
            <input class="teacher-comment-input" value="${escapeAttr(item.teacher_comment || "")}" placeholder="Optional comment">
          </label>
        </div>
      `;

      itemsNode.appendChild(article);
    }
  }

  async function retryAiGrading() {
    if (!activeGradingAttempt?.attempt_token) {
      $("gradingAiStatus").textContent = "This attempt has no available attempt token for AI retry. Manual grading is still available.";
      return;
    }

    const button = $("retryAiGradingBtn");
    button.disabled = true;
    button.textContent = "Generating…";
    $("gradingAiStatus").textContent = "Trying Gemini first, then OpenAI if needed…";

    try {
      const { data, error } = await db.functions.invoke("grade-constructed-responses", {
        body: { attempt_token: activeGradingAttempt.attempt_token, use_ai: true }
      });

      if (error) throw error;

      $("gradingAiStatus").textContent = data?.message ||
        "Provisional AI scoring completed. Reloading review…";
      await openGradingReview(activeGradingAttempt, activeGradingExam);
    } catch (error) {
      const detail = await readEdgeFunctionError(error);
      const statusCode = error?.context?.status || error?.status || "";
      $("gradingAiStatus").textContent =
        `AI provisional scoring failed${statusCode ? ` (HTTP ${statusCode})` : ""}: ${detail || error?.message || "Unknown error"}. You can still score every item manually.`;
    } finally {
      button.disabled = false;
      button.textContent = "Try AI Provisional Scoring";
    }
  }

  async function readEdgeFunctionError(error) {
    try {
      const response = error?.context;
      if (response && typeof response.clone === "function") {
        return await response.clone().text();
      }
    } catch (_) {}
    return String(error?.message || error || "").trim();
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

    if (!cards.length) {
      $("gradingReviewMsg").textContent = "No constructed-response items are loaded. Final approval is blocked.";
      return;
    }

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
  $("retryAiGradingBtn")?.addEventListener("click", retryAiGrading);
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

  function escapeAttr(value) {
    return escapeHtml(value);
  }
})();