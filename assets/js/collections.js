/*
 * Collections page: reads a Darwin Core occurrence CSV published from Google Sheets
 * and renders summary stats, a clustered map, a top-15 species bar list, and a table
 * of the most recent collections. Data is fetched on every page load, so edits to the
 * sheet appear on the site without rebuilding it.
 *
 * Requires (loaded by the page): PapaParse, Leaflet, Leaflet.markercluster.
 * Configure with data-csv-url on #collections-app.
 */
(function () {
  "use strict";

  var app = document.getElementById("collections-app");
  if (!app) return;
  var CSV_URL = app.getAttribute("data-csv-url");
  var TOP_N = 15;
  var PAGE_SIZE = 25;

  // ---------------------------------------------------------------- helpers
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function val(r, k) { return (r[k] == null ? "" : String(r[k])).trim(); }
  function num(s) { var n = parseFloat(String(s).replace(/[−–]/g, "-")); return isFinite(n) ? n : null; }
  function fmt(n) { return n.toLocaleString("en-US"); }
  function count(r) { var n = parseInt(val(r, "individualCount"), 10); return isFinite(n) && n > 0 ? n : 1; }

  function speciesKey(r) {
    if (val(r, "taxonRank").toLowerCase() !== "species") return null;
    var g = val(r, "genus"), e = val(r, "specificEpithet");
    return g && e ? g + " " + e : null;
  }

  // Taxon label as HTML: italic binomial/genus, plain higher ranks.
  function taxonHtml(r) {
    var rank = val(r, "taxonRank").toLowerCase();
    var g = val(r, "genus"), e = val(r, "specificEpithet"), auth = val(r, "scientificNameAuthorship");
    if (rank === "species" && g && e) {
      return "<i>" + esc(g + " " + e) + "</i>" + (auth ? ' <span class="coll-muted">' + esc(auth) + "</span>" : "");
    }
    if (rank === "genus" && g) return "<i>" + esc(g) + "</i> sp.";
    var higher = val(r, "family") || val(r, "order") || val(r, "class") || val(r, "scientificName");
    return higher ? esc(higher) + (rank ? ' <span class="coll-muted">(' + esc(rank) + ")</span>" : "") : '<span class="coll-muted">Unidentified</span>';
  }

  function localityText(r) {
    var county = val(r, "county");
    var parts = [val(r, "waterbody") || val(r, "locality"),
      county ? county + " Co." : "", val(r, "stateProvince")];
    var country = val(r, "country");
    if (country && !/^(US|USA|United States( of America)?)$/i.test(country)) parts.push(country);
    return parts.filter(Boolean).join(", ");
  }

  // ---------------------------------------------------------------- skeleton
  app.innerHTML =
    '<p class="coll-status" role="status">Loading collection data…</p>' +
    '<div class="coll-body" hidden>' +
    '  <div class="coll-stats"></div>' +
    '  <h2 id="coll-map-h">Collection localities</h2>' +
    '  <p class="coll-note">Each point is a collecting site; numbers are clusters of nearby sites. Click a site for details.</p>' +
    '  <div id="coll-map" role="region" aria-labelledby="coll-map-h"></div>' +
    '  <h2 id="coll-cal-h">Collecting calendar</h2>' +
    '  <p class="coll-note coll-cal-note">Days of the year I have collected on, all years combined. Darker days have more collection records; hover a day for details.</p>' +
    '  <div class="coll-legend coll-cal-legend"></div>' +
    '  <div id="coll-cal" role="img" aria-labelledby="coll-cal-h"></div>' +
    '  <h2 id="coll-top-h">Top ' + TOP_N + ' most collected species</h2>' +
    '  <p class="coll-note">Number of collection records (specimen lots) identified to species.</p>' +
    '  <div class="coll-bars" role="list" aria-labelledby="coll-top-h"></div>' +
    '  <h2 id="coll-tax-h">Species per family</h2>' +
    '  <p class="coll-note">Number of species collected in each family, grouped by order. Hover a bar to list the species.</p>' +
    '  <div class="coll-legend coll-tax-legend"></div>' +
    '  <div class="coll-bars coll-tax" role="list" aria-labelledby="coll-tax-h"></div>' +
    '  <h2 id="coll-recent-h">Recent collections</h2>' +
    '  <div class="coll-table-wrap"><table class="coll-table" aria-labelledby="coll-recent-h">' +
    '    <thead><tr><th scope="col">Date</th><th scope="col">Taxon</th><th scope="col">Locality</th>' +
    '      <th scope="col">Collector</th><th scope="col" class="coll-num">Specimens</th><th scope="col">Catalog no.</th></tr></thead>' +
    '    <tbody></tbody></table></div>' +
    '  <button type="button" class="btn coll-more">Show more</button>' +
    '</div>' +
    '<div class="coll-tip" role="tooltip" hidden></div>';

  var statusEl = app.querySelector(".coll-status");
  var bodyEl = app.querySelector(".coll-body");

  Papa.parse(CSV_URL, {
    download: true,
    header: true,
    skipEmptyLines: true,
    complete: function (res) {
      var rows = res.data.filter(function (r) { return val(r, "catalogNumber") || val(r, "occurrenceID") || val(r, "eventDate"); });
      if (!rows.length) return fail();
      statusEl.hidden = true;
      bodyEl.hidden = false;
      renderStats(rows);
      renderMap(rows);
      renderCalendar(rows);
      renderBars(rows);
      renderTaxonomy(rows);
      renderTable(rows);
    },
    error: fail
  });

  function fail() {
    statusEl.innerHTML = "Sorry, the collection data could not be loaded right now. " +
      'You can <a href="' + esc(CSV_URL) + '">download it directly</a>.';
  }

  // ---------------------------------------------------------------- stats
  function renderStats(rows) {
    var species = {}, states = {}, specimens = 0, years = [];
    rows.forEach(function (r) {
      var k = speciesKey(r); if (k) species[k] = 1;
      var s = val(r, "stateProvince"); if (s) states[s] = 1;
      specimens += count(r);
      var y = parseInt(val(r, "year") || val(r, "eventDate").slice(0, 4), 10); if (y) years.push(y);
    });
    years.sort(function (a, b) { return a - b; });
    var tiles = [
      [fmt(rows.length), "collection records"],
      [fmt(specimens), "specimens"],
      [fmt(Object.keys(species).length), "species"],
      [fmt(Object.keys(states).length), "states & provinces"],
      [years.length ? years[0] + "–" + years[years.length - 1] : "—", "years collected"]
    ];
    app.querySelector(".coll-stats").innerHTML = tiles.map(function (t) {
      return '<div class="coll-stat"><span class="coll-stat-n">' + esc(t[0]) + '</span><span class="coll-stat-l">' + esc(t[1]) + "</span></div>";
    }).join("");
  }

  // ---------------------------------------------------------------- map
  function renderMap(rows) {
    // Group records by site (identical coordinates) so each site is one point.
    var sites = {};
    rows.forEach(function (r) {
      var lat = num(val(r, "decimalLatitude")), lon = num(val(r, "decimalLongitude"));
      if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
      var key = lat.toFixed(5) + "," + lon.toFixed(5);
      var s = sites[key] || (sites[key] = { lat: lat, lon: lon, rows: [] });
      s.rows.push(r);
    });

    var map = L.map("coll-map", { scrollWheelZoom: false });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    var cluster = L.markerClusterGroup({
      showCoverageOnHover: false,
      maxClusterRadius: 40,
      iconCreateFunction: function (c) {
        var n = c.getChildCount();
        var size = n < 10 ? 30 : n < 100 ? 36 : 44;
        return L.divIcon({ html: "<span>" + n + "</span>", className: "coll-cluster", iconSize: [size, size] });
      }
    });

    var allPts = [];

    Object.keys(sites).forEach(function (k) {
      var s = sites[k];
      var m = L.circleMarker([s.lat, s.lon], {
        radius: 6, weight: 2, color: "#ffffff", fillColor: "#0f80a8", fillOpacity: 0.9
      });
      m.bindPopup(function () { return sitePopup(s); }, { maxWidth: 300 });
      cluster.addLayer(m);
      allPts.push([s.lat, s.lon]);
    });
    map.addLayer(cluster);

    // Zoom to where most sites are: ignore far-off outliers (e.g. a dropped minus sign on a
    // longitude) when fitting, though they are still plotted.
    function median(a) { a = a.slice().sort(function (x, y) { return x - y; }); return a[Math.floor(a.length / 2)]; }
    var mLat = median(allPts.map(function (p) { return p[0]; }));
    var mLon = median(allPts.map(function (p) { return p[1]; }));
    var fitPts = allPts.filter(function (p) { return Math.abs(p[0] - mLat) < 25 && Math.abs(p[1] - mLon) < 40; });
    if (fitPts.length) map.fitBounds(fitPts, { padding: [20, 20] });
    else map.setView([39, -90], 4);

    // Let the wheel zoom once the reader has clicked into the map.
    map.on("focus click", function () { map.scrollWheelZoom.enable(); });
    map.on("blur mouseout", function () { map.scrollWheelZoom.disable(); });
  }

  function sitePopup(s) {
    var r0 = s.rows[0];
    var dates = s.rows.map(function (r) { return val(r, "eventDate"); }).filter(Boolean).sort();
    var taxa = {};
    s.rows.forEach(function (r) { var h = taxonHtml(r).replace(/ <span class="coll-muted">[^<]*<\/span>$/, ""); taxa[h] = (taxa[h] || 0) + 1; });
    var list = Object.keys(taxa).sort(function (a, b) { return taxa[b] - taxa[a]; });
    var shown = list.slice(0, 8).map(function (t) { return "<li>" + t + (taxa[t] > 1 ? " (" + taxa[t] + ")" : "") + "</li>"; }).join("");
    var more = list.length > 8 ? '<li class="coll-muted">+ ' + (list.length - 8) + " more taxa</li>" : "";
    var dateText = dates.length ? (dates[0] === dates[dates.length - 1] ? dates[0] : dates[0] + " to " + dates[dates.length - 1]) : "";
    return '<div class="coll-pop"><strong>' + esc(localityText(r0)) + "</strong>" +
      '<div class="coll-muted">' + fmt(s.rows.length) + " record" + (s.rows.length > 1 ? "s" : "") +
      (dateText ? " · " + esc(dateText) : "") + "</div><ul>" + shown + more + "</ul></div>";
  }

  // ---------------------------------------------------------------- top species
  function renderBars(rows) {
    var by = {};
    rows.forEach(function (r) {
      var k = speciesKey(r); if (!k) return;
      var e = by[k] || (by[k] = { name: k, auth: val(r, "scientificNameAuthorship"), order: val(r, "order"), records: 0, specimens: 0 });
      e.records += 1;
      e.specimens += count(r);
    });
    var top = Object.keys(by).map(function (k) { return by[k]; })
      .sort(function (a, b) { return b.records - a.records || a.name.localeCompare(b.name); })
      .slice(0, TOP_N);
    var max = top.length ? top[0].records : 1;
    var total = rows.length;
    var host = app.querySelector(".coll-bars");
    host.innerHTML = top.map(function (e, i) {
      var pct = (e.records / max) * 100;
      return '<div class="coll-bar-row" role="listitem" tabindex="0" data-i="' + i + '">' +
        '<span class="coll-bar-name"><i>' + esc(e.name) + "</i></span>" +
        '<span class="coll-bar-track"><span class="coll-bar" style="width:' + pct.toFixed(2) + '%"></span></span>' +
        '<span class="coll-bar-val">' + fmt(e.records) + "</span></div>";
    }).join("");

    attachTips(host, function (i) {
      var e = top[i];
      return "<strong><i>" + esc(e.name) + "</i></strong> " + esc(e.auth) +
        '<div class="coll-tip-grid"><span>Records</span><b>' + fmt(e.records) + "</b>" +
        "<span>Specimens</span><b>" + fmt(e.specimens) + "</b>" +
        "<span>Share of all records</span><b>" + ((e.records / total) * 100).toFixed(1) + "%</b>" +
        (e.order ? "<span>Order</span><b>" + esc(e.order) + "</b>" : "") + "</div>";
    });
  }

  // Hover/focus tooltip for bar rows (.coll-bar-row[data-i]) inside host.
  function attachTips(host, contentFor) {
    var tip = app.querySelector(".coll-tip");
    function show(ev) {
      var row = ev.currentTarget;
      tip.innerHTML = contentFor(+row.getAttribute("data-i"));
      tip.hidden = false;
      var bar = row.querySelector(".coll-bar").getBoundingClientRect();
      var appBox = app.getBoundingClientRect();
      var x = bar.right - appBox.left + 12;
      var maxX = app.clientWidth - tip.offsetWidth - 4;
      tip.style.left = Math.max(4, Math.min(x, maxX)) + "px";
      tip.style.top = Math.max(0, bar.top - appBox.top + bar.height / 2 - tip.offsetHeight / 2) + "px";
    }
    function hide() { tip.hidden = true; }
    Array.prototype.forEach.call(host.querySelectorAll(".coll-bar-row"), function (row) {
      row.addEventListener("mouseenter", show);
      row.addEventListener("focus", show);
      row.addEventListener("mouseleave", hide);
      row.addEventListener("blur", hide);
    });
  }

  // ---------------------------------------------------------------- collecting calendar
  // Month (columns) x day-of-month (rows) grid, all years combined, in the style of a
  // vertical calendar heatmap. Weekdays are omitted because they differ between years.
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August",
    "September", "October", "November", "December"];
  var DAYS_IN = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  function renderCalendar(rows) {
    var el = document.getElementById("coll-cal");
    if (!window.echarts) { el.innerHTML = '<p class="coll-muted">Calendar unavailable.</p>'; return; }

    var cells = {}; // "m-d" -> stats
    rows.forEach(function (r) {
      var m = val(r, "eventDate").match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (!m) return;
      var mi = +m[2] - 1, di = +m[3] - 1;
      if (mi < 0 || mi > 11 || di < 0 || di >= DAYS_IN[mi]) return;
      var c = cells[mi + "-" + di] || (cells[mi + "-" + di] = { records: 0, specimens: 0, years: {}, sites: {} });
      c.records += 1;
      c.specimens += count(r);
      c.years[m[1]] = 1;
      c.sites[val(r, "decimalLatitude") + "," + val(r, "decimalLongitude")] = 1;
    });

    var data = [], days = 0;
    for (var mi = 0; mi < 12; mi++) {
      for (var di = 0; di < DAYS_IN[mi]; di++) {
        var c = cells[mi + "-" + di];
        if (c) days++;
        data.push([mi, di, c ? c.records : 0]);
      }
    }
    var note = app.querySelector(".coll-cal-note");
    note.textContent = "Days of the year I have collected on, all years combined: " + days +
      " of 366 calendar days. Darker days have more collection records; hover a day for details.";

    // Ordinal blue ramp (lightest step still clears 2:1 on white); "None" is the empty track.
    var pieces = [
      { value: 0, label: "None", color: "#eef1f3" },
      { min: 1, max: 5, label: "1–5", color: "#86b6ef" },
      { min: 6, max: 15, label: "6–15", color: "#3987e5" },
      { min: 16, max: 30, label: "16–30", color: "#256abf" },
      { min: 31, max: 60, label: "31–60", color: "#184f95" },
      { min: 61, label: "61+", color: "#0d366b" }
    ];
    // HTML legend so it wraps on narrow screens.
    app.querySelector(".coll-cal-legend").innerHTML = '<span class="coll-muted">Records per day:</span>' +
      pieces.map(function (p) {
        return '<span class="coll-legend-item"><span class="coll-swatch" style="background:' + p.color + '"></span>' + esc(p.label) + "</span>";
      }).join("");

    var font = getComputedStyle(app).fontFamily;
    var narrow = el.clientWidth < 420;
    var chart = echarts.init(el, null, { renderer: "svg" });
    chart.setOption({
      textStyle: { fontFamily: font, color: "#3d4144" },
      tooltip: {
        confine: true,
        borderColor: "#e3e6e8",
        textStyle: { fontSize: 12, color: "#3d4144" },
        formatter: function (p) {
          var mi = p.data[0], di = p.data[1], c = cells[mi + "-" + di];
          var head = "<strong>" + MONTH_NAMES[mi] + " " + (di + 1) + "</strong>";
          if (!c) return head + '<div class="coll-muted">No collections</div>';
          var yrs = Object.keys(c.years).sort();
          return head + '<div class="coll-tip-grid"><span>Records</span><b>' + fmt(c.records) + "</b>" +
            "<span>Specimens</span><b>" + fmt(c.specimens) + "</b>" +
            "<span>Sites</span><b>" + fmt(Object.keys(c.sites).length) + "</b>" +
            "<span>Years</span><b>" + yrs.join(", ") + "</b></div>";
        }
      },
      visualMap: { type: "piecewise", show: false, pieces: pieces },
      grid: { top: 22, bottom: 6, left: 26, right: 4 },
      xAxis: {
        type: "category", data: MONTHS, position: "top",
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { fontSize: 11, color: "#6b7175", interval: 0,
          formatter: function (v) { return narrow ? v.charAt(0) : v; } },
        splitArea: { show: false }
      },
      yAxis: {
        type: "category", inverse: true,
        data: Array.from({ length: 31 }, function (_, i) { return String(i + 1); }),
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { fontSize: 10, color: "#6b7175", interval: 0,
          formatter: function (v) { return (+v === 1 || +v % 5 === 0) ? v : ""; } }
      },
      series: [{
        type: "heatmap",
        data: data,
        itemStyle: { borderColor: "#ffffff", borderWidth: 2, borderRadius: 3 },
        emphasis: { itemStyle: { borderColor: "#3d4144", borderWidth: 1.5 } },
        progressive: 0
      }]
    });
    window.addEventListener("resize", function () { chart.resize(); });
  }

  // ---------------------------------------------------------------- species per family, by order
  // Orders get fixed colors so an order keeps its color as the data changes (validated
  // categorical palette, adjacent order). Orders not listed fold into "Other orders".
  var ORDER_COLORS = [
    ["Plecoptera", "#2a78d6"], ["Trichoptera", "#eb6834"], ["Ephemeroptera", "#1baf7a"],
    ["Megaloptera", "#eda100"], ["Odonata", "#e87ba4"], ["Neuroptera", "#008300"],
    ["Hemiptera", "#6250d6"]
  ];
  var OTHER = { name: "Other orders", color: "#8a8f93" };

  function renderTaxonomy(rows) {
    var byOrder = {}; // group name -> family label -> {order, species:{}}
    rows.forEach(function (r) {
      var sp = speciesKey(r); if (!sp) return;
      var order = val(r, "order") || "Order not recorded";
      var known = ORDER_COLORS.some(function (o) { return o[0] === order; });
      var group = known ? order : OTHER.name;
      var fam = val(r, "family") || "Family not recorded";
      var label = known ? fam : fam + " (" + order + ")";
      var g = byOrder[group] || (byOrder[group] = {});
      var f = g[label] || (g[label] = { family: fam, order: order, species: {} });
      f.species[sp] = 1;
    });

    var groups = ORDER_COLORS.map(function (o) { return { name: o[0], color: o[1] }; }).concat([OTHER])
      .filter(function (g) { return byOrder[g.name]; });
    var items = [], max = 1;
    groups.forEach(function (g) {
      var fams = Object.keys(byOrder[g.name]).map(function (k) {
        var f = byOrder[g.name][k];
        return { label: k, family: f.family, order: f.order, species: Object.keys(f.species).sort(), color: g.color };
      }).sort(function (a, b) { return b.species.length - a.species.length || a.label.localeCompare(b.label); });
      var allSp = {};
      fams.forEach(function (f) { f.species.forEach(function (s) { allSp[s] = 1; }); max = Math.max(max, f.species.length); });
      g.families = fams;
      g.speciesCount = Object.keys(allSp).length;
      items = items.concat(fams);
    });

    app.querySelector(".coll-tax-legend").innerHTML = groups.map(function (g) {
      return '<span class="coll-legend-item"><span class="coll-swatch" style="background:' + g.color + '"></span>' + esc(g.name) + "</span>";
    }).join("");

    var html = "", i = 0;
    groups.forEach(function (g) {
      html += '<div class="coll-group-h" role="presentation"><span class="coll-swatch" style="background:' + g.color + '"></span>' +
        "<strong>" + esc(g.name) + "</strong> " +
        '<span class="coll-muted">' + g.families.length + " famil" + (g.families.length === 1 ? "y" : "ies") +
        " · " + g.speciesCount + " species</span></div>";
      g.families.forEach(function (f) {
        html += '<div class="coll-bar-row" role="listitem" tabindex="0" data-i="' + (i++) + '">' +
          '<span class="coll-bar-name">' + esc(f.label) + "</span>" +
          '<span class="coll-bar-track"><span class="coll-bar" style="width:' + ((f.species.length / max) * 100).toFixed(2) +
          "%;background:" + f.color + '"></span></span>' +
          '<span class="coll-bar-val">' + f.species.length + "</span></div>";
      });
    });
    var host = app.querySelector(".coll-tax");
    host.innerHTML = html;

    attachTips(host, function (k) {
      var f = items[k], shown = f.species.slice(0, 12);
      return "<strong>" + esc(f.family) + "</strong> " + '<span class="coll-muted">' + esc(f.order) + "</span>" +
        '<div class="coll-tip-grid"><span>Species</span><b>' + f.species.length + "</b></div>" +
        '<ul class="coll-tip-list">' + shown.map(function (s) { return "<li><i>" + esc(s) + "</i></li>"; }).join("") +
        (f.species.length > shown.length ? '<li class="coll-muted">+ ' + (f.species.length - shown.length) + " more</li>" : "") + "</ul>";
    });
  }

  // ---------------------------------------------------------------- recent table
  function renderTable(rows) {
    var sorted = rows.filter(function (r) { return val(r, "eventDate"); }).sort(function (a, b) {
      var da = val(a, "eventDate"), db = val(b, "eventDate");
      if (da !== db) return da < db ? 1 : -1;
      return val(b, "catalogNumber").localeCompare(val(a, "catalogNumber"));
    });
    var tbody = app.querySelector(".coll-table tbody");
    var moreBtn = app.querySelector(".coll-more");
    var shown = 0;
    function more() {
      var next = sorted.slice(shown, shown + PAGE_SIZE);
      tbody.insertAdjacentHTML("beforeend", next.map(function (r) {
        return "<tr><td class=\"coll-nowrap\">" + esc(val(r, "eventDate")) + "</td>" +
          "<td>" + taxonHtml(r) + "</td>" +
          "<td>" + esc(localityText(r)) + "</td>" +
          "<td>" + esc(val(r, "recordedBy")) + "</td>" +
          '<td class="coll-num">' + esc(val(r, "individualCount")) + "</td>" +
          '<td class="coll-nowrap">' + esc(val(r, "catalogNumber")) + "</td></tr>";
      }).join(""));
      shown += next.length;
      moreBtn.hidden = shown >= sorted.length;
    }
    moreBtn.addEventListener("click", more);
    more();
  }
})();
