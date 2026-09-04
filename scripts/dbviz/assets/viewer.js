/*
 * dbviz viewer.js — lógica del visor autocontenido.
 * Consume los datos embebidos en #dbviz-data (manifest+sources) y #dbviz-cfg
 * (config de la sección `viewer` del config), y renderiza con Tabulator
 * (grid), Mermaid (ER) y Chart.js (stats). Regla de seguridad: TODO valor
 * proveniente de la base de datos se escapa antes de insertarse como HTML
 * (la data puede contener "<script>" u otro HTML hostil).
 *
 * Estructura: funciones a nivel de módulo (sin envolver todo en una sola IIFE).
 * El visor se sirve como un único <script> embebido al final del <body> de una
 * página autocontenida, sin más código de aplicación; `"use strict"` cubre todo
 * el archivo y el estado compartido vive en el único objeto `STATE`.
 */
"use strict";

function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

var STATE = {
  manifest: null,
  sourcesById: {},
  currentSourceId: null,
  currentTableName: null,
  tabulator: null,
  charts: [],
  cfg: { title: "dbviz", theme: "auto", erDiagram: true, charts: true, defaultTab: "tables" },
};

function ready(fn) {
  if (document.readyState !== "loading") fn();
  else document.addEventListener("DOMContentLoaded", fn);
}

ready(init);

function init() {
  var dataEl = document.getElementById("dbviz-data");
  var cfgEl = document.getElementById("dbviz-cfg");
  var payload = { manifest: { sources: [], stats: {}, warnings: [], project: {} }, sources: [] };

  try {
    if (dataEl) payload = JSON.parse(dataEl.textContent);
  } catch (e) {
    console.error("dbviz: no se pudieron parsear los datos embebidos", e);
  }
  try {
    if (cfgEl) Object.assign(STATE.cfg, JSON.parse(cfgEl.textContent));
  } catch (e) {
    console.error("dbviz: no se pudo parsear la config del visor", e);
  }

  STATE.manifest = payload.manifest || { sources: [], stats: {}, warnings: [] };
  (payload.sources || []).forEach(function (s) {
    STATE.sourcesById[s.id] = s;
  });

  document.getElementById("dbviz-project-name").textContent =
    (STATE.manifest.project && STATE.manifest.project.name) || "";

  applyTheme(STATE.cfg.theme);
  document.getElementById("dbviz-theme-toggle").addEventListener("click", toggleTheme);

  setupTabs(STATE.cfg.defaultTab || "tables");
  setupSourceSelector();
  renderAbout();

  var manifestSources = STATE.manifest.sources || [];
  var withData = manifestSources.filter(function (s) {
    return s.hasData;
  });
  if (withData.length > 0) {
    selectSource(withData[0].id);
  } else if (manifestSources.length > 0) {
    selectSource(manifestSources[0].id);
  } else {
    renderEmptyState();
  }
}

// -------------------------------------------------------------------
// Tema
// -------------------------------------------------------------------
function applyTheme(theme) {
  var root = document.documentElement;
  if (theme === "dark" || theme === "light") {
    root.setAttribute("data-theme", theme);
  } else {
    root.removeAttribute("data-theme");
  }
}

function toggleTheme() {
  var root = document.documentElement;
  var current = root.getAttribute("data-theme");
  var prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  var effectiveDark = current === "dark" || (!current && prefersDark);
  applyTheme(effectiveDark ? "light" : "dark");
}

// -------------------------------------------------------------------
// Tabs
// -------------------------------------------------------------------
function setupTabs(defaultTab) {
  var btns = Array.prototype.slice.call(document.querySelectorAll(".dbviz-tab-btn"));
  btns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      activateTab(btn.getAttribute("data-tab"));
    });
  });
  activateTab(defaultTab);
}

function activateTab(tab) {
  var btns = Array.prototype.slice.call(document.querySelectorAll(".dbviz-tab-btn"));
  btns.forEach(function (btn) {
    btn.classList.toggle("active", btn.getAttribute("data-tab") === tab);
  });
  ["tables", "schema", "stats", "about"].forEach(function (t) {
    var panel = document.getElementById("dbviz-panel-" + t);
    if (panel) panel.hidden = t !== tab;
  });
  if (tab === "schema") renderSchema();
  if (tab === "stats") renderStats();
}

