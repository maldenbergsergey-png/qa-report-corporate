(function () {
  "use strict";
  function init({ api, capture, insert, setup }) {
    const button = document.getElementById("dictationButton"), toolbar = button.closest(".editor-toolbar");
    const status = document.getElementById("dictationStatus"), destination = document.getElementById("dictationDestination");
    const cancel = document.getElementById("dictationCancel"), recovery = document.getElementById("dictationRecovery"), result = document.getElementById("dictationResult");
    let phase = "idle", attempt = 0, candidate = null, target = null, speech, delivering = false;
    const busy = () => ["starting", "recording", "stopping", "transcribing", "processing"].includes(phase);
    function describe() { destination.textContent = (busy() ? target : candidate)?.label || "В буфер обмена"; destination.title = destination.textContent; }
    function state(next, message) {
      phase = next; toolbar.dataset.dictationPhase = phase;
      button.disabled = ["starting", "stopping", "transcribing", "processing"].includes(phase);
      button.setAttribute("aria-pressed", String(phase === "recording"));
      button.setAttribute("aria-label", phase === "recording" ? "Завершить диктовку" : "Надиктовать текст");
      button.title = button.getAttribute("aria-label");
      status.textContent = message; status.hidden = !message;
      cancel.hidden = !busy(); describe();
      document.getElementById("dictationSetup").hidden = next !== "error";
      if (!busy()) { target?.editor?.classList.remove("dictation-target"); target = null; }
    }
    async function job(path, payload, id) {
      const queued = await api(path, { method: "POST", body: JSON.stringify(payload) });
      const deadline = Date.now() + 180000;
      while (id === attempt && Date.now() < deadline) {
        const value = await api(`/api/agent/jobs/${queued.jobId}`);
        if (id !== attempt) throw new Error("Диктовка отменена");
        if (value.job.status === "completed") return value.job.result;
        if (["failed", "expired"].includes(value.job.status)) throw new Error(value.job.error || "Connect не завершил действие");
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
      throw new Error("Connect не завершил действие. Проверьте подключение и повторите диктовку.");
    }
    async function clipboard(text) {
      try { await navigator.clipboard.writeText(text); return true; }
      catch { return false; }
    }
    async function receive(text) {
      const id = attempt; delivering = true; let warning = "";
      try {
        if (speech.processing && speech.processing !== "none") {
          state("processing", "Приводим текст в порядок…");
          try {
            const refined = await job("/api/ai/refine", { text, selection: speech.selection }, id);
            if (typeof refined.text !== "string" || !refined.text.trim() || refined.text.length > 20000) throw new Error("ИИ не вернул готовый текст");
            text = refined.text;
          }
          catch (error) { if (id !== attempt) return; warning = `Без обработки: ${error.message}`; }
        }
        if (id !== attempt) return;
        if (typeof text !== "string" || !text.trim()) throw new Error("Речь не распознана. Повторите диктовку.");
        // Keep a recoverable copy until insertion or clipboard access has succeeded.
        result.value = text;
        const inserted = target && insert(target, text);
        const copied = !inserted && await clipboard(text);
        if (id !== attempt) return;
        recovery.hidden = Boolean(inserted || copied);
        if (recovery.hidden) result.value = "";
        state("idle", `${inserted ? "Текст вставлен" : copied ? "Текст скопирован в буфер обмена" : "Текст готов. Нажмите «Скопировать текст»"}${warning ? ". " + warning : ""}`);
      } catch (error) { if (id === attempt) { recovery.hidden = !result.value; state("error", error.message); } }
      finally { if (id === attempt) delivering = false; }
    }
    const voice = new window.QaReportVoiceInput.VoiceInput({
      onText: receive,
      onState: value => {
        if (delivering) return;
        if (value.phase === "idle" && !busy()) return;
        const text = value.phase === "recording" ? "REC · Запись" : value.phase === "transcribing" ? "Распознаём…" : value.text;
        state(value.phase, text);
      },
      onMeter: ({ elapsed }) => {
        if (phase === "recording") { const seconds = Math.floor(elapsed); status.textContent = `REC · Запись ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; }
      },
      transcribe: (audio, selection) => job("/api/ai/transcribe", { audio, selection }, attempt),
    });
    button.addEventListener("click", async () => {
      if (phase === "recording") { voice.stop(); return; }
      if (busy()) return;
      // An uncopied result must never be discarded by another recording.
      if (!recovery.hidden) { result.focus(); return; }
      const id = ++attempt; target = candidate; target?.editor?.classList.add("dictation-target");
      state("starting", "Подключаем микрофон…");
      try {
        const settings = await job("/api/ai/profiles", {}, id);
        if (id !== attempt) return;
        speech = settings.speech;
        if (!speech) throw new Error("Обновите QA Report Connect для диктовки.");
        if (!speech.available) throw new Error(speech.reason || "Настройте распознавание речи в Connect.");
        if (speech.processingAvailable === false) throw new Error("Выберите модель ИИ по умолчанию для обработки диктовки в Connect.");
        await voice.start(speech);
      } catch (error) { if (id === attempt) state("error", error.message); }
    });
    function abort() { attempt++; delivering = false; voice.cancel(); state("idle", "Диктовка отменена"); }
    cancel.addEventListener("click", abort);
    document.addEventListener("keydown", event => { if (event.key === "Escape" && busy()) { event.preventDefault(); abort(); } });
    window.addEventListener("pagehide", abort);
    document.addEventListener("selectionchange", () => { if (!busy() && document.activeElement?.matches(".cell-editor, .intro-editor, .section-title")) { candidate = capture(); describe(); } });
    document.addEventListener("focusin", event => {
      if (busy()) return;
      if (event.target.matches(".cell-editor, .intro-editor, .section-title")) candidate = capture();
      else if (!toolbar.contains(event.target)) candidate = null;
      describe();
    });
    document.addEventListener("pointerdown", event => {
      if (busy()) return;
      if (event.target.closest("#dictationButton")) candidate = capture() || candidate;
      else if (!event.target.closest(".cell-editor, .intro-editor, .section-title, .editor-toolbar")) candidate = null;
      describe();
    });
    document.getElementById("dictationCopy").addEventListener("click", async () => {
      if (await clipboard(result.value)) { result.value = ""; recovery.hidden = true; state("idle", "Текст скопирован в буфер обмена"); }
      else { result.focus(); result.select(); state("error", "Скопируйте выделенный текст с помощью Ctrl+C или ⌘C"); }
    });
    document.getElementById("dictationDiscard").addEventListener("click", () => { result.value = ""; recovery.hidden = true; state("idle", ""); });
    document.getElementById("dictationSetup").addEventListener("click", setup);
    describe();
    return { cancel: abort };
  }
  window.QaReportDictation = { init };
})();
