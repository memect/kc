# **Description**

In this project we are trying to build an LLM driven, self-adpative, self-evolving, production level document verification system based on the philosophy of project Anything2Ontology.

For more information regarding A2O, please read briefly: /Users/mac/Desktop/Anything2Ontology

Another reference is Anything-Extractor, please read briefly: /Users/mac/Desktop/anything-extractor

This system runs in Claude Code. **Our primary goal here in this project is to compose a set of meta skills and universal tools, and to perfect them through a series of tests on specific cases.** Plan, execute, reflect, evolve.

My team and I spent the last few years developing document verification system for finance institution like banks, securities and regulation authorities. We went through grinds of business analysis, data labelling, LLM workflow developing and testing, updating and maintaining. **Now we aim to replace us with this set of skills and coding agents like Claude Code.**

For instructions regarding how to write skills which are compatible to Claude Code, please follow strictly: https://github.com/anthropics/skills/tree/main/skills/skill-creator

This project has both English and Chinese version. All user interface and actual prompts should have both language in native. For example, we should have prompts that are completely written in English and Chinese, instead of instructing output language in the beginning of the prompt. Developer user can set language in .env

# **Design Philosophy**

## **1. Core Design**

We are aiming to build an agent system that will evolve into a certain shape that fits better and better with specific user's business scenario. The system serves as a powerful agent using SOTA LLMs in the beginning, then produces a swarm of sub-agents that runs quickly, stably and cheaply with regex and LLMs with smaller sizes.

The core value is that SOTA LLMs and coding agents serve as the ground truth, judge, teacher (in other words, human) in the system, and gradually distill their ability in specific and detailed cases into the code and prompt of hardcoded workflows that runs well with smaller models. The final deliverables are the these workflows which are expensive to build, but very cheap to run. The coding agents also monitor the performance of these workflows, reflects and improves them in the long run.

In the final verification app, we aim to use the smallest (mostly also the cheapest and fastest) model that is good enough for the task. In the meta skills and universal tools, we only provide model selection and relevant sources and keep updating these lists. For now we don't provide these model api.

The data schema and other structure and format in this system is JIT (just in time). Be agile with structure. No specific structure matters, the existence and consistency of structure does matter.

The system follows the design philosophy of OTF (on the fly), meaning that the system evolves through time and may look completely different from where it started.

## **2. Roles in the system**

- 1. Super-developer: You and I here. We define the system via meta skills.
- 2. Developer users: The few users who are smart enough and willing to get their hands dirty. They use our meta skills to build a verfication app specifically for a business scenario in their work. For example, a developer user is the tech lead of commercial bank's loan department. Developer user uses our product to build a loan contract verification app.
- 3. Coding agent of developer users: Coding agents like Claude Code. Developer users load their coding agents with our meta skills and build the app in the CLI of coding agents.
- 4. Verification app: The app built by coding agent that verficates a certain type of document based a set of strictly defined rules. They runs with worker LLMs, from GLM-5, Qwen-3.5, DeepSeek-v3, to smaller ones with size of 70B/30B/14B/7B. These LLMs actually carry out the repetitive tasks in production at scale. For testing here in our building of the meta projects, we use SiliconFlow as worker-LLM provide. See api keys in .env
- 5. End Users: The final users of the verfication apps. Our product, the meta skills should be unknown to them. They report to their developer users. In the example of developer users, end users could be the analysts and managers in the loan department.

Our meta skills serve as the conductor of the orchestra. Developer users and their coding agents are the composers. The final app and worker LLMs are the performers.

## **3. Sections in the workspace**

- 1. Rules: The files that defines the actual business rules of verification. Normally, these are laws and regulations, and sometimes notes written by compliance experts within the team (often the developer user in our case).
- 2. Samples: The "training set", will be labelled by coding agent.
- 3. Input: Batches of documents from production, waiting to be verificated.
- 4. Output: Verification results of input.

## **4. How the system works**

- 1. Load a coding agent with the meta skills and other relevant instructions (starter pack) we provided. Developer users (separated from end users, who uses the verification app in that one specific business scenario chosen by developer users) start from here. Developer users configure in .env, upload necessary data and files related to workspace.

- 2. Coding agent starts to carry out the verification tasks on its own, meaning document parsing, data extracting, rule understanding and verification. Coding agent extracts business rules from rules section on a granularity that it deems fit (which can still be changed in later iterations). In some cases, developer users may provide rules that are already sorted in format of xlsx or csv, where the scope of each rule is clearly defined. In these cases, just follow developer user's instructions.

- 3. Coding agents write all the necessary information for each rule into a skill folder in the format of Claude Code Skills. Instructions are provided: https://github.com/anthropics/skills/tree/main/skills/skill-creator. For example, write the business logics in SKILL.md, regex and code snippet in script folder, original context in reference folder, data samples and corner cases in asset folder. A skill folder should be sufficient to provide all context and information needed regarding that one rule.

- 4. Based on these skills, coding agent carries out the verification tasks, evaluate the result and modify these skills when necessary. Each time of testing and iteration should be logged.

- 5. When skills are okay to run, start writing these rules into workflows of code (python) and prompts (worker LLM). Verify the results of these workflows against the results given by coding agent with skills. Modify the workflows accordingly. As usual, log all testing and iterations.

