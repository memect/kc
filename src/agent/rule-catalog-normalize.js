/**
 * Normalize a catalog.json payload into a flat array of rule records.
 *
 * KC the agent has historically produced catalog.json in at least four shapes,
 * and earlier code paths assumed a flat array — silently dropping everything
 * when the catalog was object-shaped. This helper unifies the handling so
 * the engine, the rule_catalog tool, and the release tool all see the same
 * list of rules regardless of how the file was written.
 *
 * Accepted shapes:
 *   1. [rule, rule, ...]                              flat array (original)
 *   2. { rules: [...] }                               wrapper object
 *   3. { categories: { A: [...], B: [...] }, ... }    grouped by category
 *   4. { categories: { A: { rules: [...] }, ... } }   nested category objects
 *
 * Anything else (null, wrong shape, throws) returns [].
 */
export function normalizeRuleCatalog(catalog) {
  if (Array.isArray(catalog)) return catalog;
  if (!catalog || typeof catalog !== "object") return [];

  if (Array.isArray(catalog.rules)) return catalog.rules;

  if (catalog.categories && typeof catalog.categories === "object") {
    const out = [];
    for (const group of Object.values(catalog.categories)) {
      if (Array.isArray(group)) {
        out.push(...group);
      } else if (group && Array.isArray(group.rules)) {
        out.push(...group.rules);
      }
    }
    if (out.length > 0) return out;
  }

  return [];
}
