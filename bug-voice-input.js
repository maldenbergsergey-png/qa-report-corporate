(function () {
  "use strict";
  async function wav(blob) {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio || !window.OfflineAudioContext) throw new Error("Браузер не может подготовить запись. Используйте диктовку браузера или введите текст.");
    const context = new Audio(); let decoded;
    try { decoded = await context.decodeAudioData(await blob.arrayBuffer()); } finally { await context.close(); }
    if (!decoded.duration || decoded.duration > 181) throw new Error("Запишите фрагмент не длиннее 3 минут.");
    const count = Math.min(16000 * 180, Math.ceil(decoded.duration * 16000)), offline = new OfflineAudioContext(1, count, 16000);
    const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start();
    const samples = (await offline.startRendering()).getChannelData(0), bytes = new Uint8Array(44 + samples.length * 2), view = new DataView(bytes.buffer);
    const tag = (offset, text) => [...text].forEach((c, i) => { bytes[offset + i] = c.charCodeAt(0); });
    tag(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); tag(8, "WAVE"); tag(12, "fmt "); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, "data"); view.setUint32(40, samples.length * 2, true);
    samples.forEach((sample, i) => { const value = Math.max(-1, Math.min(1, sample)); view.setInt16(44 + i * 2, value < 0 ? value * 32768 : value * 32767, true); });
    let binary = ""; for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    // This encoder writes canonical PCM WAV; the receiving server validates it again.
    return { type: "audio/wav", dataBase64: btoa(binary) };
  }
  class VoiceInput {
    constructor({ onText, onState, onMeter = () => {}, transcribe, transform }) { this.transform = transform; this.onText = onText; this.onState = onState; this.onMeter = onMeter; this.transcribe = transcribe; this.token = 0; this.phase = "idle"; }
    update(phase, text = "") { this.phase = phase; this.onState({ phase, text }); }
    releaseInput() {
      cancelAnimationFrame(this.frame); this.frame = null;
      this.source?.disconnect(); this.source = null; this.analyser = null;
      this.audioContext?.close().catch(() => {}); this.audioContext = null;
      this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    }
    meter(token) {
      this.startedAt = performance.now(); const levels = Array(64).fill(0), samples = new Float32Array(512); let last = 0;
      const tick = now => {
        if (token !== this.token || this.phase !== "recording") return;
        if (now - last >= 70) {
          last = now; let level = 0;
          if (this.analyser) { this.analyser.getFloatTimeDomainData(samples); level = Math.min(1, Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length) * 6); }
          levels.shift(); levels.push(level); this.onMeter({ levels, elapsed: (now - this.startedAt) / 1000, available: Boolean(this.analyser) });
        }
        this.frame = requestAnimationFrame(tick);
      };
      this.frame = requestAnimationFrame(tick);
    }
    async deliver(text, speech, token) {
      let warning = "";
      if (this.transform && speech.processing && speech.processing !== "none") {
        this.update("processing", "Приводим текст в порядок…");
        try {
          const refined = await this.transform(text, speech.selection);
          if (typeof refined !== "string" || !refined.trim() || refined.length > 20000) throw new Error("ИИ не вернул готовый текст");
          text = refined;
        }
        catch (error) { warning = ` Без обработки: ${error.message}`; }
      }
      if (token !== this.token) return;
      await this.onText(text);
      if (token === this.token) this.update("idle", "Диктовка добавлена. Проверьте текст." + warning);
    }
    async start(speech) {
      this.cancel(); const token = this.token;
      try {
        const browser = speech.mode === "browser", Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (browser && !Recognition) throw new Error("Диктовка недоступна в этом браузере. Выберите локальную модель или ИИ в Connect: ИИ → Распознавание речи.");
        if (!browser && !speech.available) throw new Error(speech.reason || "Настройте распознавание речи в Connect.");
        if (!navigator.mediaDevices?.getUserMedia || (!browser && !window.MediaRecorder)) throw new Error("Запись недоступна в этом браузере. Откройте QA Report по HTTPS или используйте текст.");
        this.update("starting", "Подключаем микрофон… Если браузер запросит доступ, разрешите его.");
        // Create/resume inside the click gesture; do not wait for a Connect job before capturing audio.
        const Audio = window.AudioContext || window.webkitAudioContext;
        const context = Audio ? new Audio() : null; this.audioContext = context;
        context?.resume().catch(() => {});
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true }, video: false });
        if (token !== this.token) { stream.getTracks().forEach(track => track.stop()); return; }
        this.stream = stream;
        if (context) {
          try { this.source = context.createMediaStreamSource(stream); this.analyser = context.createAnalyser(); this.analyser.fftSize = 512; this.source.connect(this.analyser); } catch { this.analyser = null; }
        }
        if (browser) {
          const recognition = this.recognition = new Recognition(); recognition.lang = speech.language === "en" ? "en-US" : "ru-RU"; recognition.continuous = true; recognition.interimResults = true;
          const final = new Map(), completed = []; let failed = false;
          recognition.onstart = () => { if (token === this.token) { this.update("recording", "Запись идёт. Нажмите квадрат, чтобы закончить, или крестик, чтобы отменить."); if (!this.frame) this.meter(token); } };
          recognition.onresult = event => {
            if (token !== this.token) return;
            let interim = "";
            for (let i = event.resultIndex; i < event.results.length; i++) {
              if (event.results[i].isFinal) final.set(i, event.results[i][0].transcript.trim());
              else interim += event.results[i][0].transcript;
            }
            if (interim && this.phase === "recording") this.update("recording", `Слушаю: ${interim.slice(0, 300)}`);
          };
          recognition.onerror = event => {
            // Silence ends a browser recognition session, not the user's recording.
            if (event.error === "no-speech" && token === this.token) return;
            if (token !== this.token) return; failed = true; this.releaseInput();
            const errors = { "not-allowed": "Разрешите микрофон в настройках браузера и повторите диктовку.", "service-not-allowed": "Сервис диктовки браузера недоступен. Выберите локальную модель или ИИ в Connect.", "audio-capture": "Микрофон недоступен. Проверьте его подключение и разрешения.", "network": "Сервис диктовки браузера недоступен. Проверьте интернет или выберите локальную модель в Connect.", "no-speech": "Речь не распознана. Повторите диктовку ближе к микрофону." };
            this.update("error", errors[event.error] || "Не удалось распознать речь. Повторите диктовку или введите текст.");
          };
          const finish = this.finishRecognition = async () => {
            if (token !== this.token) return;
            clearTimeout(this.timer); clearTimeout(this.restartTimer); this.restartTimer = null; this.recognition = null; this.finishRecognition = null; this.releaseInput();
            if (!failed) { try { const text = [...completed, ...final.values()].filter(Boolean).join(" "); if (text) await this.deliver(text, speech, token); else this.update("idle", "Речь не распознана. Повторите запись."); } catch (error) { if (token === this.token) this.update("error", error.message); } }
          };
          recognition.onend = () => {
            if (token !== this.token) return;
            if (failed || this.phase === "stopping") { finish(); return; }
            completed.push(...[...final.values()].filter(Boolean)); final.clear();
            this.restartTimer = setTimeout(() => {
              this.restartTimer = null;
              if (token !== this.token || this.phase === "stopping") return;
              try { recognition.start(); }
              catch { failed = true; finish(); this.update("error", "Сервис диктовки браузера недоступен. Выберите локальную модель или ИИ в Connect."); }
            }, 200);
          };
          recognition.start(); this.timer = setTimeout(() => this.stop(), 180000); return;
        }
        const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find(value => MediaRecorder.isTypeSupported(value));
        const recorder = this.recorder = new MediaRecorder(stream, type ? { mimeType: type } : {}), chunks = []; let size = 0;
        recorder.ondataavailable = event => { if (token === this.token && event.data.size) { chunks.push(event.data); size += event.data.size; if (size > 8 * 1024 * 1024) this.stop(); } };
        recorder.onerror = () => { if (token === this.token) { this.cancel(); this.update("error", "Запись не удалась. Повторите диктовку или введите текст."); } };
        recorder.onstop = async () => {
          if (token !== this.token) { chunks.length = 0; return; }
          this.releaseInput(); this.recorder = null; clearTimeout(this.timer);
          this.update("transcribing", speech.mode === "local" ? "Распознаём запись на компьютере…" : "ИИ распознаёт запись…");
          try {
            if (!size || size > 8 * 1024 * 1024) throw new Error("Запись пустая или слишком большая. Повторите более короткий фрагмент.");
            const audio = await wav(new Blob(chunks, { type: recorder.mimeType })); chunks.length = 0;
            if (token !== this.token) return;
            const result = await this.transcribe(audio, speech.selection);
            if (token !== this.token) return; await this.deliver(result.text, speech, token);
          } catch (error) { if (token === this.token) this.update("error", error.message); }
        };
        recorder.start(1000); this.update("recording", "Запись идёт. Нажмите квадрат, чтобы распознать, или крестик, чтобы отменить. До 3 минут."); this.meter(token); this.timer = setTimeout(() => this.stop(), 180000);
      } catch (error) {
        if (token === this.token) { this.cancel(); this.update("error", error.name === "NotAllowedError" ? "Разрешите микрофон в настройках браузера и повторите запись." : error.message); }
      }
    }
    stop() { if (this.phase !== "recording") return; clearTimeout(this.timer); this.update("stopping", "Завершаем запись…"); if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; this.finishRecognition?.(); } else this.recognition?.stop(); if (this.recorder?.state === "recording") this.recorder.stop(); this.releaseInput(); }
    cancel() { this.token++; clearTimeout(this.timer); clearTimeout(this.restartTimer); this.restartTimer = null; this.finishRecognition = null; this.recognition?.abort(); this.recognition = null; if (this.recorder?.state === "recording") this.recorder.stop(); this.releaseInput(); this.recorder = null; this.phase = "idle"; }
  }
  window.QaReportVoiceInput = { VoiceInput, wav };
})();
