import { Sun, Moon } from "lucide-react";

export function ThemeToggle() {
  function toggle() {
    const next = document.documentElement.classList.toggle("dark");
    try { localStorage.setItem("theme", next ? "dark" : "light"); } catch { /* The theme still works when storage is unavailable. */ }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle theme"
      style={{ width: 40, height: 40 }}
      className="inline-flex items-center justify-center rounded-[6px] border-0 bg-transparent text-fg-2 cursor-pointer transition-colors hover:bg-surface-hover hover:text-fg-1"
    >
      <Sun size={15} className="hidden dark:block" aria-hidden="true" />
      <Moon size={15} className="block dark:hidden" aria-hidden="true" />
    </button>
  );
}
