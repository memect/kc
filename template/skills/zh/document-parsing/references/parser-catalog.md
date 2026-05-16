# 解析器目录

## 文本类解析器（无需 LLM）

| 解析器 | 类型 | 优势 | 局限 | 安装 |
|--------|------|-----------|-------------|---------|
| PyMuPDF (fitz) | 文本抽取 | 快、稳定、基础结构识别 | 不识别表格、不支持 OCR | `pip install pymupdf` |
| pdfplumber | 版面感知 | 表格检测良好，保留空间布局 | 仅文本，不支持 OCR | `pip install pdfplumber` |
| python-docx | DOCX 解析器 | 原生支持 DOCX，保留结构 | 仅支持 DOCX | `pip install python-docx` |
| openpyxl | XLSX 解析器 | 完整支持电子表格 | 仅支持 XLSX | `pip install openpyxl` |
| MarkItDown | 多格式 | 处理 PDF、DOCX、PPTX、XLSX → markdown | 解析较基础，复杂版面可能丢失 | `pip install markitdown` |

## OCR / 视觉模型（通过 SiliconFlow API）

| 模型 | 等级 | 优势 | 最适合 |
|-------|------|-----------|----------|
| zai-org/GLM-4.6V | OCR_TIER1 | 准确率最高，中文 OCR 强 | 复杂表格、混合版面 |
| Qwen/Qwen3.5-397B-A17B | OCR_TIER2 | 通用视觉能力好，模型规模大 | 需要结合上下文理解的表格 |
| PaddlePaddle/PaddleOCR-VL-1.5 | OCR_TIER3 | 快、轻量 | 标准文本、简单表格 |

## 本地部署选项

适合偏好本地处理的开发者用户：

| 工具 | 类型 | 备注 |
|------|------|-------|
| PaddleOCR | 本地 OCR | 开源，支持中英文 |
| Surya | 本地 OCR | 现代 OCR，支持表格检测 |
| pdf2md-local | PDF → Markdown | 参考：github.com/Ruilin-mmwa/pdf2md-local |

## 选型决策树

```
PDF 是文本型（非扫描件）吗？
├─ 是 → PyMuPDF 或 pdfplumber
│   └─ 表格解析正确吗？
│       ├─ 是 → 完成
│       └─ 否 → 改用 pdfplumber → 仍不理想 → 对表格区域使用视觉模型
└─ 否（扫描件） → OCR_TIER3 → 质量不足 → OCR_TIER1
```
