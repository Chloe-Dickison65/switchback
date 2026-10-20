// Small helpers for building HTML strings.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const ic = (name) => `<i class="ti ti-${name}" aria-hidden="true"></i>`;
