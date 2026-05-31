/* ═══════════════════════════════════════════════
   Effects — GSAP Animations, Parallax, Text Split
   ═══════════════════════════════════════════════ */

(function() {
  'use strict';

  /* ─── Wait for GSAP ─── */
  if (typeof gsap === 'undefined') return;

  gsap.registerPlugin(ScrollTrigger);

  /* ─── Hero Entry Animation ─── */
  const heroTl = gsap.timeline({ delay: 0.3 });
  heroTl
    .from('.hero .t-eyebrow', { opacity: 0, y: 30, duration: 0.8, ease: 'power3.out' })
    .from('.hero .t-display', { opacity: 0, y: 50, duration: 1, ease: 'power3.out' }, '-=0.5')
    .from('.hero .t-subhead', { opacity: 0, y: 30, duration: 0.8, ease: 'power3.out' }, '-=0.6')
    .from('.hero .btn-group', { opacity: 0, y: 30, duration: 0.7, ease: 'power3.out' }, '-=0.5')
    .from('.hero-meta', { opacity: 0, y: 20, duration: 0.6, ease: 'power3.out' }, '-=0.3')
    .from('.phone-mockup', { opacity: 0, x: 60, rotateY: -15, duration: 1.2, ease: 'power3.out' }, '-=1');

  /* ─── Parallax Orbs on Mouse Move ─── */
  const heroSection = document.querySelector('.hero');
  if (heroSection) {
    const orbs = heroSection.querySelectorAll('.hero-orb');
    heroSection.addEventListener('mousemove', (e) => {
      const rect = heroSection.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width - 0.5;
      const y = (e.clientY - rect.top) / rect.height - 0.5;
      orbs.forEach((orb, i) => {
        const speed = (i + 1) * 15;
        gsap.to(orb, {
          x: x * speed,
          y: y * speed,
          duration: 1,
          ease: 'power2.out'
        });
      });
    });
  }

  /* ─── Scroll-Driven Section Parallax ─── */
  gsap.utils.toArray('.parallax-layer').forEach(layer => {
    const depth = layer.dataset.depth || 0.2;
    gsap.to(layer, {
      y: () => -ScrollTrigger.maxScroll(window) * depth,
      ease: 'none',
      scrollTrigger: {
        trigger: layer.closest('.section') || layer.parentElement,
        start: 'top bottom',
        end: 'bottom top',
        scrub: 1,
        invalidateOnRefresh: true
      }
    });
  });

  /* ─── Feature Grid Stagger ─── */
  gsap.utils.toArray('.grid-3').forEach(grid => {
    gsap.from(grid.children, {
      scrollTrigger: {
        trigger: grid,
        start: 'top 80%',
        toggleActions: 'play none none none'
      },
      opacity: 0,
      y: 40,
      stagger: 0.08,
      duration: 0.7,
      ease: 'power3.out'
    });
  });

  /* ─── Timeline Items Stagger ─── */
  const timelineItems = document.querySelectorAll('.timeline-item');
  if (timelineItems.length) {
    gsap.from(timelineItems, {
      scrollTrigger: {
        trigger: '.timeline',
        start: 'top 75%',
        toggleActions: 'play none none none'
      },
      opacity: 0,
      x: -30,
      stagger: 0.15,
      duration: 0.7,
      ease: 'power3.out'
    });
  }

  /* ─── Horizontal Scroll Gallery ─── */
  const gallery = document.querySelector('.gallery-track');
  if (gallery) {
    const items = gallery.querySelectorAll('.gallery-item');
    if (items.length > 0) {
      gsap.to(gallery, {
        x: () => -(gallery.scrollWidth - gallery.clientWidth),
        ease: 'none',
        scrollTrigger: {
          trigger: gallery.parentElement,
          start: 'top 20%',
          end: () => '+=' + (gallery.scrollWidth - gallery.clientWidth),
          scrub: 1,
          pin: true,
          anticipatePin: 1,
          invalidateOnRefresh: true
        }
      });
    }
  }

  /* ─── Phone Mockup Parallax on Scroll ─── */
  const phone = document.querySelector('.phone-mockup');
  if (phone) {
    gsap.to(phone, {
      scrollTrigger: {
        trigger: '.hero',
        start: 'top top',
        end: 'bottom top',
        scrub: 1
      },
      y: -80,
      rotateY: 5,
      ease: 'none'
    });
  }

  /* ─── Section Divider Fade-In ─── */
  gsap.utils.toArray('.section-divider').forEach(divider => {
    gsap.from(divider, {
      scrollTrigger: {
        trigger: divider,
        start: 'top 90%',
        toggleActions: 'play none none none'
      },
      scaleX: 0,
      duration: 1,
      ease: 'power3.inOut'
    });
  });

  /* ─── Marquee Speed Control ─── */
  const marquees = document.querySelectorAll('.marquee-track');
  marquees.forEach(marquee => {
    ScrollTrigger.create({
      trigger: marquee.parentElement,
      start: 'top bottom',
      end: 'bottom top',
      onUpdate: (self) => {
        marquee.style.animationDuration = (30 - self.progress * 15) + 's';
      }
    });
  });

})();
