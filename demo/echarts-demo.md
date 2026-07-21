# ECharts 图表演示

[返回主测试文档](./test.md)

本文档演示 ECharts 图表的各种用法，包括柱状图、折线图、饼图、雷达图等常见图表类型。

ECharts 使用 JSON 格式的 `option` 对象来描述图表配置，在 ```echarts 代码块中编写。

---

## 1. 柱状图

### 1.1 基础柱状图

```echarts
{
  "width": 600,
  "height": 350,
  "title": { "text": "产品销量统计", "left": "center" },
  "tooltip": { "trigger": "axis" },
  "xAxis": {
    "type": "category",
    "data": ["衬衫", "羊毛衫", "雪纺衫", "裤子", "高跟鞋", "袜子"]
  },
  "yAxis": { "type": "value" },
  "series": [
    {
      "name": "销量",
      "type": "bar",
      "data": [5, 20, 36, 10, 10, 20]
    }
  ]
}
```

### 1.2 分组柱状图

```echarts
{
  "width": 600,
  "height": 350,
  "title": { "text": "不同季度产品对比", "left": "center" },
  "tooltip": { "trigger": "axis" },
  "legend": { "data": ["产品A", "产品B"], "top": "bottom" },
  "xAxis": {
    "type": "category",
    "data": ["Q1", "Q2", "Q3", "Q4"]
  },
  "yAxis": { "type": "value" },
  "series": [
    { "name": "产品A", "type": "bar", "data": [120, 200, 150, 80] },
    { "name": "产品B", "type": "bar", "data": [90, 160, 180, 120] }
  ]
}
```

### 1.3 堆叠柱状图

```echarts
{
  "width": 600,
  "height": 350,
  "tooltip": { "trigger": "axis" },
  "legend": { "data": ["直接访问", "邮件营销", "联盟广告", "视频广告"], "top": "bottom" },
  "xAxis": {
    "type": "category",
    "data": ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
  },
  "yAxis": { "type": "value" },
  "series": [
    { "name": "直接访问", "type": "bar", "stack": "总量", "data": [320, 332, 301, 334, 390, 330, 320] },
    { "name": "邮件营销", "type": "bar", "stack": "总量", "data": [120, 132, 101, 134, 90, 230, 210] },
    { "name": "联盟广告", "type": "bar", "stack": "总量", "data": [220, 182, 191, 234, 290, 330, 310] },
    { "name": "视频广告", "type": "bar", "stack": "总量", "data": [150, 232, 201, 154, 190, 330, 410] }
  ]
}
```

---

## 2. 折线图

### 2.1 基础折线图

```echarts
{
  "width": 600,
  "height": 300,
  "title": { "text": "月度销售额趋势", "left": "center" },
  "tooltip": { "trigger": "axis" },
  "xAxis": {
    "type": "category",
    "data": ["1月", "2月", "3月", "4月", "5月", "6月"]
  },
  "yAxis": { "type": "value", "name": "万元" },
  "series": [
    {
      "name": "销售额",
      "type": "line",
      "data": [100, 150, 120, 180, 200, 170],
      "smooth": true
    }
  ]
}
```

### 2.2 多系列折线图

```echarts
{
  "width": 600,
  "height": 350,
  "title": { "text": "各学科平均成绩趋势", "left": "center" },
  "tooltip": { "trigger": "axis" },
  "legend": { "data": ["语文", "数学", "英语"], "top": "bottom" },
  "xAxis": {
    "type": "category",
    "boundaryGap": false,
    "data": ["2020", "2021", "2022", "2023", "2024"]
  },
  "yAxis": { "type": "value", "min": 70, "max": 95 },
  "series": [
    { "name": "语文", "type": "line", "data": [78.5, 81.2, 83.8, 85.3, 87.1] },
    { "name": "数学", "type": "line", "data": [82.3, 84.7, 86.2, 88.5, 90.2] },
    { "name": "英语", "type": "line", "data": [75.8, 77.9, 80.4, 82.6, 84.8] }
  ]
}
```

---

## 3. 饼图

### 3.1 基础饼图

```echarts
{
  "width": 400,
  "height": 350,
  "title": { "text": "访问来源", "left": "center" },
  "tooltip": { "trigger": "item" },
  "legend": { "orient": "vertical", "left": "left" },
  "series": [
    {
      "name": "访问来源",
      "type": "pie",
      "radius": "60%",
      "data": [
        { "value": 1048, "name": "直接访问" },
        { "value": 735, "name": "邮件营销" },
        { "value": 580, "name": "联盟广告" },
        { "value": 484, "name": "视频广告" },
        { "value": 300, "name": "搜索引擎" }
      ],
      "emphasis": {
        "itemStyle": {
          "shadowBlur": 10,
          "shadowOffsetX": 0,
          "shadowColor": "rgba(0, 0, 0, 0.5)"
        }
      }
    }
  ]
}
```

### 3.2 环形图（甜甜圈图）

```echarts
{
  "width": 400,
  "height": 350,
  "title": { "text": "用户来源占比", "left": "center" },
  "tooltip": { "trigger": "item" },
  "legend": { "top": "bottom" },
  "series": [
    {
      "name": "来源",
      "type": "pie",
      "radius": ["40%", "65%"],
      "avoidLabelOverlap": false,
      "label": { "show": false },
      "labelLine": { "show": false },
      "data": [
        { "value": 1048, "name": "直接访问" },
        { "value": 735, "name": "邮件营销" },
        { "value": 580, "name": "联盟广告" },
        { "value": 484, "name": "视频广告" },
        { "value": 300, "name": "搜索引擎" }
      ]
    }
  ]
}
```

---

## 4. 散点图

```echarts
{
  "width": 600,
  "height": 350,
  "title": { "text": "身高体重分布", "left": "center" },
  "tooltip": { "trigger": "item" },
  "xAxis": { "type": "value", "name": "身高(cm)", "min": 150, "max": 190 },
  "yAxis": { "type": "value", "name": "体重(kg)", "min": 45, "max": 90 },
  "series": [
    {
      "name": "男性",
      "type": "scatter",
      "data": [
        [161, 51], [167, 59], [159, 47], [157, 46], [155, 45],
        [170, 61], [163, 52], [166, 55], [168, 57], [177, 67],
        [174, 64], [172, 62], [175, 66], [169, 60], [180, 75],
        [182, 78], [178, 70], [176, 68], [185, 82], [179, 72]
      ]
    }
  ]
}
```

---

## 5. 雷达图

```echarts
{
  "width": 400,
  "height": 350,
  "title": { "text": "产品能力对比", "left": "center" },
  "tooltip": {},
  "legend": { "data": ["产品A", "产品B"], "top": "bottom" },
  "radar": {
    "indicator": [
      { "name": "性能", "max": 100 },
      { "name": "易用性", "max": 100 },
      { "name": "稳定性", "max": 100 },
      { "name": "扩展性", "max": 100 },
      { "name": "安全性", "max": 100 },
      { "name": "成本", "max": 100 }
    ]
  },
  "series": [
    {
      "name": "能力",
      "type": "radar",
      "data": [
        { "value": [85, 72, 90, 65, 88, 60], "name": "产品A" },
        { "value": [70, 88, 75, 82, 68, 85], "name": "产品B" }
      ]
    }
  ]
}
```

---

## 6. 面积图

```echarts
{
  "width": 600,
  "height": 300,
  "title": { "text": "北京2024年气温变化", "left": "center" },
  "tooltip": { "trigger": "axis" },
  "xAxis": {
    "type": "category",
    "boundaryGap": false,
    "data": ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"]
  },
  "yAxis": { "type": "value", "name": "°C" },
  "series": [
    {
      "name": "平均气温",
      "type": "line",
      "smooth": true,
      "areaStyle": {},
      "data": [-2, 1, 8, 15, 21, 26, 28, 27, 22, 14, 5, -1]
    }
  ]
}
```

---

## 7. 仪表盘

```echarts
{
  "width": 400,
  "height": 300,
  "series": [
    {
      "type": "gauge",
      "progress": { "show": true, "width": 18 },
      "axisLine": { "lineStyle": { "width": 18 } },
      "axisTick": { "show": false },
      "splitLine": { "length": 15, "lineStyle": { "width": 2, "color": "#999" } },
      "axisLabel": { "distance": 25, "color": "#999", "fontSize": 10 },
      "anchor": { "show": true, "size": 20, "itemStyle": { "color": "#999" } },
      "detail": { "valueAnimation": true, "fontSize": 30, "offsetCenter": [0, "70%"] },
      "data": [{ "value": 72, "name": "完成率" }]
    }
  ]
}
```

---

## 8. 热力图

```echarts
{
  "width": 600,
  "height": 350,
  "tooltip": { "position": "top" },
  "grid": { "height": "50%", "top": "10%" },
  "xAxis": {
    "type": "category",
    "data": ["周一", "周二", "周三", "周四", "周五", "周六", "周日"],
    "splitArea": { "show": true }
  },
  "yAxis": {
    "type": "category",
    "data": ["早", "中", "晚"],
    "splitArea": { "show": true }
  },
  "visualMap": {
    "min": 0,
    "max": 100,
    "calculable": true,
    "orient": "horizontal",
    "left": "center",
    "bottom": "5%"
  },
  "series": [
    {
      "name": "访问量",
      "type": "heatmap",
      "data": [
        [0, 0, 25], [0, 1, 45], [0, 2, 15],
        [1, 0, 30], [1, 1, 55], [1, 2, 20],
        [2, 0, 40], [2, 1, 65], [2, 2, 30],
        [3, 0, 35], [3, 1, 70], [3, 2, 25],
        [4, 0, 50], [4, 1, 80], [4, 2, 40],
        [5, 0, 60], [5, 1, 90], [5, 2, 55],
        [6, 0, 45], [6, 1, 75], [6, 2, 35]
      ],
      "label": { "show": true }
    }
  ]
}
```

---

## 9. 箱线图

```echarts
{
  "width": 600,
  "height": 350,
  "title": { "text": "各组数据分布", "left": "center" },
  "tooltip": { "trigger": "item" },
  "xAxis": {
    "type": "category",
    "data": ["A组", "B组", "C组", "D组"]
  },
  "yAxis": { "type": "value" },
  "series": [
    {
      "name": "箱线图",
      "type": "boxplot",
      "data": [
        [655, 850, 940, 980, 1075],
        [672, 800, 845, 885, 1012],
        [620, 750, 812, 870, 985],
        [680, 802, 865, 930, 1050]
      ]
    }
  ]
}
```

---

## 10. 烛形图（K线图）

```echarts
{
  "width": 600,
  "height": 350,
  "title": { "text": "每日股价", "left": "center" },
  "tooltip": { "trigger": "axis" },
  "xAxis": {
    "type": "category",
    "data": ["周一", "周二", "周三", "周四", "周五"]
  },
  "yAxis": { "scale": true },
  "series": [
    {
      "type": "candlestick",
      "data": [
        [20, 30, 18, 25],
        [22, 28, 20, 26],
        [25, 35, 22, 30],
        [28, 32, 25, 29],
        [29, 38, 27, 35]
      ]
    }
  ]
}
```

---

## 11. 树图

```echarts
{
  "width": 600,
  "height": 350,
  "title": { "text": "磁盘空间占用", "left": "center" },
  "tooltip": { "trigger": "item" },
  "series": [
    {
      "type": "treemap",
      "data": [
        {
          "name": "系统文件",
          "value": 42,
          "children": [
            { "name": "Windows", "value": 28 },
            { "name": "Program Files", "value": 14 }
          ]
        },
        {
          "name": "用户数据",
          "value": 35,
          "children": [
            { "name": "文档", "value": 12 },
            { "name": "图片", "value": 15 },
            { "name": "视频", "value": 8 }
          ]
        },
        {
          "name": "应用程序",
          "value": 23,
          "children": [
            { "name": "浏览器", "value": 8 },
            { "name": "编辑器", "value": 6 },
            { "name": "其他", "value": 9 }
          ]
        }
      ]
    }
  ]
}
```

---

## 12. 漏斗图

```echarts
{
  "width": 400,
  "height": 350,
  "title": { "text": "转化漏斗", "left": "center" },
  "tooltip": { "trigger": "item" },
  "series": [
    {
      "name": "漏斗",
      "type": "funnel",
      "left": "10%",
      "top": 60,
      "bottom": 60,
      "width": "80%",
      "label": { "show": true, "position": "inside" },
      "data": [
        { "value": 100, "name": "访问" },
        { "value": 80, "name": "咨询" },
        { "value": 60, "name": "加购" },
        { "value": 40, "name": "下单" },
        { "value": 20, "name": "成交" }
      ]
    }
  ]
}
```

---

## 自定义图表尺寸

ECharts 图表支持通过 `width` 和 `height` 字段自定义输出尺寸（单位为像素）。如果不指定，默认为 800×450。

```echarts
{
  "width": 500,
  "height": 250,
  "title": { "text": "自定义尺寸图表 (500×250)", "left": "center" },
  "tooltip": { "trigger": "axis" },
  "xAxis": { "type": "category", "data": ["A", "B", "C", "D"] },
  "yAxis": { "type": "value" },
  "series": [
    { "type": "bar", "data": [10, 22, 28, 16] }
  ]
}
```

---

[返回主测试文档](./test.md)
