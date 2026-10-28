import { AppShell } from "./chrome/AppShell";

// Tool packages (R4's annotate/pages/forms, R6's text-edit/redact) register themselves by being
// imported once here — see src/chrome/TOOL-API.md.
import "./tools/annotate";
import "./tools/pages";
import "./tools/forms";
import "./tools/text-edit";
import "./tools/redact";

export default function App() {
  return <AppShell />;
}
