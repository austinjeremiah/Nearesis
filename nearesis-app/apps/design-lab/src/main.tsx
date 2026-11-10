import "@nearesis/ui/styles.css";
import "./lab.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

const q = new URLSearchParams(location.search);
const theme = q.get("theme");
if (theme === "dark" || theme === "light") document.documentElement.dataset.theme = theme;
if (q.get("motion") === "reduced") document.documentElement.dataset.motion = "reduced";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
