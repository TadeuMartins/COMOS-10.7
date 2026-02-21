// ─────────────────────────────────────────────────────────────────────────────
// SpeechRecognition Polyfill — SERVER-SIDE Recording
//
// CefSharp loads pages via localfolder:// which is NOT a secure context.
// navigator.mediaDevices.getUserMedia() is completely unavailable in non-secure
// contexts in Chromium 136+.  No DLL flags can fix this.
//
// This polyfill bypasses the browser microphone entirely:
//   1. POST /api/ai/v1/mic/start → shim spawns PowerShell that records from
//      the Windows microphone using MCI (winmm.dll)
//   2. POST /api/ai/v1/mic/stop  → shim stops recording, sends WAV to Azure
//      Whisper, returns transcribed text
//
// The polyfill implements the standard SpeechRecognition interface so the
// chat-widget's W2 hook works transparently.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  "use strict";

  // ── Detect shim base URL ─────────────────────────────────────────────────
  function detectShimBase() {
    var links = document.querySelectorAll('a[href*="/comos/download/"]');
    for (var i = 0; i < links.length; i++) {
      var m = links[i].href.match(/(https?:\/\/[^/]+)\/comos\/download\//);
      if (m) return m[1];
    }
    return "http://127.0.0.1:56401";
  }

  // ── Polyfill SpeechRecognition class ─────────────────────────────────────
  function WhisperSpeechRecognition() {
    this.continuous = false;
    this.interimResults = false;
    this.lang = navigator.language || "en-US";
    this.maxAlternatives = 1;

    // Event handlers (matching Web Speech API)
    this.onstart = null;
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
    this.onspeechstart = null;
    this.onspeechend = null;
    this.onaudiostart = null;
    this.onaudioend = null;
    this.onsoundstart = null;
    this.onsoundend = null;
    this.onnomatch = null;

    // Internal state
    this._active = false;
    this._stopRequested = false;
  }

  // ── start() — tell the shim to begin recording via Windows MCI ───────────
  WhisperSpeechRecognition.prototype.start = function () {
    var self = this;
    if (self._active) return;

    console.log("[speech-polyfill] start() — requesting server-side mic recording");
    self._active = true;
    self._stopRequested = false;

    var shimBase = detectShimBase();

    fetch(shimBase + "/api/ai/v1/mic/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: self.lang }),
    })
      .then(function (resp) {
        return resp.json();
      })
      .then(function (data) {
        if (data.error) {
          console.error("[speech-polyfill] mic/start error:", data.error);
          self._active = false;
          if (self.onerror) {
            self.onerror({ error: "audio-capture", message: data.error });
          }
          if (self.onend) self.onend(new Event("end"));
          return;
        }

        console.log("[speech-polyfill] Recording started on server");
        if (self.onstart) self.onstart(new Event("start"));
        if (self.onaudiostart) self.onaudiostart(new Event("audiostart"));
        if (self.onspeechstart) self.onspeechstart(new Event("speechstart"));
      })
      .catch(function (err) {
        console.error("[speech-polyfill] mic/start fetch failed:", err);
        self._active = false;
        if (self.onerror) {
          self.onerror({
            error: "network",
            message: "Could not connect to recording service: " + err.message,
          });
        }
        if (self.onend) self.onend(new Event("end"));
      });
  };

  // ── stop() — tell the shim to stop recording and transcribe ──────────────
  WhisperSpeechRecognition.prototype.stop = function () {
    var self = this;
    if (!self._active || self._stopRequested) return;

    self._stopRequested = true;
    console.log("[speech-polyfill] stop() — requesting transcription");

    if (self.onspeechend) self.onspeechend(new Event("speechend"));

    var shimBase = detectShimBase();

    fetch(shimBase + "/api/ai/v1/mic/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: self.lang }),
    })
      .then(function (resp) {
        return resp.json();
      })
      .then(function (data) {
        if (data.error) {
          console.error("[speech-polyfill] mic/stop error:", data.error);
          if (self.onerror) {
            self.onerror({ error: "no-speech", message: data.error });
          }
          self._fireEnd();
          return;
        }

        var transcript = (data.text || "").trim();
        console.log("[speech-polyfill] Transcription:", transcript);

        if (!transcript) {
          if (self.onerror) {
            self.onerror({ error: "no-speech", message: "No speech detected" });
          }
          self._fireEnd();
          return;
        }

        // Fire onresult with SpeechRecognitionEvent-compatible structure
        if (self.onresult) {
          var resultEvent = {
            resultIndex: 0,
            results: {
              0: {
                0: { transcript: transcript, confidence: 0.95 },
                length: 1,
                isFinal: true,
              },
              length: 1,
            },
          };
          self.onresult(resultEvent);
        }

        // If continuous mode, restart recording automatically
        if (self.continuous && !self._stopRequested) {
          self._active = true;
          self._stopRequested = false;
          fetch(shimBase + "/api/ai/v1/mic/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ language: self.lang }),
          }).catch(function () {
            self._fireEnd();
          });
        } else {
          // CRITICAL: Delay _fireEnd so React processes the transcript
          // state update (from onresult above) in a SEPARATE render cycle
          // BEFORE isListening is set to false (by onend inside _fireEnd).
          //
          // The widget's useEffect copies transcript→input ONLY while
          // isListening is true.  Without this delay, React 18 batches
          // the transcript and isListening updates together, and the
          // useEffect sees isListening=false → transcript is never copied.
          setTimeout(function () {
            self._fireEnd();
          }, 120);
        }
      })
      .catch(function (err) {
        console.error("[speech-polyfill] mic/stop fetch failed:", err);
        if (self.onerror) {
          self.onerror({
            error: "network",
            message: "Transcription request failed: " + err.message,
          });
        }
        self._fireEnd();
      });
  };

  // ── abort() — cancel recording, discard audio ────────────────────────────
  WhisperSpeechRecognition.prototype.abort = function () {
    var self = this;
    self._stopRequested = true;

    var shimBase = detectShimBase();
    fetch(shimBase + "/api/ai/v1/mic/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }).catch(function () {});

    self._fireEnd();
  };

  // ── _fireEnd() — internal cleanup ────────────────────────────────────────
  WhisperSpeechRecognition.prototype._fireEnd = function () {
    this._active = false;
    if (this.onaudioend) this.onaudioend(new Event("audioend"));
    if (this.onend) this.onend(new Event("end"));
  };

  // ── Install the polyfill — ALWAYS ─────────────────────────────────────────
  // In COMOS/CefSharp, native SpeechRecognition NEVER works:
  //   - localfolder:// is not a secure context → getUserMedia unavailable
  //   - Even if SpeechRecognition class exists, start() fires "not-allowed"
  //   - CefSharp has no Google speech-recognition cloud backend anyway
  //
  // Force-override both globals unconditionally so the widget always
  // uses our server-side MCI + Whisper pipeline.
  console.log("[speech-polyfill] ====== POLYFILL INIT ======");
  console.log("[speech-polyfill] isSecureContext:", window.isSecureContext);
  console.log("[speech-polyfill] protocol:", location.protocol);
  console.log("[speech-polyfill] had native SpeechRecognition:", typeof window.SpeechRecognition);
  console.log("[speech-polyfill] had native webkitSpeechRecognition:", typeof window.webkitSpeechRecognition);

  window.SpeechRecognition = WhisperSpeechRecognition;
  window.webkitSpeechRecognition = WhisperSpeechRecognition;
  console.log("[speech-polyfill] Installed SERVER-SIDE recording polyfill (MCI + Whisper) — UNCONDITIONAL");
})();
