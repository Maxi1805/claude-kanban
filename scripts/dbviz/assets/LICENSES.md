# Licencias de librerías vendorizadas

Este directorio (`assets/`) contiene 3 librerías de terceros, descargadas una
sola vez desde el registro público de npm (vía unpkg.com) y comiteadas como
archivos estáticos para que `dbviz` funcione 100% offline y autocontenido.
Ninguna se instala vía `npm install`; son binarios de texto (JS/CSS)
vendorizados tal cual, sin modificaciones.

Las tres están bajo licencia **MIT**, permisiva y compatible con uso
comercial/interno sin restricciones, sin requerir distribuir el código fuente
propio del proyecto anfitrión.

---

## Tabulator 6.5.2

- Archivos: `tabulator.min.js`, `tabulator.min.css`
- Origen: `https://unpkg.com/tabulator-tables@6.5.2/dist/js/tabulator.min.js`
  y `https://unpkg.com/tabulator-tables@6.5.2/dist/css/tabulator.min.css`
- Uso en dbviz: grid de datos (tab "Tablas") — orden, filtro, búsqueda,
  paginación y virtual scroll.
- Expone el global `Tabulator` al cargarse vía `<script>` clásico.

```
The MIT License (MIT)

Copyright (c) 2015-2026 Oli Folkerd

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Mermaid 11.16.0

- Archivo: `mermaid.min.js`
- Origen: `https://unpkg.com/mermaid@11.16.0/dist/mermaid.min.js`
- Uso en dbviz: tab "Esquema" — genera el diagrama ER (`erDiagram`) a partir
  de las foreign keys detectadas en la base de datos.
- Expone el global `mermaid` (`globalThis["mermaid"] = ...`) al cargarse vía
  `<script>` clásico; se invoca con `mermaid.render(...)`.

```
The MIT License (MIT)

Copyright (c) 2014 - 2022 Knut Sveidqvist

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Chart.js 4.5.1

- Archivo: `chart.umd.min.js`
- Origen: `https://unpkg.com/chart.js@4.5.1/dist/chart.umd.min.js`
- Uso en dbviz: tab "Stats" — barras de filas/columnas por tabla y pie de
  distribución de tipos inferidos.
- Expone el global `Chart` al cargarse vía `<script>` clásico.

```
The MIT License (MIT)

Copyright (c) 2014-2024 Chart.js Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
