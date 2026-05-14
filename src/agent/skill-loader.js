import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_SKILLS_DIR = path.resolve(__dirname, "../../template/skills");
const PHASE_SKILLS_REGISTRY_PATH = path.join(BUNDLED_SKILLS_DIR, "phase_skills.yaml");

// v0.7.5: registry is data, not code. The phase × skills mapping lives
// in template/skills/phase_skills.yaml as the single source of truth.
// SkillLoader reads it at startup and exposes getPhaseSkillSet(phase).
//
// Fallback used when the YAML file is missing or unparseable — preserves
// prior v0.7.x behavior. Audit-derived from v0.7.4 PHASE_RELEVANT_SKILLS.
const PHASE_SKILLS_FALLBACK = {
  bootstrap: {
    always_loaded: ["bootstrap-workspace"],
    available: ["auto-model-selection", "data-sensibility", "document-parsing", "document-chunking", "version-control"],
  },
  rule_extraction: {
    always_loaded: ["rule-extraction"],
    available: ["work-decomposition", "rule-graph", "data-sensibility", "document-parsing", "document-chunking", "version-control"],
  },
  skill_authoring: {
    always_loaded: ["skill-authoring", "work-decomposition"],
    available: ["data-sensibility", "entity-extraction", "tree-processing", "compliance-judgment", "rule-graph", "corner-case-management", "evolution-loop", "skill-to-workflow", "skill-creator", "version-control"],
  },
  skill_testing: {
    always_loaded: ["evolution-loop"],
    available: ["skill-authoring", "skill-to-workflow", "tree-processing", "corner-case-management", "compliance-judgment", "data-sensibility", "rule-graph", "version-control"],
  },
  distillation: {
    always_loaded: ["skill-to-workflow", "evolution-loop"],
    available: ["skill-authoring", "task-decomposition", "corner-case-management", "confidence-system", "entity-extraction", "compliance-judgment", "version-control"],
  },
  production_qc: {
    always_loaded: ["quality-control", "evolution-loop"],
    available: ["skill-authoring", "skill-to-workflow", "confidence-system", "cross-document-verification", "corner-case-management", "compliance-judgment", "dashboard-reporting", "version-control"],
  },
  finalization: {
    always_loaded: ["quality-control"],
    available: ["skill-authoring", "skill-to-workflow", "dashboard-reporting", "version-control", "pdf-review-dashboard"],
  },
};

/**
 * Parse the simple phase-skills YAML format.
 *
 * Expected shape:
 *   phases:
 *     <name>:
 *       always_loaded: [<skill>, ...]   # or block list with leading "  - <skill>"
 *       available: [<skill>, ...]
 *
 * This handles only the file's specific shape — block-style nested mappings
 * with single-line lists OR block lists. Anchors, multiline strings, flow
 * mappings are NOT supported (we don't need them). Comments (#) ignored.
 * On any parse weirdness, returns null so caller falls back to defaults.
 */
