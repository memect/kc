---
name: dashboard-reporting
description: Generate HTML dashboards for developer users to visualize verification results, system progress, and quality metrics. Use when a testing round completes, when production batches finish processing, when the developer user wants to see the system's status, or at any point where visual reporting would help communicate progress. Dashboards should be self-contained HTML files that can be opened by double-clicking. Also use when the developer user asks about results, accuracy, or system health.
---

# 可视化仪表盘生成

## 仪表盘的定位

仪表盘是开发者用户了解系统运行状态的唯一窗口。开发者用户不应该需要打开 JSON 文件、翻阅日志目录、或者向你询问「现在准确率多少了」。一切关键信息，打开仪表盘就能看到。

仪表盘生成是一个服务性技能——在其他技能完成工作后，由你主动生成或由开发者用户按需要求生成。

## 三类仪表盘

### 一、核查结果仪表盘（Results Dashboard）

展示某一批次或某一时间段的单据核查结果。

#### 必须包含的内容

**总览区域**：
- 本批次处理的单据总数
- 各规则的通过率、不通过率、无法核查率
- 高置信度/中置信度/低置信度的分布

**按规则明细**：
- 每条规则的独立准确率
- 每条规则最常见的不通过原因（Top 3）
- 每条规则的平均置信度

**失败案例清单**：
- 判定为「不通过」的案例列表
- 每个案例的关键字段摘要、不通过原因、置信度
- 可按规则、按置信度、按不通过原因筛选

**置信度分析**：
- 置信度分布直方图
- 低置信度案例的高亮标注
- 置信度与实际准确率的校准分析（如有质控数据）

### 二、系统进展仪表盘（Progress Dashboard）

展示整个核查系统的建设进度，覆盖从规则提取到生产部署的全生命周期。

#### 必须包含的内容

**生命周期总览**：
- 规则总数及各阶段分布（已提取、技能已编写、技能已测试、工作流已蒸馏、工作流已测试、已投产）
- 用进度条或甘特图形式展示

**演化循环时间线**：
- 每条规则的迭代轮次和当前准确率
- 从第一轮到最新一轮的准确率变化趋势
- 标注关键事件（如「达到阈值」「触发回退」「开发者用户确认」）

**阻塞事项**：
- 达到 `MAX_ITERATIONS` 仍未达标的规则
- 等待开发者用户确认的模糊事项
- 缺少测试样本的规则

### 三、质量监控仪表盘（Quality Dashboard）

展示生产环境中的质量指标趋势。

#### 必须包含的内容

**准确率趋势**：
- 每条规则的准确率随时间的变化曲线
- 阈值线的标注（`WORKFLOW_ACCURACY`）
- 低于阈值的时间段高亮

**抽样率变化**：
- 各规则当前的质控抽样比例
- 抽样比例的变化历史（体现从全量到抽样的信心积累过程）

**成本追踪**：
- 每条规则的平均核查成本
- 按模型层级的成本分布
- 总成本趋势

**异常警报**：
- 准确率下降的规则（红色标注）
- 置信度漂移的规则（黄色标注）
- 成本异常的规则

## 用户反馈收集

每个仪表盘必须内置用户反馈机制，让用户可以直接在核查结果上报告错误和添加评论。用户反馈是系统中最有价值的数据来源，不是可选功能。

### 开发者用户反馈

开发者用户能看到完整的结果明细。他们的反馈界面应支持：
- **字段级修正**：点击某个提取值，输入正确的值。
- **结果覆盖**：将通过改为不通过（或反之），并附理由。
- **规则重评估请求**：标记某条结果，要求用不同方式重新处理。
- **自由评论**：对任何结果添加文本注释。

### 终端用户反馈

核查应用的终端用户看到的是简化结果。他们的反馈界面应支持：
- **一键标记错误**：一次点击即可报告他们认为不正确的结果。
- **添加评论**：简要文字说明他们认为哪里有误。
- **严重程度**：这个错误的影响有多大？（严重 / 重要 / 轻微）

### 反馈即基准真值

用户报告的错误即基准真值。它们的优先级高于编程智能体的判断和 Worker LLM 的输出。反馈数据流转如下：

1. 用户在仪表盘上提交反馈 → 存储为结构化记录。
2. 记录格式：`{result_id, trace_id, reporter_role, feedback_type, original_result, corrected_value, comment, timestamp}`。
3. 反馈记录作为已确认的失败案例，输入 `evolution-loop` 演化循环。
4. 仪表盘展示反馈趋势：修正率随时间变化、最常被报告的问题、用户修正率最高的规则。

例如：信贷审批场景中，业务人员发现某笔贷款的担保物估值被提取错误，一键标记后，该修正自动进入下一轮演化循环的失败案例池，驱动规则改进。

