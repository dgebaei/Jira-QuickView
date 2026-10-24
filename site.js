function enhanceProseImages() {
  const proseImages = Array.from(document.querySelectorAll('.prose img'));

  proseImages.forEach(image => {
    const rawSrc = image.getAttribute('src') || '';
    if (!rawSrc || rawSrc.startsWith('http://') || rawSrc.startsWith('https://')) {
      return;
    }
    if (image.closest('.lightbox-trigger') || image.closest('a')) {
      return;
    }
    if (image.closest('.gallery-grid')) {
      return;
    }

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'lightbox-trigger';
    trigger.setAttribute('aria-label', `Open ${image.alt || 'image'} in full screen`);
    image.parentNode.insertBefore(trigger, image);
    trigger.appendChild(image);
  });
}

function enhanceUserGuideToc() {
  const toc = document.querySelector('.user-guide-toc');
  const toggleAll = toc?.querySelector('[data-toc-toggle-all]');
  const sections = Array.from(toc?.querySelectorAll('.user-guide-toc-section') || []);

  if (!toc || !toggleAll || !sections.length) {
    return;
  }

  function allSectionsExpanded() {
    return sections.every(section => section.open);
  }

  function updateToggleLabel() {
    const expanded = allSectionsExpanded();
    toggleAll.textContent = expanded ? 'Collapse all' : 'Expand all';
    toggleAll.setAttribute('aria-expanded', String(expanded));
  }

  toggleAll.addEventListener('click', () => {
    const shouldExpand = !allSectionsExpanded();
    sections.forEach(section => {
      section.open = shouldExpand;
    });
    updateToggleLabel();
  });

  sections.forEach(section => {
    section.addEventListener('toggle', updateToggleLabel);
  });

  updateToggleLabel();
}

