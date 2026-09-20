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
        status.textContent = "AI feedback is not available right now. Your exam submission was still recorded successfully.";
      }
    }
  };
})();