"""KC worker-LLM client (v0.8.1 P10-A canonical shim).

Distilled workflows use this module to call worker LLMs. Provider-agnostic:
reads connection info from workspace `.env` so the same workflow can run
against SiliconFlow, OpenAI, Anthropic, Aliyun, Volcanocloud, etc.

Two modes:
  - Inside a KC session: the engine's `worker_llm_call` tool is preferred
    for new code (it tracks cost, applies rate limiting, and writes to
    events.jsonl). This shim is fine if the workflow needs to be
    portable to standalone (no-KC) deployment.
  - Standalone (deployed release bundle): this shim is the only LLM
    access path. Every call writes a line to `output/llm_ledger.jsonl`
    so post-hoc analysis can reconstruct cost and traffic.

Required `.env` fields:
  LLM_API_KEY     API key for the provider
  LLM_BASE_URL    Provider base URL (e.g. https://api.siliconflow.cn/v1)
  TIER1..TIER4    Comma-separated model names per tier

Optional:
  LLM_AUTH_TYPE   "bearer" (default) | "x-api-key" (Anthropic native)
  LLM_API_FORMAT  "openai" (default) — only OpenAI-format chat completions
                  are supported by this shim. Use worker_llm_call for
                  non-OpenAI-format providers (e.g. Anthropic native).

If LLM_BASE_URL is missing, the shim raises explicitly — no silent
fallback to a hardcoded vendor URL. This avoids accidentally sending
traffic to siliconflow.cn from an OpenAI-configured workspace.

Migration aliases:
  SILICONFLOW_API_KEY → falls back to LLM_API_KEY if the canonical
  name is missing (for workspaces predating v0.8.1).
"""
import json
import os
import time
import urllib.error
import urllib.request

_LEDGER_PATH = os.path.join("output", "llm_ledger.jsonl")


def call(tier="tier2", prompt="", system_prompt=None, max_tokens=4096, timeout_s=120):
    """Single-prompt chat-completions call.

    Returns: {response, model_used, tier, tokens_in, tokens_out}.
    Raises: RuntimeError on missing config; urllib HTTPError on transport.
    """
    if not prompt:
        raise RuntimeError("call() requires a non-empty `prompt`")

    api_key = _env("LLM_API_KEY") or _env("SILICONFLOW_API_KEY")
    if not api_key:
        raise RuntimeError(
            "LLM_API_KEY not configured. Set it in .env or run `kc-beta onboard`."
        )

    base_url = _env("LLM_BASE_URL") or _env("SILICONFLOW_BASE_URL")
    if not base_url:
        raise RuntimeError(
            "LLM_BASE_URL not configured. Set the canonical name in .env "
            "(e.g. https://api.openai.com/v1 for OpenAI; "
            "https://api.siliconflow.cn/v1 for SiliconFlow). "
            "Run `kc-beta onboard` to configure interactively."
        )
    base_url = base_url.rstrip("/")

    auth_type = (_env("LLM_AUTH_TYPE") or "bearer").lower()
    api_format = (_env("LLM_API_FORMAT") or "openai").lower()
    if api_format != "openai":
        raise RuntimeError(
            f"LLM_API_FORMAT={api_format} not supported by this shim. "
            f"Only `openai` chat-completions wire format is implemented. "
            f"Use the engine's `worker_llm_call` tool for native non-OpenAI providers."
        )

    tier_models = _load_tier_models(tier)
    if not tier_models:
        raise RuntimeError(f"No models configured for {tier.upper()}; check .env TIER1-TIER4")

    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": prompt})

    body = json.dumps(
        {"model": tier_models[0], "messages": messages, "max_tokens": max_tokens}
    ).encode("utf-8")

    headers = {"Content-Type": "application/json"}
    if auth_type == "x-api-key":
        headers["x-api-key"] = api_key
        headers["anthropic-version"] = "2023-06-01"
    else:
        headers["Authorization"] = f"Bearer {api_key}"

    req = urllib.request.Request(f"{base_url}/chat/completions", data=body, headers=headers)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        # Preserve the body for debugging — providers often return useful errors
        err_body = e.read().decode("utf-8", errors="replace")[:500] if e.fp else ""
        raise RuntimeError(f"LLM call HTTP {e.code} from {base_url}: {err_body}") from e

    usage = data.get("usage") or {}
    result = {
        "response": data["choices"][0]["message"]["content"],
        "model_used": tier_models[0],
        "tier": tier,
        "tokens_in": usage.get("prompt_tokens", 0),
        "tokens_out": usage.get("completion_tokens", 0),
    }
    _write_ledger({
        **result,
        "duration_s": round(time.time() - t0, 3),
        "ts": time.time(),
        "base_url": base_url,
        "auth_type": auth_type,
    })
    return result


def _env(key):
    """Read `key` from process env first, then workspace .env file."""
    v = os.environ.get(key)
    if v:
        return v
    if os.path.exists(".env"):
        try:
            with open(".env", "r", encoding="utf-8") as f:
                for raw in f:
                    line = raw.strip()
                    if not line or line.startswith("#"):
                        continue
                    if "=" not in line:
                        continue
                    k, val = line.split("=", 1)
                    if k.strip() == key:
                        val = val.strip()
                        if (val.startswith('"') and val.endswith('"')) or (
                            val.startswith("'") and val.endswith("'")
                        ):
                            val = val[1:-1]
                        return val
        except OSError:
            return None
    return None


def _load_tier_models(tier):
    raw = _env(tier.upper()) or ""
    return [m.strip() for m in raw.split(",") if m.strip()]


def _write_ledger(record):
    try:
        os.makedirs(os.path.dirname(_LEDGER_PATH), exist_ok=True)
        with open(_LEDGER_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError:
        # Ledger is best-effort; never break the workflow over a write failure.
        pass


__all__ = ["call"]
