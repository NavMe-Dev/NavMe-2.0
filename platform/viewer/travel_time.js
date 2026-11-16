/* Estimates use remaining routed metres, never a wall-clock countdown. */
(function (global) {
  'use strict';
  function valid(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
  function speed(value, fallback) { return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback; }
  function estimate(route, remainingMeters, config) {
    if (!route || typeof route !== 'object' || !valid(remainingMeters)) return null;
    if (valid(route.time_s) && valid(route.total_m) && route.total_m > 0) {
      return route.time_s * Math.max(0, Math.min(1, remainingMeters / route.total_m));
    }
    var defaults = (global.WF_CONFIG && global.WF_CONFIG.navigation_eta) || {};
    var options = Object.assign({}, defaults, config || {});
    var stepFree = route._stepFree === true || route.mode === 'stepfree';
    return remainingMeters / (stepFree ? speed(options.step_free_speed_mps, 0.7) : speed(options.walking_speed_mps, 0.8));
  }
  function translated(key, values, fallback) {
    var i18n = global.WFi18n;
    if (i18n && typeof i18n.t === 'function') {
      var result = i18n.t(key, values);
      if (typeof result === 'string' && result && result !== key) return result;
    }
    return fallback.replace(/\{\{(\w+)\}\}/g, function (_, name) { return values[name]; });
  }
  function format(seconds) {
    if (!valid(seconds)) return '';
    if (seconds >= 300) {
      return translated('viewer.etaMinutes', { minutes: Math.ceil(seconds / 60) }, '~{{minutes}} min');
    }
    var rounded = Math.round(seconds / 5) * 5;
    if (seconds > 0) rounded = Math.max(5, rounded);
    var minutes = Math.floor(rounded / 60), rest = rounded % 60;
    if (!minutes) return translated('viewer.etaSeconds', { seconds: rest }, '~{{seconds}} sec');
    if (!rest) return translated('viewer.etaMinutes', { minutes: minutes }, '~{{minutes}} min');
    return translated('viewer.etaMinutesSeconds', { minutes: minutes, seconds: rest }, '~{{minutes}} min {{seconds}} sec');
  }
  global.WFTravelTime = { estimate: estimate, format: format };
})(window);
