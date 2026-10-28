import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./i18n";
import "./index.css";
import App from "./App";
import { startFileOpenListener } from "./chrome/fileOpenEvents";
import { startUpdaterCheck } from "./chrome/updaterCheck";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// R7 (Windows citizenship): both are no-ops outside a real Tauri window.
startFileOpenListener();
void startUpdaterCheck();
