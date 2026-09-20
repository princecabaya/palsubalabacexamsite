(() => {
  const cfg = window.EXAM_CONFIG || {};
  const db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });

  window.ExamAI = {
    async generateFeedback(attemptToken) {
      const panel = document.getElementById("aiFeedbackPanel");
      const status = document.getElementById("aiFeedbackStatus");
      const list = document.getElementById("aiFeedbackItems");
      if (!panel || !status || !list || !attemptToken) return;

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
        if (/not found|404/i.test(detail)) {
          status.textContent = "AI feedback is not configured yet: the Supabase Edge Function generate-feedback was not found.";
        } else if (/GEMINI_API_KEY|not been configured|503/i.test(detail)) {
          status.textContent = "AI feedback is not configured yet: the Gemini API key is missing from Supabase Edge Function secrets.";
        } else if (/feedback_generated_at|ai_feedback|column/i.test(detail)) {
          status.textContent = "AI feedback database storage is not configured yet. Run the AI feedback Supabase upgrade SQL.";
        } else {
          status.textContent = "AI feedback is unavailable right now. Your exam submission was still recorded successfully.";
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