// -------------------------------------------------------------------
// Selector de fuente
// -------------------------------------------------------------------
function setupSourceSelector() {
  var sel = document.getElementById("dbviz-source-select");
  sel.innerHTML = "";
  var sources = STATE.manifest.sources || [];
  if (sources.length === 0) {
    var opt = document.createElement("option");
    opt.textContent = "(sin fuentes)";
    sel.appendChild(opt);
    sel.disabled = true;
    return;
  }
  sources.forEach(function (s) {
    var opt = document.createElement("option");
    opt.value = s.id;
    var suffix = s.hasData ? "" : " (sin datos)";
    opt.textContent = (s.label || s.id) + suffix;
    sel.appendChild(opt);
  });
  sel.addEventListener("change", function () {
    selectSource(sel.value);
  });
}

function selectSource(sourceId) {
  STATE.currentSourceId = sourceId;
  var sel = document.getElementById("dbviz-source-select");
  if (sel) sel.value = sourceId;

  renderTableList();
  var activeTab = document.querySelector(".dbviz-tab-btn.active");
  if (activeTab && activeTab.getAttribute("data-tab") === "schema") renderSchema();
  if (activeTab && activeTab.getAttribute("data-tab") === "stats") renderStats();
}

function currentSourceMeta() {
  var sources = STATE.manifest.sources || [];
  for (var i = 0; i < sources.length; i++) {
    if (sources[i].id === STATE.currentSourceId) return sources[i];
  }
  return null;
}

function currentSourceFull() {
  return STATE.sourcesById[STATE.currentSourceId] || null;
}

// -------------------------------------------------------------------
// Tab "Tablas"
// -------------------------------------------------------------------
function renderTableList() {
  var listEl = document.getElementById("dbviz-table-list");
  var errEl = document.getElementById("dbviz-source-error");
  var meta = currentSourceMeta();
  listEl.innerHTML = "";
  errEl.hidden = true;

  if (!meta) {
    listEl.innerHTML = '<div class="dbviz-table-list-empty">Sin fuente seleccionada</div>';
    return;
  }
  if (meta.error) {
    errEl.hidden = false;
    errEl.textContent = "Error en esta fuente: " + meta.error;
  }
  var tables = meta.tables || [];
  if (tables.length === 0) {
    listEl.innerHTML = '<div class="dbviz-table-list-empty">Esta fuente no tiene tablas' +
      (meta.hasData ? "" : " (solo metadata / sin datos, kind=" + escapeHtml(meta.kind) + ")") +
      "</div>";
    document.getElementById("dbviz-table-title").textContent = "";
    document.getElementById("dbviz-grid").innerHTML = "";
    document.getElementById("dbviz-sample-banner").hidden = true;
    return;
  }
  tables.forEach(function (t, i) {
    var item = document.createElement("div");
    item.className = "dbviz-table-list-item";
    item.dataset.name = t.name;
    item.innerHTML =
      '<span class="dbviz-t-name"></span><span class="dbviz-count"></span>';
    item.querySelector(".dbviz-t-name").textContent = t.name;
    item.querySelector(".dbviz-count").textContent = t.rowCountTotal;
    item.addEventListener("click", function () {
      selectTable(t.name);
    });
    listEl.appendChild(item);
    if (i === 0) selectTable(t.name);
  });
}

function findTable(name) {
  var meta = currentSourceMeta();
  var full = currentSourceFull();
  var metaTable = null,
    fullTable = null;
  (meta && meta.tables ? meta.tables : []).forEach(function (t) {
    if (t.name === name) metaTable = t;
  });
  (full && full.tables ? full.tables : []).forEach(function (t) {
    if (t.name === name) fullTable = t;
  });
  return fullTable || metaTable;
}

