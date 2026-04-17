# **Current Status**

2026-04-15 3pm. I developed and published two version of KC agents.
 - One with python backend and node.js frontend, installed via npm and pypi. Source code can be found here in desktop/kc_reborn.
 - The other one is more lightweight and written completely in node.js. Source code can be found in desktop/kc_cli.

Previous documents please see:
- v2 design: /Users/mac/Desktop/kc_cli/docs/global_update_design_v2.md
- dev_logs: /Users/mac/Desktop/kc_cli/DEV_LOG.md

Please feel free to consult Claude Code source code when needed: https://github.com/Janlaywss/cloud-code

I organized a 3hr demo and open discussion on KC architect and agent harness: /Users/mac/Desktop/kc_cli/docs/team_demo_report_0411.md. Team now has better understanding of both.

My team and I ran several tests on real case from gdpr on app user agreements, financial regulations on asset management documents, to contract law on house renting contracts for fresh graduates, and modern constitutional laws on ancient novels (this one was more for fun). We are still manually checking the results and trying to draw some conclusions for update ideas. For now, we focus on solving those problems we encountered during testing and intuitively knew the reason, and adding more supporting features and standard agent harness components. We aim to improve v3 to be a production-ready release that we can invite a small scope of developer users (previously our clients in enterprise projects) to test. This v3 version should have good experiences and can handle small to medium size sets of rules + samples. When we have more finished tests from team and these beta-test users, we can launch v4 as the first public release.

**IMPORTANT** 
**There are more than a dozen of updates and some parts of this update plan will take quite a long time to implement, so we should plan and implement one by one. Plan for one module, implement one module after my confirmation, finish, plan the next one.**

For Claude: you can append any sort of to-do list or plan in separate sections in this doc, and come back anytime you want. For me, at least maintain a tick box for each part of the plan, so that I know where are we.

# **v3 update plan**

## **0. Align both versions**

- Compare two versions of kc_agent in details. List the gaps first, and I will select and clarify what to implement.
- From now, we focus more on the pure node.js version, since this is more stable to run and easier to distribute. kc_cli in this repository is the main branch now.
- When comparing, if see any conflicts, please refer to initial design or ask me. /Users/mac/Desktop/kc_cli/docs/initial_spec_draft.md
- Specifically, I witnessed the gate control and tool registry were not working in the python backend + node.js frontend version, where agent called worker LLM in the very beginning of a session. Please check both version.

## **1. Permission Design**

- KC agent practically requires to work in YOLO mode all the time. So, in this version we don't need a sophisticated permission design like Claude Code or Codex. But we still have to restrict KC's access within a folder.
- The ideal workflow is that user cd to the folder and launch kc, kc gets full access to this folder, kc reads necessary files in this folder, kc writes most new files in its own workspace, kc can write new files in the user-selected folder when kc needs to show user something or user requires kc to do so. We can refer to openclaw's workspace logic.
- For now, we accept the risk that kc might incorrectly delete or change local files. Efficiency comes first. But what we can do is prompting user to backup local files or giving kc copies of original file during launching on a user-selected directory.

## **2. Agent.md**

- Like CLAUDE.md of Claude Code in each project, we should have an AGENT.md for kc main agent. First check what the current mechansim of system prompt is like for KC main agent and identify the gap between current method and CLAUDE.md/AGENT.md
- We can set some system prompt in AGENT.md as a start. KC agent should be allowed to modify or add content in AGENT.md. Refer to codex prompt: https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide#recommended-starter-prompt
- For now, Agent.md onlys works in that one project/workspace. It does not migrate from one to the other.

## **3. Better dashboard**

- The current dashboard show results in simple statistical data. This is clear and simple. We should keep this one.
- The main update for dashboard I want is a two column, original file - verification result comparison page. The original file that was parsed and verified should be shown on the left half of the screen and the verification results on the right half. When clicking on specific results, left side should jump to the page/chapter/location of original content accordingly. Please refer to /Users/mac/Desktop/kc_cli/docs/dashboard_w_pdf_review.md. With this intuitive method, kc can allow user to manually check verification results, and further to provide ground truth for reflection and iteration.
- From previous development of similar tools, I learnt that convert everything to pdf and then show them using a single pdf viewer is a good idea.
- This entire new dashboard is bit heavy for kc_cli tool, so we set it as a separate plugin that can be installed after kc is installed, if user want to user this feature. For basic kc, we use the static html dashboard kc already has now.

