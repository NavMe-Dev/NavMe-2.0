/** Dashboard background — themed indoor navigation art only. */

export function dashboardAmbientHtml() {
  return `
    <div class="spatial-ambient" aria-hidden="true">
      <div class="spatial-ambient-bg"></div>
      <div class="spatial-ambient-glow spatial-ambient-glow--tl"></div>
      <div class="spatial-ambient-glow spatial-ambient-glow--br"></div>
      <div class="spatial-ambient-vignette"></div>
    </div>`;
}