function selectTable(name) {
  STATE.currentTableName = name;
  Array.prototype.slice.call(document.querySelectorAll(".dbviz-table-list-item")).forEach(function (el) {
    el.classList.toggle("active", el.dataset.name === name);
  });

  var table = findTable(name);
  var titleEl = document.getElementById("dbviz-table-title");
  var bannerEl = document.getElementById("dbviz-sample-banner");
  if (!table) {
    titleEl.textContent = name;
    bannerEl.hidden = true;
    renderGrid([], []);
    return;
  }

  titleEl.innerHTML =
    escapeHtml(table.name) +
    '<span class="dbviz-sub">' +
    escapeHtml(table.type) +
    " · " +
    table.rowCountTotal +
    " filas totales</span>";

  if (table.sampled) {
    bannerEl.hidden = false;
    bannerEl.textContent =
      "Esta tabla está muestreada: mostrando una muestra de " +
      table.rowCountSample +
      " de " +
      table.rowCountTotal +
      " filas totales (estrategia: " +
      table.sampleStrategy +
      "). Para ver todas las filas usá `dbviz.sh build --max-rows " +
      table.rowCountTotal +
      "` o consultá los archivos .dbviz/data/*.json completos.";
  } else {
    bannerEl.hidden = true;
  }

  renderGrid(table.columns || [], table.rows || []);
}

function renderGrid(columns, rows) {
  var container = document.getElementById("dbviz-grid");
  if (STATE.tabulator) {
    try {
      STATE.tabulator.destroy();
    } catch (e) {
      /* noop */
    }
    STATE.tabulator = null;
  }
  container.innerHTML = "";

  if (columns.length === 0) {
    container.innerHTML = '<div class="dbviz-empty-state">Sin columnas para mostrar.</div>';
    return;
  }

  var colsByName = {};
  columns.forEach(function (c) {
    colsByName[c.name] = c;
  });

  STATE.tabulator = new Tabulator(container, {
    data: rowsToTabulatorData(columns, rows),
    columns: buildTabulatorColumns(columns),
    layout: "fitDataFill",
    height: "520px",
    pagination: true,
    paginationMode: "local",
    paginationSize: 100,
    paginationSizeSelector: [50, 100, 250, 500],
    movableColumns: true,
    placeholder: "Sin filas",
  });
}

// Convierte las filas posicionales (cada `row` es un array alineado con
// `columns`) en los objetos {campo: valor} que consume Tabulator.
function rowsToTabulatorData(columns, rows) {
  return rows.map(function (row) {
    var obj = {};
    columns.forEach(function (c, i) {
      obj[c.name] = row[i];
    });
    return obj;
  });
}

// Definiciones de columna de Tabulator. El nombre de columna viene crudo de
// la BD y Tabulator inserta `title` como HTML (innerHTML) en el header del
// grid, no como texto: debe escaparse igual que cualquier otro valor
// proveniente de datos de usuario (ver regla de seguridad en la cabecera).
function buildTabulatorColumns(columns) {
  return columns.map(function (c) {
    return {
      title: escapeHtml(c.name) + (c.primaryKey ? " 🔑" : ""),
      field: c.name,
      headerFilter: "input",
      formatter: makeCellFormatter(c),
      headerTooltip: (c.declaredType || c.inferredType || ""),
    };
  });
}

function makeCellFormatter(column) {
  return function (cell) {
    var v = cell.getValue();
    return formatCellValue(v, column);
  };
}

function formatCellValue(v, column) {
  if (v === null || v === undefined) {
    return '<span class="dbviz-chip dbviz-chip-null">NULL</span>';
  }
  if (typeof v === "object" && v !== null && v.__type__) {
    return formatTypedCell(v);
  }
  if (typeof v === "boolean") {
    return '<span class="dbviz-chip">' + (v ? "true" : "false") + "</span>";
  }
  if (typeof v === "number") {
    return '<span class="dbviz-cell-mono">' + escapeHtml(String(v)) + "</span>";
  }
  return formatStringCell(v, column);
}

