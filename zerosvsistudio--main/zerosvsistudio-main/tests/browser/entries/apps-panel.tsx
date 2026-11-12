import "@/design/tokens.css";
import "@/design/design.css";
import { createRoot } from "react-dom/client";
import AppsPanel from "@/components/settings/AppsPanel";
import Toaster from "@/components/Toaster";
(window as unknown as { mountPanel: () => void }).mountPanel = () => createRoot(document.getElementById("root")!).render(<><AppsPanel /><Toaster /></>);
