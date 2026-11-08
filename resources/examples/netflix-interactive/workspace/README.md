# Netflix 影片与剧集内容探索（离线交互报告）

单文件交互报告 `report.html`：可筛选电影/剧集、制作国家/地区、题材、发行年份范围，并按片名搜索查看作品详情；
所有统计、图表、结果列表与分页共用同一筛选结果集，按 `show_id` 去重。

## 文件结构

```
report.html                 # 交付物：单文件，内嵌 ECharts、数据、样式与脚本（4.1 MB）
data/netflix_titles.csv     # 输入（原始文件，未修改）
derived/records.json        # prepare_data.py 生成的整理后数据快照（2.9 MB）
scripts/prepare_data.py     # CSV → 清洗、译名、多值拆分、去重 → derived/records.json
scripts/build_report.py     # 模板 + 样式 + 脚本 + 数据 + vendor/ → report.html
src/template.html           # 报告 HTML 骨架（含装配标记）
src/styles.css              # 样式
src/app.js                  # 交互逻辑（筛选、聚合、图表、列表、详情、分页）
vendor/echarts.min.js       # 内置 ECharts 6.1.0（报告装配时原样嵌入）
vendor/LICENSE, NOTICE      # ECharts 的 Apache-2.0 许可与 NOTICE，同样嵌入页面
```

所有脚本以 `Path(__file__).resolve().parent.parent` 定位工作区根目录，
相对读取 `data/`、`vendor/`、`src/`、`derived/`，整个工作区移动到其他目录后仍可运行。

## 重新生成

```bash
cd <工作区>
python3 scripts/prepare_data.py    # 需要 pandas（内置环境已提供）
python3 scripts/build_report.py     # 纯标准库
```

不需要联网、不安装依赖；不会改写 `data/netflix_titles.csv`。
用浏览器直接打开 `report.html` 即可（file:// 亦可，页面不发起任何请求）。

## 数据来源

- 数据集：Netflix Movies and TV Shows，shivamb / Kaggle
- 地址：https://www.kaggle.com/datasets/shivamb/netflix-shows/data
- 本地快照：`data/netflix_titles.csv`，8,807 行 × 12 列

来源文字以普通文本写在报告顶部与页脚，离线可读；仓库无任何 CDN、外链字体或远程图片。

## 口径（报告内同样可见）

| 主题 | 口径 |
| --- | --- |
| 去重 | 以 `show_id` 为唯一键：作品总数、占比、分布、列表、分页全部基于同一去重结果集；原文件重复 ID 为 0 |
| 多值字段 | `country`、`listed_in` 按逗号拆分、去空、行内去重；**全计数**：作品涉及 N 个国家/地区或题材即各计 1 次，故分布合计 > 作品总数，单项占比之和可 > 100%，分母始终是当前作品总数 |
| 缺失 | 国家/地区缺失 831 条、题材仅含 `Movies`/`TV Shows` 格式标签 73 条、分级缺失 7 条、上架日期缺失 10 条，均显示为“未标注”，不并入“其他” |
| 题材维度 | 源数据 42 个 `listed_in` 标签中，`Movies`、`TV Shows` 仅表示格式，已从题材维度排除（余 40 个） |
| 发行年份与上架日期 | `release_year` 为作品发行年，`date_added` 为加入 Netflix 目录的日期，二者分别统计；年份范围筛选只作用于发行年份 |
| 内容分级 | `rating` 是内容分级标签（TV-MA、PG-13 等），**不是用户评分**；快照不含评分、观看量 |
| 时长 | 电影按分钟、剧集按季数分别解析与展示，两类单位不合并平均 |
| 数据修正 | 3 条记录（Louis C.K. 的三部喜剧特辑）的分钟数被写入 `rating` 列，已回填为电影时长，分级记为“未标注” |
| 上架趋势 | 上架日期范围 2008-01-01 至 **2021-09-25**，2021 年为不完整年度；数据集无下架/移除记录，新增上架数不能解读为片库净增长 |

## 局限

- 快照只反映该 Kaggle 数据集整理时的目录，不代表 Netflix 当前或历史完整片库。
- 国家/地区、题材为自由文本，合拍作品会重复计数；国家/地区命名未做规范化合并（如历史政体东德、西德、苏联按源数据保留）。
- 2021 年之后的数据、下架记录、观看量与用户评分均缺失。
- 页面已在宿主隔离 Electron viewer 中实际打开，确认 8,807 条记录与 8 个 canvas 图表成功渲染；
  筛选、图表联动、分页、详情面板等鼠标/键盘交互，以及工作区搬移后的验收，由宿主在查看器中继续确认。

## 许可

图表库 ECharts 6.1.0（Apache License 2.0）：`vendor/LICENSE`、`vendor/NOTICE` 原文已嵌入 `report.html` 的“内置图表库与许可”折叠区。
数据版权归原数据集作者与 Kaggle 数据提供方，报告仅作分析展示。
