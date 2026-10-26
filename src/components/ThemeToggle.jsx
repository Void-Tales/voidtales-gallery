import { useEffect, useState } from 'preact/hooks';

/*
 * ThemeToggle: ThemeInit.astro has already set the theme on <html> before paint;
 * this only reads it and flips it. The choice goes into the cookie on
 * .voidtales.win (shared with the portal) and into localStorage (local dev,
 * where the browser drops a cookie for another domain).
 */
export default function ThemeToggle() {
  const [dark, setDark] = useState(true);

  useEffect(() => {
    setDark(document.documentElement.classList.contains('dark'));
  }, []);

  const toggleTheme = () => {
    const newDark = !dark;
    const value = newDark ? 'dark' : 'light';
    setDark(newDark);
    document.documentElement.classList.toggle('dark', newDark);
    document.documentElement.setAttribute('data-theme', value);
    document.cookie = `theme=${value}; Domain=.voidtales.win; Path=/; Max-Age=31536000; SameSite=Lax; Secure`;
    try {
      localStorage.setItem('theme', value);
    } catch {
      // Storage disabled: the cookie still carries the choice.
    }
  };

  const label = dark ? 'Switch to light mode' : 'Switch to dark mode';

  return (
    <button
      aria-label={label}
      aria-pressed={dark}
      title={label}
      onClick={toggleTheme}
      className="header-action-btn theme-toggle"
      type="button"
    >
      {/* Sun and moon are stacked; CSS cross-fades them based on the active theme. */}
      <svg
        class="theme-icon theme-icon-sun"
        viewBox="0 0 24 24"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
      </svg>
      <svg
        class="theme-icon theme-icon-moon"
        viewBox="0 0 24 24"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
    </button>
  );
}
