#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Netflix 片库快照分析（可复跑）
数据：data/netflix_titles.csv（Netflix Movies and TV Shows, shivamb / Kaggle）
输出：figures/*.png, tables/*.csv, metrics.json
运行：python3 analysis.py
依赖：pandas, numpy, matplotlib（不联网、不装包）
"""

import json
import os
import re

import numpy as np
import pandas as pd
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import PercentFormatter

BASE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(BASE, "data", "netflix_titles.csv")
FIG = os.path.join(BASE, "figures")
TAB = os.path.join(BASE, "tables")
os.makedirs(FIG, exist_ok=True)
os.makedirs(TAB, exist_ok=True)

# ---------- 中文字体与绘图风格 ----------
plt.rcParams["font.sans-serif"] = ["Noto Sans CJK SC", "Heiti TC", "DejaVu Sans"]
plt.rcParams["axes.unicode_minus"] = False
plt.rcParams["figure.dpi"] = 150
plt.rcParams["savefig.bbox"] = "tight"
plt.rcParams["axes.spines.top"] = False
plt.rcParams["axes.spines.right"] = False
plt.rcParams["axes.edgecolor"] = "#BBBBBB"
plt.rcParams["axes.labelcolor"] = "#333333"
plt.rcParams["text.color"] = "#333333"
plt.rcParams["xtick.color"] = "#555555"
plt.rcParams["ytick.color"] = "#555555"

C_MOVIE = "#1F77B4"
C_TV = "#E45756"
C_GREY = "#9AA5B1"
C_ACCENT = "#F2A900"

M = {}  # metrics 容器，最终写入 metrics.json


def savefig(fig, name):
    path = os.path.join(FIG, name)
    fig.savefig(path, facecolor="white")
    plt.close(fig)
    print("saved", path)


def markdown_table(df, floatfmt="{:.1f}"):
    """不依赖 tabulate 的 Markdown 表格生成。"""
    cols = list(df.columns)
    lines = ["| " + " | ".join(str(c) for c in cols) + " |",
             "|" + "|".join(["---"] * len(cols)) + "|"]
    for _, row in df.iterrows():
        cells = []
        for c in cols:
            v = row[c]
            if isinstance(v, (float, np.floating)):
                cells.append(floatfmt.format(v) if not pd.isna(v) else "—")
            else:
                cells.append(str(v))
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines)


# =========================================================
# 1. 读取与清洗（原 CSV 只读，不修改）
# =========================================================
raw = pd.read_csv(SRC, dtype=str, keep_default_na=False)
M["raw_rows"], M["raw_cols"] = int(raw.shape[0]), int(raw.shape[1])

df = raw.copy()
# 1.1 去除首尾空白（date_added 有 88 个前导空格，title 有 1 个尾随空格）
padded = {c: int((raw[c] != raw[c].str.strip()).sum()) for c in raw.columns}
padded = {k: v for k, v in padded.items() if v > 0}
M["whitespace_padded"] = padded
df = df.apply(lambda s: s.str.strip())
# 1.2 空字符串统一视为缺失
df = df.replace("", np.nan)

# 1.3 字段错位：rating 列中出现 "74 min" 等时长值，duration 为空 → 互换回填
swap_mask = df["rating"].fillna("").str.fullmatch(r"\d+\s*min") & df["duration"].isna()
M["rating_duration_swapped"] = int(swap_mask.sum())
df.loc[swap_mask, "duration"] = df.loc[swap_mask, "rating"]
df.loc[swap_mask, "rating"] = np.nan

# 1.4 日期解析（上架日期与发行年份严格区分）
df["date_added_parsed"] = pd.to_datetime(df["date_added"], format="%B %d, %Y", errors="coerce")
df["add_year"] = df["date_added_parsed"].dt.year
df["add_month"] = df["date_added_parsed"].dt.month
df["release_year"] = pd.to_numeric(df["release_year"], errors="coerce").astype("Int64")

# 1.5 时长拆分：电影=分钟，剧集=季数（互不混算）
df["minutes"] = np.nan
df["seasons"] = np.nan
is_movie = df["type"] == "Movie"
is_tv = df["type"] == "TV Show"
df.loc[is_movie, "minutes"] = pd.to_numeric(
    df.loc[is_movie, "duration"].str.extract(r"^(\d+)\s*min$")[0], errors="coerce")
df.loc[is_tv, "seasons"] = pd.to_numeric(
    df.loc[is_tv, "duration"].str.extract(r"^(\d+)\s*Seasons?$")[0], errors="coerce")

# 1.6 多标签：国家 / 题材（保留原串，另生成列表列）
def split_labels(x):
    if pd.isna(x):
        return []
    return [p.strip() for p in str(x).split(",") if p.strip()]

df["country_list"] = df["country"].apply(split_labels)
df["genre_list"] = df["listed_in"].apply(split_labels)
df["n_countries"] = df["country_list"].apply(len)
df["n_genres"] = df["genre_list"].apply(len)

# 1.7 分级映射：内容分级（不是用户评分）
RATING_TIER = {
    "G": "低龄/家庭", "TV-G": "低龄/家庭", "TV-Y": "低龄/家庭",
    "TV-Y7": "低龄/家庭", "TV-Y7-FV": "低龄/家庭",
    "PG": "家长指引", "TV-PG": "家长指引",
    "PG-13": "青少年", "TV-14": "青少年",
    "R": "成人", "NC-17": "成人", "TV-MA": "成人",
    "NR": "未分级", "UR": "未分级",
}
df["rating_tier"] = df["rating"].map(RATING_TIER).fillna("未分级")

# 1.8 派生清洗文件（只写派生文件，原 CSV 不动）
clean_cols = ["show_id", "type", "title", "director", "cast", "country", "date_added",
              "date_added_parsed", "add_year", "release_year", "rating", "rating_tier",
              "duration", "minutes", "seasons", "listed_in", "n_countries", "n_genres",
              "description"]
df[clean_cols].to_csv(os.path.join(TAB, "netflix_titles_clean.csv"), index=False)

# =========================================================
# 2. 数据质量核查
# =========================================================
qc_rows = []
for c in raw.columns:
    qc_rows.append({
        "字段": c,
        "缺失数": int(df[c].isna().sum()) if c != "date_added" else int(df["date_added"].isna().sum()),
        "缺失率": (df[c].isna().sum() if c != "date_added" else df["date_added"].isna().sum()) / len(df),
    })
qc = pd.DataFrame(qc_rows)
qc.to_csv(os.path.join(TAB, "qc_missing.csv"), index=False)
M["missing"] = {r["字段"]: int(r["缺失数"]) for _, r in qc.iterrows()}

M["unique_id"] = int(df["show_id"].nunique())
M["dup_id"] = int(df["show_id"].duplicated().sum())
M["dup_rows_exact"] = int(df.duplicated(subset=[c for c in raw.columns]).sum())
dup_title = df[df["title"].duplicated(keep=False)].sort_values("title")
M["dup_title_groups"] = int(df["title"].duplicated().sum())
M["dup_title_rows"] = dup_title[["show_id", "type", "title", "release_year"]].to_dict("records")

M["date_missing"] = int(df["date_added"].isna().sum())
M["date_parsed"] = int(df["date_added_parsed"].notna().sum())
M["date_min"] = str(df["date_added_parsed"].min().date())
M["date_max"] = str(df["date_added_parsed"].max().date())
M["release_year_min"] = int(df["release_year"].min())
M["release_year_max"] = int(df["release_year"].max())
M["added_before_release"] = int((df["add_year"] < df["release_year"]).sum())
M["added_before_release_rows"] = df.loc[df["add_year"] < df["release_year"],
                                        ["show_id", "type", "title", "date_added", "release_year"]].to_dict("records")
M["2021_months"] = sorted(df.loc[df["add_year"] == 2021, "add_month"].dropna().astype(int).unique().tolist())
M["2021_count"] = int((df["add_year"] == 2021).sum())

# 多标签覆盖
M["multi_country_rows"] = int((df["n_countries"] > 1).sum())
M["multi_country_max"] = int(df["n_countries"].max())
M["multi_genre_rows"] = int((df["n_genres"] > 1).sum())
M["genres_per_title_mean"] = float(df["n_genres"].mean())
M["countries_per_title_mean"] = float(df.loc[df["n_countries"] > 0, "n_countries"].mean())
M["n_country_labels"] = int(len(set().union(*df["country_list"])))
M["n_genre_labels"] = int(len(set().union(*df["genre_list"])))

# =========================================================
# 3. 内容结构总览
# =========================================================
type_counts = df["type"].value_counts()
M["n_movie"] = int(type_counts.get("Movie", 0))
M["n_tv"] = int(type_counts.get("TV Show", 0))
M["pct_movie"] = M["n_movie"] / len(df)
M["pct_tv"] = M["n_tv"] / len(df)
ov = pd.DataFrame({
    "类型": ["Movie（电影）", "TV Show（剧集）", "合计"],
    "作品数": [M["n_movie"], M["n_tv"], len(df)],
    "占比": [M["pct_movie"], M["pct_tv"], 1.0],
})
ov.to_csv(os.path.join(TAB, "overview_type.csv"), index=False)

# 发行年份结构
M["release_year_median"] = float(df["release_year"].median())
M["release_year_q25"] = float(df["release_year"].quantile(.25))
M["release_year_q75"] = float(df["release_year"].quantile(.75))
df["release_bucket"] = pd.cut(df["release_year"],
                              bins=[1924, 1979, 1989, 1999, 2009, 2015, 2019, 2021],
                              labels=["≤1979", "1980–1989", "1990–1999", "2000–2009",
                                      "2010–2015", "2016–2019", "2020–2021"])
rel = df.groupby(["release_bucket", "type"], observed=False).size().unstack(fill_value=0)
rel["合计"] = rel.sum(axis=1)
rel["剧集占比"] = rel["TV Show"] / rel["合计"]
rel.to_csv(os.path.join(TAB, "release_year_bucket.csv"))

M["release_2010plus"] = int((df["release_year"] >= 2010).sum())
M["release_2016_2021"] = int((df["release_year"] >= 2016).sum())

# =========================================================
# 4. 制作国家/地区（多标签全计数）
# =========================================================
ctry_rows = []
for _, r in df.iterrows():
    for c in r["country_list"]:
        ctry_rows.append({"country": c, "type": r["type"]})
ctry_long = pd.DataFrame(ctry_rows)
ctry = ctry_long.pivot_table(index="country", columns="type", aggfunc=len, fill_value=0)
ctry = ctry.rename(columns={"Movie": "电影", "TV Show": "剧集"})
ctry["合计"] = ctry.sum(axis=1)
ctry = ctry.sort_values("合计", ascending=False)
ctry["占已知国家作品数"] = ctry["合计"] / int((df["n_countries"] > 0).sum())
ctry["剧集占比"] = ctry["剧集"] / ctry["合计"]
ctry.to_csv(os.path.join(TAB, "country_counts.csv"), encoding="utf-8-sig")
M["country_known_titles"] = int((df["n_countries"] > 0).sum())
M["country_unknown_titles"] = int((df["n_countries"] == 0).sum())
M["country_token_total"] = int(ctry["合计"].sum())
M["top_countries"] = ctry.head(15)[["合计", "电影", "剧集"]].reset_index().to_dict("records")

# 美/印集中度
M["us_count"] = int(ctry.loc["United States", "合计"])
M["us_share_known"] = float(M["us_count"] / M["country_known_titles"])
M["us_india_share_known"] = float((M["us_count"] + int(ctry.loc["India", "合计"])) / M["country_known_titles"])

# 按类型看国家集中度
for t, label in [("Movie", "movie"), ("TV Show", "tv")]:
    sub = ctry_long[ctry_long["type"] == t]["country"].value_counts()
    M[f"top3_{label}_countries"] = sub.head(3).to_dict()
    M[f"n_titles_{label}"] = int((df["type"] == t).sum())

# =========================================================
# 5. 题材（多标签全计数，按类型分别统计）
# =========================================================
g_rows = []
for _, r in df.iterrows():
    for g in r["genre_list"]:
        g_rows.append({"genre": g, "type": r["type"]})
glong = pd.DataFrame(g_rows)
genre = glong.pivot_table(index="genre", columns="type", aggfunc=len, fill_value=0)
genre = genre.rename(columns={"Movie": "电影", "TV Show": "剧集"})
genre["合计"] = genre.sum(axis=1)
genre = genre.sort_values("合计", ascending=False)
genre["占全部作品数"] = genre["合计"] / len(df)
genre.to_csv(os.path.join(TAB, "genre_counts.csv"), encoding="utf-8-sig")
M["genre_token_total"] = int(genre["合计"].sum())
M["top_genres"] = genre.head(15)[["合计", "电影", "剧集"]].reset_index().to_dict("records")

# 各类型内部 Top 题材（分母为该类型作品数）
g_movie = glong[glong["type"] == "Movie"]["genre"].value_counts()
g_tv = glong[glong["type"] == "TV Show"]["genre"].value_counts()
M["top_movie_genres"] = [{"genre": k, "count": int(v), "share": float(v / M["n_movie"])}
                         for k, v in g_movie.head(10).items()]
M["top_tv_genres"] = [{"genre": k, "count": int(v), "share": float(v / M["n_tv"])}
                      for k, v in g_tv.head(10).items()]
M["n_movie_genre_labels"] = int(len(g_movie))
M["n_tv_genre_labels"] = int(len(g_tv))
M["genre_shared_labels"] = sorted(set(g_movie.index) & set(g_tv.index))

# =========================================================
# 6. 内容分级（非用户评分）
# =========================================================
rating = df.pivot_table(index="rating", columns="type", aggfunc="size", fill_value=0)
rating = rating.rename(columns={"Movie": "电影", "TV Show": "剧集"})
rating["合计"] = rating.sum(axis=1)
rating["占全部作品数"] = rating["合计"] / len(df)
rating = rating.sort_values("合计", ascending=False)
rating.index.name = "rating"
rating.to_csv(os.path.join(TAB, "rating_counts.csv"), encoding="utf-8-sig")
M["rating_counts"] = {str(k): int(v) for k, v in rating["合计"].items()}
M["n_rating_labels"] = int(len(rating))

tier = df.pivot_table(index="rating_tier", columns="type", aggfunc="size", fill_value=0)
tier = tier.rename(columns={"Movie": "电影", "TV Show": "剧集"})
tier["合计"] = tier.sum(axis=1)
order = ["低龄/家庭", "家长指引", "青少年", "成人", "未分级"]
tier = tier.reindex([o for o in order if o in tier.index])
tier["电影占比"] = tier["电影"] / tier["电影"].sum()
tier["剧集占比"] = tier["剧集"] / tier["剧集"].sum()
tier.to_csv(os.path.join(TAB, "rating_tier.csv"), encoding="utf-8-sig")
M["tier_table"] = tier.reset_index().rename(columns={"rating_tier": "分级档"}).to_dict("records")
M["movie_adult_share"] = float(df[(df["type"] == "Movie") & (df["rating_tier"] == "成人")].shape[0] / M["n_movie"])
M["tv_adult_share"] = float(df[(df["type"] == "TV Show") & (df["rating_tier"] == "成人")].shape[0] / M["n_tv"])
M["movie_kids_share"] = float(df[(df["type"] == "Movie") & (df["rating_tier"] == "低龄/家庭")].shape[0] / M["n_movie"])
M["tv_kids_share"] = float(df[(df["type"] == "TV Show") & (df["rating_tier"] == "低龄/家庭")].shape[0] / M["n_tv"])
M["unrated_count"] = int((df["rating_tier"] == "未分级").sum())

# =========================================================
# 7. 上架年份趋势（上架日期口径，2021 不完整）
# =========================================================
year_type = df.pivot_table(index="add_year", columns="type", aggfunc="size", fill_value=0)
year_type = year_type.rename(columns={"Movie": "电影", "TV Show": "剧集"})
year_type["合计"] = year_type.sum(axis=1)
year_type["剧集占比"] = year_type["剧集"] / year_type["合计"]
year_type.index = year_type.index.astype(int)
year_type.to_csv(os.path.join(TAB, "year_added_by_type.csv"), encoding="utf-8-sig")
M["year_table"] = year_type.reset_index().rename(columns={"add_year": "上架年份"}).to_dict("records")

win = year_type.loc[2016:2020]
M["win_total"] = int(win["合计"].sum())
M["win_movie"] = int(win["电影"].sum())
M["win_tv"] = int(win["剧集"].sum())
M["win_tv_share"] = float(win["剧集"].sum() / win["合计"].sum())
M["win_share_of_all"] = float(win["合计"].sum() / len(df))
M["growth_2016_2020"] = float(win.loc[2020, "合计"] / win.loc[2016, "合计"] - 1)
M["tv_share_2016"] = float(win.loc[2016, "剧集占比"])
M["tv_share_2020"] = float(win.loc[2020, "剧集占比"])
M["tv_share_2019"] = float(year_type.loc[2019, "剧集占比"])
M["tv_share_2015"] = float(year_type.loc[2015, "剧集占比"])
M["peak_year"] = int(year_type["合计"].idxmax())
M["peak_year_count"] = int(year_type["合计"].max())

# 2016–2020 每年电影/剧集同比
M["year_change"] = {int(y): (float(year_type.loc[y, "合计"] / year_type.loc[y - 1, "合计"] - 1)
                             if y - 1 in year_type.index else None)
                    for y in range(2016, 2021)}

# 上架年份 vs 发行年份：新片比例
lag = df.dropna(subset=["add_year", "release_year"]).copy()
lag["lag"] = lag["add_year"] - lag["release_year"]
M["lag_median"] = float(lag["lag"].median())
M["lag_share_same_or_next"] = float((lag["lag"] <= 1).mean())
M["lag_share_10plus"] = float((lag["lag"] >= 10).mean())

# 各上架年份中位数电影时长（仅完整年份）
mdur_year = df[(df["type"] == "Movie") & df["add_year"].between(2015, 2020)] \
    .groupby("add_year")["minutes"].agg(["count", "median", "mean"]).reset_index()
mdur_year.columns = ["上架年份", "电影数", "中位时长", "平均时长"]
mdur_year.to_csv(os.path.join(TAB, "movie_duration_by_add_year.csv"), index=False)
M["movie_duration_by_year"] = mdur_year.to_dict("records")

# 各年份剧集季数中位数
s_year = df[(df["type"] == "TV Show") & df["add_year"].between(2015, 2020)] \
    .groupby("add_year")["seasons"].agg(["count", "median"]).reset_index()
M["tv_season_median_by_year"] = s_year.rename(columns={"add_year": "year", "count": "n",
                                                       "median": "median"}).to_dict("records")

# =========================================================
# 8. 电影时长分布
# =========================================================
mv = df[df["type"] == "Movie"]
mins = mv["minutes"].dropna()
M["movie_min_n"] = int(mins.shape[0])
M["movie_min_missing"] = int(mv["minutes"].isna().sum())
M["movie_min_mean"] = float(mins.mean())
M["movie_min_median"] = float(mins.median())
M["movie_min_std"] = float(mins.std())
M["movie_min_p10"] = float(mins.quantile(.10))
M["movie_min_p25"] = float(mins.quantile(.25))
M["movie_min_p75"] = float(mins.quantile(.75))
M["movie_min_p90"] = float(mins.quantile(.90))
M["movie_min_min"] = int(mins.min())
M["movie_min_max"] = int(mins.max())
M["movie_under_60"] = float((mins < 60).mean())
M["movie_under_90"] = float((mins < 90).mean())
M["movie_90_120"] = float(((mins >= 90) & (mins <= 120)).mean())
M["movie_over_120"] = float((mins > 120).mean())
M["movie_under_75_count"] = int((mins < 75).sum())
dur_stats = pd.DataFrame({
    "指标": ["有效样本", "缺失", "均值", "标准差", "中位数", "P10", "P25", "P75", "P90", "最小值", "最大值"],
    "数值": [int(M["movie_min_n"]), int(M["movie_min_missing"]), M["movie_min_mean"], M["movie_min_std"],
             M["movie_min_median"], M["movie_min_p10"], M["movie_min_p25"], M["movie_min_p75"],
             M["movie_min_p90"], int(M["movie_min_min"]), int(M["movie_min_max"])],
})
dur_stats.to_csv(os.path.join(TAB, "movie_duration_stats.csv"), index=False)

# 按题材看电影时长（只取电影 Top 题材，全计数口径下的子集）
dur_by_genre = []
for g in g_movie.head(8).index:
    s = mv[mv["genre_list"].apply(lambda L: g in L)]["minutes"].dropna()
    dur_by_genre.append({"题材": g, "电影数": int(s.shape[0]), "中位时长": float(s.median()),
                         "均值": float(s.mean())})
pd.DataFrame(dur_by_genre).to_csv(os.path.join(TAB, "movie_duration_by_genre.csv"), index=False)
M["movie_duration_by_genre"] = dur_by_genre

# =========================================================
# 9. 剧集季数分布
# =========================================================
tv = df[df["type"] == "TV Show"]
seasons = tv["seasons"].dropna()
M["tv_n"] = int(seasons.shape[0])
M["tv_missing"] = int(tv["seasons"].isna().sum())
M["tv_season_mean"] = float(seasons.mean())
M["tv_season_median"] = float(seasons.median())
M["tv_season_max"] = int(seasons.max())
M["tv_season_min"] = int(seasons.min())
M["tv_one_season_share"] = float((seasons == 1).mean())
M["tv_two_season_share"] = float((seasons == 2).mean())
M["tv_3plus_share"] = float((seasons >= 3).mean())
M["tv_5plus_share"] = float((seasons >= 5).mean())
M["tv_10plus_count"] = int((seasons >= 10).sum())
season_counts = seasons.value_counts().sort_index()
sc = pd.DataFrame({"季数": season_counts.index.astype(int), "剧集数": season_counts.values})
sc["占比"] = sc["剧集数"] / M["tv_n"]
sc.to_csv(os.path.join(TAB, "tv_seasons_counts.csv"), index=False)
M["season_top"] = {int(k): int(v) for k, v in season_counts.head(6).items()}
M["longest"] = tv.nlargest(5, "seasons")[["title", "seasons", "release_year"]].to_dict("records")

# =========================================================
# 10. 图表
# =========================================================
# 图1 类型构成
fig, ax = plt.subplots(figsize=(7.2, 3.2))
vals = [M["n_movie"], M["n_tv"]]
labels = [f"电影 Movie\n{M['n_movie']:,} 部 ({M['pct_movie']:.1%})",
          f"剧集 TV Show\n{M['n_tv']:,} 部 ({M['pct_tv']:.1%})"]
bars = ax.barh(labels, vals, color=[C_MOVIE, C_TV], height=.55)
for b, v in zip(bars, vals):
    ax.text(v + 90, b.get_y() + b.get_height() / 2, f"{v:,}", va="center", fontsize=10)
ax.set_xlim(0, max(vals) * 1.18)
ax.set_xlabel("作品数（按 show_id 去重，n=8,807）")
ax.set_title("图1  片库快照的类型构成：电影约占七成", fontsize=12, loc="left")
ax.invert_yaxis()
savefig(fig, "fig1_type_overview.png")

# 图2 上架年份 × 类型
fig, ax = plt.subplots(figsize=(8.4, 4.2))
yrs = year_type.index.tolist()
x = np.arange(len(yrs))
mv_v = year_type["电影"].values
tv_v = year_type["剧集"].values
ax.bar(x, mv_v, color=C_MOVIE, label="电影", width=.7)
ax.bar(x, tv_v, bottom=mv_v, color=C_TV, label="剧集", width=.7)
for i, y in enumerate(yrs):
    tot = year_type.loc[y, "合计"]
    ax.text(i, tot + 28, f"{int(tot):,}", ha="center", fontsize=8.5)
# 2021 标注不完整
i21 = yrs.index(2021)
ax.bar(i21, mv_v[i21], color=C_MOVIE, width=.7, alpha=.45, hatch="//", edgecolor="white")
ax.bar(i21, tv_v[i21], bottom=mv_v[i21], color=C_TV, width=.7, alpha=.45, hatch="//", edgecolor="white")
ax.annotate("2021 仅含 1/1–9/25\n（不完整，不参与趋势比较）",
            xy=(i21, year_type.loc[2021, "合计"]), xytext=(i21 - 1.6, 2050),
            fontsize=8.5, color="#B34700",
            arrowprops=dict(arrowstyle="->", color="#B34700", lw=1))
ax.set_xticks(x)
ax.set_xticklabels(yrs)
ax.set_xlabel("上架年份（date_added，非发行年份）")
ax.set_ylabel("上架作品数")
ax.set_ylim(0, 2350)
ax.legend(frameon=False, loc="upper left")
ax.set_title("图2  各年上架数量与类型结构（2021 为不完整年份）", fontsize=12, loc="left")
# 标注空白年份
for i, y in enumerate(yrs):
    if y < 2015:
        pass
savefig(fig, "fig2_added_by_year.png")

# 图3 结构变化：剧集占比 + 电影中位时长
fig, axes = plt.subplots(1, 2, figsize=(10, 3.8))
ax = axes[0]
sub = year_type.loc[2015:2020]
ax.plot(sub.index, sub["剧集占比"] * 100, marker="o", color=C_TV, lw=2)
for xx, yy in zip(sub.index, sub["剧集占比"] * 100):
    ax.text(xx, yy + 1.1, f"{yy:.1f}%", ha="center", fontsize=8.5, color=C_TV)
ax.set_ylim(0, 48)
ax.set_xlabel("上架年份")
ax.set_ylabel("剧集中占比（%）")
ax.set_title("(a) 剧集在新上架内容中的占比", fontsize=10.5, loc="left")
ax.grid(axis="y", color="#EEEEEE")

ax = axes[1]
ax.plot(mdur_year["上架年份"], mdur_year["中位时长"], marker="s", color=C_MOVIE, lw=2)
for xx, yy in zip(mdur_year["上架年份"], mdur_year["中位时长"]):
    ax.text(xx, yy + 1.6, f"{yy:.0f}", ha="center", fontsize=8.5, color=C_MOVIE)
ax.set_ylim(80, 115)
ax.set_xlabel("上架年份")
ax.set_ylabel("电影时长中位数（分钟）")
ax.set_title("(b) 当年上架电影的中位时长", fontsize=10.5, loc="left")
ax.grid(axis="y", color="#EEEEEE")
fig.suptitle("图3  2015–2020 年上架结构变化", fontsize=12, x=.01, ha="left")
savefig(fig, "fig3_structure_trend.png")

# 图4 国家 Top12（多标签全计数）
top_c = ctry.head(12).iloc[::-1]
fig, ax = plt.subplots(figsize=(8.4, 4.6))
yy = np.arange(len(top_c))
ax.barh(yy, top_c["电影"], color=C_MOVIE, label="电影", height=.7)
ax.barh(yy, top_c["剧集"], left=top_c["电影"], color=C_TV, label="剧集", height=.7)
for i, (idx, r) in enumerate(top_c.iterrows()):
    ax.text(r["合计"] + 40, i, f"{int(r['合计']):,}（剧集 {r['剧集占比']:.0%}）",
            va="center", fontsize=8)
ax.set_yticks(yy)
ax.set_yticklabels(top_c.index)
ax.set_xlim(0, top_c["合计"].max() * 1.32)
ax.set_xlabel("含该国家/地区标签的作品数（多标签全计数）")
ax.legend(frameon=False, loc="lower right")
ax.set_title("图4  制作国家/地区 Top 12 及类型构成", fontsize=12, loc="left")
savefig(fig, "fig4_top_countries.png")

# 图5 题材 Top12（电影/剧集分开）
fig, axes = plt.subplots(1, 2, figsize=(10.4, 4.6))
ax = axes[0]
t = g_movie.head(12).iloc[::-1]
ax.barh(t.index, t.values, color=C_MOVIE, height=.68)
for i, v in enumerate(t.values):
    ax.text(v + 25, i, f"{v:,}", va="center", fontsize=8)
ax.set_xlim(0, t.max() * 1.2)
ax.set_title(f"(a) 电影题材 Top 12（n={M['n_movie']:,}）", fontsize=10.5, loc="left")
ax.set_xlabel("全计数：含该题材标签的电影数")

ax = axes[1]
t = g_tv.head(12).iloc[::-1]
ax.barh(t.index, t.values, color=C_TV, height=.68)
for i, v in enumerate(t.values):
    ax.text(v + 15, i, f"{v:,}", va="center", fontsize=8)
ax.set_xlim(0, t.max() * 1.22)
ax.set_title(f"(b) 剧集题材 Top 12（n={M['n_tv']:,}）", fontsize=10.5, loc="left")
ax.set_xlabel("全计数：含该题材标签的剧集数")
fig.suptitle("图5  题材结构：电影偏“国际/剧情/喜剧”，剧集偏“国际剧/剧情/喜剧”", fontsize=12, x=.01, ha="left")
savefig(fig, "fig5_genres.png")

# 图6 分级结构
fig, axes = plt.subplots(1, 2, figsize=(10.4, 4.0), gridspec_kw={"width_ratios": [1.25, 1]})
ax = axes[0]
top_r = rating.head(10).iloc[::-1]
yy = np.arange(len(top_r))
ax.barh(yy, top_r["电影"], color=C_MOVIE, label="电影", height=.7)
ax.barh(yy, top_r["剧集"], left=top_r["电影"], color=C_TV, label="剧集", height=.7)
for i, (idx, r) in enumerate(top_r.iterrows()):
    ax.text(r["合计"] + 25, i, f"{int(r['合计']):,}", va="center", fontsize=8)
ax.set_yticks(yy)
ax.set_yticklabels(top_r.index)
ax.set_xlim(0, top_r["合计"].max() * 1.18)
ax.set_xlabel("作品数")
ax.legend(frameon=False, loc="lower right")
ax.set_title("(a) 主要分级标签", fontsize=10.5, loc="left")

ax = axes[1]
tier_pct = tier[["电影占比", "剧集占比"]] * 100
xx = np.arange(len(tier))
w = .38
ax.bar(xx - w / 2, tier_pct["电影占比"], width=w, color=C_MOVIE, label="电影")
ax.bar(xx + w / 2, tier_pct["剧集占比"], width=w, color=C_TV, label="剧集")
for i in range(len(tier)):
    ax.text(xx[i] - w / 2, tier_pct["电影占比"].iloc[i] + .6, f"{tier_pct['电影占比'].iloc[i]:.0f}",
            ha="center", fontsize=8)
    ax.text(xx[i] + w / 2, tier_pct["剧集占比"].iloc[i] + .6, f"{tier_pct['剧集占比'].iloc[i]:.0f}",
            ha="center", fontsize=8)
ax.set_xticks(xx)
ax.set_xticklabels(tier.index, fontsize=9)
ax.set_ylabel("占本类型作品比例（%）")
ax.set_ylim(0, 75)
ax.legend(frameon=False, loc="upper right", fontsize=8.5)
ax.set_title("(b) 分级档位结构（组内百分比）", fontsize=10.5, loc="left")
fig.suptitle("图6  内容分级分布（分级≠用户评分）", fontsize=12, x=.01, ha="left")
savefig(fig, "fig6_ratings.png")

# 图7 电影时长分布
fig, ax = plt.subplots(figsize=(8.4, 4.0))
bins = np.arange(0, 316, 10)
ax.hist(mins, bins=bins, color=C_MOVIE, alpha=.85, edgecolor="white", linewidth=.6)
ax.axvline(M["movie_min_median"], color="#B22222", ls="--", lw=1.4)
ax.text(M["movie_min_median"] + 3, ax.get_ylim()[1] * .92,
        f"中位数 {M['movie_min_median']:.0f} 分钟", color="#B22222", fontsize=9)
ax.set_xlim(0, 300)
ax.set_xlabel("电影时长（分钟）")
ax.set_ylabel("电影数")
ax.set_title(f"图7  电影时长分布（n={M['movie_min_n']:,}，均值 {M['movie_min_mean']:.1f} 分钟）",
             fontsize=12, loc="left")
savefig(fig, "fig7_movie_duration.png")

# 图8 剧集季数分布
fig, ax = plt.subplots(figsize=(8.4, 4.0))
sx = sc["季数"].values
sy = sc["剧集数"].values
ax.bar(sx, sy, color=C_TV, width=.7)
for xv, yv in zip(sx, sy):
    ax.text(xv, yv + 25, f"{int(yv):,}", ha="center", fontsize=7.5, rotation=0)
ax.set_xticks(sx)
ax.set_xlabel("季数")
ax.set_ylabel("剧集数")
ax.set_ylim(0, sy.max() * 1.18)
ax.set_title(f"图8  剧集季数分布（n={M['tv_n']:,}）：单季剧占 {M['tv_one_season_share']:.1%}",
             fontsize=12, loc="left")
savefig(fig, "fig8_tv_seasons.png")

# =========================================================
# 11. 关键交叉表：2016–2020 逐年结构与题材
# =========================================================
win_df = df[df["add_year"].between(2016, 2020)]
year_genre = []
for y, g in win_df.groupby("add_year"):
    vc = pd.Series([x for L in g["genre_list"] for x in L]).value_counts()
    year_genre.append({"上架年份": int(y), "作品数": int(len(g)),
                       "剧集占比": float((g["type"] == "TV Show").mean()),
                       "首位题材": vc.index[0], "首位题材数": int(vc.iloc[0]),
                       "电影中位时长": float(g.loc[g["type"] == "Movie", "minutes"].median()),
                       "剧集中位季数": float(g.loc[g["type"] == "TV Show", "seasons"].median())})
pd.DataFrame(year_genre).to_csv(os.path.join(TAB, "year_2016_2020_profile.csv"), index=False)
M["year_profile"] = year_genre

# 输出 metrics
M["share_of_all_in_2016_2020"] = float(len(win_df) / len(df))
with open(os.path.join(BASE, "metrics.json"), "w", encoding="utf-8") as f:
    json.dump(M, f, ensure_ascii=False, indent=2, default=str)

print("\n=== 关键指标 ===")
for k in ["raw_rows", "unique_id", "n_movie", "n_tv", "pct_movie", "date_min", "date_max",
          "win_total", "win_tv_share", "movie_min_mean", "movie_min_median", "tv_one_season_share",
          "country_known_titles", "multi_country_rows", "multi_genre_rows"]:
    print(k, "=", M[k])
print("\nyear_type\n", year_type)
print("\nctry top10\n", ctry.head(10))
print("\ngenre top12\n", genre.head(12))
print("\ntier\n", tier)
print("\ntv seasons\n", sc.head(6))
