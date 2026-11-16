/* Counts only the configured camera transitions and pauses in a preview. */
(function (global) {
  'use strict';

  function duration(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  }

  function formatMMSS(milliseconds) {
    var seconds = Math.ceil(duration(milliseconds) / 1000);
    return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
  }

  function create(options) {
    options = options || {};
    var now = options.now || function () {
      return global.performance && typeof global.performance.now === 'function' ? global.performance.now() : Date.now();
    };
    var scheduleInterval = options.setInterval || function (callback, delay) { return global.setInterval(callback, delay); };
    var clearScheduledInterval = options.clearInterval || function (id) { global.clearInterval(id); };
    var onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : function () {};
    var pendingMs = 0;
    var phase = null;
    var timer = null;
    var timerGeneration = 0;
    var cancelled = false;
    var previousValue = null;

    function stopTimer() {
      timerGeneration += 1;
      if (timer !== null) clearScheduledInterval(timer);
      timer = null;
    }

    function phaseRemaining() {
      if (!phase) return 0;
      var elapsed = phase.running ? Math.max(0, now() - phase.startedAt) : 0;
      return Math.max(0, phase.remainingMs - elapsed);
    }

    function remainingMs() {
      // A slow or stalled transition may exhaust its own budget, but cannot
      // consume the transitions and pauses that have not started yet.
      return Math.max(0, pendingMs - (phase ? phase.budgetMs - phaseRemaining() : 0));
    }

    function emit(force) {
      var value = remainingMs();
      if (force || value !== previousValue) {
        previousValue = value;
        onUpdate(value);
      }
    }

    function startTimer() {
      stopTimer();
      if (!cancelled && phase && phase.running && phaseRemaining() > 0) {
        var generation = timerGeneration;
        timer = scheduleInterval(function () {
          if (generation !== timerGeneration || cancelled || !phase || !phase.running) return;
          emit(false);
          if (phaseRemaining() === 0) stopTimer();
        }, 200);
      }
    }

    function complete() {
      if (cancelled) return;
      stopTimer();
      if (phase) pendingMs = Math.max(0, pendingMs - phase.budgetMs);
      phase = null;
      emit(false);
    }

    return {
      reset: function (totalMs) {
        stopTimer();
        pendingMs = duration(totalMs);
        phase = null;
        cancelled = false;
        emit(true);
      },
      begin: function (milliseconds) {
        if (cancelled) return;
        if (phase) complete();
        var budgetMs = Math.min(pendingMs, duration(milliseconds));
        phase = { budgetMs: budgetMs, remainingMs: budgetMs, startedAt: now(), running: true };
        emit(false);
        startTimer();
      },
      complete: complete,
      freeze: function () {
        if (cancelled || !phase) return;
        phase.remainingMs = phaseRemaining();
        phase.running = false;
        stopTimer();
        emit(false);
      },
      resume: function () {
        if (cancelled || !phase || phase.running) return;
        phase.startedAt = now();
        phase.running = true;
        emit(false);
        startTimer();
      },
      cancel: function () {
        if (phase) {
          phase.remainingMs = phaseRemaining();
          phase.running = false;
        }
        cancelled = true;
        stopTimer();
      },
      finish: function () {
        stopTimer();
        pendingMs = 0;
        phase = null;
        // Late SDK callbacks cannot restart a finished preview.
        cancelled = true;
        emit(true);
      },
      remainingMs: remainingMs
    };
  }

  global.WFPreviewTiming = { create: create, formatMMSS: formatMMSS };
})(window);
