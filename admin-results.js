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

    const row = examRows.querySelector(`tr[data-exam-takers-for="${CSS.escape(String(exam.id))}"]`);
    if (!row) return;

    const opening = row.classList.contains("hidden");
    examRows.querySelectorAll(".exam-takers-row").forEach(other => {
      if (other !== row) other.classList.add("hidden");
    });

    row.classList.toggle("hidden", !opening);
    button.classList.toggle("expanded", opening);

    if (opening) {
      await loadInlineExamTakers(exam, row);
    }
  });

  $("closeExamResultsBtn")?.addEventListener("click", () => {
    panel.classList.add("hidden");
    const workspace = $("manageWorkspace");
    workspace?.classList.remove("review-mode", "split-active");
    if ($("examPreviewPanel")?.classList.contains("hidden")) {
      $("manageRightPane")?.classList.add("hidden");
    }
  });

  async function loadInlineExamTakers(exam, row) {
    const container = row.querySelector(".exam-takers-dropdown");
    if (!container) return;

    container.innerHTML = '<p class="muted">Loading student takers…</p>';

    const { data, error } = await db
      .from("attempts")
      .select(`
        id,attempt_token,status,started_at,submitted_at,score,max_score,grading_status,provisional_score,provisional_max_score,
        students(student_no,full_name)
      `)
      .eq("exam_id", exam.id)
      .order("started_at", { ascending: true });

    if (error) {
      container.innerHTML = `<p class="message-inline error">${escapeHtml(error.message)}</p>`;
      return;
    }

    const attempts = data || [];
    if (!attempts.length) {
      container.innerHTML = '<p class="muted">No student has taken this exam yet.</p>';
      return;
    }

    container.innerHTML = `
      <div class="exam-takers-dropdown-head">
        <strong>${attempts.length} student${attempts.length === 1 ? "" : "s"} took this exam</strong>
        <button type="button" class="open-full-results-btn">Open Results Summary</button>
      </div>
      <div class="exam-taker-list"></div>
    `;

    container.querySelector(".open-full-results-btn")?.addEventListener("click", async () => {
      await openExamResults(exam);
    });

    const list = container.querySelector(".exam-taker-list");
    const proctorOnly = Boolean(window.ExamAdmin?.isProctorForExam?.(exam.id));

    attempts.forEach(attempt => {
      const approved = attempt.grading_status === "approved" || attempt.grading_status === "not_required";
      const item = document.createElement("div");
      item.className = "exam-taker-item";
      item.innerHTML = `
        <button type="button" class="exam-taker-name-btn">
          <span>
            <strong>${escapeHtml(attempt.students?.full_name || "Unknown Student")}</strong>
            <small>${escapeHtml(attempt.students?.student_no || "")}</small>
          </span>
          <span class="exam-taker-state">${approved ? "Approved" : (attempt.status === "submitted" ? "Needs review" : escapeHtml(attempt.status))}</span>
        </button>
        <div class="exam-taker-quick-actions">
          ${attempt.status === "submitted" && !proctorOnly ? '<button type="button" class="inline-review-btn">Review / Edit Scores</button>' : ""}
          ${attempt.status === "submitted" ? '<button type="button" class="inline-pdf-btn">Result PDF</button>' : ""}
        </div>
      `;

      item.querySelector(".exam-taker-name-btn")?.addEventListener("click", async () => {
        const loaded = await openExamResults(exam, { noScroll: true });
        const match = loaded.find(row => row.id === attempt.id) || attempt;
        if (match.status === "submitted" && !proctorOnly) {
          await openGradingReview(match, exam);
        }
      });

      item.querySelector(".inline-review-btn")?.addEventListener("click", async () => {
        const loaded = await openExamResults(exam, { noScroll: true });
        const match = loaded.find(row => row.id === attempt.id) || attempt;
        await openGradingReview(match, exam);
      });

      item.querySelector(".inline-pdf-btn")?.addEventListener("click", async event => {
        await window.ExamReport?.generateTeacher(attempt.id, event.currentTarget);
      });

      list.appendChild(item);
    });
  }

  async function openExamResults(exam, { noScroll = false } = {}) {
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
      return [];
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
    if (!noScroll && !$("manageWorkspace")?.classList.contains("split-active")) {
      if (!workspace?.classList.contains("split-active")) panel.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    return rows;
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
    $("manageRightPane")?.classList.remove("hidden");
    $("examPreviewPanel")?.classList.add("hidden");
    $("examResultsPanel")?.classList.remove("hidden");
    const workspace = $("manageWorkspace");
    workspace?.classList.remove("preview-mode");
    workspace?.classList.add("review-mode", "split-active");
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
        .select("question_id,answer,provisional_score,provisional_reason,teacher_score,teacher_comment,teacher_rubric_scores,review_status")
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
        teacher_rubric_scores: response.teacher_rubric_scores || null,
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

      const isAnalyticMatrix = item.question_type === "essay" &&
        item.rubric_type === "analytic" &&
        Array.isArray(item.rubric_criteria) &&
        item.rubric_criteria.length > 0 &&
        item.rubric_criteria.every(criterion =>
          Array.isArray(criterion?.levels) && criterion.levels.length >= 2
        );

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
        ${isAnalyticMatrix ? '<div class="analytic-grading-mount"></div>' : ""}
        <div class="form-grid compact grading-inputs">
          <label>Teacher score
            <input class="teacher-score-input" type="number" min="0" max="${escapeAttr(item.points)}" step="0.25" value="${startingScore}" ${isAnalyticMatrix ? "readonly" : ""}>
          </label>
          <label>Teacher comment
            <input class="teacher-comment-input" value="${escapeAttr(item.teacher_comment || "")}" placeholder="Optional comment">
          </label>
        </div>
      `;

      itemsNode.appendChild(article);

      if (isAnalyticMatrix) {
        renderAnalyticGradingSelector(article, item);
      }
    }
  }

  function renderAnalyticGradingSelector(article, item) {
    const mount = article.querySelector(".analytic-grading-mount");
    const scoreInput = article.querySelector(".teacher-score-input");
    if (!mount || !scoreInput) return;

    const persisted = item.teacher_rubric_scores && typeof item.teacher_rubric_scores === "object"
      ? item.teacher_rubric_scores
      : {};

    const selected = {};

    mount.innerHTML = `
      <div class="analytic-grading-header">
        <div>
          <strong>Analytic Rubric</strong>
          <p class="muted">Select one performance level for every criterion.</p>
        </div>
        <div class="analytic-grading-total">
          <span>Rubric score</span>
          <strong class="analytic-running-score">0 / ${escapeHtml(item.points)}</strong>
        </div>
      </div>
      <div class="analytic-grading-criteria"></div>
    `;

    const criteriaWrap = mount.querySelector(".analytic-grading-criteria");
    const running = mount.querySelector(".analytic-running-score");

    function recalculate() {
      let total = 0;
      let complete = true;

      item.rubric_criteria.forEach((criterion, criterionIndex) => {
        const choice = selected[String(criterionIndex)];
        if (!choice) {
          complete = false;
          return;
        }
        total += Number(choice.points || 0);
      });

      scoreInput.value = complete ? String(total) : "";
      article.dataset.rubricScores = JSON.stringify(selected);
      running.textContent = `${formatNumber(total)} / ${formatNumber(item.points)}`;
      mount.classList.toggle("rubric-incomplete", !complete);
    }

    item.rubric_criteria.forEach((criterion, criterionIndex) => {
      const section = document.createElement("section");
      section.className = "analytic-grade-criterion";

      const criterionMax = Math.max(
        ...criterion.levels.map(level => Number(level?.points || 0))
      );

      const heading = document.createElement("div");
      heading.className = "analytic-grade-criterion-head";
      heading.innerHTML = `
        <div>
          <strong>${escapeHtml(criterion.criterion || `Criterion ${criterionIndex + 1}`)}</strong>
          <span class="muted">Maximum ${formatNumber(criterionMax)} pts</span>
        </div>
        <strong class="criterion-selected-score">— / ${formatNumber(criterionMax)}</strong>
      `;
      section.appendChild(heading);

      const levels = document.createElement("div");
      levels.className = "analytic-grade-levels";

      criterion.levels.forEach((level, levelIndex) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "analytic-level-choice";
        button.dataset.criterionIndex = String(criterionIndex);
        button.dataset.levelIndex = String(levelIndex);
        button.innerHTML = `
          <div class="analytic-level-choice-head">
            <strong>${escapeHtml(level?.level || `Level ${levelIndex + 1}`)}</strong>
            <span>${formatNumber(level?.points)} pts</span>
          </div>
          <p>${escapeHtml(level?.description || "No descriptor provided.")}</p>
        `;

        button.addEventListener("click", () => {
          selected[String(criterionIndex)] = {
            level: String(level?.level || ""),
            points: Number(level?.points || 0),
            description: String(level?.description || "")
          };

          levels.querySelectorAll(".analytic-level-choice").forEach(node => {
            node.classList.toggle("selected", node === button);
          });

          heading.querySelector(".criterion-selected-score").textContent =
            `${formatNumber(level?.points)} / ${formatNumber(criterionMax)}`;

          recalculate();
        });

        levels.appendChild(button);
      });

      section.appendChild(levels);
      criteriaWrap.appendChild(section);

      const savedChoice = persisted[String(criterionIndex)] || persisted[criterion.criterion];
      if (savedChoice) {
        const wantedLevel = String(savedChoice.level || "").trim().toLowerCase();
        const wantedPoints = Number(savedChoice.points);
        const matching = [...levels.querySelectorAll(".analytic-level-choice")].find((button, levelIndex) => {
          const level = criterion.levels[levelIndex];
          return (
            (wantedLevel && String(level?.level || "").trim().toLowerCase() === wantedLevel) ||
            (Number.isFinite(wantedPoints) && Number(level?.points) === wantedPoints)
          );
        });
        matching?.click();
      }
    });

    recalculate();
  }

  function formatNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "0";
    return number.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
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
      await readEdgeFunctionError(error);
      $("gradingAiStatus").textContent =
        "Optional AI scoring is unavailable right now. Continue with manual teacher scoring.";
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

      let rubric_scores = null;
      if (card.querySelector(".analytic-grading-mount")) {
        try {
          rubric_scores = JSON.parse(card.dataset.rubricScores || "{}");
        } catch (_) {
          rubric_scores = {};
        }

        const criteriaCount = card.querySelectorAll(".analytic-grade-criterion").length;
        if (Object.keys(rubric_scores).length !== criteriaCount) {
          $("gradingReviewMsg").textContent = "Select one performance level for every analytic rubric criterion before approval.";
          return;
        }
      }

      scores.push({
        question_id: card.dataset.questionId,
        score,
        comment,
        rubric_scores
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
    const workspace = $("manageWorkspace");
    workspace?.classList.remove("review-mode", "split-active");
    if ($("examPreviewPanel")?.classList.contains("hidden")) {
      $("manageRightPane")?.classList.add("hidden");
    }
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