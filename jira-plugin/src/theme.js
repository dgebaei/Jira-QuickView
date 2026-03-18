const DEFAULT_THEME_MODE = 'system';
const SUPPORTED_THEME_MODES = ['light', 'dark', 'system'];
const THEME_MEDIA_QUERY = '(prefers-color-scheme: dark)';

function getThemeMediaQuery() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return null;
  }
  return window.matchMedia(THEME_MEDIA_QUERY);
}

export function normalizeThemeMode(value) {
  return SUPPORTED_THEME_MODES.indexOf(value) === -1 ? DEFAULT_THEME_MODE : value;
}

export function resolveThemeMode(value) {
  const themeMode = normalizeThemeMode(value);
  if (themeMode !== 'system') {
    return themeMode;
  }

  const mediaQuery = getThemeMediaQuery();
  return mediaQuery && mediaQuery.matches ? 'dark' : 'light';
}

function applyResolvedTheme(doc, themeMode) {
  if (!doc || !doc.documentElement) {
    return;
  }

  const normalizedThemeMode = normalizeThemeMode(themeMode);
  doc.documentElement.setAttribute('data-jhl-theme-mode', normalizedThemeMode);
  doc.documentElement.setAttribute('data-jhl-theme', resolveThemeMode(normalizedThemeMode));
}

export function syncDocumentTheme(doc, themeMode) {
  const normalizedThemeMode = normalizeThemeMode(themeMode);
  const mediaQuery = getThemeMediaQuery();
  const updateTheme = () => applyResolvedTheme(doc, normalizedThemeMode);

  updateTheme();

  if (normalizedThemeMode !== 'system' || !mediaQuery) {
    return () => {};
  }

  if (typeof mediaQuery.addEventListener === 'function') {
    mediaQuery.addEventListener('change', updateTheme);
    return () => mediaQuery.removeEventListener('change', updateTheme);
  }

  mediaQuery.addListener(updateTheme);
  return () => mediaQuery.removeListener(updateTheme);
}

export {
  DEFAULT_THEME_MODE,
  SUPPORTED_THEME_MODES
};
