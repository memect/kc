import { BaseTool, ToolResult } from "./base.js";
import { Scheduler } from "../scheduler.js";

/**
 * Manage scheduled document-ingestion jobs. Each job is a shell command that
 * lands files in `input/`. KC writes a per-job wrapper script under
 * `scripts/ingest/<id>.sh`; the user installs the script into their crontab
 * (or other OS scheduler) themselves via `crontab -e`.
 *
 * KC does NOT run jobs itself — it generates the artifacts the OS scheduler
 * needs. This means scheduled ingestion works while kc-beta is closed.
 */
export class ScheduleFetchTool extends BaseTool {
  constructor(workspace) {
    super();
    this._workspace = workspace;
    this._sched = new Scheduler(workspace);
  }

  get name() { return "schedule_fetch"; }

  get description() {
    return (
      "Manage scheduled ingestion jobs that pull documents into input/. " +
      "Each job is a shell command (e.g. rsync, curl, wget, custom script). " +
      "KC writes a per-job wrapper script under scripts/ingest/<id>.sh; the user " +
      "installs the script into their system cron (or launchd / Task Scheduler) " +
      "via 'crontab -e'. Jobs run while kc-beta is closed. " +
      "Files landing in input/ are auto-prefixed with <job-id>_<UTC-timestamp>_ " +
      "so origin and ingest time are visible in the filename."
    );
  }

  get inputSchema() {
    return {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["add", "list", "remove", "enable", "disable", "print_crontab"],
          description: "Operation: add (register), list, remove, enable, disable, print_crontab.",
        },
        id: {
          type: "string",
          description: "Job identifier (alphanumeric + _-). Required for add/remove/enable/disable.",
        },
        command: {
          type: "string",
          description: "Shell command for add. Available env vars: $WORKSPACE, $INPUT_DIR, $PROJECT_DIR. Example: 'rsync -av /shared/regs/ \"$INPUT_DIR\"/'.",
        },
        description: {
          type: "string",
          description: "Optional human-readable description of the job.",
        },
        cron_hint: {
          type: "string",
          description: "Optional cron expression (5 fields) to embed in the printed crontab line. KC does NOT evaluate it; the OS does. Example: '0 9 * * *' for daily at 09:00.",
        },
      },
      required: ["operation"],
    };
  }

  async execute(input) {
    const op = input.operation;
    switch (op) {
      case "add": {
        const r = this._sched.add({
          id: input.id,
          command: input.command,
          description: input.description,
          cron_hint: input.cron_hint,
        });
        if (!r.ok) return new ToolResult(`add failed: ${r.reason}`, true);
        const scriptRel = `scripts/ingest/${r.job.id}.sh`;
        return new ToolResult(
          `Job '${r.job.id}' registered. Wrapper script: ${scriptRel}\n` +
          `Install via 'crontab -e' — use 'schedule_fetch print_crontab' to get the line.`
        );
      }
      case "list": {
        const jobs = this._sched.list();
        if (jobs.length === 0) return new ToolResult("(no jobs registered)");
        const lines = jobs.map((j) => {
          const status = j.enabled ? "enabled" : "disabled";
          const hint = j.cron_hint ? ` cron_hint='${j.cron_hint}'` : "";
          return `  ${j.id} [${status}]${hint}\n    cmd: ${j.command}\n    ${j.description ? `desc: ${j.description}` : ""}`;
        });
        const tail = this._sched.tailLog(5);
        return new ToolResult(
          lines.join("\n") +
          (tail ? `\n\nlogs/ingest.log (last 5 lines):\n${tail}` : "")
        );
      }
      case "remove": {
        if (!input.id) return new ToolResult("id required for remove", true);
        const r = this._sched.remove(input.id);
        return new ToolResult(r.ok ? `Removed '${input.id}'.` : `remove failed: ${r.reason}`, !r.ok);
      }
      case "enable":
      case "disable": {
        if (!input.id) return new ToolResult(`id required for ${op}`, true);
        const r = this._sched.setEnabled(input.id, op === "enable");
        return new ToolResult(
          r.ok
            ? `Job '${input.id}' ${op}d.${op === "disable" ? " Wrapper script removed; remember to remove the line from your crontab too." : ""}`
            : `${op} failed: ${r.reason}`,
          !r.ok,
        );
      }
      case "print_crontab": {
        return new ToolResult(this._sched.formatCrontab());
      }
      default:
        return new ToolResult(`Unknown operation: ${op}`, true);
    }
  }
}