## **4. Improve skills and harness design for doc parsing and data extraction**

- Like KC itself, doc parser and data extraction workflow should also be produced in JIT fashion during agent runtime. I am planning two new projects independent from KC to build two new CLI tools. In the future, these two new tools will be intergrated into KC.
- For now, we improve the doc parsing and data extraction performance in KC by polishing related meta-meta and meta skills. I am manually reading these skills and writing down my suggestions based on my experience. For claude, you can propose some improvements here, we will further discuss and choose what to implement later. Mark a to-do here.

## **5. Polish more meta skills from my previous docs**

- From around 1 yr ago to half an year ago, when I was still manually developing large number of rule-based verification workflows in production level accross projects, I wrote some conclusive docs as prompt engineering summary and experience sharing. These documents can be intergrated into the meta skills we have now, as supplements.
- For Claude, please read: /Users/mac/Desktop/feishu-doc-base/feishu_doc/2025-11-05 在做了几百上千条托管条线的字段抽取和规则审核之后，我们能总结出什么.md and use this as the main reference. You can explore relevant content in the same 'feishu_doc' folder. Don't indulge and use subagent when necesary, since there are many long docs.

## **6. Model selection for different tiers**

- Current method of main agent + web_search tool deciding model selection for different tiers is unreliable. Remove this. Keep the web_search and fetch from url tool available (when api is provided).
- In v3 we do two method:
  - Baseline is our mannual setting. In early releases I will keep these model selections up to date.
  - Use context7, a CLI tool specifically design for getting latest LLM/tool info in a single line of command. Mark this as a to-do. Auto model selection and LLM client configuration should a optional plugin that user can choose to install. Together with pdf viewing dashboard and other plugins in plan, these plugins can be installed during onboarding or via starting items, or uesr's direct request input. Like how OpenClaw does.
- In v3 the baseline method follows this priority order, please double check:
  - Only the LLM providers we support, no custom API.
  - We pre-set the model selection for each tier, one by one for each LLM provider.
  - If the LLM provider we already set, fails to provide the LLM we pre-selected, try /models and find replacement.
  - If provider does not support /model, leave the unavailable tier blank.
  - If all worker LLM tiers are blank, prompt user.

## **7. Ralph-loop as default**

- Please see: https://github.com/snarktank/ralph, for what ralph-loop is.
- KC should have the concept of ralph-loop by design, not necessarily copying ralph's code. Because kc is dealing with tasks that are naturally breakable into a list of sub-tasks. The understanding, skill writing, skill testing, workflow composition, workflow testing of one rule is naturally separated from another rule. Learn from ralph-loop's design and use the same logic to build a task disassembly and management mechanism for KC.
- Show a concise dashboard and current status on the TUI when carrying out the task, like how Claude Code does when doing a complicated task with multiple steps/parts.

---
From here below are more of ideas than actual implementation plans. In each part we can discuss, plan, find some intermediate node. Above are the 7 major updates that we must implement in v3.
---

## **8. Built workflows release as an app**

- KC now has two main phases: build and distill. It should have a third one, run. Upon successfully building of worker LLM workflows that can generate results at acceptable accuracy levels, they should be released as an app. This app faces the final users, instead of that one developer user in this project alone. Final users need better UI/UX and intuitive visual/statistical result demonstration.
- We can discuss some intermediate form of app here first, and combine with what we need to implement now in part 3 better dashboard.

## **9. Allow automatic method of production input**

- For most actual production cases, user needs to verify documents on a regular basis. Ideally, fetching/downloading these documents should be done automatically by a script/cron job/agent heartbeat, or similar method. In some cases where the documents are publically available, they can also be acquired via monitoring and web crawl. We can let user define how to do this in natural language and let KC write it.

