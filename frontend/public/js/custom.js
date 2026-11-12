/*
 * The page's own inline <script> blocks, verbatim and in page order.
 *
 * Only difference from the Webflow export: this file is injected after React
 * hydrates, by which time DOMContentLoaded has already fired, so
 *   document.addEventListener("DOMContentLoaded", fn)
 * is written as
 *   __avandeDomReady(fn)
 * which simply calls fn. WebflowRuntime.tsx holds jQuery's ready event until
 * this file has run, so these still execute before Webflow.ready, as on the
 * original page.
 */
function __avandeDomReady(fn) { fn(); }

/* ---- inline script 1 of 7 ---- */
  window.Webflow = window.Webflow || [];

  window.Webflow.push(function () {
    // Don't run in Webflow Designer / Editor
    if (window.Webflow && Webflow.env && Webflow.env("editor") !== undefined) return;
    if (!window.Lenis) return;

    // Add required Lenis CSS using JS
    const lenisStyle = document.createElement("style");
    lenisStyle.innerHTML = `
      html.lenis,
      html.lenis body {
        height: auto;
      }

      .lenis.lenis-smooth {
        scroll-behavior: auto !important;
      }

      .lenis.lenis-smooth [data-lenis-prevent] {
        overscroll-behavior: contain;
      }

      .lenis.lenis-stopped {
        overflow: hidden;
      }

      .lenis.lenis-smooth iframe {
        pointer-events: none;
      }

      html {
        scroll-behavior: auto !important;
      }

      body {
        overscroll-behavior: none;
        -webkit-font-smoothing: antialiased;
      }
    `;
    document.head.appendChild(lenisStyle);

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) return;

    const lenis = new Lenis({
      duration: 1.25,
      easing: function (t) {
        return Math.min(1, 1.001 - Math.pow(2, -10 * t));
      },
      smoothWheel: true,
      wheelMultiplier: 0.85,
      syncTouch: false,
      touchMultiplier: 1.2,
      infinite: false,
      anchors: true
    });

    function raf(time) {
      lenis.raf(time);
      requestAnimationFrame(raf);
    }

    requestAnimationFrame(raf);

    window.addEventListener("load", function () {
      lenis.resize();
    });
  });

/* ---- inline script 2 of 7 ---- */
__avandeDomReady(() => {
  if (!window.gsap) return;

  const borderLines = document.querySelectorAll(
    ".hero-banner-border-line"
  );

  borderLines.forEach((line) => {
    const paths = line.querySelectorAll("svg path");

    // First path = square
    // Second path = dashed line
    const path = paths[1];

    if (!path) return;

    const dash = 6.0936;
    const gap = 6.0936;

    // One complete dash + gap cycle
    const cycle = dash + gap;

    // Move many complete cycles for faster motion
    const distance = cycle * 20;

    gsap.set(path, {
      strokeDasharray: `${dash} ${gap}`,
      strokeDashoffset: 0
    });

    gsap.to(path, {
      strokeDashoffset: -distance,

      // Smaller = faster
      duration: 4,

      repeat: -1,
      ease: "none",

      // Helps avoid accumulated values
      repeatRefresh: false
    });
  });
});

/* ---- inline script 3 of 7 ---- */
__avandeDomReady(() => {
  if (!window.gsap) return;

  const svgs = document.querySelectorAll(".automation-circle");

  svgs.forEach((svg) => {
    const bars = gsap.utils.toArray(
      svg.querySelectorAll(".circle-bar")
    );

    const dots = gsap.utils.toArray(
      svg.querySelectorAll(".circle-dot")
    );

    if (!bars.length) return;

    const fillColor = "#D3FB43";
    const emptyOpacity = 0.12;
    const fillDuration = 5;
    const completedPause = 1;

    gsap.set(bars, {
      opacity: emptyOpacity,
      fill: fillColor
    });

    gsap.set(dots, {
      opacity: emptyOpacity,
      fill: fillColor
    });

    const tl = gsap.timeline({
      repeat: -1,
      repeatDelay: 0.3
    });

    tl.to(bars, {
      opacity: 1,
      duration: 0.18,
      stagger: {
        each: fillDuration / bars.length,
        from: "start"
      },
      ease: "none"
    }, 0);

    tl.to(dots, {
      opacity: 1,
      duration: 0.12,
      stagger: {
        each: fillDuration / dots.length,
        from: "start"
      },
      ease: "none"
    }, 0);

    tl.to({}, {
      duration: completedPause
    });

    tl.set(bars, {
      opacity: emptyOpacity
    });

    tl.set(dots, {
      opacity: emptyOpacity
    });
  });
});

/* ---- inline script 4 of 7 ---- */
window.Webflow = window.Webflow || [];

