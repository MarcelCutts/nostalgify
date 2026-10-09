const ERROR_CLASSES = new Set(["Error", "TypeError", "ReferenceError", "SyntaxError", "RangeError", "URIError", "DOMException", "ResizeObserver"]);
const RESIZE_ERRORS = new Set(["ResizeObserver loop limit exceeded", "ResizeObserver loop completed with undelivered notifications."]);

export function safeWebError(event = {}) {
  const resize = RESIZE_ERRORS.has(event.message);
  const name = resize ? "ResizeObserver" : event.error?.name;
  return {
    code: resize ? "resize_observer_loop" : "javascript_error",
    errorClass: ERROR_CLASSES.has(name) ? name : "Unknown",
    source: typeof event.filename === "string" && event.filename.split(/[?#]/)[0].split("/").at(-1) === "app.js" ? "app.js" : "unknown",
    ...(Number.isSafeInteger(event.lineno) && event.lineno >= 0 ? { line: event.lineno } : {}),
    ...(Number.isSafeInteger(event.colno) && event.colno >= 0 ? { column: event.colno } : {}),
  };
}
