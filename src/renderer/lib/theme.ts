export type Theme = 'dark' | 'light';
const storageKey = 'data-agent.theme';

export function readTheme(): Theme {
  try {
    return localStorage.getItem(storageKey) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export function saveTheme(theme: Theme) {
  applyTheme(theme);
  // Appearance remains usable when browser storage is unavailable.
  try {
    localStorage.setItem(storageKey, theme);
  } catch {
    /* Keep the in-memory selection. */
  }
}
