/**
 * Adds Glass ripple feedback to interactive controls.
 */

const SELECTOR =
  '.glass-shell button, .form-overlay button, .scene-tool-btn, .poi-item, .user-item';

/**
 * @param {HTMLElement} root
 */
export function initButtonRipples(root = document.body) {
  root.addEventListener(
    'click',
    (e) => {
      const target = e.target.closest(SELECTOR);
      if (!target || target.disabled) return;

      target.classList.add('btn-ripple-host');

      const rect = target.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height) * 1.2;
      const ripple = document.createElement('span');
      ripple.className = 'btn-ripple';
      ripple.style.width = `${size}px`;
      ripple.style.height = `${size}px`;
      ripple.style.left = `${e.clientX - rect.left - size / 2}px`;
      ripple.style.top = `${e.clientY - rect.top - size / 2}px`;

      target.appendChild(ripple);
      ripple.addEventListener(
        'animationend',
        () => ripple.remove(),
        { once: true },
      );
    },
    { passive: true },
  );
}
