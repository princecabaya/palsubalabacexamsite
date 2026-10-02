(() => {
  const cfg = window.EXAM_CONFIG || {};
  const db = window.supabase?.createClient
    ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY)
    : null;
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const examId = params.get("exam_id") || "";
  let lastReport = null;

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, ch => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
    })[ch]);
  }

  function mean(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  }

  function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a,b) => a-b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid-1] + sorted[mid]) / 2;
  }

  function sampleVariance(values) {
    if (values.length < 2) return null;
    const m = mean(values);
    return values.reduce((sum, value) => sum + Math.pow(value - m, 2), 0) / (values.length - 1);
  }

  function sampleSd(values) {
    const variance = sampleVariance(values);
    return variance === null ? null : Math.sqrt(Math.max(0, variance));
  }

  function pearson(x, y) {
    if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length || x.length < 3) return null;
    const mx = mean(x);
    const my = mean(y);
    let numerator = 0, dx = 0, dy = 0;
    for (let i = 0; i < x.length; i += 1) {
      const a = x[i] - mx;
      const b = y[i] - my;
      numerator += a * b;
      dx += a * a;
      dy += b * b;
    }
    if (dx <= 0 || dy <= 0) return null;
    return numerator / Math.sqrt(dx * dy);
  }

  function alphaFromMatrix(matrix) {
    const n = matrix.length;
    const k = matrix[0]?.length || 0;
    if (n < 2 || k < 2) return null;

    let sumItemVariances = 0;
    for (let j = 0; j < k; j += 1) {
      const variance = sampleVariance(matrix.map(row => Number(row[j] || 0)));
      sumItemVariances += variance ?? 0;
    }

    const totals = matrix.map(row => row.reduce((sum, value) => sum + Number(value || 0), 0));
    const totalVariance = sampleVariance(totals);
    if (totalVariance === null || totalVariance <= 0) return null;

    return (k / (k - 1)) * (1 - (sumItemVariances / totalVariance));
  }

  function kr20FromMatrix(matrix) {
    const n = matrix.length;
    const k = matrix[0]?.length || 0;
    if (n < 2 || k < 2) return null;

    const totals = matrix.map(row => row.reduce((sum, value) => sum + Number(value || 0), 0));
    const totalVariance = sampleVariance(totals);
    if (totalVariance === null || totalVariance <= 0) return null;

    let sumPQ = 0;
    for (let j = 0; j < k; j += 1) {
      const p = mean(matrix.map(row => Number(row[j] || 0)));
      sumPQ += p * (1 - p);
    }

    return (k / (k - 1)) * (1 - (sumPQ / totalVariance));
  }

  function normalizeAnswer(value) {
    return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  }

  function fmt(value, digits = 3) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
    return Number(value).toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
  }

  function typeLabel(type) {
    return ({
      mcq:"MCQ", binary:"Binary", essay:"Essay", text:"Essay",
      short_response:"Short Response", math_solver:"Math Solver"
    })[type] || type || "Item";
  }

  function reliabilityLabel(value) {
    if (value === null || !Number.isFinite(value)) return "Not estimable from the available score variation.";
    if (value >= 0.90) return "Very high internal consistency.";
    if (value >= 0.80) return "Good internal consistency.";
    if (value >= 0.70) return "Acceptable internal consistency.";
    if (value >= 0.60) return "Questionable internal consistency.";
    return "Low internal consistency; review item functioning, score variation, and test length.";
  }

  function setStatus(message, error = false) {
    const card = $("analysisLoadingCard");
    const status = $("analysisPageStatus");
    if (status) status.textContent = message;
    if (card) card.classList.toggle("analysis-load-error", error);
  }

  async function verifyTeacher() {
    const { data: sessionData } = await db.auth.getSession();
    const user = sessionData?.session?.user;
    if (!user) throw new Error("Teacher session not found. Sign in to the Admin Dashboard, then open Test Analysis again.");

    const { data: profile, error } = await db
      .from("exam_admins")
      .select("is_admin,role")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) throw error;
    if (!profile?.is_admin) throw new Error("Teacher access is required.");
    return user;
  }

  async function computeAnalysis() {
    if (!db) throw new Error("Supabase is unavailable.");
    if (!examId) throw new Error("No examination was specified.");

    $("analysisReportContent")?.classList.add("hidden");
    $("analysisLoadingCard")?.classList.remove("hidden");
    setStatus("Checking teacher access…");

    const user = await verifyTeacher();

    const { data: exam, error: examError } = await db
      .from("exams")
      .select("id,title,code,owner_id")
      .eq("id", examId)
      .maybeSingle();

    if (examError) throw examError;
    if (!exam) throw new Error("Examination was not found.");

    if (exam.owner_id !== user.id) {
      const { data: profile } = await db
        .from("exam_admins")
        .select("role")
        .eq("user_id", user.id)
        .maybeSingle();
      if (profile?.role !== "main_admin") {
        throw new Error("Test analysis is available to the exam owner and Main Admin.");
      }
    }

    $("analysisReportTitle").textContent = exam.title || "Test Analysis Report";
    $("analysisReportMeta").textContent = (exam.code || "") + " • Test Analysis Report";
    document.title = (exam.title || "Exam") + " — Test Analysis";

    setStatus("Computing validity, reliability, and item statistics…");

    const [questionResult, attemptResult] = await Promise.all([
      db.from("questions")
        .select("id,position,section_title,prompt,question_type,choices,correct_answer,points")
        .eq("exam_id", examId)
        .order("position", { ascending: true }),
      db.from("attempts")
        .select("id,status,grading_status,score,max_score,students(student_no,full_name)")
        .eq("exam_id", examId)
        .eq("status", "submitted")
    ]);

    if (questionResult.error) throw questionResult.error;
    if (attemptResult.error) throw attemptResult.error;

    const questions = questionResult.data || [];
    const attempts = (attemptResult.data || []).filter(attempt =>
      attempt.grading_status === "approved" || attempt.grading_status === "not_required"
    );

    if (!questions.length) throw new Error("This exam has no saved questions.");
    if (attempts.length < 2) throw new Error("At least two finalized submitted attempts are required.");

    const attemptIds = attempts.map(attempt => attempt.id);
    const responseResult = await db.from("responses")
      .select("attempt_id,question_id,answer,teacher_score")
      .in("attempt_id", attemptIds);

    if (responseResult.error) throw responseResult.error;

    const responses = responseResult.data || [];
    const responseMap = new Map(
      responses.map(response => [response.attempt_id + ":" + response.question_id, response])
    );
    const constructed = new Set(["essay","text","short_response","math_solver"]);

    const scoreMatrix = attempts.map(attempt => questions.map(question => {
      const response = responseMap.get(attempt.id + ":" + question.id);
      const maxPoints = Number(question.points || 0);

      if (constructed.has(question.question_type)) {
        const score = Number(response?.teacher_score);
        return Number.isFinite(score) ? Math.max(0, Math.min(maxPoints, score)) : 0;
      }

      if (question.correct_answer !== null && question.correct_answer !== undefined) {
        return normalizeAnswer(response?.answer) === normalizeAnswer(question.correct_answer)
          ? maxPoints
          : 0;
      }
      return 0;
    }));

    const totalMax = questions.reduce((sum, question) => sum + Number(question.points || 0), 0);
    const rawTotals = scoreMatrix.map(row => row.reduce((sum, score) => sum + score, 0));
    const percentages = totalMax > 0 ? rawTotals.map(score => score / totalMax * 100) : [];

    const alpha = alphaFromMatrix(scoreMatrix);

    const objectiveItems = questions.map((question, index) => ({ question, index }))
      .filter(item =>
        !constructed.has(item.question.question_type) &&
        item.question.correct_answer !== null &&
        item.question.correct_answer !== undefined &&
        Number(item.question.points || 0) > 0
      );

    const binaryMatrix = scoreMatrix.map(row => objectiveItems.map(item => {
      const maxPoints = Number(item.question.points || 0);
      return row[item.index] >= maxPoints ? 1 : 0;
    }));
    const kr20 = objectiveItems.length >= 2 ? kr20FromMatrix(binaryMatrix) : null;

    const oddIndexes = questions.map((_, index) => index).filter(index => index % 2 === 0);
    const evenIndexes = questions.map((_, index) => index).filter(index => index % 2 === 1);
    let splitHalf = null;
    if (oddIndexes.length && evenIndexes.length) {
      const oddScores = scoreMatrix.map(row => oddIndexes.reduce((sum, index) => sum + row[index], 0));
      const evenScores = scoreMatrix.map(row => evenIndexes.reduce((sum, index) => sum + row[index], 0));
      const halfCorrelation = pearson(oddScores, evenScores);
      if (halfCorrelation !== null && halfCorrelation > -1) {
        splitHalf = (2 * halfCorrelation) / (1 + halfCorrelation);
      }
    }

    const rawSd = sampleSd(rawTotals);
    const sem = alpha !== null && alpha <= 1 && rawSd !== null
      ? rawSd * Math.sqrt(Math.max(0, 1 - alpha))
      : null;

    const itemStats = questions.map((question, itemIndex) => {
      const itemScores = scoreMatrix.map(row => row[itemIndex]);
      const maxPoints = Number(question.points || 0);
      const difficulty = maxPoints > 0 ? mean(itemScores) / maxPoints : null;
      const restScores = rawTotals.map((total, studentIndex) => total - itemScores[studentIndex]);
      const itemTotal = pearson(itemScores, restScores);
      const reducedMatrix = scoreMatrix.map(row => row.filter((_, index) => index !== itemIndex));
      const alphaDeleted = questions.length > 2 ? alphaFromMatrix(reducedMatrix) : null;
      const flags = [];

      if (difficulty !== null && difficulty < 0.20) flags.push("Very difficult");
      if (difficulty !== null && difficulty > 0.90) flags.push("Very easy");
      if (itemTotal !== null && itemTotal < 0) flags.push("Negative discrimination");
      else if (itemTotal !== null && itemTotal < 0.20) flags.push("Low discrimination");

      return { question, difficulty, itemTotal, alphaDeleted, flags };
    });

    const distractors = questions.map(question => {
      if (question.question_type !== "mcq" || !Array.isArray(question.choices)) return null;

      const counts = new Map(question.choices.map(choice => [String(choice), 0]));
      let blanks = 0;

      attempts.forEach(attempt => {
        const answer = String(responseMap.get(attempt.id + ":" + question.id)?.answer ?? "").trim();
        if (!answer) {
          blanks += 1;
          return;
        }
        const matched = question.choices.find(choice =>
          normalizeAnswer(choice) === normalizeAnswer(answer)
        );
        if (matched !== undefined) {
          counts.set(String(matched), (counts.get(String(matched)) || 0) + 1);
        }
      });

      return {
        question,
        blanks,
        options: question.choices.map(choice => {
          const count = counts.get(String(choice)) || 0;
          const percentage = count / attempts.length * 100;
          const correct = normalizeAnswer(choice) === normalizeAnswer(question.correct_answer);
          return {
            choice: String(choice),
            count,
            percentage,
            correct,
            nonFunctioning: !correct && percentage < 5
          };
        })
      };
    }).filter(Boolean);

    const positive = itemStats.filter(item => item.itemTotal !== null && item.itemTotal >= 0.20).length;
    const negative = itemStats.filter(item => item.itemTotal !== null && item.itemTotal < 0).length;
    const meanDifficulty = mean(itemStats.map(item => item.difficulty).filter(value => value !== null));
    const flagged = itemStats.filter(item => item.flags.length).length;

    lastReport = {
      exam,
      questions,
      attempts,
      alpha,
      kr20,
      splitHalf,
      sem,
      itemStats,
      distractors,
      descriptive: {
        n: attempts.length,
        mean: mean(percentages),
        median: median(percentages),
        sd: sampleSd(percentages),
        min: Math.min(...percentages),
        max: Math.max(...percentages)
      },
      validity: { positive, negative, meanDifficulty, flagged }
    };

    renderAnalysis(lastReport);
    $("analysisLoadingCard")?.classList.add("hidden");
    $("analysisReportContent")?.classList.remove("hidden");
  }

  function renderAnalysis(report) {
    const d = report.descriptive;
    $("analysisN").textContent = String(d.n);
    $("analysisMean").textContent = fmt(d.mean,2) + "%";
    $("analysisMedian").textContent = fmt(d.median,2) + "%";
    $("analysisSd").textContent = fmt(d.sd,2);
    $("analysisMin").textContent = fmt(d.min,2) + "%";
    $("analysisMax").textContent = fmt(d.max,2) + "%";

    $("analysisAlpha").textContent = fmt(report.alpha,3);
    $("analysisKr20").textContent = fmt(report.kr20,3);
    $("analysisSem").textContent = report.sem === null ? "—" : fmt(report.sem,2) + " pts";
    $("analysisSplitHalf").textContent = fmt(report.splitHalf,3);
    $("analysisReliabilityNote").textContent =
      "Cronbach's alpha: " + reliabilityLabel(report.alpha) +
      " KR-20 uses only dichotomously scored objective items. SEM is in raw score points.";

    $("analysisPositiveDiscrimination").textContent =
      report.validity.positive + "/" + report.itemStats.length;
    $("analysisNegativeDiscrimination").textContent = String(report.validity.negative);
    $("analysisMeanDifficulty").textContent = fmt(report.validity.meanDifficulty,3);
    $("analysisFlaggedItems").textContent = String(report.validity.flagged);

    const cautions = [];
    if (report.attempts.length < 20) {
      cautions.push("N=" + report.attempts.length + ": coefficients and item statistics may be unstable with a small sample. Interpret cautiously and accumulate more administrations.");
    }
    if (report.attempts.length < 5) {
      cautions.push("Very small sample: reliability and discrimination coefficients are especially unstable.");
    }
    cautions.push("Internal consistency and corrected item-total correlations are validity-related evidence about item functioning. They do not establish content, criterion, or construct validity by themselves.");

    $("testAnalysisCautions").innerHTML = cautions
      .map(message => '<p class="analysis-caution">' + escapeHtml(message) + '</p>')
      .join("");

    const itemRows = $("analysisItemRows");
    itemRows.innerHTML = "";
    report.itemStats.forEach(stat => {
      const q = stat.question;
      const tr = document.createElement("tr");
      const flagHtml = stat.flags.length
        ? stat.flags.map(flag => '<span class="analysis-flag">' + escapeHtml(flag) + '</span>').join(" ")
        : '<span class="muted">—</span>';

      tr.innerHTML =
        '<td><strong>' + escapeHtml(q.position) + '</strong></td>' +
        '<td>' + escapeHtml(typeLabel(q.question_type)) + '</td>' +
        '<td>' + escapeHtml(fmt(Number(q.points || 0),2)) + '</td>' +
        '<td>' + fmt(stat.difficulty,3) + '</td>' +
        '<td class="' + (stat.itemTotal !== null && stat.itemTotal < 0 ? 'analysis-negative' : '') + '">' + fmt(stat.itemTotal,3) + '</td>' +
        '<td>' + fmt(stat.alphaDeleted,3) + '</td>' +
        '<td>' + flagHtml + '</td>';
      itemRows.appendChild(tr);
    });

    const distractorReport = $("analysisDistractorReport");
    distractorReport.innerHTML = "";
    if (!report.distractors.length) {
      distractorReport.innerHTML = '<p class="muted">No multiple-choice items are available for distractor analysis.</p>';
      return;
    }

    report.distractors.forEach(item => {
      const section = document.createElement("section");
      section.className = "distractor-item";
      const blankText = item.blanks ? " • " + item.blanks + " blank" : "";
      section.innerHTML =
        '<div class="distractor-head"><strong>Item ' + escapeHtml(item.question.position) + '</strong>' +
        '<span class="muted">N=' + report.attempts.length + blankText + '</span></div>' +
        '<div class="table-wrap"><table><thead><tr><th>Option</th><th>Selected</th><th>%</th><th>Interpretation</th></tr></thead><tbody></tbody></table></div>';

      const tbody = section.querySelector("tbody");
      item.options.forEach(option => {
        const tr = document.createElement("tr");
        let interpretation = "Distractor functioning";
        if (option.correct) interpretation = '<span class="badge ok">Correct key</span>';
        else if (option.nonFunctioning) interpretation = '<span class="analysis-flag">Non-functioning distractor (&lt;5%)</span>';

        tr.innerHTML =
          '<td>' + escapeHtml(option.choice) + '</td>' +
          '<td>' + option.count + '</td>' +
          '<td>' + fmt(option.percentage,1) + '%</td>' +
          '<td>' + interpretation + '</td>';
        tbody.appendChild(tr);
      });
      distractorReport.appendChild(section);
    });
  }

  function downloadCsv() {
    if (!lastReport) return;
    const report = lastReport;
    const rows = [
      ["Exam", report.exam.title || ""],
      ["Exam Code", report.exam.code || ""],
      ["Analyzed N", report.descriptive.n],
      ["Mean %", fmt(report.descriptive.mean,4)],
      ["Median %", fmt(report.descriptive.median,4)],
      ["SD %", fmt(report.descriptive.sd,4)],
      ["Cronbach alpha", fmt(report.alpha,6)],
      ["KR-20", fmt(report.kr20,6)],
      ["SEM raw points", fmt(report.sem,6)],
      ["Split-half Spearman-Brown", fmt(report.splitHalf,6)],
      [],
      ["Item","Type","Max Points","Difficulty/Mean Fraction","Corrected Item-Total r","Alpha if Deleted","Flags"]
    ];

    report.itemStats.forEach(stat => rows.push([
      stat.question.position,
      typeLabel(stat.question.question_type),
      stat.question.points,
      stat.difficulty === null ? "" : stat.difficulty,
      stat.itemTotal === null ? "" : stat.itemTotal,
      stat.alphaDeleted === null ? "" : stat.alphaDeleted,
      stat.flags.join("; ")
    ]));

    rows.push([]);
    rows.push(["Distractor Analysis"]);
    report.distractors.forEach(item => {
      rows.push(["Item " + item.question.position,"Option","Selected","Percent","Interpretation"]);
      item.options.forEach(option => rows.push([
        "",
        option.choice,
        option.count,
        option.percentage,
        option.correct ? "Correct key" : (option.nonFunctioning ? "Non-functioning distractor (<5%)" : "Distractor functioning")
      ]));
    });

    const csv = rows.map(row => row.map(value => {
      const text = String(value ?? "");
      return /[",\n]/.test(text) ? '"' + text.replace(/"/g,'""') + '"' : text;
    }).join(",")).join("\n");

    const blob = new Blob([csv], { type:"text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "Test_Analysis_" +
      String(report.exam.code || report.exam.title || "Exam").replace(/[^a-z0-9_-]+/gi,"_") +
      ".csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1500);
  }

  $("analysisBackBtn")?.addEventListener("click", () => {
    if (history.length > 1) history.back();
    else location.href = "admin.html";
  });
  $("analysisRefreshBtn")?.addEventListener("click", () => {
    computeAnalysis().catch(error => {
      setStatus(error?.message || "Could not compute the test analysis.", true);
      $("analysisLoadingCard")?.classList.remove("hidden");
      $("analysisReportContent")?.classList.add("hidden");
    });
  });
  $("analysisCsvBtn")?.addEventListener("click", downloadCsv);
  $("analysisPrintBtn")?.addEventListener("click", () => window.print());

  computeAnalysis().catch(error => {
    console.error("Test analysis failed:", error);
    setStatus(error?.message || "Could not compute the test analysis.", true);
    $("analysisLoadingCard")?.classList.remove("hidden");
    $("analysisReportContent")?.classList.add("hidden");
  });
})();