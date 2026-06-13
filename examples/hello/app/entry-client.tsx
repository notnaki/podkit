import { hydrateRoot } from "react-dom/client";
declare global { interface Window { __PODKIT_DATA__: unknown } }
const root = document.getElementById("root")!;
hydrateRoot(root, root.firstElementChild as never);
