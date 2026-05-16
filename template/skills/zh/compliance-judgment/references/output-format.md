# 轻量输出格式规范

本文档定义核查结果的紧凑文本标注格式、其语法、JSON 转换规则以及边界情况处理。

## 语法

```
[RESULT] field_name <- value (constraint) | conf:score | src:location | note:text
```

| 组成 | 是否必填 | 格式 | 说明 | 示例 |
|-----------|----------|--------|-------------|---------|
| `[RESULT]` | 是 | 取值之一：PASS、FAIL、MISSING、ERROR、UNCERTAIN | 判定结果。 | `[FAIL]` |
| `field_name` | 是 | snake_case 标识符 | 被核查的规则或字段。 | `capital_adequacy` |
| `<- value` | 否（MISSING 时省略） | 自由文本，不含竖线 | 从文档中抽取出的值。 | `<- 12.5%` |
| `(constraint)` | 否（无约束时省略） | 括号表达式 | 期望值或条件。 | `(>= 8.0%)` |
| `conf:score` | 是 | 0.00-1.00 的小数 | 判定的置信度分数。 | `conf:0.95` |
| `src:location` | 否 | 页-节引用或 trace ID 前缀 | 文档中的来源位置。 | `src:p3-s2` |
| `note:text` | 否 | 至行末的自由文本 | 人类可读的注释。 | `note:Signing overdue by 45 days` |

`field_name` 之后的各个组成部分以 ` | `（空格-竖线-空格）分隔。`<- value` 和 `(constraint)` 出现在第一个竖线之前，彼此以空格分隔。

## 字段定义

### 结果取值

| 取值 | 含义 | 使用时机 |
|-------|---------|-------------|
| `PASS` | 实体符合规则。 | 确定性检查或语义检查确认合规。 |
| `FAIL` | 实体不符合规则。 | 明确检测到不合规。强烈建议填写 note。 |
| `MISSING` | 文档中未找到该实体。 | 抽取过程无法定位到所需字段。 |
| `ERROR` | 处理过程出错。 | 解析错误、API 超时、非预期格式。 |
| `UNCERTAIN` | 判定存在歧义。 | 临界值、证据冲突、置信度偏低。 |

### 置信度分数

介于 0.00 与 1.00 之间的小数，表示系统对该结果的把握程度。对于确定性 Python 检查，置信度通常为 0.95-1.00。对于 LLM 语义判定，置信度反映模型自评的确定性。低于 `.env` 中配置阈值的分数会触发人工复核。

### 来源位置

`src:` 部分使用紧凑引用格式 `p{page}-s{section}`。示例：`src:p3-s2` 表示第 3 页第 2 节。如需与 trace ID 集成，使用 trace ID 前缀：`src:R001-DOC042-P3-S2`（详见下文"与 Trace ID 的集成"）。

## JSON 转换

### 标注 → JSON

```
Input:  [FAIL] sign_date_gap <- 75d (<= 30d) | conf:0.90 | src:p1-s4 | note:Signing overdue by 45 days

Output:
{
  "field": "sign_date_gap",
  "result": "fail",
  "extracted_value": "75d",
  "expected": "<= 30d",
  "confidence": 0.90,
  "source": "p1-s4",
  "comment": "Signing overdue by 45 days"
}
```

伪代码：
1. 解析 `[RESULT]`，转小写，赋值给 `result` 字段。
2. 解析下一个 token，赋值给 `field` 字段。
3. 若后随 `<-`，解析到 `(` 或 `|` 为止，赋值给 `extracted_value`。
4. 若后随 `(...)`，解析括号内容，赋值给 `expected`。
5. 将剩余部分按 ` | ` 拆分。对每一段：
   - `conf:X` → `confidence`（按浮点数解析）。
   - `src:X` → `source`。
   - `note:X` → `comment`。

### JSON → 标注

伪代码：
1. `[` + 大写(`result`) + `] ` + `field`。
2. 若存在 `extracted_value`：` <- ` + `extracted_value`。
3. 若存在 `expected`：` (` + `expected` + `)`。
4. ` | conf:` + 格式化(`confidence`, 保留 2 位小数)。
5. 若存在 `source`：` | src:` + `source`。
6. 若存在 `comment`：` | note:` + `comment`。

## Diff 示例

对比两次核查运行，正是标注格式最能发挥优势的场景。

**标注 diff**（干净、易扫读）：
```
  [PASS] capital_adequacy <- 12.5% (>= 8.0%) | conf:0.95 | src:p3-s2
- [PASS] sign_date_gap <- 28d (<= 30d) | conf:0.92 | src:p1-s4
+ [FAIL] sign_date_gap <- 75d (<= 30d) | conf:0.90 | src:p1-s4 | note:Signing overdue by 45 days
  [MISSING] collateral_value | conf:0.60 | note:Collateral valuation not found
```

**JSON diff**（噪声大、难以扫读）：
```json
  {
    "field": "sign_date_gap",
-   "result": "pass",
+   "result": "fail",
-   "extracted_value": "28d",
+   "extracted_value": "75d",
    "expected": "<= 30d",
-   "confidence": 0.92,
+   "confidence": 0.90,
    "source": "p1-s4",
-   "comment": ""
+   "comment": "Signing overdue by 45 days"
  }
```

同样的信息，标注 diff 只需要一行变更，而 JSON diff 需要五行。

## 边界情况

### 多值字段
当一个字段抽取出多个值（例如同一个指标在两处出现且数值不一致），用分号分隔多个值：
```
[UNCERTAIN] total_assets <- 1,234,567;1,234,590 | conf:0.50 | src:p3-s1;p7-s2 | note:Conflicting values found
```

### 长注释
在标注格式中，超过 80 字符的 note 截断为 `...`。完整文本保留在 JSON 中。示例：
```
[FAIL] risk_disclosure <- (see detail) | conf:0.85 | note:Missing discussion of liquidity risk, market risk, and operational ri...
```

### 特殊字符
如果值或 note 中包含竖线 `|`，用反斜杠转义：`\|`。转换为 JSON 时再反转义回 `|`。

### 没有约束条件的字段
完全省略括号部分：
```
[MISSING] collateral_value | conf:0.60 | note:Collateral valuation not found in document
```

### 没有抽取值的字段
省略 `<-` 部分（在 MISSING 和 ERROR 结果中很常见）：
```
[ERROR] capital_adequacy | conf:0.00 | note:PDF parsing failed on page 3
```

## 与 Trace ID 的集成

`src:` 部分可以编码 trace ID 前缀，将每一行结果与 `version-control` 定义的完整 trace ID 关联。直接采用 trace ID 格式即可：

```
[PASS] capital_adequacy <- 12.5% (>= 8.0%) | conf:0.95 | src:R001-DOC042-P3-S2
[FAIL] sign_date_gap <- 75d (<= 30d) | conf:0.90 | src:R003-DOC042-P1-S4 | note:Signing overdue by 45 days
```

转换为 JSON 时，`src:` 的值映射为完整结果对象中的 `trace_id` 字段。当需要更高精度时，可在末尾追加字符范围 (`C{start}:{end}`)：`src:R001-DOC042-P3-S2-C120:180`。
