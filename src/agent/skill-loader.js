import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_SKILLS_DIR = path.resolve(__dirname, "../../template/skills");

/**
 * Discover and index meta skills from template/skills/.
 * Follows Claude Code's pattern: skills are NOT dumped into the system prompt.
 * Instead, a brief index (name + description) is injected into context.
 * The agent reads full SKILL.md content on demand via workspace_file or sandbox_exec.
 *
 * Skills are organized as:
 *   template/skills/{lang}/meta-meta/  — System architecture methodology
 *   template/skills/{lang}/meta/       — Verification domain methodology
 *   template/skills/{lang}/skill-creator/ — Anthropic's official skill creation toolkit
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
  }

  /**
   * Build the skill index by scanning SKILL.md frontmatter.
   * Cached after first call.
   * @returns {Array<{name: string, description: string, category: string, path: string}>}
   */
  getIndex() {
    if (this._index) return this._index;

    this._index = [];
    const langDir = path.join(this._skillsDir, this._lang);
    if (!fs.existsSync(langDir)) return this._index;

    for (const category of ["meta-meta", "meta", "skill-creator"]) {
      const catDir = path.join(langDir, category);
      if (!fs.existsSync(catDir)) continue;

      // skill-creator is a single skill, not a directory of skills
      const skillMd = path.join(catDir, "SKILL.md");
      if (fs.existsSync(skillMd)) {
        const { name, description } = this._parseFrontmatter(skillMd);
        if (name) {
          this._index.push({
            name: name || category,
            description: description || "",
            category,
            path: path.relative(this._skillsDir, catDir),
          });
        }
      }

      // Check subdirectories (meta-meta/bootstrap-workspace/, etc.)
      for (const entry of fs.readdirSync(catDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const subSkillMd = path.join(catDir, entry.name, "SKILL.md");
        if (!fs.existsSync(subSkillMd)) continue;

        const { name, description } = this._parseFrontmatter(subSkillMd);
        this._index.push({
          name: name || entry.name,
          description: description || "",
          category,
          path: path.relative(this._skillsDir, path.join(catDir, entry.name)),
        });
      }
    }

    return this._index;
  }

  /**
   * Format the skill index for injection into agent context.
   * Brief listing — agent reads full content on demand.
   * @returns {string}
   */
  formatForContext() {
    const index = this.getIndex();
    if (index.length === 0) return "";

    const metaMeta = index.filter((s) => s.category === "meta-meta");
    const meta = index.filter((s) => s.category === "meta");
    const other = index.filter((s) => s.category !== "meta-meta" && s.category !== "meta");

    const lines = ["## Available Methodology Skills",
      "Read full skill content from the skills/ directory when needed.\n"];

    if (metaMeta.length) {
      lines.push("**System Architecture (meta-meta):**");
      for (const s of metaMeta) {
        lines.push(`- **${s.name}**: ${s.description.slice(0, 120)}`);
      }
      lines.push("");
    }

    if (meta.length) {
      lines.push("**Verification Methodology (meta):**");
      for (const s of meta) {
        lines.push(`- **${s.name}**: ${s.description.slice(0, 120)}`);
      }
      lines.push("");
    }

    if (other.length) {
      lines.push("**Toolkits:**");
      for (const s of other) {
        lines.push(`- **${s.name}**: ${s.description.slice(0, 120)}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Parse YAML frontmatter from a SKILL.md file.
   * Only extracts name and description — lightweight.
   */
  _parseFrontmatter(filePath) {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const match = content.match(/^---\n([\s\S]*?)\n---/);
      if (!match) return {};

      const frontmatter = match[1];
      const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim() || "";

      // Handle both single-line and multi-line (YAML >) descriptions
      let description = "";
      const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
      if (descMatch && descMatch[1].trim() === ">") {
        // Multi-line: capture indented lines after "description: >"
        const multiMatch = frontmatter.match(/^description:\s*>\s*\n((?:[ \t]+.+\n?)*)/m);
        if (multiMatch) {
          description = multiMatch[1].replace(/^[ \t]+/gm, "").replace(/\n/g, " ").trim();
        }
      } else if (descMatch) {
        description = descMatch[1].trim();
      }
      return { name, description };
    } catch {
      return {};
    }
  }
}
