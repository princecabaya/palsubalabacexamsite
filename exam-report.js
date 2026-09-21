(() => {
  const cfg = window.EXAM_CONFIG || {};
  const studentDb = window.supabase?.createClient
    ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
      })
    : null;

  const PSU_LOGO_URL = "https://upload.wikimedia.org/wikipedia/commons/f/fa/Palawan_State_University_seal.png";
  const WATERMARK_TEACHER = "Sir Prince Jobetroh N. Cabaya Cruz";
  let logoDataPromise = null;
  let studentToken = null;
  let studentBound = false;
  let studentReport = null;

  function getJsPdf() {
    const jsPDF = window.jspdf?.jsPDF;
    if (!jsPDF) throw new Error("PDF library is not available. Refresh the page and try again.");
    return jsPDF;
  }

  async function loadLogoData() {
    if (logoDataPromise) return logoDataPromise;
    logoDataPromise = (async () => {
      try {
        const response = await fetch(PSU_LOGO_URL, { mode: "cors", cache: "force-cache" });
        if (!response.ok) throw new Error("Logo request failed.");
        const blob = await response.blob();
        return await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      } catch (error) {
        console.warn("PSU logo could not be loaded for PDF:", error);
        return null;
      }
    })();
    return logoDataPromise;
  }

  function safeFilePart(value) {
    return String(value || "report")
      .trim()
      .replace(/[^a-z0-9_-]+/gi, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80) || "report";
  }

  function asNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function fmtNumber(value) {
    const number = asNumber(value);
    if (number === null) return "—";
    return number.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
  }

  function fmtDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleString();
  }

  function resultLabel(item) {
    if (item?.result === "correct") return "CORRECT";
    if (item?.result === "wrong") return "WRONG";
    return "NOT AUTO-SCORED";
  }

  function drawHeader(doc, logoData) {
    const pageWidth = doc.internal.pageSize.getWidth();

    if (logoData) {
      try {
        doc.addImage(logoData, "PNG", 18, 10, 24, 24, undefined, "FAST");
      } catch (error) {
        console.warn("Could not place PSU logo in PDF:", error);
      }
    } else {
      doc.setDrawColor(80);
      doc.circle(30, 22, 11);
      doc.setFont("times", "bold");
      doc.setFontSize(9);
      doc.setTextColor(50);
      doc.text("PSU", 30, 24, { align: "center" });
    }

    doc.setTextColor(25);
    doc.setFont("times", "normal");
    doc.setFontSize(10);
    doc.text("Republic of the Philippines", pageWidth / 2 + 7, 14, { align: "center" });

    doc.setFont("times", "bold");
    doc.setFontSize(13);
    doc.text("PALAWAN STATE UNIVERSITY", pageWidth / 2 + 7, 20, { align: "center" });

    doc.setFont("times", "normal");
    doc.setFontSize(10);
    doc.text("Puerto Princesa City, Palawan", pageWidth / 2 + 7, 26, { align: "center" });

    doc.setDrawColor(80);
    doc.setLineWidth(0.35);
    doc.line(18, 36, pageWidth - 18, 36);
  }

  function drawWatermark(doc, report) {
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const teacherName = String(report?.teacher_name || WATERMARK_TEACHER || "Teacher").trim();
    const text = `${teacherName} • ${report.student_no || ""}`;

    doc.saveGraphicsState?.();
    doc.setFont("times", "bold");
    doc.setFontSize(20);
    doc.setTextColor(230, 230, 230);

    for (let y = 82; y < pageHeight - 24; y += 62) {
      doc.text(text, pageWidth / 2, y, {
        align: "center",
        angle: 32
      });
    }

    doc.restoreGraphicsState?.();
  }

  function drawFooter(doc, pageNumber, pageCount) {
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    doc.setFont("times", "normal");
    doc.setFontSize(8);
    doc.setTextColor(95);
    doc.text(
      `Exam result report • Page ${pageNumber} of ${pageCount}`,
      pageWidth / 2,
      pageHeight - 8,
      { align: "center" }
    );
  }

  async function buildPdf(report) {
    if (!report || !Array.isArray(report.items)) {
      throw new Error("The result report data is incomplete.");
    }

    const jsPDF = getJsPdf();
    const doc = new jsPDF({
      orientation: "portrait",
      unit: "mm",
      format: "a4",
      compress: true
    });

    const logoData = await loadLogoData();
    drawHeader(doc, logoData);
    drawWatermark(doc, report);

    const pageWidth = doc.internal.pageSize.getWidth();
    const score = fmtNumber(report.score);
    const maxScore = fmtNumber(report.max_score);
    const percentage = asNumber(report.percentage);

    doc.setTextColor(20);
    doc.setFont("times", "bold");
    doc.setFontSize(13);
    doc.text("EXAMINATION RESULT REPORT", pageWidth / 2, 45, { align: "center" });

    doc.setFont("times", "normal");
    doc.setFontSize(10.5);
    doc.text(`Student Name: ${report.student_name || "—"}`, 18, 54);
    doc.text(`Student ID: ${report.student_no || "—"}`, 18, 60);
    doc.text(`Examination: ${report.exam_title || "—"}`, 18, 66);
    doc.text(`Exam Code: ${report.exam_code || "—"}`, 18, 72);

    doc.text(`Submitted: ${fmtDate(report.submitted_at)}`, 112, 54);
    doc.text(`Score: ${score}/${maxScore}`, 112, 60);
    doc.text(
      `Percentage: ${percentage === null ? "—" : fmtNumber(percentage) + "%"}`,
      112,
      66
    );

    doc.setFont("times", "italic");
    doc.setFontSize(9);
    doc.setTextColor(85);
    doc.text(
      "This report shows the student's saved answer and the answer key for auto-scored items.",
      18,
      79
    );

    const body = report.items.map(item => [
      String(item.position ?? ""),
      String(item.prompt || ""),
      String(item.student_answer || "No answer"),
      item.correct_answer == null ? "Not auto-scored" : String(item.correct_answer),
      resultLabel(item),
      item.points_awarded == null
        ? "—"
        : `${fmtNumber(item.points_awarded)}/${fmtNumber(item.points)}`
    ]);

    if (typeof doc.autoTable !== "function") {
      throw new Error("PDF table library is not available. Refresh the page and try again.");
    }

    doc.autoTable({
      startY: 85,
      margin: { top: 42, right: 14, bottom: 16, left: 14 },
      head: [["Item", "Question", "Student Answer", "Correct Answer", "Result", "Points"]],
      body,
      theme: "grid",
      styles: {
        font: "times",
        fontSize: 8.5,
        cellPadding: 2.2,
        valign: "top",
        lineColor: [190, 195, 205],
        lineWidth: 0.15,
        textColor: [30, 30, 30]
      },
      headStyles: {
        font: "times",
        fontStyle: "bold",
        fillColor: [235, 239, 247],
        textColor: [20, 32, 51],
        lineColor: [160, 170, 185],
        lineWidth: 0.2
      },
      columnStyles: {
        0: { cellWidth: 11, halign: "center" },
        1: { cellWidth: 61 },
        2: { cellWidth: 35 },
        3: { cellWidth: 35 },
        4: { cellWidth: 24, halign: "center" },
        5: { cellWidth: 20, halign: "center" }
      },
      didParseCell(data) {
        if (data.section !== "body" || data.column.index !== 4) return;
        const value = String(data.cell.raw || "");
        data.cell.styles.fontStyle = "bold";
        if (value === "CORRECT") {
          data.cell.styles.textColor = [6, 118, 71];
        } else if (value === "WRONG") {
          data.cell.styles.textColor = [180, 35, 24];
        } else {
          data.cell.styles.textColor = [104, 114, 138];
        }
      }
    });

    const pages = doc.getNumberOfPages();
    for (let page = 1; page <= pages; page += 1) {
      doc.setPage(page);
      if (page > 1) drawHeader(doc, logoData);
      if (page > 1) drawWatermark(doc, report);
      drawFooter(doc, page, pages);
    }

    return doc;
  }

  async function saveReport(report) {
    const doc = await buildPdf(report);
    const filename = [
      "Exam_Result",
      safeFilePart(report.student_no),
      safeFilePart(report.exam_code || report.exam_title)
    ].join("_") + ".pdf";
    doc.save(filename);
    return filename;
  }

  async function fetchStudentReport(attemptToken) {
    if (!studentDb) throw new Error("Supabase is unavailable.");
    const { data, error } = await studentDb.rpc("get_submitted_exam_report", {
      p_attempt_token: attemptToken
    });
    if (error) throw error;
    if (!data) throw new Error("Result report is not available.");
    return data;
  }

  async function fetchTeacherReport(attemptId) {
    const db = window.ExamAdmin?.db;
    if (!db) throw new Error("Teacher session is unavailable.");
    const { data, error } = await db.rpc("admin_get_attempt_report", {
      p_attempt_id: attemptId
    });
    if (error) throw error;
    if (!data) throw new Error("Result report is not available.");
    return data;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
    })[c]);
  }

  function renderStudentReview(report) {
    const scoreNode = document.getElementById("studentResultScore");
    const pctNode = document.getElementById("studentResultPercent");
    const correctNode = document.getElementById("studentCorrectCount");
    const wrongNode = document.getElementById("studentWrongCount");
    const rowsNode = document.getElementById("studentResultRows");

    const items = Array.isArray(report?.items) ? report.items : [];
    const correct = items.filter(item => item.result === "correct").length;
    const wrong = items.filter(item => item.result === "wrong").length;

    if (scoreNode) scoreNode.textContent = `${fmtNumber(report?.score)}/${fmtNumber(report?.max_score)}`;
    if (pctNode) pctNode.textContent = report?.percentage == null ? "—" : `${fmtNumber(report.percentage)}%`;
    if (correctNode) correctNode.textContent = String(correct);
    if (wrongNode) wrongNode.textContent = String(wrong);

    if (!rowsNode) return;
    rowsNode.innerHTML = "";

    if (!items.length) {
      rowsNode.innerHTML = '<tr><td colspan="4">No auto-scored items were found.</td></tr>';
      return;
    }

    for (const item of items) {
      const tr = document.createElement("tr");
      const cssClass = item.result === "correct" ? "result-correct" : item.result === "wrong" ? "result-wrong" : "result-manual";
      const answer = item.student_answer || "No answer";
      const correctAnswer = item.correct_answer == null ? "Not auto-scored" : item.correct_answer;
      tr.innerHTML = `
        <td><strong>${escapeHtml(item.position ?? "")}</strong></td>
        <td><span class="result-status ${cssClass}">${escapeHtml(resultLabel(item))}</span></td>
        <td>${escapeHtml(answer)}</td>
        <td>${escapeHtml(correctAnswer)}</td>
      `;
      rowsNode.appendChild(tr);
    }
  }

  async function prepareStudentReport() {
    const button = document.getElementById("resultPdfBtn");
    const message = document.getElementById("resultPdfMsg");
    if (!studentToken || !button || !message) return;

    button.disabled = true;
    message.textContent = "Preparing your result report…";
    message.classList.remove("error", "success");

    try {
      studentReport = await fetchStudentReport(studentToken);
      renderStudentReview(studentReport);
      button.disabled = false;
      message.textContent = "Your result review is ready. You may also download the PDF copy.";
      message.classList.add("success");
    } catch (error) {
      console.error("Student result review error:", error);
      studentReport = null;
      message.textContent = error?.message || "Could not load the submitted result report.";
      message.classList.add("error");
      const rowsNode = document.getElementById("studentResultRows");
      if (rowsNode) rowsNode.innerHTML = '<tr><td colspan="4">Result review is unavailable until the result-report database upgrade is installed.</td></tr>';
    }
  }

  function enableStudent(attemptToken) {
    studentToken = attemptToken || null;
    studentReport = null;

    const panel = document.getElementById("resultReportPanel");
    const button = document.getElementById("resultPdfBtn");
    const message = document.getElementById("resultPdfMsg");
    if (!panel || !button || !message || !studentToken) return;

    panel.classList.remove("hidden");
    prepareStudentReport();

    if (studentBound) return;
    studentBound = true;

    button.addEventListener("click", async () => {
      if (!studentToken) return;
      button.disabled = true;
      button.textContent = "Generating PDF…";
      message.textContent = "";

      try {
        const report = studentReport || await fetchStudentReport(studentToken);
        studentReport = report;
        renderStudentReview(report);
        const filename = await saveReport(report);
        message.textContent = `Result PDF generated: ${filename}`;
        message.classList.remove("error");
        message.classList.add("success");
      } catch (error) {
        console.error("Student result PDF error:", error);
        message.textContent = error?.message || "Could not generate the result PDF.";
        message.classList.remove("success");
        message.classList.add("error");
      } finally {
        button.disabled = !studentReport;
        button.textContent = "Download Result PDF";
      }
    });
  }

  async function generateTeacher(attemptId, button = null) {
    if (!attemptId) return;

    const oldText = button?.textContent;
    if (button) {
      button.disabled = true;
      button.textContent = "Generating…";
    }

    try {
      const report = await fetchTeacherReport(attemptId);
      await saveReport(report);
    } catch (error) {
      console.error("Teacher result PDF error:", error);
      alert(
        `Could not generate result PDF: ${error?.message || error}\n\nIf the database report function is missing, run supabase-upgrade-result-pdf.sql in Supabase SQL Editor.`
      );
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = oldText || "Result PDF";
      }
    }
  }

  async function fetchPublishedExam(examId) {
    const db = window.ExamAdmin?.db;
    if (!db) throw new Error("Teacher session is unavailable.");

    const { data: exam, error: examError } = await db
      .from("exams")
      .select("id,title,code,duration_minutes,status,start_at,end_at")
      .eq("id", examId)
      .maybeSingle();

    if (examError) throw examError;
    if (!exam) throw new Error("Examination was not found.");
    if (exam.status !== "published") {
      throw new Error("Only published examinations can be generated as an Exam PDF.");
    }

    const { data: questions, error: questionError } = await db
      .from("questions")
      .select("position,prompt,question_type,choices,points")
      .eq("exam_id", examId)
      .order("position", { ascending: true });

    if (questionError) throw questionError;

    return {
      ...exam,
      questions: questions || []
    };
  }

  async function buildExamPdf(exam) {
    const jsPDF = getJsPdf();
    const doc = new jsPDF({
      orientation: "portrait",
      unit: "mm",
      format: "a4",
      compress: true
    });

    const logoData = await loadLogoData();
    const pageWidth = doc.internal.pageSize.getWidth();
    const left = 18;
    const right = pageWidth - 18;
    const bottomLimit = doc.internal.pageSize.getHeight() - 18;

    const totalPoints = (exam.questions || []).reduce((sum, q) => {
      const points = Number(q.points);
      return sum + (Number.isFinite(points) ? points : 0);
    }, 0);

    function beginPage(firstPage = false) {
      if (!firstPage) doc.addPage();
      drawHeader(doc, logoData);

      doc.setTextColor(20);
      doc.setFont("times", "bold");
      doc.setFontSize(13);
      doc.text(String(exam.title || "EXAMINATION").toUpperCase(), pageWidth / 2, 45, { align: "center" });

      doc.setFont("times", "normal");
      doc.setFontSize(10);
      doc.text(`Exam Code: ${exam.code || "—"}`, left, 53);
      doc.text(`Time: ${exam.duration_minutes || "—"} minutes`, pageWidth / 2, 53, { align: "center" });
      doc.text(`Total Points: ${fmtNumber(totalPoints)}`, right, 53, { align: "right" });

      doc.text("Name: _______________________________________________", left, 62);
      doc.text("Student ID: ___________________________", 122, 62);
      doc.text("Date: __________________", 122, 69);

      doc.setFont("times", "italic");
      doc.setFontSize(9);
      doc.setTextColor(80);
      doc.text("Read each item carefully. Select or write the best answer as instructed.", left, 77);

      return 86;
    }

    let y = beginPage(true);

    const ensureSpace = (needed = 20) => {
      if (y + needed > bottomLimit) {
        y = beginPage(false);
      }
    };

    const split = (text, width) => doc.splitTextToSize(String(text || ""), width);

    for (const q of exam.questions || []) {
      const qNo = Number(q.position) || "";
      const pointText = Number(q.points) === 1 ? "1 point" : `${fmtNumber(q.points)} points`;
      const promptLines = split(`${qNo}. ${q.prompt || ""}`, 157);

      ensureSpace(8 + promptLines.length * 5);
      doc.setTextColor(20);
      doc.setFont("times", "bold");
      doc.setFontSize(10.5);
      doc.text(promptLines, left, y);

      doc.setFont("times", "italic");
      doc.setFontSize(8.5);
      doc.setTextColor(95);
      doc.text(pointText, right, y, { align: "right" });

      y += promptLines.length * 5 + 3;

      if (q.question_type === "mcq" && Array.isArray(q.choices)) {
        const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        q.choices.forEach((choice, index) => {
          const choiceLines = split(`${letters[index] || index + 1}. ${choice}`, 160);
          ensureSpace(choiceLines.length * 4.6 + 2);
          doc.setFont("times", "normal");
          doc.setFontSize(10);
          doc.setTextColor(30);
          doc.text(choiceLines, left + 7, y);
          y += choiceLines.length * 4.6 + 1.5;
        });
      } else {
        for (let line = 0; line < 4; line += 1) {
          ensureSpace(7);
          doc.setDrawColor(150);
          doc.line(left + 4, y + 2, right, y + 2);
          y += 7;
        }
      }

      y += 4;
    }

    const pageCount = doc.getNumberOfPages();
    for (let page = 1; page <= pageCount; page += 1) {
      doc.setPage(page);
      drawFooter(doc, page, pageCount);
    }

    return doc;
  }

  async function generateExamPdf(examId, button = null) {
    if (!examId) return;

    const oldText = button?.textContent;
    if (button) {
      button.disabled = true;
      button.textContent = "Generating…";
    }

    try {
      const exam = await fetchPublishedExam(examId);
      const doc = await buildExamPdf(exam);
      const filename = [
        "Examination",
        safeFilePart(exam.code),
        safeFilePart(exam.title)
      ].join("_") + ".pdf";
      doc.save(filename);
    } catch (error) {
      console.error("Exam PDF error:", error);
      alert(error?.message || "Could not generate the examination PDF.");
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = oldText || "Exam PDF";
      }
    }
  }

  window.ExamReport = {
    enableStudent,
    generateTeacher,
    generateExamPdf
  };
})();