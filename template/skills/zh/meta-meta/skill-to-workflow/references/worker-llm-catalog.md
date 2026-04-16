# Worker LLM Catalog

Models available via SiliconFlow API for worker LLM tasks. Update this catalog as models change.

## Text Models

| Tier | Model | Context Window | Strengths | Notes |
|------|-------|---------------|-----------|-------|
| TIER1 | Pro/zai-org/GLM-5 | 128K | Strong reasoning, Chinese language | Top tier for complex judgment |
| TIER1 | Pro/moonshotai/Kimi-K2.5 | 128K | Long context, strong extraction | Good for full-document processing |
| TIER2 | Pro/deepseek-ai/DeepSeek-V3.2 | 64K | Balanced capability/cost | Good general purpose |
| TIER2 | Pro/MiniMaxAI/MiniMax-M2.5 | 64K | Strong Chinese, fast | Good for Chinese documents |
| TIER2 | Qwen/Qwen3.5-397B-A17B | 32K | Large MoE, strong reasoning | Cost-effective for complex tasks |
| TIER3 | Qwen/Qwen3.5-122B-A10B | 32K | Good accuracy, lower cost | Sweet spot for many tasks |
| TIER4 | Qwen/Qwen3.5-35B-A3B | 16K | Fast, cheap | Best for simple extraction |

## Vision/OCR Models

| Tier | Model | Strengths | Notes |
|------|-------|-----------|-------|
| OCR_TIER1 | zai-org/GLM-4.6V | Best OCR accuracy | Use for complex tables/charts |
| OCR_TIER2 | Qwen/Qwen3.5-397B-A17B | Good general vision | Multimodal version |
| OCR_TIER3 | PaddlePaddle/PaddleOCR-VL-1.5 | Fast, lightweight OCR | Best for standard text |

## Selection Guidelines

- Start with the highest tier that fits your context window needs.
- For extraction of simple entities (dates, amounts, names): TIER3-4 often sufficient.
- For semantic judgment (adequacy, compliance): TIER1-2 usually needed.
- For Chinese financial documents: prefer GLM and Qwen models over DeepSeek for domain terminology.
- Context window constraint: if the section to process exceeds the model's window, either narrow the context further (tree processing) or use a model with a larger window.

## API Configuration

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

This catalog should be maintained by the coding agent. Add new models as they become available, remove deprecated models, and update capability assessments based on testing experience.