// Tabla de formateo por `__type__`: cada marca de tipo especial que emite
// `encode_cell` del backend (cuando el valor no cabe en un JSON plano) mapea
// a la función que arma su chip. Todo lo que viene de la BD se escapa acá.
var TYPED_CELL_FORMATTERS = {
  number: function (v) {
    return '<span class="dbviz-chip dbviz-chip-nan">' + escapeHtml(v.value) + "</span>";
  },
  bigint: function (v) {
    return (
      '<span class="dbviz-cell-mono" title="Entero de 64 bits (fuera del rango seguro de Number en JS: se muestra exacto como texto)">' +
      escapeHtml(v.value) +
      "</span>"
    );
  },
  text: function (v) {
    return (
      '<span class="dbviz-chip dbviz-chip-trunc" title="' +
      escapeHtml(v.value) +
      '">TEXTO truncado (' +
      v.size +
      " caract.)</span>"
    );
  },
  blob: function (v) {
    var hex = v.preview_hex ? " hex: " + escapeHtml(v.preview_hex) + "…" : "";
    return '<span class="dbviz-chip dbviz-chip-blob" title="Binary' + escapeHtml(hex) + '">Binary (' + v.size + " bytes)</span>";
  },
  error: function (v) {
    return '<span class="dbviz-chip dbviz-chip-error" title="' + escapeHtml(v.reason) + '">valor no serializable</span>';
  },
};

// Celda con marca de tipo especial (`__type__`). Un `__type__` desconocido
// cae al chip genérico con el objeto serializado (mismo comportamiento que el
// `default` del switch original).
function formatTypedCell(v) {
  var fmt = TYPED_CELL_FORMATTERS[v.__type__];
  if (fmt) return fmt(v);
  return '<span class="dbviz-chip">' + escapeHtml(JSON.stringify(v)) + "</span>";
}

// Celda de texto plano (el caso por defecto). El texto JSON-like recibe el
// chip clickeable "ver JSON"; el resto se muestra en una sola línea con los
// saltos de línea/tabs sustituidos por marcadores visibles (el valor real no
// cambia: el `title` conserva el texto completo sin tocar).
function formatStringCell(v, column) {
  var isJson = column && column.stats && column.stats.jsonLike;
  var text = String(v);
  var truncatedForDisplay = text.length > 300 ? text.slice(0, 300) + "…" : text;
  if (isJson) {
    // El valor COMPLETO (no truncado) va en `title`, no solo por accesibilidad:
    // es la única fuente que usa el modal "ver JSON" (ver listener de click
    // más abajo), para que un JSON de más de 300 caracteres se pueda ver/parsear
    // entero en vez de mostrar el fragmento cortado como si fuera el valor real.
    return (
      '<span class="dbviz-chip dbviz-chip-json" data-json-cell="1" title="' +
      escapeHtml(text) +
      '">' +
      escapeHtml(truncatedForDisplay) +
      "</span>"
    );
  }
  // Texto multilínea (\n, \t): el grid renderiza en una sola línea (nowrap),
  // así que saltos de línea y tabs se ven fusionados en una sola cadena sin
  // ninguna indicación. Se sustituyen por marcadores visibles en el texto
  // MOSTRADO (el dato real no cambia: `title` sí conserva los saltos de
  // línea originales, y los navegadores los respetan en el tooltip nativo).
  var hasWhitespaceMeta = /[\n\r\t]/.test(text);
  var displayText = hasWhitespaceMeta
    ? truncatedForDisplay.replace(/\r\n|\r|\n/g, "⏎").replace(/\t/g, "→")
    : truncatedForDisplay;
  var multilineClass = hasWhitespaceMeta ? " dbviz-cell-text-multiline" : "";
  return (
    '<span class="dbviz-cell-text' + multilineClass + '" title="' + escapeHtml(text) + '">' +
    escapeHtml(displayText) +
    "</span>"
  );
}

// Delegación de click para chips "ver JSON"
document.addEventListener("click", function (ev) {
  var el = ev.target.closest && ev.target.closest('[data-json-cell="1"]');
  if (!el) return;
  // `title` contiene el valor COMPLETO sin truncar (ver formatCellValue);
  // `textContent` es sólo el fragmento visible (recortado a 300 caracteres)
  // y NO debe usarse para parsear, o un JSON largo se corta a mitad de
  // token y el usuario termina viendo el fragmento truncado como si fuera
  // el valor real.
  var text = el.hasAttribute("title") ? el.getAttribute("title") : el.textContent;
  try {
    var parsed = JSON.parse(text);
    showModal("JSON", JSON.stringify(parsed, null, 2));
  } catch (e) {
    showModal("Valor", text);
  }
});