Webflow.push(() => {
  document.querySelectorAll(".feature-content-slider-wrap").forEach((wrap) => {
    const slides = wrap.querySelectorAll(".feature-content-slide");
    const dots = wrap.querySelectorAll(".w-slider-dot");
    const number = wrap.querySelector(".feature-slider-number");

    if (!slides.length || !dots.length || !number) return;

    const total = slides.length;
    let currentIndex = -1;

    const formatNumber = (num) => {
      return `0-${String(num).padStart(2, "0")}/0-${String(total).padStart(2, "0")}`;
    };

    const updateNumber = () => {
      const activeDot = wrap.querySelector(".w-slider-dot.w-active");
      if (!activeDot) return;

      const newIndex = [...dots].indexOf(activeDot);

      if (newIndex === currentIndex) return;

      currentIndex = newIndex;

      if (!window.gsap) {
        number.textContent = formatNumber(newIndex + 1);
        return;
      }

      gsap.killTweensOf(number);

      gsap.to(number, {
        yPercent: -100,
        autoAlpha: 0,
        duration: 0.25,
        ease: "power2.in",
        onComplete: () => {
          number.textContent = formatNumber(newIndex + 1);

          gsap.fromTo(
            number,
            {
              yPercent: 100,
              autoAlpha: 0
            },
            {
              yPercent: 0,
              autoAlpha: 1,
              duration: 0.35,
              ease: "power2.out"
            }
          );
        }
      });
    };

    updateNumber();

    const observer = new MutationObserver(updateNumber);

    dots.forEach((dot) => {
      observer.observe(dot, {
        attributes: true,
        attributeFilter: ["class", "aria-pressed"]
      });
    });
  });
});

/* ---- inline script 5 of 7 ---- */
__avandeDomReady(() => {
  if (!window.gsap) return;

  document.querySelectorAll(".blogs-shape-wrap").forEach((wrap) => {
    const line = wrap.querySelector("svg path:last-child");

    if (!line) return;

    gsap.set(line, {
      strokeDashoffset: 0
    });

    gsap.to(line, {
      strokeDashoffset: -22.08,
      duration: 0.35,
      repeat: -1,
      ease: "none"
    });
  });
});

/* ---- inline script 6 of 7 ---- */
__avandeDomReady(() => {
  if (!window.gsap) return;

  document.querySelectorAll(".faq-wrap").forEach((faqWrap) => {
    const faqItems = faqWrap.querySelectorAll(".faq-items");

    if (!faqItems.length) return;

    // =========================
    // INITIAL STATE
    // =========================
    faqItems.forEach((item, index) => {
      const answer = item.querySelector(".faq-ans-box");
      const icon = item.querySelector(".faq-qus-icon-box");

      if (!answer || !icon) return;

      gsap.set(answer, {
        overflow: "hidden"
      });

      gsap.set(icon, {
        transformOrigin: "50% 50%"
      });

      if (index === 0) {
        item.classList.add("active");

        gsap.set(answer, {
          height: answer.scrollHeight
        });

        gsap.set(icon, {
          rotation: -180
        });
      } else {
        item.classList.remove("active");

        gsap.set(answer, {
          height: 0
        });

        gsap.set(icon, {
          rotation: 0
        });
      }
    });

    // =========================
    // CLICK
    // =========================
    faqItems.forEach((item) => {
      const answer = item.querySelector(".faq-ans-box");
      const icon = item.querySelector(".faq-qus-icon-box");

      if (!answer || !icon) return;

      item.addEventListener("click", () => {
        if (item.classList.contains("active")) return;

        const activeItem = faqWrap.querySelector(".faq-items.active");

        // =========================
        // CLOSE CURRENT
        // =========================
        if (activeItem) {
          const activeAnswer =
            activeItem.querySelector(".faq-ans-box");

          const activeIcon =
            activeItem.querySelector(".faq-qus-icon-box");

          activeItem.classList.remove("active");

          gsap.killTweensOf([activeAnswer, activeIcon]);

          gsap.to(activeAnswer, {
            height: 0,
            duration: 0.42,
            ease: "power2.inOut",
            overwrite: true
          });

          gsap.to(activeIcon, {
            rotation: 0,
            duration: 0.35,
            ease: "power2.inOut",
            overwrite: true
          });
        }

        // =========================
        // OPEN CLICKED
        // =========================
        item.classList.add("active");

        gsap.killTweensOf([answer, icon]);

        const targetHeight = answer.scrollHeight;

        gsap.to(answer, {
          height: targetHeight,
          duration: 0.42,
          ease: "power2.inOut",
          overwrite: true
        });

        gsap.to(icon, {
          rotation: -180,
          duration: 0.35,
          ease: "power2.inOut",
          overwrite: true
        });
      });
    });

    // =========================
    // RESPONSIVE HEIGHT FIX
    // =========================
    window.addEventListener("resize", () => {
      const activeItem = faqWrap.querySelector(".faq-items.active");

      if (!activeItem) return;

      const activeAnswer =
        activeItem.querySelector(".faq-ans-box");

      if (!activeAnswer) return;

      gsap.set(activeAnswer, {
        height: "auto"
      });

      const newHeight = activeAnswer.scrollHeight;

      gsap.set(activeAnswer, {
        height: newHeight
      });
    });
  });
});

/* ---- inline script 7 of 7 ---- */
window.Webflow = window.Webflow || [];

Webflow.push(() => {
  const buttons = document.querySelectorAll(
    ".footer-copy-right-button-box .primary-button"
  );

  buttons.forEach((button) => {
    button.setAttribute("href", "#");

    button.addEventListener("click", (e) => {
      e.preventDefault();

      const scroll = {
        y: window.scrollY
      };

      gsap.to(scroll, {
        y: 0,
        duration: 1.2,
        ease: "power3.inOut",
        onUpdate: () => {
          window.scrollTo(0, scroll.y);
        }
      });
    });
  });
});
