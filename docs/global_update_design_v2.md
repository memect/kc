# **Status Report**

2026-04-08 6pm. I developed and published two version of KC agents.
 - One with python backend and node.js frontend, installed via npm and pypi. Source code can be found here in desktop/kc_reborn.
 - The other one is more lightweight and written completely in node.js. Source code can be found in desktop/kc_cli.

I conducted an AB test on both versions. Using GDPR Chapter 3 as rule, and 20 app user agreements as sample docs. Both agent failed after an hour of working. Two reasons: 
- One is the LLM provider API is unstable, especially when two agents using the same one at the same time.
- The other one is due to the flaw of our design. Features like context compacting, error handling, auto resuming and etc. are missing. (Don't overdesign this, we'll refer to the architect of Claude Code later and see what to do).

Also, pure node.js CLI version of KC showed some inconsistency against my initial design, like calling worker LLM to do rule extraction, which is KC's own task. The violations needed to be fixed are already planned and will be fixed in its own sessions. **This doc is for both versions. Updates in this doc need to be implemented to both kc_reborn and kc_cli.**

Please feel free to consult Claude Code source code when needed: https://github.com/Janlaywss/cloud-code

# **Updates I planned in order of Priority**

## **1. Multi-LLM-provider**

- In earlier versions we successfully called GLM-5 from Aliyun Bailian API, that API was in my coding plan. Let's add it alongside SiliconFlow as provider. We should support both API key and coding plan key. In China, VolcanoCloud(bytedance), GLM, MiniMax, etc. In North America, OpenRouter, BedRock, OpenAI, Anthropic, etc. We can look at openclaw (https://github.com/openclaw/openclaw), see what it supports.

- Instead of we appointing specifc model selection for different tiers, model selection by tier should be one of the meta-meta skills, alongside skill-to-workflow distillation. KC agent should first test API and see what models are available, propose a bundle of model selection and ask user's confirmation in onboarding phase. We can set some basic principle for model selection like what is good for parsing/extraction/semantic judgement. Because LLMs are always trained on outdated data, so on its own LLM almost 100% underestimate the capability and context window size of LLMs available at present.

## **2. Context Engineering**

KC agent now becomes unstable after 30-40 min of work, which can not be accepted since the projects we need KC to work on are always huge and requires KC to working continuously for hours without complete stopping. I witnessed significant lagging when context became superlong, with a 0.1s delay when input with my keyboard(I am not sure what caused this but I assumed over-long context, since it only happened after 30min or running). I am still not 100% familiar with everything of Agent Harness, so correct me if I am wrong. To fix this, here is what I planned:

- /clear and /compact commands, and showing current context length and percentage in status bar, like earlier version of Claude Code.

- When encountering failures and errors, which are absolutely normal for an agent working on its own for hours, we need to have good resume and retry methods. This is already handled partially by agent loops. But agent loops can not solve when the LLM powering KC agent is disconnected. For this, we need a retry 10 times with timeout mechansim hardcoded as fail-safe. Check Claude Code source code to see how this is done.

- Sessions should be kept intact, breaking the limit of context window, because we need everything original. AgentEvent should be upgrade to lasting event log. Pipeline can be restored. This is from Claude's Managed Agents design. We need more sophisticated architect design here. Context management should be independent from full sessions.

- Should we use subagents more aggressively, and fork KC main agent with all context loaded as new subagents? Check how Claude Code orchestrate its subagents and plan carefully here. Ideally the v0.1 of what KC builds should not exceed the 200k context length for KC main agent. (not compulsory, we have /compact features for that)

- Claude launched Managed Agents today. We can refer to it for design, see summary at: /Users/mac/Desktop/kc_cli/managed-agents-analysis.md

- For more information, see original blog at:
  - https://claude.com/blog/claude-managed-agents
  - https://www.anthropic.com/engineering/managed-agents
  - https://www.anthropic.com/engineering/managed-agents

## **3. Better Configuration Interaction**

- There should be two commands, 'kc onboard' and 'kc config'. Onboarding handles all settings sequentially and ends with the auto boostrap initiation of the first session. Configuration is for user to change settings later, and should be set in different categories, like LLM API key, model tier, thresholds, etc. Please check openclaw agents configuration part.

- Check for hardcoded threshold/parameters and move them to .env, also making them configurable, like model tier and accuracy thresholds.

- During onboarding and configuration, those fields where we already set default recommendation and allow users to skip, we should prompt in grey like 'Press ENTER to skip' or 'Press Enter to use default'. My team confused in this part and didn't know how to continue.

## **4. Starting Items**

- We need to add some starting items. We can see what Claude Code has but for now, the most important one is a one-time language setting. I want to set something like 'kc --en' and 'kc --zh' to start this only one session in the language I chose, without changing the global language setting.

## **5. More Tools for KC agents**

- We need web_search tool for KC agents for situations like searching about latest LLM model info or some Git repo/API doc. But we need to consider carefully when to allow KC call this web search tool, since user-provided, domain specific rules are prior to what's open on the Internet in most of our cases.

## **6. Always show spinner words when working**

- KC oftens works 10-15min before stopping and reporting to users. Users need clear sign of whether it is working right now. So we should constantly show ING spinner works above input area as long as KC is not stopped. Now I can see the spinner words only once in a while (only when calling and streaming LLM that powers KC main agent I suppose?), not during tool use or showing code/result.