function showModal(title, text) {
  var modal = document.getElementById("dbviz-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "dbviz-modal";
    modal.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:9999;";
    modal.innerHTML =
      '<div style="background:var(--dbviz-bg-elev,#fff);color:var(--dbviz-fg,#111);max-width:80vw;max-height:80vh;overflow:auto;border-radius:8px;padding:16px;box-shadow:0 10px 40px rgba(0,0,0,.3);">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
      '<strong id="dbviz-modal-title"></strong>' +
      '<button id="dbviz-modal-close" type="button" style="cursor:pointer;">✕</button>' +
      "</div>" +
      '<pre id="dbviz-modal-body" style="white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,monospace;font-size:12px;margin:0;"></pre>' +
      "</div>";
    document.body.appendChild(modal);
    modal.addEventListener("click", function (ev) {
      if (ev.target === modal || ev.target.id === "dbviz-modal-close") modal.remove();
    });
  }
  modal.querySelector("#dbviz-modal-title").textContent = title;
  modal.querySelector("#dbviz-modal-body").textContent = text;
}

// -------------------------------------------------------------------
// Tab "Esquema" (Mermaid erDiagram con fallback HTML — Riesgo R1)
// -------------------------------------------------------------------
function renderSchema() {
  var container = document.getElementById("dbviz-schema-container");
  var full = currentSourceFull();
  var meta = currentSourceMeta();
  if (!meta || !full || !full.tables || full.tables.length === 0) {
    container.innerHTML = '<div class="dbviz-empty-state">Sin tablas para diagramar en esta fuente.</div>';
    return;
  }

  if (!STATE.cfg.erDiagram) {
    container.innerHTML = renderSchemaFallbackHtml(full.tables);
    return;
  }

  var mermaidText = buildMermaidEr(full.tables);
  container.innerHTML = '<div id="dbviz-mermaid-target"></div>';

  try {
    if (typeof mermaid === "undefined") throw new Error("mermaid global no disponible");
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
    var renderId = "dbviz-er-" + Math.random().toString(36).slice(2);
    mermaid
      .render(renderId, mermaidText)
      .then(function (res) {
        document.getElementById("dbviz-mermaid-target").innerHTML = res.svg;
      })
      .catch(function (err) {
        console.warn("dbviz: mermaid.render falló, usando fallback HTML", err);
        container.innerHTML = renderSchemaFallbackHtml(full.tables);
      });
  } catch (err) {
    console.warn("dbviz: mermaid no disponible/falló, usando fallback HTML", err);
    container.innerHTML = renderSchemaFallbackHtml(full.tables);
  }
}

function sanitizeMermaidToken(s) {
  return String(s).replace(/[^A-Za-z0-9_]/g, "_") || "_";
}

function buildMermaidEr(tables) {
  var lines = ["erDiagram"];
  tables.forEach(function (t) {
    var ename = sanitizeMermaidToken(t.name);
    lines.push("  " + ename + " {");
    (t.columns || []).slice(0, 60).forEach(function (c) {
      var type = sanitizeMermaidToken(c.declaredType || c.inferredType || "TEXT") || "TEXT";
      var cname = sanitizeMermaidToken(c.name);
      var flag = c.primaryKey ? " PK" : isForeignKeyColumn(t, c.name) ? " FK" : "";
      lines.push("    " + type + " " + cname + flag);
    });
    lines.push("  }");
  });
  tables.forEach(function (t) {
    (t.foreignKeys || []).forEach(function (fk) {
      var from = sanitizeMermaidToken(fk.referencesTable);
      var to = sanitizeMermaidToken(t.name);
      var label = sanitizeMermaidToken(fk.column);
      lines.push("  " + from + " ||--o{ " + to + ' : "' + label + '"');
    });
  });
  return lines.join("\n");
}

function isForeignKeyColumn(table, colName) {
  return (table.foreignKeys || []).some(function (fk) {
    return fk.column === colName;
  });
}

