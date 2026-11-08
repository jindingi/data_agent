/* Netflix 内容探索 · 离线交互逻辑
 * 数据来自页面内嵌的 JSON 快照（prepare_data.py 生成），不发起任何网络请求。
 */
(function () {
  'use strict';

  var DATA = JSON.parse(document.getElementById('app-data').textContent);
  var META = DATA.meta;
  var RD = DATA.records;
  var COUNTRY = META.country_names;   // [[中文名, 英文原文], ...]
  var GENRE = META.genre_names;
  var RATING = META.rating_names;
  var UNK = -1;
  var Y_MIN = META.snapshot.release_min;
  var Y_MAX = META.snapshot.release_max;
  var AY_MIN = META.snapshot.added_year_min;
  var AY_MAX = META.snapshot.added_year_max;
  var MOVIE_COLOR = '#2a6f97';
  var TV_COLOR = '#e07a5f';
  var UNK_COLOR = '#9aa7b4';
  var REST_COLOR = '#b8c6d3';
  var PARTIAL_COLOR = '#c98b3f';
  var nf = new Intl.NumberFormat('zh-CN');

  /* ---------------------------------------------------------------- 记录 */
  var recs = new Array(RD.id.length);
  for (var i = 0; i < RD.id.length; i++) {
    recs[i] = {
      i: i,
      id: RD.id[i],
      title: RD.title[i],
      type: RD.type[i],
      country: RD.country[i],
      genre: RD.genre[i],
      ry: RD.ry[i],
      added: RD.added[i],
      rating: RD.rating[i],
      minutes: RD.minutes[i],
      seasons: RD.seasons[i],
      director: RD.director[i],
      cast: RD.cast[i],
      desc: RD.desc[i],
      lower: RD.title[i].toLowerCase()
    };
  }

  var state = {
    type: 'all',
    country: 'all',
    genre: 'all',
    y0: Y_MIN,
    y1: Y_MAX,
    q: '',
    sort: 'ryDesc',
    page: 1,
    pageSize: 20,
    selected: null
  };

  /* ---------------------------------------------------------------- 工具 */
  function fmt(n) { return nf.format(n); }
  function pct(n, d) { return d ? (n / d * 100) : 0; }
  function pctText(n, d) { return d ? (n / d * 100).toFixed(1) + '%' : '—'; }
  function median(arr) {
    if (!arr.length) return null;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function byId(id) { return document.getElementById(id); }
  function text(id, v) { var el = byId(id); if (el) el.textContent = v; }

  /* ------------------------------------------------------------ 过滤逻辑 */
  function computeFiltered() {
    var q = state.q.trim().toLowerCase();
    var out = [];
    for (var k = 0; k < recs.length; k++) {
      var r = recs[k];
      if (state.type === 'movie' && r.type !== 0) continue;
      if (state.type === 'tv' && r.type !== 1) continue;
      if (state.country !== 'all' && r.country.indexOf(state.country) === -1) continue;
      if (state.genre !== 'all' && r.genre.indexOf(state.genre) === -1) continue;
      if (r.ry < state.y0 || r.ry > state.y1) continue;
      if (q && r.lower.indexOf(q) === -1) continue;
      out.push(r);
    }
    return out;
  }

  var SORTS = {
    ryDesc: function (a, b) { return b.ry - a.ry || a.i - b.i; },
    ryAsc: function (a, b) { return a.ry - b.ry || a.i - b.i; },
    title: function (a, b) { return a.lower.localeCompare(b.lower, 'en') || a.i - b.i; },
    id: function (a, b) { return a.i - b.i; }
  };

  /* -------------------------------------------------------------- 聚合 */
  var MIN_BINS = [
    { label: '<60', test: function (m) { return m < 60; } },
    { label: '60–79', test: function (m) { return m >= 60 && m < 80; } },
    { label: '80–89', test: function (m) { return m >= 80 && m < 90; } },
    { label: '90–99', test: function (m) { return m >= 90 && m < 100; } },
    { label: '100–109', test: function (m) { return m >= 100 && m < 110; } },
    { label: '110–119', test: function (m) { return m >= 110 && m < 120; } },
    { label: '120–149', test: function (m) { return m >= 120 && m < 150; } },
    { label: '≥150', test: function (m) { return m >= 150; } }
  ];

  function aggregate(rows) {
    var a = {
      n: rows.length, movies: 0, tv: 0,
      cc: new Map(), gc: new Map(), rc: new Map(),
      ryM: new Map(), ryT: new Map(), added: new Map(),
      countryTags: 0, genreTags: 0,
      noCountry: 0, noGenre: 0, noRating: 0, noAdded: 0,
      minutes: [], seasons: [], minBins: MIN_BINS.map(function () { return 0; }),
      seasonBins: 0
    };
    var seasonCounts = new Map();
    for (var k = 0; k < rows.length; k++) {
      var r = rows[k];
      if (r.type === 0) a.movies++; else a.tv++;
      for (var c = 0; c < r.country.length; c++) {
        var ci = r.country[c];
        a.cc.set(ci, (a.cc.get(ci) || 0) + 1);
        if (ci === UNK) a.noCountry++; else a.countryTags++;
      }
      for (var g = 0; g < r.genre.length; g++) {
        var gi = r.genre[g];
        a.gc.set(gi, (a.gc.get(gi) || 0) + 1);
        if (gi === UNK) a.noGenre++; else a.genreTags++;
      }
      a.rc.set(r.rating, (a.rc.get(r.rating) || 0) + 1);
      if (r.rating === UNK) a.noRating++;
      if (r.type === 0) a.ryM.set(r.ry, (a.ryM.get(r.ry) || 0) + 1);
      else a.ryT.set(r.ry, (a.ryT.get(r.ry) || 0) + 1);
      if (r.added) a.added.set(r.added.slice(0, 4), (a.added.get(r.added.slice(0, 4)) || 0) + 1);
      else a.noAdded++;
      if (r.type === 0) {
        if (r.minutes != null) {
          a.minutes.push(r.minutes);
          for (var b = 0; b < MIN_BINS.length; b++) {
            if (MIN_BINS[b].test(r.minutes)) { a.minBins[b]++; break; }
          }
        }
      } else if (r.seasons != null) {
        a.seasons.push(r.seasons);
        seasonCounts.set(r.seasons, (seasonCounts.get(r.seasons) || 0) + 1);
      }
    }
    a.seasonCounts = seasonCounts;
    return a;
  }

  /* ------------------------------------------------------------- 图表 */
  var charts = {};
  function chart(id) {
    if (charts[id]) return charts[id];
    var el = byId(id);
    if (!el) return null;
    var c = echarts.init(el, null, { renderer: 'canvas' });
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(function () { c.resize(); });
      ro.observe(el);
      el._ro = ro;
    }
    charts[id] = c;
    return c;
  }

  var BASE_GRID = { left: 10, right: 18, top: 22, bottom: 8, containLabel: true };
  var AXIS_STYLE = {
    axisLine: { lineStyle: { color: '#dbe3eb' } },
    axisTick: { show: false },
    axisLabel: { color: '#5d6b7a', fontSize: 11 },
    splitLine: { lineStyle: { color: '#eef2f6' } }
  };
  var TIP_STYLE = {
    backgroundColor: 'rgba(255,255,255,.98)',
    borderColor: '#dbe3eb',
    textStyle: { color: '#1b2430', fontSize: 12, lineHeight: 18 },
    extraCssText: 'box-shadow:0 6px 20px rgba(20,35,50,.14);border-radius:8px;'
  };

  function emptyOption(msg) {
    return {
      title: {
        text: '无匹配数据',
        subtext: msg || '请调整筛选条件',
        left: 'center',
        top: '38%',
        textStyle: { fontSize: 14, fontWeight: 'normal', color: '#5d6b7a' },
        subtextStyle: { fontSize: 12, color: '#8a97a4' }
      }
    };
  }

  function hbar(id, rows, a, onClick) {
    var c = chart(id);
    if (!c) return;
    if (!a.n || !rows.length) { c.setOption(emptyOption(), true); return; }
    var data = rows.slice().reverse(); // 由下至上绘制，使最大值在顶部
    var opt = {
      animationDuration: 240,
      grid: { left: 10, right: 56, top: 10, bottom: 10, containLabel: true },
      tooltip: Object.assign({}, TIP_STYLE, {
        trigger: 'item',
        renderMode: 'richText',
        formatter: function (p) {
          var d = p.data;
          var lines = [d.name];
          lines.push('出现次数：' + fmt(d.value) + ' 次');
          lines.push('占当前筛选作品：' + pctText(d.value, a.n) + '（分母 ' + fmt(a.n) + ' 部）');
          if (d.en && d.en !== d.name) lines.push('源字段：' + d.en);
          lines.push('多标签作品重复计入，合计可大于作品数');
          return lines.join('\n');
        }
      }),
      xAxis: Object.assign({}, AXIS_STYLE, { type: 'value', splitLine: { show: false } }),
      yAxis: Object.assign({}, AXIS_STYLE, {
        type: 'category',
        data: data.map(function (d) { return d.name; }),
        splitLine: { show: false },
        axisLabel: { color: '#33414f', fontSize: 12 }
      }),
      series: [{
        type: 'bar',
        barMaxWidth: 18,
        emphasis: { itemStyle: { opacity: .85 } },
        label: { show: true, position: 'right', color: '#5d6b7a', fontSize: 11, formatter: function (p) { return fmt(p.value); } },
        data: data.map(function (d) {
          var item = { name: d.name, value: d.value, idx: d.idx, en: d.en };
          if (d.idx === UNK) item.itemStyle = { color: UNK_COLOR };
          else if (d.idx == null) item.itemStyle = { color: REST_COLOR };
          else item.itemStyle = { color: MOVIE_COLOR };
          return item;
        })
      }]
    };
    c.setOption(opt, true);
    c.off('click');
    if (onClick) {
      c.on('click', function (p) {
        if (p.data && p.data.idx != null) onClick(p.data.idx);
      });
      c.getZr().setCursorStyle('pointer');
    }
  }

  function renderTypeChart(a) {
    var id = 'c-type';
    var c = chart(id);
    if (!c) return;
    if (!a.n) { c.setOption(emptyOption(), true); return; }
    var opt = {
      animationDuration: 240,
      tooltip: Object.assign({}, TIP_STYLE, {
        trigger: 'item',
        renderMode: 'richText',
        formatter: function (p) {
          return p.name + '\n' + fmt(p.value) + ' 部\n占当前筛选作品：' + pctText(p.value, a.n);
        }
      }),
      legend: { bottom: 0, icon: 'circle', itemWidth: 9, itemHeight: 9, textStyle: { color: '#5d6b7a', fontSize: 12 } },
      title: {
        text: fmt(a.n) + ' 部',
        subtext: a.n ? pctText(a.movies, a.n) + ' 电影' : '',
        left: 'center', top: '34%',
        textAlign: 'center',
        textStyle: { fontSize: 20, fontWeight: 600, color: '#1b2430' },
        subtextStyle: { fontSize: 11.5, color: '#5d6b7a' }
      },
      series: [{
        type: 'pie',
        radius: ['46%', '68%'],
        center: ['50%', '45%'],
        itemStyle: { borderColor: '#fff', borderWidth: 2 },
        label: { formatter: '{b}\n{d}%', color: '#33414f', fontSize: 11.5, lineHeight: 16 },
        labelLine: { length: 8, length2: 6 },
        data: [
          { name: '电影', value: a.movies, itemStyle: { color: MOVIE_COLOR } },
          { name: '剧集', value: a.tv, itemStyle: { color: TV_COLOR } }
        ].filter(function (d) { return d.value > 0; })
      }]
    };
    c.setOption(opt, true);
    c.off('click');
    c.on('click', function (p) {
      setType(p.name === '电影' ? 'movie' : 'tv');
    });
  }

  function renderRatingChart(a) {
    var c = chart('c-rating');
    if (!c) return;
    if (!a.n) { c.setOption(emptyOption(), true); return; }
    var rows = Array.from(a.rc.entries()).map(function (kv) {
      return { name: kv[0] === UNK ? '未标注' : RATING[kv[0]], value: kv[1], idx: kv[0] };
    });
    rows.sort(function (x, y) { return y.value - x.value; });
    var opt = {
      animationDuration: 240,
      grid: { left: 10, right: 16, top: 18, bottom: 8, containLabel: true },
      tooltip: Object.assign({}, TIP_STYLE, {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        renderMode: 'richText',
        formatter: function (ps) {
          var p = ps[0];
          return p.name + '\n' + fmt(p.value) + ' 部\n占当前筛选作品：' + pctText(p.value, a.n) + '（内容分级，不是用户评分）';
        }
      }),
      xAxis: Object.assign({}, AXIS_STYLE, {
        type: 'category',
        data: rows.map(function (r) { return r.name; }),
        axisLabel: { color: '#5d6b7a', fontSize: 11, interval: 0, rotate: rows.length > 8 ? 40 : 0 }
      }),
      yAxis: Object.assign({}, AXIS_STYLE, { type: 'value' }),
      series: [{
        type: 'bar',
        barMaxWidth: 26,
        data: rows.map(function (r) {
          return {
            value: r.value,
            itemStyle: { color: r.idx === UNK ? UNK_COLOR : '#4f8bab' }
          };
        }),
        label: { show: true, position: 'top', color: '#5d6b7a', fontSize: 10.5, formatter: function (p) { return fmt(p.value); } }
      }]
    };
    c.setOption(opt, true);
  }

  function renderYearChart(a) {
    var c = chart('c-year');
    if (!c) return;
    if (!a.n) { c.setOption(emptyOption(), true); return; }
    var cats = [];
    var mv = [];
    var tv = [];
    for (var y = Y_MIN; y <= Y_MAX; y++) {
      cats.push(String(y));
      mv.push(a.ryM.get(y) || 0);
      tv.push(a.ryT.get(y) || 0);
    }
    var opt = {
      animationDuration: 240,
      legend: { top: 0, right: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 10, textStyle: { color: '#5d6b7a', fontSize: 12 } },
      grid: { left: 10, right: 16, top: 34, bottom: 6, containLabel: true },
      tooltip: Object.assign({}, TIP_STYLE, {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        renderMode: 'richText',
        formatter: function (ps) {
          var total = 0;
          var lines = [ps[0].axisValue + ' 年发行'];
          ps.forEach(function (p) { total += p.value; lines.push(p.marker + p.seriesName + '：' + fmt(p.value) + ' 部'); });
          lines.push('合计：' + fmt(total) + ' 部（占当前筛选 ' + pctText(total, a.n) + '）');
          return lines.join('\n');
        }
      }),
      xAxis: Object.assign({}, AXIS_STYLE, {
        type: 'category',
        data: cats,
        axisLabel: { color: '#5d6b7a', fontSize: 11, interval: function (idx, v) { return Number(v) % 10 === 0; } }
      }),
      yAxis: Object.assign({}, AXIS_STYLE, { type: 'value' }),
      series: [
        { name: '电影', type: 'bar', stack: 'all', data: mv, itemStyle: { color: MOVIE_COLOR }, barMaxWidth: 14 },
        { name: '剧集', type: 'bar', stack: 'all', data: tv, itemStyle: { color: TV_COLOR }, barMaxWidth: 14 }
      ]
    };
    c.setOption(opt, true);
    c.off('click');
    c.on('click', function (p) {
      var yv = Number(p.name);
      if (!isNaN(yv)) setYearRange(yv, yv);
    });
    c.getZr().setCursorStyle('pointer');
  }

  function renderAddedChart(a) {
    var c = chart('c-added');
    if (!c) return;
    if (!a.n) { c.setOption(emptyOption(), true); return; }
    var cats = [];
    var full = [];
    var partial = [];
    for (var y = AY_MIN; y <= AY_MAX; y++) {
      cats.push(String(y));
      var v = a.added.get(String(y)) || 0;
      if (y === AY_MAX) { full.push(null); partial.push(v); }
      else { full.push(v); partial.push(null); }
    }
    var opt = {
      animationDuration: 240,
      legend: { top: 0, right: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 10, textStyle: { color: '#5d6b7a', fontSize: 12 } },
      grid: { left: 10, right: 16, top: 34, bottom: 6, containLabel: true },
      tooltip: Object.assign({}, TIP_STYLE, {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        renderMode: 'richText',
        formatter: function (ps) {
          var p = ps.filter(function (x) { return x.value != null; })[0];
          if (!p) return ps[0].axisValue + ' 年：无上架记录';
          var lines = [p.axisValue + ' 年上架'];
          lines.push(fmt(p.value) + ' 条记录（占当前筛选 ' + pctText(p.value, a.n) + '）');
          if (p.axisValue === String(AY_MAX)) lines.push('该年度截至 ' + META.snapshot.added_max + '，不完整');
          lines.push('仅为新增上架记录，数据无下架信息');
          return lines.join('\n');
        }
      }),
      xAxis: Object.assign({}, AXIS_STYLE, {
        type: 'category',
        data: cats,
        axisLabel: { color: '#5d6b7a', fontSize: 11 }
      }),
      yAxis: Object.assign({}, AXIS_STYLE, { type: 'value' }),
      series: [
        {
          name: '完整年度新增上架',
          type: 'bar',
          data: full,
          itemStyle: { color: MOVIE_COLOR },
          barMaxWidth: 26,
          label: { show: true, position: 'top', color: '#5d6b7a', fontSize: 10, formatter: function (p) { return p.value ? fmt(p.value) : ''; } }
        },
        {
          name: AY_MAX + '（截至 ' + META.snapshot.added_max.slice(5) + '，不完整）',
          type: 'bar',
          data: partial,
          itemStyle: { color: PARTIAL_COLOR },
          barMaxWidth: 26,
          label: { show: true, position: 'top', color: '#a3611b', fontSize: 10, formatter: function (p) { return p.value ? fmt(p.value) : ''; } }
        }
      ]
    };
    c.setOption(opt, true);
  }

  function renderRuntimeChart(a) {
    var c = chart('c-runtime');
    if (!c) return;
    if (!a.movies) { c.setOption(emptyOption('当前筛选没有电影记录'), true); return; }
    var opt = {
      animationDuration: 240,
      grid: { left: 10, right: 16, top: 22, bottom: 6, containLabel: true },
      tooltip: Object.assign({}, TIP_STYLE, {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        renderMode: 'richText',
        formatter: function (ps) {
          var p = ps[0];
          return p.name + ' 分钟\n' + fmt(p.value) + ' 部电影（占当前电影 ' + pctText(p.value, a.movies) + '）';
        }
      }),
      xAxis: Object.assign({}, AXIS_STYLE, {
        type: 'category',
        data: MIN_BINS.map(function (b) { return b.label; }),
        axisLabel: { color: '#5d6b7a', fontSize: 11, interval: 0, rotate: a.minBins.length > 8 ? 0 : 0 },
        name: '分钟',
        nameTextStyle: { color: '#8a97a4', fontSize: 11 }
      }),
      yAxis: Object.assign({}, AXIS_STYLE, { type: 'value' }),
      series: [{
        type: 'bar',
        data: a.minBins,
        itemStyle: { color: MOVIE_COLOR },
        barMaxWidth: 34,
        label: { show: true, position: 'top', color: '#5d6b7a', fontSize: 10.5, formatter: function (p) { return p.value ? fmt(p.value) : ''; } }
      }]
    };
    c.setOption(opt, true);
  }

  function renderSeasonsChart(a) {
    var c = chart('c-seasons');
    if (!c) return;
    if (!a.tv) { c.setOption(emptyOption('当前筛选没有剧集记录'), true); return; }
    var maxSeason = 0;
    a.seasonCounts.forEach(function (v, k) { if (k > maxSeason) maxSeason = k; });
    var labels = [];
    var vals = [];
    for (var s = 1; s <= 8; s++) {
      labels.push(s + ' 季');
      vals.push(a.seasonCounts.get(s) || 0);
    }
    var rest = 0;
    a.seasonCounts.forEach(function (v, k) { if (k > 8) rest += v; });
    if (rest > 0 || maxSeason > 8) { labels.push('9 季及以上'); vals.push(rest); }
    var opt = {
      animationDuration: 240,
      grid: { left: 10, right: 16, top: 22, bottom: 6, containLabel: true },
      tooltip: Object.assign({}, TIP_STYLE, {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        renderMode: 'richText',
        formatter: function (ps) {
          var p = ps[0];
          return p.name + '\n' + fmt(p.value) + ' 部剧集（占当前剧集 ' + pctText(p.value, a.tv) + '）';
        }
      }),
      xAxis: Object.assign({}, AXIS_STYLE, {
        type: 'category',
        data: labels,
        axisLabel: { color: '#5d6b7a', fontSize: 11, interval: 0 }
      }),
      yAxis: Object.assign({}, AXIS_STYLE, { type: 'value' }),
      series: [{
        type: 'bar',
        data: vals,
        itemStyle: { color: TV_COLOR },
        barMaxWidth: 34,
        label: { show: true, position: 'top', color: '#5d6b7a', fontSize: 10.5, formatter: function (p) { return p.value ? fmt(p.value) : ''; } }
      }]
    };
    c.setOption(opt, true);
  }

  /* -------------------------------------------------------------- KPI */
  function renderKpis(a) {
    text('k-total', fmt(a.n));
    text('k-total-sub', a.n ? '占全库 ' + fmt(recs.length) + ' 部的 ' + pctText(a.n, recs.length) : '当前条件下没有作品');

    var mp = pct(a.movies, a.n);
    text('k-type-movie', a.n ? '电影 ' + mp.toFixed(1) + '%' : '—');
    text('k-type-sub', a.n
      ? '电影 ' + fmt(a.movies) + ' 部 · 剧集 ' + fmt(a.tv) + ' 部（剧集 ' + pct(a.tv, a.n).toFixed(1) + '%）'
      : '—');
    byId('k-bar-m').style.width = (a.n ? mp : 0) + '%';
    byId('k-bar-t').style.width = (a.n ? pct(a.tv, a.n) : 0) + '%';

    text('k-country', fmt(a.countryTags) + ' 次');
    text('k-country-sub', a.n
      ? '覆盖 ' + (a.cc.size - (a.cc.has(UNK) ? 1 : 0)) + ' 个国家/地区 · 未标注 ' + fmt(a.noCountry) + ' 部 · 平均每部 ' + (a.countryTags / a.n).toFixed(2) + ' 个'
      : '—');

    text('k-genre', fmt(a.genreTags) + ' 次');
    text('k-genre-sub', a.n
      ? '覆盖 ' + (a.gc.size - (a.gc.has(UNK) ? 1 : 0)) + ' 个题材 · 未标注 ' + fmt(a.noGenre) + ' 部 · 平均每部 ' + (a.genreTags / a.n).toFixed(2) + ' 个'
      : '—');

    var mm = median(a.minutes);
    var sm = median(a.seasons);
    text('k-duration', mm != null ? fmt(mm) + ' 分钟' : '—');
    text('k-duration-sub', '电影时长中位数 ' + (mm != null ? fmt(mm) + ' 分钟' : '—') +
      ' · 剧集季数中位数 ' + (sm != null ? fmt(sm) + ' 季' : '—') +
      '（样本 ' + fmt(a.minutes.length) + ' 部电影 / ' + fmt(a.seasons.length) + ' 部剧集）');
  }

  /* ----------------------------------------------------------- 筛选栏 */
  function fillSelects() {
    var overall = aggregate(recs);
    var cSel = byId('f-country');
    var gSel = byId('f-genre');
    var cCounts = Array.from(overall.cc.entries());
    cCounts.sort(function (x, y) { return y[1] - x[1]; });
    var cFrag = document.createDocumentFragment();
    var oAll = document.createElement('option');
    oAll.value = 'all'; oAll.textContent = '全部国家/地区（' + fmt(recs.length) + ' 部）';
    cFrag.appendChild(oAll);
    cCounts.forEach(function (kv) {
      var opt = document.createElement('option');
      opt.value = String(kv[0]);
      opt.textContent = (kv[0] === UNK ? '未标注（缺失）' : COUNTRY[kv[0]][0]) + '（' + fmt(kv[1]) + ' 部）';
      cFrag.appendChild(opt);
    });
    cSel.replaceChildren(cFrag);

    var gCounts = Array.from(overall.gc.entries());
    gCounts.sort(function (x, y) { return y[1] - x[1]; });
    var gFrag = document.createDocumentFragment();
    var gAll = document.createElement('option');
    gAll.value = 'all'; gAll.textContent = '全部题材（' + fmt(recs.length) + ' 部）';
    gFrag.appendChild(gAll);
    gCounts.forEach(function (kv) {
      var opt = document.createElement('option');
      opt.value = String(kv[0]);
      opt.textContent = (kv[0] === UNK ? '未标注（缺失）' : GENRE[kv[0]][0]) + '（' + fmt(kv[1]) + ' 部）';
      gFrag.appendChild(opt);
    });
    gSel.replaceChildren(gFrag);

    var y0 = byId('f-year-min');
    var y1 = byId('f-year-max');
    [y0, y1].forEach(function (el) {
      el.min = String(Y_MIN);
      el.max = String(Y_MAX);
      el.step = '1';
    });
    y0.value = String(state.y0);
    y1.value = String(state.y1);
  }

  function updateYearLabels() {
    text('year-min-label', state.y0 + ' 年');
    text('year-max-label', state.y1 + ' 年');
  }

  function summaryText(a) {
    var parts = [];
    if (state.type !== 'all') parts.push(state.type === 'movie' ? '类型：电影' : '类型：剧集');
    if (state.country !== 'all') parts.push('国家/地区：' + (state.country === UNK ? '未标注' : COUNTRY[state.country][0]));
    if (state.genre !== 'all') parts.push('题材：' + (state.genre === UNK ? '未标注' : GENRE[state.genre][0]));
    if (state.y0 !== Y_MIN || state.y1 !== Y_MAX) parts.push('发行年份：' + state.y0 + '–' + state.y1);
    if (state.q.trim()) parts.push('片名含“' + state.q.trim() + '”');
    return parts.length
      ? '当前筛选：' + parts.join(' · ') + ' ｜ 命中 ' + fmt(a.n) + ' 部作品'
      : '当前未筛选：全库 ' + fmt(a.n) + ' 部作品（按 show_id 去重）';
  }

  /* ----------------------------------------------------------- 结果表 */
  function countryLabel(r) {
    if (r.country.length === 1 && r.country[0] === UNK) return '未标注';
    var names = r.country.filter(function (c) { return c !== UNK; }).map(function (c) { return COUNTRY[c][0]; });
    return names.join('、');
  }
  function genreLabel(r) {
    if (r.genre.length === 1 && r.genre[0] === UNK) return '未标注';
    return r.genre.filter(function (g) { return g !== UNK; }).map(function (g) { return GENRE[g][0]; }).join('、');
  }
  function truncate(str, max) {
    if (str.length <= max) return str;
    var cut = str.slice(0, max);
    var idx = cut.lastIndexOf('、');
    if (idx > max * 0.5) cut = cut.slice(0, idx);
    return cut + '…';
  }
  function durationLabel(r) {
    if (r.type === 0) return r.minutes != null ? fmt(r.minutes) + ' 分钟' : '时长未标注';
    return r.seasons != null ? fmt(r.seasons) + ' 季' : '季数未标注';
  }
  function ratingLabel(r) { return r.rating === UNK ? '未标注' : RATING[r.rating]; }

  function renderTable(rows) {
    var tbody = byId('tbody');
    var total = rows.length;
    var pages = Math.max(1, Math.ceil(total / state.pageSize));
    if (state.page > pages) state.page = pages;
    if (state.page < 1) state.page = 1;
    var start = (state.page - 1) * state.pageSize;
    var pageRows = rows.slice(start, start + state.pageSize);

    var frag = document.createDocumentFragment();
    pageRows.forEach(function (r) {
      var tr = document.createElement('tr');
      tr.tabIndex = 0;
      tr.dataset.id = r.id;
      if (state.selected === r.i) tr.classList.add('selected');

      var tdTitle = document.createElement('td');
      tdTitle.className = 'title-cell';
      tdTitle.textContent = r.title;
      var sub = document.createElement('span');
      sub.className = 'sub';
      sub.textContent = r.id;
      tdTitle.appendChild(document.createElement('br'));
      tdTitle.appendChild(sub);
      tr.appendChild(tdTitle);

      var tdType = document.createElement('td');
      var badge = document.createElement('span');
      badge.className = 'badge ' + (r.type === 0 ? 'm' : 't');
      badge.textContent = r.type === 0 ? '电影' : '剧集';
      tdType.appendChild(badge);
      tr.appendChild(tdType);

      var tdC = document.createElement('td');
      tdC.className = 'hide-sm';
      var spanC = document.createElement('span');
      spanC.className = 'trunc';
      var fullC = countryLabel(r);
      spanC.textContent = truncate(fullC, 18);
      spanC.title = fullC;
      tdC.appendChild(spanC);
      tr.appendChild(tdC);

      var tdG = document.createElement('td');
      var spanG = document.createElement('span');
      spanG.className = 'trunc';
      var fullG = genreLabel(r);
      spanG.textContent = truncate(fullG, 22);
      spanG.title = fullG;
      tdG.appendChild(spanG);
      tr.appendChild(tdG);

      var tdY = document.createElement('td');
      tdY.className = 'num';
      tdY.textContent = String(r.ry);
      tr.appendChild(tdY);

      var tdA = document.createElement('td');
      tdA.className = 'num hide-sm';
      tdA.textContent = r.added || '未提供';
      tr.appendChild(tdA);

      var tdR = document.createElement('td');
      tdR.className = 'hide-sm';
      if (r.rating === UNK) {
        var ub = document.createElement('span');
        ub.className = 'badge unk';
        ub.textContent = '未标注';
        tdR.appendChild(ub);
      } else {
        tdR.textContent = RATING[r.rating];
      }
      tr.appendChild(tdR);

      var tdD = document.createElement('td');
      tdD.className = 'num';
      tdD.textContent = durationLabel(r);
      tr.appendChild(tdD);

      tr.addEventListener('click', function () { showDetail(r); });
      tr.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); showDetail(r); }
      });
      frag.appendChild(tr);
    });
    tbody.replaceChildren(frag);

    var info = byId('pager-info');
    if (!total) {
      info.textContent = '共 0 部作品';
    } else {
      info.textContent = '共 ' + fmt(total) + ' 部作品 · 第 ' + state.page + ' / ' + pages + ' 页 · 本页显示 ' +
        fmt(pageRows.length) + ' 条（按 show_id 去重）';
    }
    renderPager(pages);
  }

  function renderPager(pages) {
    var box = byId('pager-controls');
    var frag = document.createDocumentFragment();
    function mk(label, page, opts) {
      opts = opts || {};
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn small';
      b.textContent = label;
      if (opts.current) b.setAttribute('aria-current', 'page');
      if (opts.disabled) b.disabled = true;
      if (opts.aria) b.setAttribute('aria-label', opts.aria);
      if (!opts.disabled && !opts.current) {
        b.addEventListener('click', function () { state.page = page; renderAll(); scrollToList(); });
      }
      frag.appendChild(b);
    }
    if (!pages) { box.replaceChildren(frag); return; }
    mk('« 首页', 1, { disabled: state.page === 1, aria: '第一页' });
    mk('‹ 上一页', state.page - 1, { disabled: state.page === 1 });
    var win = [];
    var from = Math.max(1, state.page - 2);
    var to = Math.min(pages, from + 4);
    from = Math.max(1, to - 4);
    for (var p = from; p <= to; p++) win.push(p);
    if (from > 1) {
      mk('1', 1, { current: state.page === 1 });
      if (from > 2) {
        var gap = document.createElement('span');
        gap.className = 'gap';
        gap.textContent = '…';
        frag.appendChild(gap);
      }
    }
    win.forEach(function (p) { mk(String(p), p, { current: p === state.page }); });
    if (to < pages) {
      if (to < pages - 1) {
        var gap2 = document.createElement('span');
        gap2.className = 'gap';
        gap2.textContent = '…';
        frag.appendChild(gap2);
      }
      mk(String(pages), pages, { current: state.page === pages });
    }
    mk('下一页 ›', state.page + 1, { disabled: state.page === pages });
    mk('末页 »', pages, { disabled: state.page === pages, aria: '最后一页' });
    box.replaceChildren(frag);
  }

  function scrollToList() {
    var el = document.querySelector('.results');
    if (!el) return;
    var top = el.getBoundingClientRect().top + window.scrollY - 90;
    window.scrollTo({ top: top, behavior: 'smooth' });
  }

  /* -------------------------------------------------------------- 详情 */
  function showDetail(r) {
    state.selected = r.i;
    text('d-title', r.title);
    text('d-id', 'show_id：' + r.id);
    var tEl = byId('d-type');
    tEl.textContent = r.type === 0 ? '电影' : '剧集';
    text('d-year', String(r.ry));
    text('d-added', r.added || '未提供上架日期');
    text('d-rating', r.rating === UNK ? '未标注（内容分级，非用户评分）' : RATING[r.rating] + '（内容分级，非用户评分）');
    text('d-duration', durationLabel(r));
    text('d-country', countryLabel(r));
    text('d-genre', genreLabel(r));
    text('d-director', r.director || '未标注');
    text('d-cast', r.cast || '未标注');
    text('d-desc', r.desc || '（源数据未提供剧情简介）');
    var d = byId('detail');
    d.hidden = false;
    d.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    Array.prototype.forEach.call(document.querySelectorAll('#tbody tr'), function (tr) {
      tr.classList.toggle('selected', tr.dataset.id === r.id);
    });
  }

  function hideDetail() {
    state.selected = null;
    byId('detail').hidden = true;
    Array.prototype.forEach.call(document.querySelectorAll('#tbody tr.selected'), function (tr) {
      tr.classList.remove('selected');
    });
  }

  /* ---------------------------------------------------------- 渲染总控 */
  function renderAll() {
    var rows = computeFiltered();
    rows.sort(SORTS[state.sort]);
    var a = aggregate(rows);

    updateYearLabels();
    text('filter-summary', summaryText(a));
    renderKpis(a);
    renderTypeChart(a);
    renderRatingChart(a);
    hbar('c-country', countryRows(a), a, function (idx) { setCountry(idx); });
    hbar('c-genre', genreRows(a), a, function (idx) { setGenre(idx); });
    renderYearChart(a);
    renderAddedChart(a);
    renderRuntimeChart(a);
    renderSeasonsChart(a);

    var empty = rows.length === 0;
    byId('empty').hidden = !empty;
    byId('table-wrap').hidden = empty;
    byId('pager').hidden = empty;
    if (empty) {
      byId('tbody').replaceChildren();
      byId('pager-info').textContent = '共 0 部作品';
      byId('pager-controls').replaceChildren();
      hideDetail();
    } else {
      renderTable(rows);
    }
    var rc = byId('results-count');
    var strong = document.createElement('b');
    strong.textContent = fmt(rows.length) + ' 部';
    rc.textContent = '当前筛选命中 ';
    rc.appendChild(strong);
    rc.appendChild(document.createTextNode(' 作品（按 show_id 去重）'));
  }

  function countryRows(a) {
    var items = Array.from(a.cc.entries()).filter(function (kv) { return kv[0] !== UNK; });
    items.sort(function (x, y) { return y[1] - x[1]; });
    var top = items.slice(0, 12);
    var rest = items.slice(12);
    var rows = top.map(function (kv) {
      return { name: COUNTRY[kv[0]][0], value: kv[1], idx: kv[0], en: COUNTRY[kv[0]][1] };
    });
    if (rest.length) {
      rows.push({
        name: '其他（' + rest.length + ' 个）',
        value: rest.reduce(function (s, kv) { return s + kv[1]; }, 0),
        idx: null
      });
    }
    if (a.cc.get(UNK)) rows.push({ name: '未标注（缺失）', value: a.cc.get(UNK), idx: UNK });
    return rows;
  }

  function genreRows(a) {
    var items = Array.from(a.gc.entries()).filter(function (kv) { return kv[0] !== UNK; });
    items.sort(function (x, y) { return y[1] - x[1]; });
    var top = items.slice(0, 12);
    var rest = items.slice(12);
    var rows = top.map(function (kv) {
      return { name: GENRE[kv[0]][0], value: kv[1], idx: kv[0], en: GENRE[kv[0]][1] };
    });
    if (rest.length) {
      rows.push({
        name: '其他（' + rest.length + ' 个）',
        value: rest.reduce(function (s, kv) { return s + kv[1]; }, 0),
        idx: null
      });
    }
    if (a.gc.get(UNK)) rows.push({ name: '未标注（缺失）', value: a.gc.get(UNK), idx: UNK });
    return rows;
  }

  /* ---------------------------------------------------------- 状态修改 */
  function setType(t) {
    state.type = t;
    state.page = 1;
    Array.prototype.forEach.call(document.querySelectorAll('#type-seg button'), function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.type === t));
    });
    renderAll();
  }
  function setCountry(idx) {
    state.country = idx;
    byId('f-country').value = String(idx);
    state.page = 1;
    renderAll();
  }
  function setGenre(idx) {
    state.genre = idx;
    byId('f-genre').value = String(idx);
    state.page = 1;
    renderAll();
  }
  function setYearRange(a, b) {
    state.y0 = Math.min(a, b);
    state.y1 = Math.max(a, b);
    byId('f-year-min').value = String(state.y0);
    byId('f-year-max').value = String(state.y1);
    state.page = 1;
    renderAll();
  }
  function resetAll() {
    state.type = 'all';
    state.country = 'all';
    state.genre = 'all';
    state.y0 = Y_MIN;
    state.y1 = Y_MAX;
    state.q = '';
    state.sort = 'ryDesc';
    state.page = 1;
    state.pageSize = 20;
    byId('f-q').value = '';
    byId('f-country').value = 'all';
    byId('f-genre').value = 'all';
    byId('f-year-min').value = String(Y_MIN);
    byId('f-year-max').value = String(Y_MAX);
    byId('f-sort').value = 'ryDesc';
    byId('page-size').value = '20';
    Array.prototype.forEach.call(document.querySelectorAll('#type-seg button'), function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.type === 'all'));
    });
    hideDetail();
    renderAll();
  }

  /* -------------------------------------------------------------- 事件 */
  function bind() {
    Array.prototype.forEach.call(document.querySelectorAll('#type-seg button'), function (b) {
      b.addEventListener('click', function () { setType(b.dataset.type); });
    });
    byId('f-country').addEventListener('change', function (ev) {
      var v = ev.target.value;
      state.country = v === 'all' ? 'all' : Number(v);
      state.page = 1;
      renderAll();
    });
    byId('f-genre').addEventListener('change', function (ev) {
      var v = ev.target.value;
      state.genre = v === 'all' ? 'all' : Number(v);
      state.page = 1;
      renderAll();
    });
    byId('f-year-min').addEventListener('input', function (ev) {
      var v = Number(ev.target.value);
      state.y0 = Math.min(v, state.y1);
      ev.target.value = String(state.y0);
      state.page = 1;
      renderAll();
    });
    byId('f-year-max').addEventListener('input', function (ev) {
      var v = Number(ev.target.value);
      state.y1 = Math.max(v, state.y0);
      ev.target.value = String(state.y1);
      state.page = 1;
      renderAll();
    });
    var timer = null;
    byId('f-q').addEventListener('input', function (ev) {
      var v = ev.target.value;
      clearTimeout(timer);
      timer = setTimeout(function () {
        state.q = v;
        state.page = 1;
        renderAll();
      }, 160);
    });
    byId('f-q').addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { ev.target.value = ''; state.q = ''; state.page = 1; renderAll(); }
    });
    byId('f-sort').addEventListener('change', function (ev) {
      state.sort = ev.target.value;
      state.page = 1;
      renderAll();
    });
    byId('page-size').addEventListener('change', function (ev) {
      state.pageSize = Number(ev.target.value);
      state.page = 1;
      renderAll();
    });
    byId('f-reset').addEventListener('click', resetAll);
    byId('empty-reset').addEventListener('click', resetAll);
    byId('f-clear-search').addEventListener('click', function () {
      byId('f-q').value = '';
      state.q = '';
      state.page = 1;
      renderAll();
    });
    byId('d-close').addEventListener('click', hideDetail);
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !byId('detail').hidden) hideDetail();
    });
  }

  /* ---------------------------------------------------------- 静态文案 */
  function fillStatic() {
    text('hero-total', fmt(META.snapshot.records));
    text('hero-ry', META.snapshot.release_min + '–' + META.snapshot.release_max);
    text('hero-added', META.snapshot.added_min + ' 至 ' + META.snapshot.added_max);
    text('hero-unk', fmt(META.quality.country_missing));
    text('src-rows', fmt(META.snapshot.raw_rows));
    text('added-missing', fmt(META.quality.added_missing));
    text('added-max', META.snapshot.added_max);
    text('n-raw', fmt(META.snapshot.raw_rows));
    text('n-uniq', fmt(META.snapshot.records));
    text('n-dup', fmt(META.snapshot.dup_ids));
    text('n-genre-tags', fmt(META.quality.genre_labels_total));
    text('n-movie', fmt(META.snapshot.movies));
    text('n-tv', fmt(META.snapshot.tv));
    text('n-ry', META.snapshot.release_min + '–' + META.snapshot.release_max);
    text('n-added', META.snapshot.added_min + ' 至 ' + META.snapshot.added_max);
    text('n-country-missing', fmt(META.quality.country_missing));
    text('n-format', fmt(META.quality.genre_format_only));
    text('n-added-missing', fmt(META.quality.added_missing));
    text('n-rating-missing', fmt(META.quality.rating_missing));
    text('n-rating-swap', fmt(META.quality.rating_swapped));
    text('n-added-max-2', META.snapshot.added_max);
  }

  /* -------------------------------------------------------------- 启动 */
  function boot() {
    if (typeof echarts === 'undefined') {
      var msg = document.createElement('p');
      msg.className = 'note';
      msg.textContent = '图表库未能加载，仅显示筛选与列表功能。';
      document.querySelector('.charts').prepend(msg);
      return;
    }
    fillStatic();
    fillSelects();
    bind();
    renderAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
