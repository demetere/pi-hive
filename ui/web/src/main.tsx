import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import WorkflowDashboard from "./workflow-dashboard";
import "./base.css";
import "./workflow-dashboard.css";

const root = document.getElementById("root");
if (root) createRoot(root).render(<StrictMode><WorkflowDashboard /></StrictMode>);
