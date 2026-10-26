import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./index.css";
import "./styles.css";

// The dark theme is set by public/theme.js. In a build, #root already holds the prerendered first
// screen (see vite.config.ts); rendering replaces it with the live app.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider delay={400}>
      <App />
    </TooltipProvider>
  </StrictMode>,
);