function initTocSpy() {
  const links = Array.from(document.querySelectorAll('.toc-link, .user-guide-toc a[href^="#"]'));
  if (!links.length) {
    return;
  }

  links.forEach(link => {
    if (!link.title) {
      link.title = link.textContent.trim();
    }
  });

  const entries = links
    .map(link => {
      const id = decodeURIComponent((link.getAttribute('href') || '').replace(/^#/, ''));
      const heading = id ? document.getElementById(id) : null;
      return heading ? { link, heading } : null;
    })
    .filter(Boolean);

  if (!entries.length) {
    return;
  }

  let activeLink = null;
  let ticking = false;

  function setActive(link) {
    if (link === activeLink) {
      return;
    }

    if (activeLink) {
      activeLink.classList.remove('is-active');
      activeLink.removeAttribute('aria-current');
    }

    activeLink = link;

    if (!link) {
      return;
    }

    link.classList.add('is-active');
    link.setAttribute('aria-current', 'true');

    const section = link.closest('.user-guide-toc-section');
    if (section && !section.open) {
      section.open = true;
    }
  }

  function updateActiveHeading() {
    ticking = false;
    const threshold = 120;
    let current = null;

    for (const entry of entries) {
      const top = entry.heading.getBoundingClientRect().top;
      if (top <= threshold) {
        current = entry;
      } else {
        break;
      }
    }

    if (!current) {
      current = entries[0];
    }

    setActive(current.link);
  }

  function scheduleUpdate() {
    if (ticking) {
      return;
    }
    ticking = true;
    window.requestAnimationFrame(updateActiveHeading);
  }

  window.addEventListener('scroll', scheduleUpdate, { passive: true });
  window.addEventListener('resize', scheduleUpdate);
  updateActiveHeading();
}

function fitTocLabels() {
  const links = Array.from(document.querySelectorAll('.toc-link, .user-guide-toc a[href^="#"]'));

  links.forEach(link => {
    const full = link.dataset.fullLabel || link.textContent.trim();
    link.dataset.fullLabel = full;
    link.title = full;
    link.setAttribute('aria-label', full);
    link.textContent = full;

    if (!link.clientWidth || link.scrollWidth <= link.clientWidth) {
      return;
    }

    let low = 0;
    let high = full.length;

    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      link.textContent = `${full.slice(0, mid).trimEnd()}…`;
      if (link.scrollWidth <= link.clientWidth) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }

    link.textContent = `${full.slice(0, Math.max(1, low)).trimEnd()}…`;
  });
}

function initLightbox() {
  const lightboxTriggers = Array.from(document.querySelectorAll('.lightbox-trigger'));
  if (!lightboxTriggers.length) {
    return;
  }

  const lightbox = document.createElement('div');
  lightbox.className = 'lightbox';
  lightbox.setAttribute('data-open', 'false');
  lightbox.setAttribute('aria-hidden', 'true');

  lightbox.innerHTML = `
    <button type="button" class="lightbox-backdrop" aria-label="Close full screen image"></button>
    <div class="lightbox-panel" role="dialog" aria-modal="true" aria-label="Full screen image viewer">
      <button type="button" class="lightbox-nav lightbox-prev" aria-label="Show previous image">&#8249;</button>
      <button type="button" class="lightbox-nav lightbox-next" aria-label="Show next image">&#8250;</button>
      <button type="button" class="lightbox-close" aria-label="Close full screen image">&times;</button>
      <figure class="lightbox-figure">
        <img src="" alt="">
        <figcaption class="lightbox-caption"></figcaption>
      </figure>
      <p class="lightbox-meta" aria-live="polite"></p>
    </div>
  `;

  document.body.appendChild(lightbox);

  const lightboxImage = lightbox.querySelector('.lightbox-figure img');
  const lightboxCaption = lightbox.querySelector('.lightbox-caption');
  const lightboxMeta = lightbox.querySelector('.lightbox-meta');
  const lightboxCloseButtons = lightbox.querySelectorAll('.lightbox-backdrop, .lightbox-close');
  const lightboxPrev = lightbox.querySelector('.lightbox-prev');
  const lightboxNext = lightbox.querySelector('.lightbox-next');

  let lastTrigger = null;
  let activeIndex = -1;
  let inertBackground = [];

  function getTriggerImageData(trigger) {
    const image = trigger.querySelector('img');
    const figure = trigger.closest('figure');
    const caption = figure?.querySelector('figcaption')?.textContent?.trim() || image?.alt || '';

    return { image, caption };
  }

  function updateNavigationState() {
    const hasMultipleImages = lightboxTriggers.length > 1;
    lightboxPrev.disabled = !hasMultipleImages;
    lightboxNext.disabled = !hasMultipleImages;
    lightboxMeta.hidden = !hasMultipleImages || activeIndex < 0;
    lightboxMeta.textContent = activeIndex >= 0 ? `${activeIndex + 1} / ${lightboxTriggers.length}` : '';
  }

  function renderLightboxImage(index) {
    if (!lightboxTriggers.length) {
      return;
    }

    const normalizedIndex = ((index % lightboxTriggers.length) + lightboxTriggers.length) % lightboxTriggers.length;
    const { image, caption } = getTriggerImageData(lightboxTriggers[normalizedIndex]);

    if (!image) {
      return;
    }

    activeIndex = normalizedIndex;
    lightboxImage.src = image.src;
    lightboxImage.alt = image.alt || caption;
    lightboxCaption.textContent = caption;
    updateNavigationState();
  }

  function stepLightbox(offset) {
    if (activeIndex < 0 || lightboxTriggers.length < 2) {
      return;
    }

    renderLightboxImage(activeIndex + offset);
  }

  function setScrollLock(locked) {
    document.documentElement.classList.toggle('lightbox-open', locked);
    document.body.classList.toggle('lightbox-open', locked);
  }

  function closeLightbox() {
    lightbox.setAttribute('data-open', 'false');
    lightbox.setAttribute('aria-hidden', 'true');
    setScrollLock(false);
    inertBackground.forEach(element => {
      element.inert = false;
    });
    inertBackground = [];
    lightboxImage.src = '';
    lightboxImage.alt = '';
    lightboxCaption.textContent = '';
    activeIndex = -1;
    updateNavigationState();
    if (lastTrigger) {
      lastTrigger.focus();
      lastTrigger = null;
    }
  }

  function openLightbox(trigger) {
    const triggerIndex = lightboxTriggers.indexOf(trigger);
    const { image } = getTriggerImageData(trigger);

    if (!image || triggerIndex < 0) {
      return;
    }

    lastTrigger = trigger;
    inertBackground = Array.from(document.body.children).filter(element => element !== lightbox && !element.inert);
    inertBackground.forEach(element => {
      element.inert = true;
    });
    renderLightboxImage(triggerIndex);
    lightbox.setAttribute('data-open', 'true');
    lightbox.setAttribute('aria-hidden', 'false');
    setScrollLock(true);
    lightbox.querySelector('.lightbox-close')?.focus();
  }

  lightboxTriggers.forEach(trigger => {
    trigger.addEventListener('click', () => openLightbox(trigger));
  });

  lightboxCloseButtons.forEach(button => {
    button.addEventListener('click', closeLightbox);
  });

  lightboxPrev.addEventListener('click', () => stepLightbox(-1));
  lightboxNext.addEventListener('click', () => stepLightbox(1));

  document.addEventListener('keydown', event => {
    if (lightbox.getAttribute('data-open') !== 'true') {
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      closeLightbox();
      return;
    }

    if (event.key === 'Tab') {
      const controls = Array.from(lightbox.querySelectorAll('.lightbox-panel button:not(:disabled)'));
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      stepLightbox(-1);
      return;
    }

    if (event.key === 'ArrowRight') {
      event.preventDefault();
      stepLightbox(1);
    }
  });

  updateNavigationState();
}

enhanceUserGuideToc();
enhanceProseImages();
initTocSpy();
fitTocLabels();
initLightbox();

window.addEventListener('resize', () => {
  window.requestAnimationFrame(fitTocLabels);
});

document.querySelectorAll('.user-guide-toc-section').forEach(section => {
  section.addEventListener('toggle', () => {
    window.requestAnimationFrame(fitTocLabels);
  });
});
