import { renderToString } from "react-dom/server";
import App from "./App";
import { TooltipProvider } from "@/components/ui/tooltip";

/** The app's first screen as HTML, for index.html at build time (see vite.config.ts). */
export function render(): string {
  return renderToString(
    <TooltipProvider delay={400}>
      <App />
    </TooltipProvider>,
  );
}
