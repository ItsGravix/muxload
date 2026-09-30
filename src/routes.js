// Shared by the browser and server so custom paths follow the same rules.
const defaults = {
  create: "uploads",
  batch: "batches",
  status: "status",
  complete: "uploads/:id/complete",
  remove: "uploads/:id",
};

export function uploadRoutes(overrides = {}, { browser = false } = {}) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("routes must be an object.");
  }
  for (const name of Object.keys(overrides)) {
    if (!Object.hasOwn(defaults, name)) throw new TypeError(`Unknown upload route: ${name}.`);
  }
  const routes = Object.fromEntries(Object.entries(defaults).map(([name, fallback]) => {
    const value = overrides[name] ?? fallback;
    // Existing advanced browser URL builders remain usable with custom servers.
    if (browser && typeof value === "function") return [name, value];
    if (typeof value !== "string" || !value.trim()) throw new TypeError(`routes.${name} must be a path.`);
    if (browser && /^https?:\/\//i.test(value)) return [name, value];
    const path = value.replace(/^\/+|\/+$/g, "");
    const dynamic = name === "complete" || name === "remove";
    if (!path || path.split("/").some((part) => ((part === "." || part === ".." || !/^[a-zA-Z0-9._~-]+$/.test(part)) && part !== ":id"))
      || path.split("/").filter((part) => part === ":id").length !== (dynamic ? 1 : 0)) {
      throw new TypeError(`routes.${name} must be a relative path${dynamic ? " containing one :id segment" : " without parameters"}.`);
    }
    return [name, path];
  }));
  const postRoutes = ["create", "batch", "complete"];
  for (let i = 0; i < postRoutes.length; i++) {
    for (let j = i + 1; j < postRoutes.length; j++) {
      const a = routes[postRoutes[i]];
      const b = routes[postRoutes[j]];
      if (typeof a !== "string" || typeof b !== "string") continue;
      const left = a.split("/");
      const right = b.split("/");
      if (left.length === right.length && left.every((part, index) => part === right[index] || part === ":id" || right[index] === ":id")) {
        throw new TypeError(`routes.${postRoutes[i]} and routes.${postRoutes[j]} overlap. Choose different paths.`);
      }
    }
  }
  return routes;
}

export function matchUploadRoute(template, pathname) {
  const actual = pathname.replace(/^\//, "").split("/");
  const expected = template.split("/");
  if (actual.length !== expected.length) return null;
  let id;
  for (let index = 0; index < expected.length; index++) {
    if (expected[index] === ":id") {
      if (!actual[index]) return null;
      id = actual[index];
    } else if (expected[index] !== actual[index]) return null;
  }
  return { id };
}
