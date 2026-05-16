# Worker LLM 目录

通过 SiliconFlow API 可调用的 worker LLM 模型。模型有更新时同步维护此目录。

## 文本模型

| 等级 | 模型 | 上下文窗口 | 优势 | 备注 |
|------|-------|---------------|-----------|-------|
| TIER1 | Pro/zai-org/GLM-5 | 128K | 推理能力强、中文好 | 用于复杂判定的顶级选项 |
| TIER1 | Pro/moonshotai/Kimi-K2.5 | 128K | 长上下文、抽取能力强 | 适合整篇文档处理 |
| TIER2 | Pro/deepseek-ai/DeepSeek-V3.2 | 64K | 性价比均衡 | 通用场景表现良好 |
| TIER2 | Pro/MiniMaxAI/MiniMax-M2.5 | 64K | 中文强、速度快 | 适合中文文档 |
| TIER2 | Qwen/Qwen3.5-397B-A17B | 32K | 大型 MoE，推理力强 | 复杂任务的高性价比选项 |
| TIER3 | Qwen/Qwen3.5-122B-A10B | 32K | 准确率良好、成本较低 | 多数任务的甜点位 |
| TIER4 | Qwen/Qwen3.5-35B-A3B | 16K | 快、便宜 | 简单抽取首选 |

## 视觉 / OCR 模型

| 等级 | 模型 | 优势 | 备注 |
|------|-------|-----------|-------|
| OCR_TIER1 | zai-org/GLM-4.6V | OCR 准确率最高 | 用于复杂表格/图表 |
| OCR_TIER2 | Qwen/Qwen3.5-397B-A17B | 通用视觉好 | 多模态版本 |
| OCR_TIER3 | PaddlePaddle/PaddleOCR-VL-1.5 | 快、轻量 OCR | 标准文本首选 |

## 选型要点

- 在能满足上下文窗口需求的前提下，优先选择最高等级的模型。
- 抽取简单实体（日期、金额、姓名）：TIER3-4 通常够用。
- 语义判定（充分性、合规性）：通常需要 TIER1-2。
- 中文金融文档：优先选择 GLM 与 Qwen 系列，而非 DeepSeek，以更好处理行业术语。
- 上下文窗口约束：若待处理段落超出模型窗口，要么进一步收窄上下文（采用树状处理），要么换上下文更大的模型。

## API 配置

```python
import openai

client = openai.OpenAI(
    api_key=os.getenv("SILICONFLOW_API_KEY"),
    base_url=os.getenv("SILICONFLOW_BASE_URL")
)

response = client.chat.completions.create(
    model="Qwen/Qwen3.5-122B-A10B",  # Use the model name from the table
    messages=[{"role": "user", "content": prompt}],
    temperature=0.1  # Low temperature for deterministic extraction
)
```

本目录由编程智能体负责维护。有新模型时及时加入，模型停服时移除，并基于测试经验更新能力评估。
