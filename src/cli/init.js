import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.resolve(__dirname, "../../template");

/**
 * kc-beta init [project-name] [--lang=zh]
 * Creates a new workspace from the bundled template.
 */
export async function init() {
  const args = process.argv.slice(3);
  let projectName = "kc-project";
  let lang = "en";

  for (const arg of args) {
    if (arg.startsWith("--lang=")) {
      lang = arg.split("=")[1] || "en";
    } else if (!arg.startsWith("-")) {
      projectName = arg;
    }
  }

  const targetDir = path.resolve(process.cwd(), projectName);

  if (fs.existsSync(targetDir)) {
    console.error(`Error: Directory '${projectName}' already exists.`);
    process.exit(1);
  }

  if (!fs.existsSync(TEMPLATE_DIR)) {
    console.error("Error: Template directory not found. Ensure kc-beta is installed correctly.");
    process.exit(1);
  }

  // Copy template
  copyDir(TEMPLATE_DIR, targetDir);

  // Remove opposite language skills
  const skillsDir = path.join(targetDir, "skills");
  if (fs.existsSync(skillsDir)) {
    const removeLang = lang === "zh" ? "en" : "zh";
    const removePath = path.join(skillsDir, removeLang);
    if (fs.existsSync(removePath)) {
      fs.rmSync(removePath, { recursive: true, force: true });
    }
  }

  // Rename .env.template to .env
  const envTemplate = path.join(targetDir, ".env.template");
  const envTarget = path.join(targetDir, ".env");
  if (fs.existsSync(envTemplate)) {
    fs.renameSync(envTemplate, envTarget);
    // Set language
    let content = fs.readFileSync(envTarget, "utf-8");
    content = content.replace("LANGUAGE=en", `LANGUAGE=${lang}`);
    fs.writeFileSync(envTarget, content, "utf-8");
  }

  console.log(`\n  Created ${projectName}/`);
  console.log(`  Language: ${lang === "zh" ? "中文" : "English"}`);
  console.log(`\n  Next steps:`);
  console.log(`    cd ${projectName}`);
  console.log(`    kc-beta onboard    # configure API keys`);
  console.log(`    kc-beta            # start the agent\n`);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
