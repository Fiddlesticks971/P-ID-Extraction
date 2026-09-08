import { installMapUpsertPolyfill } from "./mapUpsertPolyfill";

installMapUpsertPolyfill();

// Deferred so the polyfill above is installed on this worker's global Map
// prototype before the real worker script (which relies on it) runs.
import("pdfjs-dist/build/pdf.worker.min.mjs");
