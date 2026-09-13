import { useEffect, useState } from 'react';

type ThemePreference = 'system' | 'light' | 'dark';

export function ThemePicker() {
  const [preference, setPreference] = useState<ThemePreference>(() => {
    const initial = document.documentElement.dataset.themePreference;
    return initial === 'light' || initial === 'dark' ? initial : 'system';
  });

  useEffect(() => {
    const systemTheme = matchMedia('(prefers-color-scheme: dark)');
    const applyTheme = () => {
      document.documentElement.dataset.themePreference = preference;
      document.documentElement.dataset.theme = preference === 'system'
        ? (systemTheme.matches ? 'dark' : 'light')
        : preference;
    };
    applyTheme();
    systemTheme.addEventListener('change', applyTheme);
    return () => systemTheme.removeEventListener('change', applyTheme);
  }, [preference]);

  function changeTheme(next: ThemePreference) {
    setPreference(next);
    try {
      if (next === 'system') localStorage.removeItem('kumpel-theme');
      else localStorage.setItem('kumpel-theme', next);
    } catch {
      // The selection still works for this page when storage is unavailable.
    }
  }

  return <label className="theme-picker">
    <span>Theme</span>
    <select value={preference} onChange={event => changeTheme(event.target.value as ThemePreference)}>
      <option value="system">System</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  </label>;
}