function renderSchemaFallbackHtml(tables) {
  var html = '<div class="dbviz-schema-fallback">';
  tables.forEach(function (t) {
    html += "<h4>" + escapeHtml(t.name) + " (" + escapeHtml(t.type) + ")</h4><ul>";
    (t.columns || []).forEach(function (c) {
      var flags = [];
      if (c.primaryKey) flags.push("PK");
      if (isForeignKeyColumn(t, c.name)) flags.push("FK");
      html +=
        "<li><code>" +
        escapeHtml(c.name) +
        "</code> — " +
        escapeHtml(c.declaredType || c.inferredType || "") +
        (flags.length ? " [" + flags.join(",") + "]" : "") +
        "</li>";
    });
    html += "</ul>";
    if ((t.foreignKeys || []).length > 0) {
      html += "<p>Relaciones: ";
      html += t.foreignKeys
        .map(function (fk) {
          return (
            "<code>" +
            escapeHtml(t.name) +
            "." +
            escapeHtml(fk.column) +
            " → " +
            escapeHtml(fk.referencesTable) +
            "." +
            escapeHtml(fk.referencesColumn) +
            "</code>"
          );
        })
        .join(", ");
      html += "</p>";
    }
  });
  html += "</div>";
  return html;
}

// -------------------------------------------------------------------
// Tab "Stats" (Chart.js)
// -------------------------------------------------------------------
function destroyCharts() {
  STATE.charts.forEach(function (c) {
    try {
      c.destroy();
    } catch (e) {
      /* noop */
    }
  });
  STATE.charts = [];
}

var STATS_PALETTE = ["#2f6fed", "#33b679", "#f0a63a", "#e5534b", "#9b59d0", "#1abcbf", "#e07ba0", "#8a8f99"];

function renderStats() {
  var container = document.getElementById("dbviz-stats-container");
  destroyCharts();
  container.innerHTML = "";

  var full = currentSourceFull();
  if (!full || !full.tables || full.tables.length === 0) {
    container.innerHTML = '<div class="dbviz-empty-state">Sin datos para graficar en esta fuente.</div>';
    return;
  }
  if (!STATE.cfg.charts) {
    container.innerHTML = '<div class="dbviz-empty-state">Gráficas deshabilitadas (viewer.charts=false).</div>';
    return;
  }

  var tables = full.tables;
  var labels = tables.map(function (t) {
    return t.name;
  });

  container.innerHTML =
    '<div class="dbviz-stat-card"><h3>Filas por tabla</h3><canvas id="dbviz-chart-rows"></canvas></div>' +
    '<div class="dbviz-stat-card"><h3>Columnas por tabla</h3><canvas id="dbviz-chart-cols"></canvas></div>' +
    '<div class="dbviz-stat-card"><h3>Distribución de tipos inferidos</h3><canvas id="dbviz-chart-types"></canvas></div>';

  if (typeof Chart === "undefined") {
    container.innerHTML = '<div class="dbviz-empty-state">Chart.js no disponible.</div>';
    return;
  }

  var fg = getComputedStyle(document.documentElement).getPropertyValue("--dbviz-fg") || "#333";
  Chart.defaults.color = fg.trim() || "#333";

  STATE.charts.push(buildRowsChart(tables, labels));
  STATE.charts.push(buildColsChart(tables, labels));
  STATE.charts.push(buildTypesChart(tables));
}

// Barras: filas totales por tabla.
function buildRowsChart(tables, labels) {
  return new Chart(document.getElementById("dbviz-chart-rows"), {
    type: "bar",
    data: {
      labels: labels,
      datasets: [
        {
          label: "Filas totales",
          data: tables.map(function (t) {
            return t.rowCountTotal;
          }),
          backgroundColor: STATS_PALETTE[0],
        },
      ],
    },
    options: { responsive: true, plugins: { legend: { display: false } } },
  });
}

// Barras: cantidad de columnas por tabla.
function buildColsChart(tables, labels) {
  return new Chart(document.getElementById("dbviz-chart-cols"), {
    type: "bar",
    data: {
      labels: labels,
      datasets: [
        {
          label: "Columnas",
          data: tables.map(function (t) {
            return (t.columns || []).length;
          }),
          backgroundColor: STATS_PALETTE[1],
        },
      ],
    },
    options: { responsive: true, plugins: { legend: { display: false } } },
  });
}

