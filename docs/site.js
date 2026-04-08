const lightboxTriggers = Array.from(document.querySelectorAll('.lightbox-trigger'));

if (lightboxTriggers.length) {
  const lightbox = document.createElement('div');
  lightbox.className = 'lightbox';
  lightbox.setAttribute('data-open', 'false');
  lightbox.setAttribute('aria-hidden', 'true');

  lightbox.innerHTML = `
    <button type="button" class="lightbox-backdrop" aria-label="Close full screen image"></button>
    <div class="lightbox-panel" role="dialog" aria-modal="true" aria-label="Full screen image viewer">
      <button type="button" class="lightbox-close" aria-label="Close full screen image">&times;</button>
      <figure class="lightbox-figure">
        <img src="" alt="">
        <figcaption class="lightbox-caption"></figcaption>
      </figure>
    </div>
  `;

  document.body.appendChild(lightbox);

  const lightboxImage = lightbox.querySelector('.lightbox-figure img');
  const lightboxCaption = lightbox.querySelector('.lightbox-caption');
  const lightboxCloseButtons = lightbox.querySelectorAll('.lightbox-backdrop, .lightbox-close');

  let lastTrigger = null;

  function closeLightbox() {
    lightbox.setAttribute('data-open', 'false');
    lightbox.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('lightbox-open');
    lightboxImage.src = '';
    lightboxImage.alt = '';
    lightboxCaption.textContent = '';
    if (lastTrigger) {
      lastTrigger.focus();
      lastTrigger = null;
    }
  }

  function openLightbox(trigger) {
    const image = trigger.querySelector('img');
    const figure = trigger.closest('figure');
    const caption = figure?.querySelector('figcaption')?.textContent?.trim() || image?.alt || '';

    if (!image) {
      return;
    }

    lastTrigger = trigger;
    lightboxImage.src = image.src;
    lightboxImage.alt = image.alt || caption;
    lightboxCaption.textContent = caption;
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

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && lightbox.getAttribute('data-open') === 'true') {
      closeLightbox();
    }
  });
}
