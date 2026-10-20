// Drag a workout to another day. On touch, press and hold to pick it up (so a
// normal swipe still scrolls); with a mouse, just drag.

const LONG_PRESS_MS = 300;
const MOVE_SLOP = 8;
const EDGE = 90; // px from the top/bottom edge where the page auto-scrolls

export function enableDrag(onDrop) {
  let pending = null; // pressed on a workout, not dragging yet
  let drag = null;    // currently dragging
  let suppressClick = false;

  const dayAt = (x, y) => document.elementFromPoint(x, y)?.closest('.day[data-date]');

  function press(el, x, y, touch) {
    pending = { el, x, y, touch };
    if (touch) pending.timer = setTimeout(() => begin(x, y), LONG_PRESS_MS);
  }

  function begin(x, y) {
    const { el } = pending;
    pending = null;
    const rect = el.getBoundingClientRect();
    const ghost = el.cloneNode(true);
    ghost.classList.add('drag-ghost');
    Object.assign(ghost.style, { width: `${rect.width}px`, left: `${rect.left}px`, top: `${rect.top}px` });
    document.body.appendChild(ghost);
    el.classList.add('drag-source');
    document.body.classList.add('dragging');
    navigator.vibrate?.(12);
    drag = { el, ghost, dx: x - rect.left, dy: y - rect.top, from: el.dataset.date, id: el.dataset.id, x, y, target: null };
    move(x, y);
    autoScroll();
  }

  function move(x, y) {
    drag.x = x;
    drag.y = y;
    drag.ghost.style.transform = `translate(${x - drag.dx - parseFloat(drag.ghost.style.left)}px, ${y - drag.dy - parseFloat(drag.ghost.style.top)}px) rotate(-2deg)`;
    const day = dayAt(x, y);
    if (day !== drag.target) {
      drag.target?.classList.remove('drop-target');
      drag.target = day;
      day?.classList.add('drop-target');
    }
  }

  function autoScroll() {
    if (!drag) return;
    const { y } = drag;
    const step = y < EDGE ? -(EDGE - y) / 4 : y > innerHeight - EDGE - 64 ? (y - (innerHeight - EDGE - 64)) / 4 : 0;
    if (step) {
      scrollBy(0, step);
      move(drag.x, drag.y);
    }
    requestAnimationFrame(autoScroll);
  }

  function release() {
    if (pending) {
      clearTimeout(pending.timer);
      pending = null;
      return;
    }
    if (!drag) return;
    const { el, ghost, from, id, target } = drag;
    drag = null;
    ghost.remove();
    el.classList.remove('drag-source');
    target?.classList.remove('drop-target');
    document.body.classList.remove('dragging');
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 400);
    if (target && target.dataset.date !== from) onDrop(from, id, target.dataset.date);
  }

  // Touch
  document.addEventListener('touchstart', (e) => {
    const el = e.target.closest('.wk[data-id]');
    if (el && e.touches.length === 1) press(el, e.touches[0].clientX, e.touches[0].clientY, true);
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (drag) {
      e.preventDefault(); // stop the page from scrolling while dragging
      move(t.clientX, t.clientY);
    } else if (pending && Math.hypot(t.clientX - pending.x, t.clientY - pending.y) > MOVE_SLOP) {
      clearTimeout(pending.timer); // it's a scroll, not a drag
      pending = null;
    }
  }, { passive: false });
  document.addEventListener('touchend', release);
  document.addEventListener('touchcancel', release);

  // Mouse
  document.addEventListener('mousedown', (e) => {
    const el = e.button === 0 && e.target.closest('.wk[data-id]');
    if (el) press(el, e.clientX, e.clientY, false);
  });
  document.addEventListener('mousemove', (e) => {
    if (drag) move(e.clientX, e.clientY);
    else if (pending && !pending.touch && Math.hypot(e.clientX - pending.x, e.clientY - pending.y) > MOVE_SLOP) begin(e.clientX, e.clientY);
  });
  document.addEventListener('mouseup', release);

  // A drag shouldn't also count as a tap that opens the workout.
  document.addEventListener('click', (e) => {
    if (suppressClick && e.target.closest('.wk')) {
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);
  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.wk')) e.preventDefault();
  });
}
