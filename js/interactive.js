/* ═══════════════════════════════════════════════
   Interactive — FAQ, Copy, Cursor, Magnetic
   ═══════════════════════════════════════════════ */

(function() {
  'use strict';

  /* ─── Custom Cursor ─── */
  const dot = document.querySelector('.cursor-dot');
  const ring = document.querySelector('.cursor-ring');
  if (dot && ring && window.innerWidth > 1024) {
    let mx = 0, my = 0, rx = 0, ry = 0;

    document.addEventListener('mousemove', (e) => {
      mx = e.clientX;
      my = e.clientY;
      dot.style.left = mx + 'px';
      dot.style.top = my + 'px';
    });

    function animateRing() {
      rx += (mx - rx) * 0.12;
      ry += (my - ry) * 0.12;
      ring.style.left = rx + 'px';
      ring.style.top = ry + 'px';
      requestAnimationFrame(animateRing);
    }
    animateRing();

    /* Hover state for interactive elements */
    const hoverTargets = document.querySelectorAll('a, button, .btn, .faq-q, .device-pill, .tag');
    hoverTargets.forEach(el => {
      el.addEventListener('mouseenter', () => document.body.classList.add('cursor-hover'));
      el.addEventListener('mouseleave', () => document.body.classList.remove('cursor-hover'));
    });
  }

  /* ─── FAQ Toggle ─── */
  document.querySelectorAll('.faq-q').forEach(q => {
    q.addEventListener('click', () => {
      const item = q.parentElement;
      const wasOpen = item.classList.contains('open');
      /* Close all others */
      item.closest('.faq-list').querySelectorAll('.faq-item.open').forEach(openItem => {
        if (openItem !== item) openItem.classList.remove('open');
      });
      item.classList.toggle('open', !wasOpen);
    });
  });

  /* ─── Copy QQ Number ─── */
  window.copyQQ = function() {
    navigator.clipboard.writeText('478538539').then(() => {
      const btn = document.querySelector('.qq-box .btn');
      if (!btn) return;
      const orig = btn.textContent;
      btn.textContent = '已复制 ✓';
      setTimeout(() => btn.textContent = orig, 2000);
    }).catch(() => {
      prompt('手动复制：', '478538539');
    });
  };

  /* ─── Magnetic Button Effect ─── */
  document.querySelectorAll('.magnetic').forEach(wrapper => {
    const btn = wrapper.querySelector('.btn') || wrapper;
    wrapper.addEventListener('mousemove', (e) => {
      const rect = wrapper.getBoundingClientRect();
      const x = e.clientX - rect.left - rect.width / 2;
      const y = e.clientY - rect.top - rect.height / 2;
      btn.style.transform = `translate(${x * 0.2}px, ${y * 0.2}px)`;
    });
    wrapper.addEventListener('mouseleave', () => {
      btn.style.transform = '';
    });
  });

  /* ─── Gallery Drag Scroll ─── */
  const gallery = document.querySelector('.gallery-track');
  if (gallery) {
    let isDown = false, startX, scrollLeft;
    gallery.addEventListener('mousedown', (e) => {
      isDown = true;
      gallery.style.cursor = 'grabbing';
      startX = e.pageX - gallery.offsetLeft;
      scrollLeft = gallery.scrollLeft;
    });
    gallery.addEventListener('mouseleave', () => { isDown = false; gallery.style.cursor = 'grab'; });
    gallery.addEventListener('mouseup', () => { isDown = false; gallery.style.cursor = 'grab'; });
    gallery.addEventListener('mousemove', (e) => {
      if (!isDown) return;
      e.preventDefault();
      const x = e.pageX - gallery.offsetLeft;
      gallery.scrollLeft = scrollLeft - (x - startX) * 1.5;
    });
    gallery.style.cursor = 'grab';
  }

  /* ─── Phone Screen Time Update ─── */
  const phoneTime = document.querySelector('.phone-time');
  if (phoneTime) {
    function updateTime() {
      const now = new Date();
      phoneTime.textContent = now.getHours().toString().padStart(2, '0') + ':' +
                              now.getMinutes().toString().padStart(2, '0');
    }
    updateTime();
    setInterval(updateTime, 10000);
  }

})();