## **10. Better rule extraction skills from pdf2skills/a2o**

- For more information regarding pdf2skills, please read briefly: /Users/mac/Desktop/cc_projects/pdf2skills
- For more information regarding A2O, please read briefly: /Users/mac/Desktop/Anything2Ontology
- Rules in KC are clearer and more distinguishable than in pdf2skills/a2o, where rules/knowledge are more abstract and harder to identify. Learn the methodology from these two projects and discuss with me how we can improve the meta-meta skills here in KC. No need to copy the code of the entire pipeline from them, but the core concepts regarding knowledge modelling and management is paramount.

## **11. Better File System**

- When KC starts working on heavy projects in production scale in future, a well-designed file system is very important. KC should have even better file system design than harnesses like Claude Code. Because essentially KC is not managing a code repo, instead it is managing a knowledge base.
- Please read: https://blog.langchain.com/the-anatomy-of-an-agent-harness/ and focus on the file system part. What improvements can we do?
- After reading this blog from langchain, if there are other architect design improvements we can do, propose them.
- **TODO:** Add a tool for KC to selectively copy original files from project dir into workspace. Should NOT be used at large scale (samples can be hundreds of large PDFs). For targeted copying when KC needs a working copy of specific files.

## **12. Feishu as IM channel**

- Think about how users use feishu as IM channel with OpenClaw as the agent. For users with their rules/samples docs in feishu, or using feishu as primary office app, adding feishu as IM channel is benefitial for many of our users. Discuss with me here in this final part, how can we utilize feishu as channel. Open to explore, we can experiment first locally on kc with my own feishu account. If good, we write it as a skill/plugin.
- Feishu opensource CLI tool, see: /Users/mac/Desktop/feishu-doc-base/SKILL-feishu-doc-export.md.
- Feishu as channel should be a optional plugin that user can choose to install. Intergrate the setup of feishu cli tool into a standard procedure, prompt user to do what kc has no authority of. We can first try to link kc locally in this device with my feishu bot, and upon success, summarize the method and write it in KC.

## **13. Hermes and EvoMap research**

