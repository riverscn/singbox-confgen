// shadcn's dark theme is keyed on a `.dark` class; follow the system setting. A classic script in
// <head> rather than part of the app bundle, so the prerendered page paints in the right theme.
const dark = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => document.documentElement.classList.toggle("dark", dark.matches);
applyTheme();
dark.addEventListener("change", applyTheme);
