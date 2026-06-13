import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/hanken-grotesk";
import "@fontsource/spline-sans-mono/400.css";
import "@fontsource/spline-sans-mono/500.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/layout.css";
import { App } from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