反馈收集机制与仪表盘生成是一体的，不是独立功能。每个生成的 HTML 仪表盘都应包含反馈 UI，即使最初只是将反馈写入本地 JSON 文件，由编程智能体在下次迭代时读取。

## 技术规范

### 自包含 HTML

仪表盘必须是单个 HTML 文件，不依赖任何外部资源：

- CSS 内联（`<style>` 标签）
- JavaScript 内联（`<script>` 标签）
- 不引用任何 CDN 资源
- 不需要启动任何服务器
- 双击文件即可在浏览器中打开

### 不依赖第三方库

所有图表和可视化使用原生 HTML/CSS/JavaScript 实现：

- 进度条：CSS `width` 百分比
- 柱状图/条形图：CSS Flexbox 或 Grid + `div` 高度百分比
- 折线图：SVG `<polyline>` 或 `<path>`
- 饼图：SVG `<circle>` 的 `stroke-dasharray`
- 表格：原生 `<table>` + CSS 样式

不要引入 Chart.js、D3.js、ECharts 等库。保持零依赖。

### 响应式布局

仪表盘应在不同屏幕尺寸下可用：

- 桌面端（1200px+）：多列布局
- 平板端（768px - 1200px）：两列布局
- 手机端（< 768px）：单列布局

使用 CSS Media Query 实现响应式。

### 深色/浅色模式

支持系统级的深色/浅色模式切换：

```css
@media (prefers-color-scheme: dark) {
  :root {
    --bg-primary: #1a1a2e;
    --bg-secondary: #16213e;
    --text-primary: #e8e8e8;
    --text-secondary: #a0a0a0;
    --accent-green: #4ade80;
    --accent-red: #f87171;
    --accent-yellow: #fbbf24;
  }
}

@media (prefers-color-scheme: light) {
  :root {
    --bg-primary: #ffffff;
    --bg-secondary: #f3f4f6;
    --text-primary: #1f2937;
    --text-secondary: #6b7280;
    --accent-green: #16a34a;
    --accent-red: #dc2626;
    --accent-yellow: #d97706;
  }
}
```

## 数据来源

仪表盘的数据从以下位置读取（由生成脚本在生成时内嵌到 HTML 中）：

| 数据类型 | 来源路径 |
|---------|---------|
| 核查结果 | `Output/*/results.json` |
| 质控评审 | `logs/qc/reviews/*.json` |
| 演化日志 | `logs/evolution/*/iteration_*.json` |
| 版本信息 | `versions.json` |
| 准确率趋势 | `logs/qc/trends.json` |
| 规则目录 | `rule-catalog.json` |
| 成本数据 | 从工作流日志中汇总 |

数据以 JavaScript 变量的形式嵌入到 HTML 文件头部：

```html
<script>
const DASHBOARD_DATA = {
  generated_at: "2025-04-01T20:00:00Z",
  batch_id: "BATCH-2025-04-01",
  results: [...],
  qc_reviews: [...],
  trends: {...}
};
</script>
```

## 生成触发时机

### 自动触发

- 每轮测试完成后（演化循环中）→ 生成进展仪表盘
- 每批次处理完成后 → 生成结果仪表盘
- 每次质控评审完成后 → 更新质量监控仪表盘

### 手动触发

开发者用户随时可以要求生成仪表盘。常见的请求方式：
- 「给我看一下现在的进展」
- 「生成一下结果报告」
- 「准确率怎么样了」

无论请求如何措辞，都应生成对应类型的仪表盘。

## 仪表盘文件命名与存放

```
dashboards/
├── results_2025-04-01_batch01.html
├── progress_2025-04-01.html
├── quality_2025-04-01.html
└── latest/
    ├── results.html          # 最新结果仪表盘的软链接/副本
    ├── progress.html         # 最新进展仪表盘的软链接/副本
    └── quality.html          # 最新质量仪表盘的软链接/副本
```

`latest/` 目录下始终保留最新版本，方便开发者用户快速访问。

## 设计原则

### 先总后分

仪表盘打开后，开发者用户首先看到的是一句话总结：

```
本批次共处理 50 份单据，综合准确率 92.3%，全部规则均达标。
```

或者：

```
⚠ 本批次 R003 规则准确率 (78%) 低于阈值 (85%)，已触发演化循环。
```

总结之后再展开细节。

### 色彩编码

- 绿色：达标、通过、正常
- 黄色：接近阈值、需关注、中等置信度
- 红色：低于阈值、不通过、异常

### 可操作性

仪表盘不只是展示数据，还应提供操作建议：

- 「R003 建议重新运行演化循环」
- 「R001 已连续 5 个批次达标，建议将抽样比例从 50% 降至 20%」
- 「3 条模糊规则待确认，请查看详情」

### 生成时间戳

每个仪表盘底部显示生成时间，避免开发者用户看到过时的数据而不自知：

```
仪表盘生成时间：2025-04-01 20:00:00 | 数据范围：2025-04-01 批次 #01
```
