(() => {
  const cfg = window.EXAM_CONFIG || {};
  const db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });

  window.ExamAI = {
    async generateFeedback(attemptToken, result = {}) {
      const panel = document.getElementById("aiFeedbackPanel");
      const status = document.getElementById("aiFeedbackStatus");
      const list = document.getElementById("aiFeedbackItems");
      if (!panel || !status || !list || !attemptToken) return;

      const score = Number(result?.score);
      const maxScore = Number(result?.maxScore);
      const hasValidScore = Number.isFinite(score) && Number.isFinite(maxScore) && maxScore > 0;

      if (hasValidScore && score >= maxScore) {
        panel.classList.remove("hidden");
        list.innerHTML = "";
        status.textContent = "Excellent work — all auto-scored answers were correct, so no corrective AI feedback is needed.";
        return;
      }

      panel.classList.remove("hidden");
      list.innerHTML = "";
      status.textContent = "Preparing personalized feedback for incorrect answers…";

      try {
        const { data, error } = await db.functions.invoke("generate-feedback", {
          body: { attempt_token: attemptToken }
        });

        if (error) throw error;

        const items = Array.isArray(data?.feedback) ? data.feedback : [];
        if (!items.length) {
          status.textContent = data?.message || "No incorrect auto-scored answers need feedback.";
          return;
        }

        status.textContent = `Feedback generated for ${items.length} incorrect answer${items.length === 1 ? "" : "s"}.`;

        for (const item of items) {
          const article = document.createElement("article");
          article.className = "feedback-item";

          const heading = document.createElement("h3");
          heading.textContent = `Question ${item.position ?? ""}`.trim();

          const answer = document.createElement("p");
          answer.className = "feedback-answer";
          answer.textContent = `Your answer: ${item.answer || "No answer"}`;

          const feedback = document.createElement("p");
          feedback.className = "feedback-text";
          feedback.textContent = item.feedback || "Review this concept with your instructor.";

          article.append(heading, answer, feedback);
          list.appendChild(article);
        }
      } catch (err) {
        console.warn("AI feedback unavailable:", err);

        const detail = await readFunctionError(err);
        if (/missing_gemini_api_key|GEMINI_API_KEY is missing|not been configured|503/i.test(detail)) {
          status.textContent = "AI feedback is not configured yet: GEMINI_API_KEY is missing from Supabase Edge Function Secrets.";
        } else if (/not found|404/i.test(detail) && /function|generate-feedback/i.test(detail)) {
          status.textContent = "AI feedback is not configured yet: the Supabase Edge Function generate-feedback was not found.";
        } else if (/feedback_generated_at|ai_feedback|column/i.test(detail)) {
          status.textContent = "AI feedback database storage is not configured yet. Run the AI feedback Supabase upgrade SQL.";
        } else if (/gemini_api_error|Gemini rejected/i.test(detail)) {
          const reason = extractServerReason(detail);
          status.textContent = "Gemini could not generate feedback" + (reason ? `: ${reason}` : ". Check the API key and model.");
        } else if (/Invalid JWT|JWT/i.test(detail)) {
          status.textContent = "The Edge Function authorization settings rejected the browser request. Check the generate-feedback function authentication setting.";
        } else {
          const reason = extractServerReason(detail);
          status.textContent = reason
            ? `AI feedback is unavailable: ${reason}`
            : "AI feedback is unavailable right now. Your exam submission was still recorded successfully.";
        }
      }

      function extractServerReason(detail) {
        try {
          const parsed = JSON.parse(detail);
          return String(parsed?.detail || parsed?.error || parsed?.message || "").trim();
        } catch (_) {
          return "";
        }
      }

      async function readFunctionError(err) {
        try {
          const context = err?.context;
          if (context && typeof context.json === "function") {
            const body = await context.clone().json();
            return JSON.stringify(body);
          }
          if (context && typeof context.text === "function") {
            return await context.clone().text();
          }
        } catch (_) {}
        return String(err?.message || err || "");
      }
    }
  };
})();