- Think about how we did the shiji-kb migration to kc_agent. We did it in a very meta way, only took the core methodology. Here are two agent harness/tool I want to learn from: Hermes (https://github.com/nousresearch/hermes-agent) and EvoMap (https://github.com/EvoMap/evolver).

---

## **Progress Tracker**

- [x] Block 0: Align both versions — gap analysis done, kc_reborn frozen, kc_cli is main branch
  - [x] Separate worker LLM config (optional, falls back to conductor)
  - [x] model-tiers.json — standalone file for LLM (tier1-4) and VLM (tier1-3) per provider
  - [x] Updated providers.js, config.js, onboard.js, config editor, engine.js, tools
  - [ ] **TODO (Block 6):** Manually review and finalize model selections for all providers in model-tiers.json
  - [ ] **TODO (Block 6):** Run actual end-to-end tests with each provider to verify model availability
- [x] Block 1: Permission Design
  - [x] Dual-directory model: project dir (CWD) + workspace (~/.kc_agent/workspaces/{sessionId}/)
  - [x] `scope` param on workspace_file, document_parse, document_search; `cwd` param on sandbox_exec
  - [x] Project-aware bootstrap (detects rules/samples in project dir)
  - [x] Backup recommendation in TUI welcome banner
  - [x] Session state persists/restores projectDir
  - [ ] **TODO (Block 11):** Add tool for KC to selectively copy specific files from project to workspace
- [x] Block 2: Agent.md
  - [x] template/AGENT.md — lightweight per-project prompt template
  - [x] Initializer creates AGENT.md in workspace at bootstrap
  - [x] ContextAssembler injects AGENT.md after AGENT_IDENTITY
  - [x] Engine reads AGENT.md on every turn (agent modifications take effect immediately)
- [x] Block 3: Better Dashboard
  - [x] Two-column PDF review prototype — tested with 上海国际信托24年年报.pdf
  - [x] Packaged as meta-meta skill: `pdf-review-dashboard` (en + zh)
  - [x] Generator script with adaptable data mapping section
  - [x] Fixed skill-loader multi-line YAML description parsing
  - [ ] **TODO (Block 11):** Line-level bbox highlighting (requires OCR coordinate data)
- [x] Block 4: Improve skills for doc parsing & data extraction
  - [x] entity-extraction: reframed as cost-accuracy search, not regex-first
  - [x] compliance-judgment: removed fixed ordering, KC picks method per rule
  - [x] document-parsing: rearranged escalation (pdfjs → provider VLM → MineRU)
  - [x] document-parse.js: implemented VLM call via provider API
  - [x] NEW document-chunking meta skill: fast/cheap batch chunking
  - [x] tree-processing: refocused on production chunking (observe → pattern → code)
  - [x] rule-extraction: clarified one-off vs repeating extraction distinction
  - [x] AGENT_IDENTITY: updated extraction guidance to cost-accuracy framing
- [x] Block 5: Polish meta skills from historical docs
  - [x] A: 3-part rule decomposition (location→extraction→judgment) + scope classification in rule-extraction
  - [x] B: Post-processing > prompt negation anti-pattern in entity-extraction + compliance-judgment
  - [x] C: Pipeline node decomposition principle in skill-authoring
  - [x] D: Exit criteria design-first pattern in compliance-judgment
  - [x] E: Chain optimization goal (shortest chain→smallest model→shortest prompt) in skill-to-workflow
  - Source: production experience from 2025-11-05 summary doc + SAM design doc
- [x] Block 6: Model selection for different tiers
  - [x] Baseline criteria verified (5/5 met, added startup warning for blank tiers)
  - [x] NEW auto-model-selection meta-meta skill using Context7 CLI (en + zh)
  - [ ] **TODO:** Manually review and finalize model-tiers.json selections per provider
  - [ ] **TODO:** End-to-end test with each provider to verify model availability
- [x] Block 7: Ralph-loop as default
  - [x] TaskManager class — per-rule task tracking, persisted to tasks.json
  - [x] runTaskLoop() — auto-continues through pending tasks, aggressive compaction between tasks
  - [x] Task creation from rule catalog on phase transitions
  - [x] Context safety — 70% safeguard, compact to summary between tasks
  - [x] TUI TaskDashboard component with progress bar
  - [x] /tasks slash command
- [~] Block 10: Better rule extraction skills from pdf2skills/A2O — partial (v0.3.2)
  - [x] Project glossary supplement — living, project-scoped vocabulary built during EXTRACTION, enriched throughout BUILD/DISTILL. Sections added to rule-extraction (build site), rule-graph (analysis site, glossary backs `shares_entity` edges), entity-extraction (light cross-reference, no prescriptive regex pattern).
  - [ ] **TODO:** Semantic density preprocessing for long regulations (pdf2skills NLP-then-LLM scoring of substantive vs boilerplate paragraphs).
  - [ ] **TODO:** Cross-document rule deduplication (SKU-fusion-style merging when extracting from multiple regulations or revisions).
  - [ ] **TODO:** Sharpen completeness checking with label hierarchies (A2O-style coverage validation as graph operation).
  - Note: much of the original Block 10 description was already covered by Blocks 4-5 (Location→Extraction→Judgment, onion-peeler chunking with Levenshtein fallback, independence-first rule graph with all four A2O edge types).

### v0.3.1 audit pass (2026-04-17)

End-to-end self-test of all seven blocks. Two critical bugs fixed:

- **engine.js had a duplicate `compact()` definition** that shadowed the
  working one and assigned to a getter-only property — would have crashed
  `runTaskLoop` on the first auto-continued task. Removed the duplicate
  and updated the two `runTaskLoop` callsites to pass options as object.
- **document-parse.js VLM fallback** was pushing empty page placeholders
  when `canvas` package was missing, inflating output to look like a
  successful parse. Now returns null and lets the escalation chain
  fall through to MineRU.

Plus packaging prep for npm: README.md, repository/homepage/bugs metadata,
README + QUICKSTART included in `files` allowlist.