// v0.8 P4 — templated continuation prompts for the marathon driver.
//
// Driver state → prompt template mapping. Templates are deterministic
// (no LLM in the driver), bilingual (en + zh per workspace LANGUAGE).
// Goal: surface to KC's main conductor the smallest useful nudge to
// keep the pipeline moving without leaking marathon-implementation
// details into the agent's context.
//
// Each template is a function (engineState, goal) → string. State
// fields used:
//   currentPhase, milestones, idleSec, lastEventType, goal
//
// Add new templates here as the driver state machine grows.

const TEMPLATES_EN = {
  initial: (s) => `Goal: ${s.goal}\n\n` +
    `You are running in marathon mode (no manual user check-ins). Advance the pipeline phase by phase. ` +
    `Engine derives milestones from filesystem facts; produce real artifacts, then call phase_advance. ` +
    `If you get stuck on a specific phase, surface the blocker in your next response and the driver will ` +
    `inject a diagnostic prompt next turn.`,

  continue_phase: (s) => `Continue with ${s.currentPhase} work. ` +
    `Engine status: ${formatMilestones(s.milestones)}.`,

  advance_phase: (s) => `${s.currentPhase} milestones look complete (${formatMilestones(s.milestones)}). ` +
    `Verify the gate conditions then call \`phase_advance\` to the next phase.`,

  unstick: (s) => `No phase progress in the last ${Math.round(s.idleSec / 60)} minutes. ` +
    `Either (1) surface the blocker explicitly so the developer user can intervene, or (2) ` +
    `consult the relevant meta-skill for the current phase and try a different approach. ` +
    `If you've genuinely finished and the engine gate is wrong, force phase_advance with reason.`,

  finalize: (s) => `You've reached finalization. Wrap the deliverable bundle: ` +
    `verify rule_skills/coverage_report.md is substantive, output/releases/<slug>/ is current ` +
    `(re-run release tool if workflows changed after the last snapshot), and final_dashboard.html ` +
    `reflects the latest QC data. When done, just say so — the marathon will exit.`,

  stop: () => `Marathon stop condition reached. Save state and summarize what was accomplished.`,
};

const TEMPLATES_ZH = {
  initial: (s) => `目标：${s.goal}\n\n` +
    `你正运行在 marathon 模式（无人工 check-in）。按阶段推进整条流水线。` +
    `引擎从文件系统事实派生里程碑；先把真实交付物产出来，再调用 phase_advance。` +
    `如果在某个阶段卡住了，直接在下一回合的回复里把阻塞点说清楚，驱动器会在下一回合注入诊断提示。`,

  continue_phase: (s) => `继续 ${s.currentPhase} 阶段的工作。` +
    `引擎状态：${formatMilestones(s.milestones)}。`,

  advance_phase: (s) => `${s.currentPhase} 阶段的里程碑看起来已经完成（${formatMilestones(s.milestones)}）。` +
    `核对一遍门控条件，然后调用 \`phase_advance\` 进入下一阶段。`,

  unstick: (s) => `已经 ${Math.round(s.idleSec / 60)} 分钟没有阶段推进了。` +
    `两条路：(1) 明确说出阻塞在哪里、让开发者用户介入；(2) 查阅当前阶段相关的 meta-skill 换个思路再试。` +
    `如果你确实已经做完、但引擎门控判断错误，用 reason 强制 phase_advance。`,

  finalize: (s) => `已经进入 finalization。收尾打包：` +
    `确认 rule_skills/coverage_report.md 内容充实、output/releases/<slug>/ 是最新的（` +
    `如果 workflows 在最近一次快照之后还有改动，重新跑 release 工具），final_dashboard.html 反映最新 QC 数据。` +
    `做完之后直接说一声，marathon 会退出。`,

  stop: () => `Marathon 停止条件已触发。保存状态、总结已完成的工作。`,
};

function formatMilestones(m) {
  if (!m || typeof m !== "object") return "(unknown)";
  const parts = [];
  for (const [k, v] of Object.entries(m)) {
    if (typeof v === "number") parts.push(`${k}:${v}`);
    else if (typeof v === "boolean") parts.push(`${k}:${v ? "yes" : "no"}`);
    else if (Array.isArray(v)) parts.push(`${k}:${v.length}`);
  }
  return parts.slice(0, 6).join(", ") || "(empty)";
}

/**
 * Render a continuation prompt for the given driver state.
 *
 * @param {string} templateKey — one of: initial, continue_phase, advance_phase, unstick, finalize, stop
 * @param {object} state — {goal, currentPhase, milestones, idleSec, lastEventType}
 * @param {string} [language] — "en" or "zh" (defaults to "en")
 * @returns {string}
 */
export function renderPrompt(templateKey, state, language = "en") {
  const tmpls = language === "zh" ? TEMPLATES_ZH : TEMPLATES_EN;
  const tmpl = tmpls[templateKey];
  if (!tmpl) {
    throw new Error(`Unknown marathon prompt template: ${templateKey}`);
  }
  return tmpl(state);
}

export const PROMPT_TEMPLATES = Object.freeze(Object.keys(TEMPLATES_EN));
