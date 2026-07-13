import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./style.css";

const rootElement = document.querySelector<HTMLElement>("#root");

if (rootElement === null) {
  throw new Error("Options root element was not found.");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
