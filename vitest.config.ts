import { configDefaults, defineConfig } from "vitest/config";

/**
 * OLA G — POR QUÉ ESTE ARCHIVO EXISTE, Y POR QUÉ NO EXISTÍA ANTES.
 *
 * Hasta esta ola el proyecto no tenía configuración de vitest: `npx vitest run`
 * usaba el `include` por defecto (`**\/*.{test,spec}.?(c|m)[jt]s?(x)`) y eso
 * alcanzaba, porque todo lo que hay bajo la raíz del repo es código de este
 * analizador.
 *
 * Esta ola clonó el corpus DENTRO del repo (`corpus/`, 8 repos externos a su
 * SHA fijo del manifiesto). Ocho proyectos reales traen sus PROPIOS tests, y
 * el `include` por defecto los levanta: medido en la primera corrida de esta
 * ola, `npx vitest run` pasó de 179 archivos a **500**, con **254 archivos
 * fallando** (casi todos por errores de COLECCIÓN — dependencias que esos
 * repos declaran y este `node_modules` no tiene) y 29 tests rojos de
 * `corpus/vueuse` que dependen de un entorno de navegador. Ninguno de esos
 * rojos dice nada sobre el analizador; lo único que hacen es volver ilegible
 * la compuerta (la línea base documentada, 2.556/1/37, deja de ser
 * comparable) y multiplicar por tres el tiempo de la suite.
 *
 * El corpus es MATERIAL DE MEDICIÓN del analizador, no una suite hermana: se
 * lee con `analyzeRepo`, nunca se ejecuta. Por eso se excluye del
 * descubrimiento de tests, y no al revés (no se mueve el corpus fuera del
 * repo: `tests/golden/manifest.json` lo referencia como `corpus/<slug>` y
 * `CK_CORPUS_DIR` apunta a la raíz que lo contiene).
 *
 * Se conservan los defaults de vitest para todo lo demás — `include` sigue
 * siendo el de fábrica, y `exclude` es `configDefaults.exclude` MÁS `corpus`,
 * para no perder ninguna exclusión estándar (node_modules, dist, .git…).
 * Verificado: con esto la corrida de raíz vuelve a descubrir exactamente los
 * mismos archivos que `npx vitest run src tests scripts web`, que es como los
 * frentes venían midiendo a mano.
 *
 * OLA X (integrador) — `corpus-app/` es la MISMA decisión, un directorio más
 * tarde. Cuando entraron poblaciones de APLICACIÓN al árbol (`corpus-app/gitea`,
 * `jenkins`, `redmine`) el `exclude` no las cubría, y la suite pasó de 199 a
 * 275 archivos con ~76 rojos que son los tests del propio Gitea fallando por
 * falta de `navigator`/`jQuery` en Node. Ninguno dice nada sobre el analizador
 * y la línea base documentada ("3 fail / 0 skip") dejaba de ser comparable —
 * exactamente el problema que este archivo existe para evitar. Mismo criterio,
 * misma razón: el corpus se LEE con `analyzeRepo`, nunca se ejecuta.
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "corpus/**", "corpus-app/**", "scratchpad*/**"],
    // `scratchpad*/**`: los frentes sacan copias enteras del arbol para comparar corridas
    // (la Ola AI dejo scratchpad-ai1/arbol0 y arbol1). Sin esto vitest recoge SUS tests
    // —son .test.mts, no .test.ts— y suma rojos que no son de produccion.
  },
});
