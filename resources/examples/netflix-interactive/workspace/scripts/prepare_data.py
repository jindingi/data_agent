#!/usr/bin/env python3
"""整理 Netflix 数据快照，生成报告所需的 JSON（不修改原始 CSV）。

用法：
    python3 scripts/prepare_data.py

输入：<工作区>/data/netflix_titles.csv
输出：<工作区>/derived/records.json
脚本内的路径均相对脚本自身位置解析，工作区整体移动后仍可运行。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pandas as pd

BASE = Path(__file__).resolve().parent.parent
SRC = BASE / "data" / "netflix_titles.csv"
OUT = BASE / "derived" / "records.json"

# ---------------------------------------------------------------- 标签译名
# 国家/地区：源数据英文写法 -> 报告显示名（仅作地理标签，不涉政治判断）
COUNTRY_ZH = {
    "Afghanistan": "阿富汗", "Albania": "阿尔巴尼亚", "Algeria": "阿尔及利亚",
    "Angola": "安哥拉", "Argentina": "阿根廷", "Armenia": "亚美尼亚",
    "Australia": "澳大利亚", "Austria": "奥地利", "Azerbaijan": "阿塞拜疆",
    "Bahamas": "巴哈马", "Bangladesh": "孟加拉国", "Belarus": "白俄罗斯",
    "Belgium": "比利时", "Bermuda": "百慕大", "Botswana": "博茨瓦纳",
    "Brazil": "巴西", "Bulgaria": "保加利亚", "Burkina Faso": "布基纳法索",
    "Cambodia": "柬埔寨", "Cameroon": "喀麦隆", "Canada": "加拿大",
    "Cayman Islands": "开曼群岛", "Chile": "智利", "China": "中国大陆",
    "Colombia": "哥伦比亚", "Croatia": "克罗地亚", "Cuba": "古巴",
    "Cyprus": "塞浦路斯", "Czech Republic": "捷克", "Denmark": "丹麦",
    "Dominican Republic": "多米尼加", "East Germany": "东德（历史政体）",
    "Ecuador": "厄瓜多尔", "Egypt": "埃及", "Ethiopia": "埃塞俄比亚",
    "Finland": "芬兰", "France": "法国", "Georgia": "格鲁吉亚",
    "Germany": "德国", "Ghana": "加纳", "Greece": "希腊",
    "Guatemala": "危地马拉", "Hong Kong": "中国香港", "Hungary": "匈牙利",
    "Iceland": "冰岛", "India": "印度", "Indonesia": "印度尼西亚",
    "Iran": "伊朗", "Iraq": "伊拉克", "Ireland": "爱尔兰", "Israel": "以色列",
    "Italy": "意大利", "Jamaica": "牙买加", "Japan": "日本", "Jordan": "约旦",
    "Kazakhstan": "哈萨克斯坦", "Kenya": "肯尼亚", "Kuwait": "科威特",
    "Latvia": "拉脱维亚", "Lebanon": "黎巴嫩", "Liechtenstein": "列支敦士登",
    "Lithuania": "立陶宛", "Luxembourg": "卢森堡", "Malawi": "马拉维",
    "Malaysia": "马来西亚", "Malta": "马耳他", "Mauritius": "毛里求斯",
    "Mexico": "墨西哥", "Mongolia": "蒙古", "Montenegro": "黑山",
    "Morocco": "摩洛哥", "Mozambique": "莫桑比克", "Namibia": "纳米比亚",
    "Nepal": "尼泊尔", "Netherlands": "荷兰", "New Zealand": "新西兰",
    "Nicaragua": "尼加拉瓜", "Nigeria": "尼日利亚", "Norway": "挪威",
    "Pakistan": "巴基斯坦", "Palestine": "巴勒斯坦", "Panama": "巴拿马",
    "Paraguay": "巴拉圭", "Peru": "秘鲁", "Philippines": "菲律宾",
    "Poland": "波兰", "Portugal": "葡萄牙", "Puerto Rico": "波多黎各",
    "Qatar": "卡塔尔", "Romania": "罗马尼亚", "Russia": "俄罗斯",
    "Samoa": "萨摩亚", "Saudi Arabia": "沙特阿拉伯", "Senegal": "塞内加尔",
    "Serbia": "塞尔维亚", "Singapore": "新加坡", "Slovakia": "斯洛伐克",
    "Slovenia": "斯洛文尼亚", "Somalia": "索马里", "South Africa": "南非",
    "South Korea": "韩国", "Soviet Union": "苏联（历史政体）", "Spain": "西班牙",
    "Sri Lanka": "斯里兰卡", "Sudan": "苏丹", "Sweden": "瑞典",
    "Switzerland": "瑞士", "Syria": "叙利亚", "Taiwan": "中国台湾",
    "Thailand": "泰国", "Turkey": "土耳其", "Uganda": "乌干达",
    "Ukraine": "乌克兰", "United Arab Emirates": "阿联酋",
    "United Kingdom": "英国", "United States": "美国", "Uruguay": "乌拉圭",
    "Vatican City": "梵蒂冈", "Venezuela": "委内瑞拉", "Vietnam": "越南",
    "West Germany": "西德（历史政体）", "Zimbabwe": "津巴布韦",
}

# 题材：源数据共有 42 个标签，其中 Movies / TV Shows 只是格式标签，按口径排除
GENRE_ZH = {
    "Dramas": "剧情", "Comedies": "喜剧", "International Movies": "国际电影",
    "International TV Shows": "国际剧集", "Documentaries": "纪录片",
    "Action & Adventure": "动作冒险", "TV Dramas": "剧集·剧情",
    "Independent Movies": "独立电影", "Children & Family Movies": "儿童家庭",
    "Romantic Movies": "爱情", "TV Comedies": "剧集·喜剧", "Thrillers": "惊悚",
    "Crime TV Shows": "剧集·罪案", "Kids' TV": "儿童节目", "Docuseries": "剧集·纪实",
    "Music & Musicals": "音乐歌舞", "Romantic TV Shows": "剧集·爱情",
    "Horror Movies": "恐怖", "Stand-Up Comedy": "单口喜剧", "Reality TV": "真人秀",
    "British TV Shows": "英剧", "Sci-Fi & Fantasy": "科幻奇幻",
    "Sports Movies": "体育", "Anime Series": "动画剧集",
    "Spanish-Language TV Shows": "西语剧集", "TV Action & Adventure": "剧集·动作冒险",
    "Korean TV Shows": "韩剧", "Classic Movies": "经典电影",
    "LGBTQ Movies": "LGBTQ 电影", "TV Mysteries": "剧集·悬疑",
    "Science & Nature TV": "科学自然", "TV Sci-Fi & Fantasy": "剧集·科幻奇幻",
    "TV Horror": "剧集·恐怖", "Anime Features": "动画电影", "Cult Movies": "邪典电影",
    "Teen TV Shows": "青春剧集", "Faith & Spirituality": "信仰灵性",
    "TV Thrillers": "剧集·惊悚", "Stand-Up Comedy & Talk Shows": "单口喜剧与脱口秀",
    "Classic & Cult TV": "经典邪典剧集",
}
FORMAT_TAGS = {"Movies", "TV Shows"}  # 格式标签，不计入题材
UNKNOWN = "未标注"


def split_multi(value) -> list[str]:
    """把逗号分隔的多值字段拆成去重后的列表（保持原顺序）。"""
    if value is None or value is pd.NA:
        return []
    try:
        if pd.isna(value):
            return []
    except (TypeError, ValueError):
        pass
    out: list[str] = []
    for part in str(value).split(","):
        item = part.strip()
        if item and item not in out:
            out.append(item)
    return out


def main() -> None:
    raw = pd.read_csv(SRC)
    n_raw = len(raw)

    df = raw.copy()
    # 1) 主键去重（show_id 唯一），保证统计与列表都按唯一 ID 计数
    n_dup = int(df["show_id"].duplicated().sum())
    df = df.drop_duplicates(subset=["show_id"]).reset_index(drop=True)

    # 2) 基础清洗
    for col in ["type", "title", "director", "cast", "country", "rating", "duration", "listed_in"]:
        df[col] = df[col].astype("string").str.strip()
    df["title"] = df["title"].fillna("")

    # 3) 分级 / 时长列错位修正：3 行把时长写进了 rating 列
    swapped = df["rating"].str.fullmatch(r"\d+\s*min", na=False)
    n_rating_swapped = int(swapped.sum())
    df.loc[swapped, "duration"] = df.loc[swapped, "rating"]
    df.loc[swapped, "rating"] = pd.NA

    # 4) 时长解析：电影为分钟，剧集为季数，两套单位分开保存
    minutes = df["duration"].str.extract(r"(\d+)\s*min", expand=False)
    seasons = df["duration"].str.extract(r"(\d+)\s*Season", expand=False)
    is_movie = df["type"].eq("Movie")
    df["minutes"] = pd.to_numeric(minutes, errors="coerce").where(is_movie)
    df["seasons"] = pd.to_numeric(seasons, errors="coerce").where(~is_movie)

    # 5) 上架日期解析（源格式 "September 25, 2021"）
    added = pd.to_datetime(df["date_added"].str.strip(), format="%B %d, %Y", errors="coerce")
    df["added"] = added.dt.strftime("%Y-%m-%d")
    df["added_year"] = added.dt.year

    # 6) 多值字段拆分
    countries = [split_multi(v) for v in df["country"]]
    genres_raw = [split_multi(v) for v in df["listed_in"]]
    genres = [[g for g in row if g not in FORMAT_TAGS] for row in genres_raw]
    n_format_only = sum(1 for row in genres if not row)
    country_unknown = sum(1 for row in countries if not row)

    country_names = sorted({c for row in countries for c in row})
    genre_names = sorted({g for row in genres for g in row})
    unmapped_country = [c for c in country_names if c not in COUNTRY_ZH]
    unmapped_genre = [g for g in genre_names if g not in GENRE_ZH]
    if unmapped_country or unmapped_genre:
        raise SystemExit(f"缺少译名: {unmapped_country} {unmapped_genre}")

    country_idx = {c: i for i, c in enumerate(country_names)}
    genre_idx = {g: i for i, g in enumerate(genre_names)}
    rating_names = sorted(df["rating"].dropna().unique().tolist())
    rating_idx = {r: i for i, r in enumerate(rating_names)}

    def int_or_none(v):
        return None if pd.isna(v) else int(v)

    records = {
        "id": df["show_id"].tolist(),
        "title": df["title"].tolist(),
        # 0 = 电影，1 = 剧集
        "type": [0 if t == "Movie" else 1 for t in df["type"]],
        "country": [[country_idx[c] for c in row] or [-1] for row in countries],
        "genre": [[genre_idx[g] for g in row] or [-1] for row in genres],
        "ry": [int(v) for v in df["release_year"]],
        "added": [None if pd.isna(v) else v for v in df["added"]],
        "rating": [rating_idx.get(r, -1) for r in df["rating"]],
        "minutes": [int_or_none(v) for v in df["minutes"]],
        "seasons": [int_or_none(v) for v in df["seasons"]],
        "director": [None if pd.isna(v) or v == "" else v for v in df["director"]],
        "cast": [None if pd.isna(v) or v == "" else v for v in df["cast"]],
        "desc": [None if pd.isna(v) else v for v in df["description"]],
    }

    if len(records["id"]) != len(set(records["id"])):
        raise SystemExit("ID 去重失败")

    years = df["release_year"]
    added_years = df["added_year"].dropna()
    meta = {
        "source": {
            "name": "Netflix Movies and TV Shows",
            "author": "shivamb / Kaggle",
            "url": "https://www.kaggle.com/datasets/shivamb/netflix-shows/data",
            "local_file": "data/netflix_titles.csv",
        },
        "snapshot": {
            "raw_rows": n_raw,
            "records": len(df),
            "dup_ids": n_dup,
            "movies": int(is_movie.sum()),
            "tv": int((~is_movie).sum()),
            "release_min": int(years.min()),
            "release_max": int(years.max()),
            "added_min": added.min().strftime("%Y-%m-%d"),
            "added_max": added.max().strftime("%Y-%m-%d"),
            "added_year_min": int(added_years.min()),
            "added_year_max": int(added_years.max()),
        },
        "quality": {
            "country_missing": country_unknown,
            "genre_format_only": n_format_only,
            "added_missing": int(df["added"].isna().sum()),
            "rating_missing": int(df["rating"].isna().sum()),
            "rating_swapped": n_rating_swapped,
            "duration_missing": int((is_movie & df["minutes"].isna()).sum() + (~is_movie & df["seasons"].isna()).sum()),
            "multi_country_rows": int(sum(1 for r in countries if len(r) > 1)),
            "max_countries_row": int(max(len(r) for r in countries)),
            "genre_tags_total": int(sum(len(r) for r in genres)),
            "genre_labels_total": int(len({g for row in genres_raw for g in row})),
            "country_tags_total": int(sum(len(r) for r in countries)),
        },
        "added_year_counts": {
            str(int(k)): int(v) for k, v in df["added_year"].value_counts().sort_index().items()
        },
        "release_year_counts": {
            str(int(k)): int(v) for k, v in years.value_counts().sort_index().items()
        },
        "country_names": [[COUNTRY_ZH[c], c] for c in country_names],
        "genre_names": [[GENRE_ZH[g], g] for g in genre_names],
        "rating_names": rating_names,
        "country_top": sorted(
            ((COUNTRY_ZH[c], sum(1 for row in countries if c in row)) for c in country_names),
            key=lambda kv: -kv[1],
        )[:10],
        "genre_top": sorted(
            ((GENRE_ZH[g], sum(1 for row in genres if g in row)) for g in genre_names),
            key=lambda kv: -kv[1],
        )[:10],
        "notes": [
            "按 show_id 去重；原文件无重复 ID。",
            f"{country_unknown} 条记录未提供制作国家/地区，标为“未标注”，保留为独立类别。",
            f"{n_format_only} 条记录只含 Movies / TV Shows 格式标签，题材标为“未标注”。",
            f"{int(df['added'].isna().sum())} 条记录无上架日期，仅参与发行年份统计。",
            f"{n_rating_swapped} 条记录的时长被误写入分级列，已回填为电影分钟数，分级标为“未标注”。",
            "国家/地区与题材均为多值字段：一部作品涉及 N 个标签即计 N 次（全计数），合计大于作品数。",
        ],
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "meta": meta,
        "records": records,
    }
    text = json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    OUT.write_text(text, encoding="utf-8")
    print(f"写入 {OUT.relative_to(BASE)}：{len(df)} 条记录，{len(text)/1024/1024:.2f} MB")
    print(json.dumps(meta["snapshot"], ensure_ascii=False))
    print(json.dumps(meta["quality"], ensure_ascii=False))


if __name__ == "__main__":
    main()
