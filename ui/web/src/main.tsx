import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import WorkflowDashboard from "./workflow-dashboard";
import "./base.css";
import "./themes/soft-signal.css";
import "./themes/terminal.css";
import "./workflow-dashboard.css";
import "./renderers/terminal-shell.css";

const root = document.getElementById("root");
if (root) createRoot(root).render(<StrictMode><WorkflowDashboard /></StrictMode>);
