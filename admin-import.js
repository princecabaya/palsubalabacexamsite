(() => {
  const fileInput = document.getElementById("examExcelFile");
  const importBtn = document.getElementById("importExamExcelBtn");
  const templateBtn = document.getElementById("downloadExamTemplateBtn");
  const msg = document.getElementById("excelImportMsg");
  const latexFileInput = document.getElementById("examLatexFile");
  const latexImportBtn = document.getElementById("importExamLatexBtn");
  const latexTemplateBtn = document.getElementById("downloadLatexTemplateBtn");
  const latexMsg = document.getElementById("latexImportMsg");

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
  latexTemplateBtn?.addEventListener("click", downloadLatexTemplate);
  latexImportBtn?.addEventListener("click", importLatexFile);

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


  async function importLatexFile() {
    setLatexMessage("");

    const file = latexFileInput?.files?.[0];
    if (!file) {
      setLatexMessage("Choose a LaTeX .tex file first.", true);
      return;
    }

    latexImportBtn.disabled = true;

    try {
      const source = await file.text();
      const parsed = parseLatexExam(source);

      if (!parsed.length) {
        throw new Error("No supported \\\\question entries were found in the LaTeX file.");
      }

      const builder = window.ExamBuilder;
      if (!builder?.replaceQuestions) {
        throw new Error("The question builder is not ready. Refresh the dashboard and try again.");
      }

      const currentCards = document.querySelectorAll("#questionBuilder .question-card");
      const hasExistingContent = [...currentCards].some(function(card) {
        return Boolean(card.querySelector(".q-prompt")?.value?.trim());
      });

      if (hasExistingContent) {
        const proceed = confirm(
          "Import " + parsed.length + " LaTeX question" +
          (parsed.length === 1 ? "" : "s") +
          " and replace the questions currently in the builder?"
        );
        if (!proceed) {
          setLatexMessage("Import cancelled. Existing questions were kept.");
          return;
        }
      }

      builder.replaceQuestions(parsed);
      setLatexMessage(
        "Imported " + parsed.length + " LaTeX question" +
        (parsed.length === 1 ? "" : "s") +
        " successfully. Review them, then click Save Exam."
      );
      builder.setMessage(
        parsed.length + " LaTeX question" +
        (parsed.length === 1 ? "" : "s") +
        " imported. Review the questions before saving."
      );

      document.getElementById("questionBuilder")?.scrollIntoView({
        behavior: "smooth",
        block: "start"
      });
    } catch (error) {
      console.error(error);
      setLatexMessage(error?.message || "Could not import the LaTeX file.", true);
    } finally {
      latexImportBtn.disabled = false;
    }
  }

  function parseLatexExam(source) {
    const text = stripLatexComments(String(source || "")).replace(/\\r\\n?/g, "\\n");
    const lines = text.split("\\n");
    const blocks = [];
    let current = null;

    for (const originalLine of lines) {
      const line = originalLine.trim();
      const match = line.match(/^\\\\question(?:\\[([^\\]]+)\\])?\\s*(.*)$/);

      if (match) {
        if (current) blocks.push(current);
        current = {
          points: parsePositiveNumber(match[1]) || 1,
          firstPrompt: match[2] || "",
          lines: []
        };
        continue;
      }

      if (current) current.lines.push(originalLine);
    }

    if (current) blocks.push(current);

    return blocks.map(function(block, index) {
      return parseLatexQuestionBlock(block, index + 1);
    });
  }

  function parseLatexQuestionBlock(block, number) {
    const raw = [block.firstPrompt].concat(block.lines).join("\\n").trim();
    const hasBinary = /\\\\begin\\{binary\\}/i.test(raw);
    const hasChoices = /\\\\begin\\{choices\\}/i.test(raw);
    const hasCriteria = /\\\\begin\\{essay\\}/i.test(raw) ||
      /\\\\begin\\{criteria\\}/i.test(raw) ||
      /\\\\criterion(?:\\[|\\{)/i.test(raw);

    const prompt = extractLatexPrompt(raw).trim();
    if (!prompt) throw new Error("LaTeX question " + number + " has no question text.");

    if (hasBinary || hasChoices) {
      const type = hasBinary ? "binary" : "mcq";
      const env = extractEnvironment(raw, hasBinary ? "binary" : "choices");
      const parsed = parseLatexChoices(env?.body || raw);

      if (parsed.choices.length < 2) {
        throw new Error("LaTeX question " + number + " needs at least two choices.");
      }
      if (type === "binary" && parsed.choices.length !== 2) {
        throw new Error("LaTeX question " + number + " Binary Response must contain exactly two choices.");
      }
      if (!parsed.correct) {
        throw new Error("LaTeX question " + number + " needs one \\\\CorrectChoice.");
      }

      return {
        prompt: prompt,
        question_type: type,
        choices: parsed.choices,
        correct_answer: parsed.correct,
        points: block.points,
        rubric_criteria: []
      };
    }

    if (hasCriteria) {
      const env = extractEnvironment(raw, "criteria");
      const criteria = parseLatexCriteria(env?.body || raw);
      if (!criteria.length) {
        throw new Error("LaTeX question " + number + " is an Essay but has no \\\\criterion entries.");
      }

      return {
        prompt: prompt,
        question_type: "essay",
        choices: null,
        correct_answer: null,
        points: criteria.reduce(function(sum, item) { return sum + item.max_points; }, 0),
        rubric_criteria: criteria
      };
    }

    throw new Error(
      "LaTeX question " + number +
      " has no supported answer block. Use choices, binary, or essay criteria."
    );
  }

  function extractLatexPrompt(raw) {
    const tokens = [
      "\\\\begin{choices}",
      "\\\\begin{binary}",
      "\\\\begin{essay}",
      "\\\\begin{criteria}",
      "\\\\criterion"
    ];
    let end = raw.length;

    tokens.forEach(function(token) {
      const pos = raw.indexOf(token);
      if (pos >= 0 && pos < end) end = pos;
    });

    let prompt = raw.slice(0, end).trim();
    if (prompt.startsWith("{") && prompt.endsWith("}")) {
      const group = readBraceGroup(prompt, 0);
      if (group && group.end === prompt.length) prompt = group.value.trim();
    }
    return prompt;
  }

  function extractEnvironment(raw, name) {
    const begin = "\\\\begin{" + name + "}";
    const endToken = "\\\\end{" + name + "}";
    const start = raw.indexOf(begin);
    if (start < 0) return null;
    const end = raw.indexOf(endToken, start + begin.length);
    return {
      body: raw.slice(start + begin.length, end >= 0 ? end : raw.length)
    };
  }

  function parseLatexChoices(body) {
    const lines = String(body || "").split("\\n");
    const choices = [];
    let correct = "";

    lines.forEach(function(line) {
      const match = line.trim().match(/^\\\\(CorrectChoice|choice)\\b\\s*(.*)$/i);
      if (!match) return;

      const isCorrect = /^CorrectChoice$/i.test(match[1]);
      let value = match[2].trim();

      if (value.startsWith("{")) {
        const group = readBraceGroup(value, 0);
        if (group) value = group.value.trim();
      }

      if (!value) throw new Error("A LaTeX choice is blank.");
      choices.push(value);

      if (isCorrect) {
        if (correct) throw new Error("Only one \\\\CorrectChoice is allowed per question.");
        correct = value;
      }
    });

    return { choices: choices, correct: correct };
  }

  function parseLatexCriteria(body) {
    const source = String(body || "");
    const criteria = [];
    const token = "\\\\criterion";
    let cursor = 0;

    while (cursor < source.length) {
      const start = source.indexOf(token, cursor);
      if (start < 0) break;

      let pos = start + token.length;
      while (/\\s/.test(source[pos] || "")) pos += 1;

      let points = null;
      if (source[pos] === "[") {
        const close = source.indexOf("]", pos + 1);
        if (close < 0) throw new Error("A \\\\criterion point value is missing its closing ].");
        points = parsePositiveNumber(source.slice(pos + 1, close));
        pos = close + 1;
      }

      while (/\\s/.test(source[pos] || "")) pos += 1;
      const name = readBraceGroup(source, pos);
      if (!name) throw new Error("A \\\\criterion is missing {Criterion Name}.");
      pos = name.end;

      while (/\\s/.test(source[pos] || "")) pos += 1;
      const description = readBraceGroup(source, pos);
      if (!description) throw new Error("A \\\\criterion is missing {Description}.");
      pos = description.end;

      if (!points) {
        throw new Error(
          'Criterion "' + name.value.trim() +
          '" needs positive points, e.g. \\\\criterion[5]{...}{...}.'
        );
      }

      criteria.push({
        criterion: name.value.trim(),
        description: description.value.trim(),
        max_points: points
      });

      cursor = Math.max(pos, start + token.length);
    }

    return criteria;
  }

  function readBraceGroup(source, start) {
    if (source[start] !== "{") return null;
    let depth = 0;

    for (let i = start; i < source.length; i += 1) {
      if (source[i] === "{" && source[i - 1] !== "\\\\") depth += 1;
      if (source[i] === "}" && source[i - 1] !== "\\\\") {
        depth -= 1;
        if (depth === 0) {
          return { value: source.slice(start + 1, i), end: i + 1 };
        }
      }
    }

    return null;
  }

  function stripLatexComments(source) {
    return source.split(/\\r?\\n/).map(function(line) {
      let out = "";
      for (let i = 0; i < line.length; i += 1) {
        if (line[i] === "%" && line[i - 1] !== "\\\\") break;
        out += line[i];
      }
      return out;
    }).join("\\n");
  }

  function parsePositiveNumber(value) {
    const number = Number(String(value ?? "").trim());
    return Number.isFinite(number) && number > 0 ? number : null;
  }

  function setLatexMessage(text, isError = false) {
    if (!latexMsg) return;
    latexMsg.textContent = text || "";
    latexMsg.classList.toggle("error", Boolean(isError));
    latexMsg.classList.toggle("success", Boolean(text) && !isError);
  }

  function downloadLatexTemplate() {
    const template = [
      "\\\\documentclass{exam}",
      "\\\\begin{document}",
      "",
      "% Multiple Choice",
      "\\\\question[1] Simplify \\\\(x=2\\\\left(\\\\frac{1}{y+4}\\\\right)\\\\).",
      "\\\\begin{choices}",
      "  \\\\choice \\\\(x=\\\\frac{1}{y+4}\\\\)",
      "  \\\\CorrectChoice \\\\(x=\\\\frac{2}{y+4}\\\\)",
      "  \\\\choice \\\\(x=\\\\frac{y+4}{2}\\\\)",
      "  \\\\choice \\\\(x=2(y+4)\\\\)",
      "\\\\end{choices}",
      "",
      "% Binary Response",
      "\\\\question[1] The number \\\\(2\\\\) is prime.",
      "\\\\begin{binary}",
      "  \\\\CorrectChoice True",
      "  \\\\choice False",
      "\\\\end{binary}",
      "",
      "% Essay",
      "\\\\question Explain how you would solve a word problem involving fractions.",
      "\\\\begin{essay}",
      "\\\\begin{criteria}",
      "  \\\\criterion[5]{Mathematical Reasoning}{Explains a correct and logical solution process.}",
      "  \\\\criterion[3]{Accuracy}{Uses correct mathematical operations and conclusions.}",
      "  \\\\criterion[2]{Communication}{Presents the explanation clearly and coherently.}",
      "\\\\end{criteria}",
      "\\\\end{essay}",
      "",
      "\\\\end{document}",
      ""
    ].join("\\n");

    const blob = new Blob([template], { type: "text/x-tex;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "Exam_Question_Import_Template.tex";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
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