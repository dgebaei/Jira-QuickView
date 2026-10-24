function enhanceReadmeImages() {
  const readmeImages = Array.from(document.querySelectorAll('.readme-render img'));

  readmeImages.forEach(image => {
    const rawSrc = image.getAttribute('src') || '';
    if (!rawSrc || rawSrc.startsWith('http://') || rawSrc.startsWith('https://')) {
      return;
    }
    if (image.closest('.lightbox-trigger') || image.closest('a')) {
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

enhanceUserGuideToc();
enhanceReadmeImages();

const lightboxTriggers = Array.from(document.querySelectorAll('.lightbox-trigger'));

if (lightboxTriggers.length) {
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

  function closeLightbox() {
    lightbox.setAttribute('data-open', 'false');
    lightbox.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('lightbox-open');
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
    renderLightboxImage(triggerIndex);
    lightbox.setAttribute('data-open', 'true');
    lightbox.setAttribute('aria-hidden', 'false');
    document.body.classList.add('lightbox-open');
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
      closeLightbox();
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