function parsePhaseSkillsYaml(text) {
  if (!text || typeof text !== "string") return null;

  const lines = text.split("\n");
  const result = { phases: {} };

  let currentPhase = null;
  let currentList = null; // "always_loaded" | "available" | null

  for (let raw of lines) {
    // Strip inline comments + trailing whitespace
    const hashIdx = raw.indexOf("#");
    const line = (hashIdx >= 0 ? raw.slice(0, hashIdx) : raw).trimEnd();
    if (!line.trim()) continue;

    // Match indent level — phases: at column 0, phase name at 2 spaces,
    // list-name at 4 spaces, list-item at 6 spaces
    if (/^phases\s*:\s*$/.test(line)) {
      currentPhase = null;
      currentList = null;
      continue;
    }

    // Phase name line: "  bootstrap:"
    const phaseMatch = /^ {2}(\w+)\s*:\s*$/.exec(line);
    if (phaseMatch) {
      currentPhase = phaseMatch[1];
      result.phases[currentPhase] = { always_loaded: [], available: [] };
      currentList = null;
      continue;
    }

    // List name line: "    always_loaded:" or "    available:" or with inline list
    const listMatch = /^ {4}(always_loaded|available)\s*:\s*(.*)$/.exec(line);
    if (listMatch && currentPhase) {
      const listName = listMatch[1];
      const inline = listMatch[2].trim();
      currentList = listName;
      // Inline list shape: "[foo, bar]" or "[]"
      if (inline.startsWith("[") && inline.endsWith("]")) {
        const inner = inline.slice(1, -1).trim();
        if (inner) {
          result.phases[currentPhase][listName] = inner
            .split(",")
            .map(s => s.trim().replace(/^["']|["']$/g, ""))
            .filter(Boolean);
        }
        currentList = null; // inline list closed
      }
      continue;
    }

    // List item line: "      - foo"
    const itemMatch = /^ {6}-\s+(.+)$/.exec(line);
    if (itemMatch && currentPhase && currentList) {
      const item = itemMatch[1].trim().replace(/^["']|["']$/g, "");
      result.phases[currentPhase][currentList].push(item);
      continue;
    }
  }

  // Validate we got at least one phase
  if (Object.keys(result.phases).length === 0) return null;
  return result;
}

/**
 * Discover and index meta skills from template/skills/.
 *
 * v0.7.5 layout (flat):
 *   template/skills/{lang}/<name>/SKILL.md
 *
 * Earlier v0.3.0–v0.7.4 layout (deep, deprecated):
 *   template/skills/{lang}/{meta-meta|meta|skill-creator}/<name>/SKILL.md
 *
 * SkillLoader supports both layouts during the v0.7.5 reorganization;
 * after Group B completes, only the flat layout exists.
 *
 * Skills are auto-discovered by walking the lang dir for any subdirectory
 * containing a SKILL.md. Frontmatter is parsed for name, description,
 * and tier (meta | meta-meta). The phase × skills registry
 * (template/skills/phase_skills.yaml) declares which skills appear in
 * which phase's always-loaded vs available sets.
 */
export class SkillLoader {
  /**
   * @param {string} [language] - "en" or "zh"
   * @param {string} [skillsDir] - Override skills directory (default: bundled template)
   */
  constructor(language = "en", skillsDir) {
    this._lang = language;
    this._skillsDir = skillsDir || BUNDLED_SKILLS_DIR;
    this._index = null;
    this._registry = null;
    this._bodyCache = new Map(); // name → body string
  }

  /**
   * Load + cache the phase × skills registry from YAML.
   * Falls back to PHASE_SKILLS_FALLBACK on parse failure or missing file.
   */
  _loadRegistry() {
    if (this._registry) return this._registry;
    try {
      if (fs.existsSync(PHASE_SKILLS_REGISTRY_PATH)) {
        const text = fs.readFileSync(PHASE_SKILLS_REGISTRY_PATH, "utf-8");
        const parsed = parsePhaseSkillsYaml(text);
        if (parsed?.phases) {
          this._registry = parsed.phases;
          return this._registry;
        }
        // eslint-disable-next-line no-console
        console.warn("[skill-loader] phase_skills.yaml parsed empty/invalid; using fallback");
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[skill-loader] phase_skills.yaml load error: ${err.message}; using fallback`);
    }
    this._registry = PHASE_SKILLS_FALLBACK;
    return this._registry;
  }

  /**
   * Get the always_loaded + available skill names for a phase.
   * always_loaded is auto-added to available (set semantics, no duplicates).
   *
   * @param {string} phase
   * @returns {{alwaysLoaded: string[], available: string[]}}
   */
  getPhaseSkillSet(phase) {
    const reg = this._loadRegistry();
    const entry = reg[phase];
    if (!entry) return { alwaysLoaded: [], available: [] };
    const alwaysLoaded = [...(entry.always_loaded || [])];
    const availableSet = new Set([...alwaysLoaded, ...(entry.available || [])]);
    return {
      alwaysLoaded,
      available: [...availableSet],
    };
  }

  /**
   * Find a skill's directory on disk, supporting both flat (v0.7.5+)
   * and deep (v0.3.0–v0.7.4) layouts. Returns absolute path to the
   * directory containing SKILL.md, or null.
   */
  _findSkillDir(name) {
    const langDir = path.join(this._skillsDir, this._lang);
    if (!fs.existsSync(langDir)) return null;

    // v0.7.5 flat layout: <langDir>/<name>/SKILL.md
    const flatPath = path.join(langDir, name);
    if (fs.existsSync(path.join(flatPath, "SKILL.md"))) return flatPath;

    // Pre-v0.7.5 deep layout: <langDir>/{meta-meta|meta|skill-creator}/<name>/SKILL.md
    for (const category of ["meta-meta", "meta", "skill-creator"]) {
      const deepPath = path.join(langDir, category, name);
      if (fs.existsSync(path.join(deepPath, "SKILL.md"))) return deepPath;
    }
    return null;
  }

  /**
   * Read a skill's body (post-frontmatter content).
   * Cached after first read.
   *
   * @param {string} name
   * @returns {string|null} body text, or null if skill not found
   */
  loadSkillBody(name) {
    if (this._bodyCache.has(name)) return this._bodyCache.get(name);
    const dir = this._findSkillDir(name);
    if (!dir) {
      this._bodyCache.set(name, null);
      return null;
    }
    try {
      const text = fs.readFileSync(path.join(dir, "SKILL.md"), "utf-8");
      // Strip frontmatter: everything between leading "---\n" and the next "---\n"
      const stripped = text.replace(/^---\n[\s\S]*?\n---\n?/, "");
      this._bodyCache.set(name, stripped);
      return stripped;
    } catch {
      this._bodyCache.set(name, null);
      return null;
    }
  }

  /**
   * Build the skill index by scanning SKILL.md frontmatter.
   * Cached after first call.
   *
   * @returns {Array<{name: string, description: string, category: string, tier: string, path: string}>}
   */
  getIndex() {
    if (this._index) return this._index;
    this._index = [];

    const langDir = path.join(this._skillsDir, this._lang);
    if (!fs.existsSync(langDir)) return this._index;

    // Walk lang dir. For each entry that is a directory:
    //   - if it directly contains SKILL.md → flat skill (v0.7.5+ layout)
    //   - else if it matches a known category name → walk it for skills
    //     (pre-v0.7.5 deep layout backward-compat during Group B reorg)
    const entries = fs.readdirSync(langDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const entryPath = path.join(langDir, entry.name);
      const directSkillMd = path.join(entryPath, "SKILL.md");

      if (fs.existsSync(directSkillMd)) {
        // Flat layout
        const meta = this._parseFrontmatter(directSkillMd);
        if (meta.name) {
          this._index.push({
            name: meta.name,
            description: meta.description || "",
            tier: meta.tier || this._inferTierFromName(meta.name),
            category: meta.tier || "meta", // legacy alias
            path: path.relative(this._skillsDir, entryPath),
          });
        }
      } else if (["meta-meta", "meta", "skill-creator"].includes(entry.name)) {
        // Deep layout (pre-v0.7.5) — recurse one level
        // For skill-creator, the SKILL.md is at this level (not in a subdir)
        const skillCreatorMd = path.join(entryPath, "SKILL.md");
        if (fs.existsSync(skillCreatorMd)) {
          const meta = this._parseFrontmatter(skillCreatorMd);
          if (meta.name) {
            this._index.push({
              name: meta.name,
              description: meta.description || "",
              tier: meta.tier || "meta",
              category: entry.name,
              path: path.relative(this._skillsDir, entryPath),
            });
          }
        }
        for (const subEntry of fs.readdirSync(entryPath, { withFileTypes: true })) {
          if (!subEntry.isDirectory()) continue;
          const subSkillMd = path.join(entryPath, subEntry.name, "SKILL.md");
          if (!fs.existsSync(subSkillMd)) continue;
          const meta = this._parseFrontmatter(subSkillMd);
          this._index.push({
            name: meta.name || subEntry.name,
            description: meta.description || "",
            tier: meta.tier || (entry.name === "meta-meta" ? "meta-meta" : "meta"),
            category: entry.name,
            path: path.relative(this._skillsDir, path.join(entryPath, subEntry.name)),
          });
        }
      }
    }

    return this._index;
  }

  /**
   * Heuristic tier inference for skills lacking explicit `tier:` frontmatter.
   * Used as a fallback during the v0.7.5 reorganization when frontmatter
   * hasn't been backfilled yet. Once Group B completes, every SKILL.md
   * declares its tier explicitly and this inference becomes a no-op fallback.
   */
  _inferTierFromName(name) {
    const META_META = new Set([
      "bootstrap-workspace", "evolution-loop", "quality-control",
      "rule-graph", "task-decomposition", "work-decomposition",
      "dashboard-reporting",
    ]);
    return META_META.has(name) ? "meta-meta" : "meta";
  }

  /**
   * Format the skill index + always-loaded bodies for injection into agent context.
   *
   * v0.7.5: emits TWO sections:
   *   - Always loaded: full bodies inline (architecturally-needed for the phase)
   *   - Available: name + description tease + reminder to use consult_skill
   *
   * Pre-v0.7.5: emitted only descriptions for the phase-relevant subset.
   *
   * @param {string} [phase] - Current engine phase
   * @returns {string}
   */
  formatForContext(phase) {
    const index = this.getIndex();
    if (index.length === 0) return "";

    const { alwaysLoaded, available } = this.getPhaseSkillSet(phase);
    const alwaysSet = new Set(alwaysLoaded);
    const availableSet = new Set(available);

    const byName = new Map(index.map(s => [s.name, s]));

    const lines = [];

    // Section 1: Always-loaded skill bodies (inline)
    if (alwaysLoaded.length > 0) {
      lines.push("## Methodology Skills — Loaded Into Your Context");
      lines.push(
        "These are the architecturally-required skills for the current phase. " +
        "Treat their content as authoritative guidance for your work in this phase. " +
        "If meta-meta and meta guidance conflict, meta-meta wins (architect's frame " +
        "bounds the technique).\n",
      );
      for (const name of alwaysLoaded) {
        const skill = byName.get(name);
        const body = this.loadSkillBody(name);
        if (!body) continue;
        const tierLabel = skill?.tier ? ` [tier: ${skill.tier}]` : "";
        lines.push(`### ${name}${tierLabel}\n`);
        lines.push(body.trim());
        lines.push("");
      }
    }

    // Section 2: Available skills (description teases only)
    const consultable = [...availableSet].filter(n => !alwaysSet.has(n));
    if (consultable.length > 0) {
      lines.push("## Available Methodology Skills");
      lines.push(
        "Call `consult_skill(name)` to load the full body into your conversation " +
        "history when a description tease isn't enough. Each consult returns the " +
        "skill body once; subsequent turns may need to re-consult if the body has " +
        "aged out of context.\n",
      );

      const visible = consultable
        .map(n => byName.get(n))
        .filter(Boolean);

      const metaMeta = visible.filter(s => s.tier === "meta-meta");
      const meta = visible.filter(s => s.tier !== "meta-meta");

      if (metaMeta.length > 0) {
        lines.push("**System Architecture (meta-meta):**");
        for (const s of metaMeta) {
          lines.push(`- **${s.name}**: ${s.description.slice(0, 160)}`);
        }
        lines.push("");
      }

      if (meta.length > 0) {
        lines.push("**Procedural Techniques (meta):**");
        for (const s of meta) {
          lines.push(`- **${s.name}**: ${s.description.slice(0, 160)}`);
        }
        lines.push("");
      }
    }

    return lines.join("\n");
  }

  /**
   * Populate `<workspace>/skills/` with the available skill set for a phase.
   *
   * Uses symlink-with-copy-fallback: each phase's `available` skills are
   * symlinked from the bundled template/skills/<lang>/<name>/ into
   * <workspace>/skills/<name>. On phase advance/retreat, the workspace
   * `skills/` is wiped + re-populated to match the new phase.
   *
   * The agent's `ls skills/` shows only the phase-relevant set. The
   * `consult_skill` tool reads bodies via SkillLoader (independent of
   * workspace dir state), so consult still works for the available set
   * even if symlinks fail.
   *
   * @param {string} workspaceCwd - absolute path to workspace root
   * @param {string} phase - current phase
   * @returns {{phase: string, populated: string[], failures: Array<{name: string, error: string}>}}
   */
  populateWorkspaceSkills(workspaceCwd, phase) {
    const targetDir = path.join(workspaceCwd, "skills");
    const result = { phase, populated: [], failures: [] };

    // Clear existing skills/ contents (preserve dir).
    try {
      fs.mkdirSync(targetDir, { recursive: true });
      for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
        const entryPath = path.join(targetDir, entry.name);
        try {
          if (entry.isSymbolicLink() || entry.isFile()) {
            fs.unlinkSync(entryPath);
          } else if (entry.isDirectory()) {
            fs.rmSync(entryPath, { recursive: true, force: true });
          }
        } catch (err) {
          result.failures.push({ name: entry.name, error: `clear failed: ${err.message}` });
        }
      }
    } catch (err) {
      result.failures.push({ name: "(setup)", error: `mkdir/clear failed: ${err.message}` });
      return result;
    }

    const { available } = this.getPhaseSkillSet(phase);

    for (const name of available) {
      const sourceDir = this._findSkillDir(name);
      if (!sourceDir) {
        result.failures.push({ name, error: "source not found in bundled skills" });
        continue;
      }
      const linkPath = path.join(targetDir, name);
      try {
        // Try symlink first (zero file churn on phase advance/retreat).
        fs.symlinkSync(sourceDir, linkPath, "dir");
        result.populated.push(name);
      } catch (symErr) {
        // Fallback: recursive copy. Slower but works on Windows / restricted FSes.
        try {
          this._recursiveCopy(sourceDir, linkPath);
          result.populated.push(name);
        } catch (copyErr) {
          result.failures.push({ name, error: `symlink: ${symErr.message}; copy: ${copyErr.message}` });
        }
      }
    }

    return result;
  }

  /**
   * Recursive directory copy (sync). Used as fallback when symlinkSync fails.
   */
  _recursiveCopy(srcDir, destDir) {
    fs.mkdirSync(destDir, { recursive: true });
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const src = path.join(srcDir, entry.name);
      const dst = path.join(destDir, entry.name);
      if (entry.isDirectory()) {
        this._recursiveCopy(src, dst);
      } else if (entry.isFile()) {
        fs.copyFileSync(src, dst);
      }
    }
  }

  /**
   * Parse YAML frontmatter from a SKILL.md file.
   * Extracts name, description, and tier.
   */
  _parseFrontmatter(filePath) {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const match = content.match(/^---\n([\s\S]*?)\n---/);
      if (!match) return {};

      const frontmatter = match[1];
      const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim() || "";
      const tier = frontmatter.match(/^tier:\s*(.+)$/m)?.[1]?.trim() || "";

      // Description: single-line OR multi-line (YAML > folded)
      let description = "";
      const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
      if (descMatch && descMatch[1].trim() === ">") {
        const multiMatch = frontmatter.match(/^description:\s*>\s*\n((?:[ \t]+.+\n?)*)/m);
        if (multiMatch) {
          description = multiMatch[1].replace(/^[ \t]+/gm, "").replace(/\n/g, " ").trim();
        }
      } else if (descMatch) {
        description = descMatch[1].trim();
      }
      return { name, description, tier };
    } catch {
      return {};
    }
  }
}
