(() => {
  const fileInput = document.getElementById("examExcelFile");
  const importBtn = document.getElementById("importExamExcelBtn");
  const templateBtn = document.getElementById("downloadExamTemplateBtn");
  const msg = document.getElementById("excelImportMsg");

  if (!fileInput || !importBtn || !templateBtn) return;

  const REQUIRED = [
    "Item Number",
    "Item Stem",
    "Option A",
    "Option B",
    "Option C",
    "Option D",
    "Correct Answer"
  ];

  templateBtn.addEventListener("click", downloadTemplate);
  importBtn.addEventListener("click", importWorkbook);

  async function importWorkbook() {
    setMessage("");

    const file = fileInput.files?.[0];
    if (!file) {
      setMessage("Choose an Excel file first.", true);
      return;
    }

    if (!window.XLSX) {
      setMessage("The Excel reader did not load. Refresh the page and try again.", true);
      return;
    }

    importBtn.disabled = true;

    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: "array", cellDates: false });

      const firstSheetName = workbook.SheetNames[0];
      if (!firstSheetName) throw new Error("The workbook does not contain a worksheet.");

      const worksheet = workbook.Sheets[firstSheetName];
      const rawRows = XLSX.utils.sheet_to_json(worksheet, {
        defval: "",
        raw: false,
        blankrows: false
      });

      if (!rawRows.length) {
        throw new Error("The first worksheet has no question rows.");
      }

      const availableHeaders = Object.keys(rawRows[0] || {});
      const headerMap = buildHeaderMap(availableHeaders);
      const missing = REQUIRED.filter(name => !headerMap[name]);

      if (missing.length) {
        throw new Error(
          "Missing required column" + (missing.length === 1 ? "" : "s") +
          ": " + missing.join(", ")
        );
      }

      const parsed = [];
      const errors = [];
      const seenItemNumbers = new Set();

      rawRows.forEach((row, index) => {
        const excelRow = index + 2;

        const itemNumberRaw = readCell(row, headerMap["Item Number"]);
        const itemStem = readCell(row, headerMap["Item Stem"]);
        const optionA = readCell(row, headerMap["Option A"]);
        const optionB = readCell(row, headerMap["Option B"]);
        const optionC = readCell(row, headerMap["Option C"]);
        const optionD = readCell(row, headerMap["Option D"]);
        const correctRaw = readCell(row, headerMap["Correct Answer"]);

        // Completely blank rows are ignored.
        if (![itemNumberRaw,itemStem,optionA,optionB,optionC,optionD,correctRaw].some(Boolean)) return;

        const rowErrors = [];
        if (!itemNumberRaw) rowErrors.push("Item Number is blank");
        if (!itemStem) rowErrors.push("Item Stem is blank");
        if (!optionA) rowErrors.push("Option A is blank");
        if (!optionB) rowErrors.push("Option B is blank");
        if (!optionC) rowErrors.push("Option C is blank");
        if (!optionD) rowErrors.push("Option D is blank");
        if (!correctRaw) rowErrors.push("Correct Answer is blank");

        const itemKey = itemNumberRaw.toLowerCase();
        if (itemNumberRaw && seenItemNumbers.has(itemKey)) {
          rowErrors.push(`duplicate Item Number "${itemNumberRaw}"`);
        } else if (itemNumberRaw) {
          seenItemNumbers.add(itemKey);
        }

        const choices = [optionA, optionB, optionC, optionD];
        const nonEmptyChoices = choices.filter(Boolean);
        const normalizedChoices = nonEmptyChoices.map(normalize);
        if (new Set(normalizedChoices).size !== normalizedChoices.length) {
          rowErrors.push("options contain duplicate answer text");
        }

        let correctAnswer = "";
        if (correctRaw && nonEmptyChoices.length === 4) {
          correctAnswer = resolveCorrectAnswer(correctRaw, choices);
          if (!correctAnswer) {
            rowErrors.push(
              `Correct Answer "${correctRaw}" does not match A/B/C/D or any option text`
            );
          }
        }

        if (rowErrors.length) {
          errors.push(`Excel row ${excelRow}: ${rowErrors.join("; ")}.`);
          return;
        }

        parsed.push({
          sourceOrder: index,
          itemNumber: itemNumberRaw,
          sortNumber: parseItemNumber(itemNumberRaw),
          prompt: itemStem,
          question_type: "mcq",
          choices,
          correct_answer: correctAnswer,
          points: 1
        });
      });

      if (errors.length) {
        const preview = errors.slice(0, 8).join(" ");
        const more = errors.length > 8 ? ` Plus ${errors.length - 8} more error(s).` : "";
        throw new Error(preview + more);
      }

      if (!parsed.length) {
        throw new Error("No valid question rows were found.");
      }

      parsed.sort((a, b) => {
        const an = a.sortNumber;
        const bn = b.sortNumber;
        if (an !== null && bn !== null && an !== bn) return an - bn;
        if (an !== null && bn === null) return -1;
        if (an === null && bn !== null) return 1;
        return a.sourceOrder - b.sourceOrder;
      });

      const builder = window.ExamBuilder;
      if (!builder?.replaceQuestions) {
        throw new Error("The question builder is not ready. Refresh the dashboard and try again.");
      }

      const currentCards = document.querySelectorAll("#questionBuilder .question-card");
      const hasExistingContent = [...currentCards].some(card => {
        const prompt = card.querySelector(".q-prompt")?.value?.trim();
        return Boolean(prompt);
      });

      if (hasExistingContent) {
        const proceed = confirm(
          `Import ${parsed.length} questions and replace the questions currently in the builder?`
        );
        if (!proceed) {
          setMessage("Import cancelled. Existing questions were kept.");
          return;
        }
      }

      builder.replaceQuestions(parsed.map(({prompt,question_type,choices,correct_answer,points}) => ({
        prompt, question_type, choices, correct_answer, points
      })));

      setMessage(
        `Imported ${parsed.length} question${parsed.length === 1 ? "" : "s"} successfully. Review them, then click Save Exam.`
      );

      builder.setMessage(
        `${parsed.length} Excel question${parsed.length === 1 ? "" : "s"} imported. Review the questions before saving.`
      );

      document.getElementById("questionBuilder")?.scrollIntoView({
        behavior: "smooth",
        block: "start"
      });
    } catch (error) {
      console.error(error);
      setMessage(error?.message || "Could not import the Excel file.", true);
    } finally {
      importBtn.disabled = false;
    }
  }

  function buildHeaderMap(headers) {
    const normalized = new Map(headers.map(header => [normalizeHeader(header), header]));
    const map = {};

    const aliases = {
      "Item Number": ["item number","item no","item no.","item #","number","no","no."],
      "Item Stem": ["item stem","stem","question","question stem","item","question text"],
      "Option A": ["option a","a","choice a","answer a"],
      "Option B": ["option b","b","choice b","answer b"],
      "Option C": ["option c","c","choice c","answer c"],
      "Option D": ["option d","d","choice d","answer d"],
      "Correct Answer": ["correct answer","answer","key","answer key","correct option","correct"]
    };

    for (const required of REQUIRED) {
      const candidates = aliases[required] || [required];
      for (const alias of candidates) {
        const actual = normalized.get(normalizeHeader(alias));
        if (actual) {
          map[required] = actual;
          break;
        }
      }
    }
    return map;
  }

  function resolveCorrectAnswer(raw, choices) {
    const value = String(raw).trim();
    const token = value
      .toUpperCase()
      .replace(/^OPTION\s+/, "")
      .replace(/^CHOICE\s+/, "")
      .replace(/[\.\)\:\-\s]+$/g, "")
      .trim();

    const letterMap = { A:0, B:1, C:2, D:3, "1":0, "2":1, "3":2, "4":3 };
    if (Object.prototype.hasOwnProperty.call(letterMap, token)) {
      return choices[letterMap[token]] || "";
    }

    const target = normalize(value);
    const matchIndex = choices.findIndex(choice => normalize(choice) === target);
    return matchIndex >= 0 ? choices[matchIndex] : "";
  }

  function parseItemNumber(value) {
    const cleaned = String(value).trim();
    const direct = Number(cleaned);
    if (Number.isFinite(direct)) return direct;

    const match = cleaned.match(/\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : null;
  }

  function readCell(row, key) {
    return String(row?.[key] ?? "").trim();
  }

  function normalize(value) {
    return String(value ?? "").trim().toLocaleLowerCase();
  }

  function normalizeHeader(value) {
    return String(value ?? "")
      .replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLocaleLowerCase();
  }

  function setMessage(text, isError = false) {
    msg.textContent = text || "";
    msg.classList.toggle("error", Boolean(isError));
    msg.classList.toggle("success", Boolean(text) && !isError);
  }

  function downloadTemplate() {
    if (!window.XLSX) {
      setMessage("The Excel library did not load. Refresh the page and try again.", true);
      return;
    }

    const headers = [[
      "Item Number",
      "Item Stem",
      "Option A",
      "Option B",
      "Option C",
      "Option D",
      "Correct Answer"
    ]];

    const ws = XLSX.utils.aoa_to_sheet(headers);
    ws["!cols"] = [
      { wch: 14 },
      { wch: 60 },
      { wch: 28 },
      { wch: 28 },
      { wch: 28 },
      { wch: 28 },
      { wch: 18 }
    ];

    const instructions = [
      ["Exam Question Import Template"],
      [""],
      ["Column", "Instruction"],
      ["Item Number", "Required. Use 1, 2, 3, ... to control question order."],
      ["Item Stem", "Required. Enter the full multiple-choice question."],
      ["Option A-D", "Required. Enter four answer choices."],
      ["Correct Answer", "Required. You may enter A, B, C, D; 1, 2, 3, 4; or the exact option text."],
      [""],
      ["Note", "The importer reads the first worksheet. Keep Questions as the first worksheet."]
    ];
    const infoWs = XLSX.utils.aoa_to_sheet(instructions);
    infoWs["!cols"] = [{ wch: 20 }, { wch: 80 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Questions");
    XLSX.utils.book_append_sheet(wb, infoWs, "Instructions");
    XLSX.writeFile(wb, "Exam_Question_Import_Template.xlsx");
  }
})();