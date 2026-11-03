import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./ui/themes.css";
import "./styles.css";
import "./ui/desktop.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
