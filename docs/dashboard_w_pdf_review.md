---
  生成一个单 HTML 文件的 PDF Review 界面：

  布局： 左右分栏，左侧 PDF 预览（用 pdf.js CDN），右侧可交互表格。中间可拖拽调整比例。

  左侧 PDF 面板：
  - PDF 以 base64 内嵌（变量 PDF_B64），用 pdf.js 逐页渲染到 canvas
  - 每页 canvas 上叠加一层透明 overlay div
  - overlay 里按行级 bbox 坐标放置高亮元素（.line-hl），每个元素有 data-line-id 和对应的文本内容
  - 顶部搜索框：输入关键词高亮匹配行，上下箭头切换，显示匹配计数
  - 底部缩放控件（+/-/适应宽度）

  右侧表格面板：
  - 表头可点击排序，下方有下拉筛选+文本搜索
  - 点击行时：展开显示原文段落，同时左侧 PDF 跳转到对应位置并高亮
  - 跳转逻辑：每行数据关联一组 line_ids，点击后找到对应 .line-hl 元素 → scrollIntoView + 加橙色高亮动画
  - 如果无法匹配到具体行，fallback 跳转到该页顶部

  数据格式（JS 变量）：
  const DATA = {
    page_sizes: [[w,h], ...],          // 每页原始尺寸
    lines: [{id, page, bbox, text}],   // 行级数据（来自 OCR/解析）
    rows: [{字段名: 值, lines: [[line_ids]], ...}]  // 表格数据
  };
  const PDF_B64 = "...";  // base64 编码的 PDF

  ---