// Torta: distribución de tipos inferidos sobre todas las columnas de la fuente.
function buildTypesChart(tables) {
  var typeCounts = {};
  tables.forEach(function (t) {
    (t.columns || []).forEach(function (c) {
      var k = c.inferredType || "string";
      typeCounts[k] = (typeCounts[k] || 0) + 1;
    });
  });
  var typeLabels = Object.keys(typeCounts);
  return new Chart(document.getElementById("dbviz-chart-types"), {
    type: "pie",
    data: {
      labels: typeLabels,
      datasets: [
        {
          data: typeLabels.map(function (k) {
            return typeCounts[k];
          }),
          backgroundColor: typeLabels.map(function (_, i) {
            return STATS_PALETTE[i % STATS_PALETTE.length];
          }),
        },
      ],
    },
    options: { responsive: true },
  });
}

// -------------------------------------------------------------------
// Tab "Acerca de"
// -------------------------------------------------------------------
function renderAbout() {
  var container = document.getElementById("dbviz-about-container");
  var m = STATE.manifest;
  var html = "<h2>dbviz — visualizador de bases de datos</h2>";
  html +=
    "<p>Generado el <code>" +
    escapeHtml(m.generatedAt || "") +
    "</code> con motor <code>" +
    escapeHtml((m.engine && m.engine.name) || "?") +
    "</code> (host <code>" +
    escapeHtml((m.engine && m.engine.host) || "?") +
    "</code>).</p>";

  html += aboutStatsTableHtml(m.stats || {});
  html += aboutWarningsHtml(m.warnings || []);

  html +=
    '<p style="margin-top:20px;color:var(--dbviz-fg-muted);font-size:12px;">Generado por dbviz — herramienta reutilizable de visualización de bases de datos. Ver <code>scripts/dbviz/README.md</code> en el proyecto de origen.</p>';

  container.innerHTML = html;
}

// Tabla de métricas globales del manifest, para la pestaña "Acerca de".
function aboutStatsTableHtml(stats) {
  var html = "<table><tr><th>Métrica</th><th>Valor</th></tr>";
  [
    ["Fuentes detectadas", stats.sourceCount],
    ["Fuentes extraídas", stats.sourceExtracted],
    ["Tablas totales", stats.tableCount],
    ["Filas totales (real)", stats.rowCountTotal],
    ["Filas incluidas (muestra)", stats.rowCountSample],
  ].forEach(function (row) {
    html += "<tr><td>" + escapeHtml(row[0]) + "</td><td>" + escapeHtml(row[1]) + "</td></tr>";
  });
  html += "</table>";
  return html;
}

// Lista de avisos del manifest (o "Sin avisos."), para la pestaña "Acerca de".
function aboutWarningsHtml(warnings) {
  if (warnings.length === 0) {
    return "<p>Sin avisos.</p>";
  }
  var html = "<h3>Avisos (" + warnings.length + ")</h3><ul>";
  warnings.forEach(function (w) {
    html +=
      "<li><code>" +
      escapeHtml(w.code) +
      "</code> " +
      escapeHtml(w.message) +
      (w.sourceId ? " (fuente: " + escapeHtml(w.sourceId) + ")" : "") +
      "</li>";
  });
  html += "</ul>";
  return html;
}

// -------------------------------------------------------------------
// Estado vacío (sin fuentes detectadas)
// -------------------------------------------------------------------
function renderEmptyState() {
  document.getElementById("dbviz-table-list").innerHTML = "";
  document.getElementById("dbviz-grid").innerHTML =
    '<div class="dbviz-empty-state">No se detectaron bases de datos en este proyecto. Corré <code>dbviz.sh detect</code> para revisar, o editá <code>dbviz.config.json</code> para agregar fuentes manualmente.</div>';
  document.getElementById("dbviz-table-title").textContent = "";
  document.getElementById("dbviz-sample-banner").hidden = true;
}