- 6. When workflows are ready on samples, starting adapting them on input and work in batches from production. Coding agent still need to conduct quality control on the result. A confidence level and strata-based sampling mechanism should be designed for each rule. For example, coding agent can only examine 10% of results with 0.9 confidence, but may have to examine 50% of results with 0.6 confidence and 100% of 0.2. This mechanism itself is designed and can still be modified continuously by coding agent.

- 7. In the ideal situation, coding agent can gradually reduce its monitoring frequency and amount to zero, unless business rules itself changes.

- 8. The system automatically produces dashboards in html for developer users so that they can see results, plans and issues intuitively.

## **5. My experience regarding document verification system building**

- 1. Document Parsing: doc parser should be a multi-level downgrade design based on the same 'minimum model viable' principle. Start from simple parsers like pymupdf and upgrade when necessary. Please look at https://github.com/Ruilin-mmwa/pdf2md-local. Models used in this project is locally deployed. In our project here and those verification apps to be built by developer users, both local deployment and api from providers are acceptable. In many document parsing tasks prior to verification, good parsing of tables and charts are important. Remember to optimize specifically for certain types of tables and charts. But again, only do these optimization when necessary.

- 2. Tree processing: in most document verification tasks, simply extract original context accurately from source files is not enough. Many rules specifically target at designated chapters or parts of the document. Also, we will be dealing with some superlong files (1000+ pages) very often, which can not be fitted into the context window of a single LLM call. In this case, we need to build a tree extracting mechanism. Please refer to the design of "onion peeler" in A2O project. The exploration should be agile and final method should be simple. For example, coding agent can explore a dozen of sample files for patterns and find that chapter titles all starts with certain symbol/number, then a regex-based chunker is optimal for the final app.

- 3. Object extraction: that number/entity/text we need to check according to the rule. In ideal cases, they should be extracted directly from full source file. But remember we aim to teach smaller models to do the job, so we design basically a 'full context - chapter - entity' procedure to fit smaller context window of worker LLMs (usually 16k - 32k). We might have several types of extraction like extract a single entity/multiple entities from a single chapter/multiple chapters/full text. Deal with them accordingly. Define clear, accurate and agile data schema and postprocessing for extraction. Extraction can be executed by regex or LLM prompts. Refer to anything-extractor: /Users/mac/Desktop/anything-extractor

- 4. Judgement call: determine if the entity fits/complies with the rule or not. The logical judgement itself could be in many forms. Choose the appropriate format when interpretting rules in NL to workflows. Use python for calculation and regex, use LLM for semantic analysis, etc. Workflows should give simple and concise comments when entities don't fit with the rules. Normally, workflows can skip commenting if fits, unless developer users specify.

- 5. Corner Cases: for parsing, extracting, verificating process, there will all be corner cases that just cannot be merged and universally represented by a well-designed workflow. Workflow should not have too many patches. Manage these corner cases in a separate list or database (visible and manageable to human users as well) and call them with high threshold during execution, like an RAG pipeline with progressive disclosure.

# **Quick Start for users**

This should be very simple for users. This project will be uploaded to Github. Developer users should be able to install via npm. A very simple script will set up the workspace, downloading the meta skills and instructions, creating the folders and .env file. Then, developer users load necessary data like rules and samples into the folders. Finally, developer users launch their coding agent in the workspace, asking the agent to read something and start working.

# **Comment Section for Claude**

Overall, you slightly underestimated the capability of coding agents at developer users environment. They are, like you, Claude Code running with Opus 4.6, which are extremely smart and can handle a lot of work defined at a really META and concise level. We don't have to define everything step by step for them (that's what they need to do for the final app). Ideas and methodologies matter more. From my experience, providing too much specific examples in meta skills will lead to overfitting to them in the final app, which is actually not good for that specific case. Give the freedom and authority to developers' agents.

Meta skills we provided here should be divided into two layers:
- Meta Meta Skills: How to design the system that bootstrap and evolves. How to downgrade from coding agents to worker LLMs. How to consider what parameters need to be set in .env. What to discuss with developer user. Basically the skills of me as a system architect and product manager.
- Meta Skills: How to actually do document verification and how to specifically build a workflow. Basically the skills of me as a business analyst and prompt engineer.

For your concerns specifically:

1. Your design is good, we can start from here. Basically, these are the skills of how to build a good verification app, aiming to replace myself. We also need some design in formats other than skills to make sure we establish the bootstrap mechanism. We need to make sure that coding agents of developer users are writing rules into skills and workflows. Both output are important.

2. Builder and Observer are both coding agents of developer users.

3. Your design is good, but I still want to leave agile to the coding agents of developer users. Ask them to follow strictly skill-creator of Anthropic official. We can even copy skill-creator as one of the meta skills. I don't want to add other premature restrictions.

4. We can add some entry/exit conditions. For now we add in .env threshold for skill_accuracy, workflow accuracy and monitor frequency (low, mid and high). Set them to 90% and mid for now. The parameters we set now can be agile and not exactly quantitative. Defining them quantitatively is the job of coding agents of developer users. What we provide here is the instructions to them that these threshold should be set and discussed with developer users.

5. We need to provide here a skill about how to design a confidence system for a extraction/verification workflow, not specifically saying that we need to do it like this. Do some research here and see if there are relevant skills already available and proven.

6. We need version control, but in the format of a version-control skill that tells the coding agent what to control and how. Research here and see if there are some proven skills regarding lightweight version control.

7. Your design is good, write them into the meta skills and use them as a reference. Specific design in a certain project is up to the coding agent of developer user.

8. I like your method, it is simple enough.

9&10. Convey my core design and use your design as reference.