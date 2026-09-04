/**
 * group-naming.ts
 * ----------------
 * Nombra automáticamente un grupo de tablas (una comunidad detectada por
 * Louvain/Leiden u otro algoritmo de clustering) SIN modelos de lenguaje,
 * SIN configuración manual y SIN dependencias externas. Todo sale de los
 * propios datos: los nombres de las tablas y las relaciones FK entre ellas.
 *
 * Diseño (heurística en cascada, evaluada y medida contra 5 grupos reales
 * de un esquema Rails de 51 tablas — ver report-librerias-y-nombres.md):
 *
 *   Tier 1 — Prefijo común estricto de tokens (snake_case), 100% de los
 *            miembros. Barato y muy preciso CUANDO existe, pero en la
 *            práctica casi nunca dispara: en esquemas Rails la tabla
 *            "hub" suele estar en plural sin sufijo ("forms") mientras
 *            sus tablas hijas usan el singular como prefijo compuesto
 *            ("form_answers", "form_questions") — son strings distintos
 *            ("form" != "forms"), así que el prefijo estricto por token
 *            se rompe en la posición 0 y da vacío. Por eso el Tier 2
 *            singulariza antes de comparar.
 *
 *   Tier 2 — Token más frecuente ENTRE TODAS LAS POSICIONES de los
 *            nombres, singularizando cada token antes de contar (así
 *            "forms" y "form_answers" SÍ coinciden en el token "form").
 *            Se acepta como ganador si cubre >= 50% de los miembros del
 *            grupo (mayoría simple). Medido sobre datos reales:
 *              forms  -> "form"  cobertura 75% (6/8)
 *              jobs   -> "job"   cobertura 100% (5/5)
 *              tags   -> "tag"   cobertura 80% (4/5)
 *              bookings/heterogéneo -> cobertura 22-29%, NO alcanza 50%
 *            En los dos últimos casos no hay "tema léxico" dominante y
 *            se cae al Tier 3.
 *
 *   Tier 3 — Fallback estructural (grafo, no texto): se construye el
 *            subgrafo inducido por el grupo (solo aristas entre
 *            miembros del propio grupo) y se elige la tabla con más
 *            "hijos" dentro del grupo (más tablas del grupo que la
 *            referencian como padre vía FK), desempatando por grado
 *            total (hijos + padres) y, en último caso, alfabéticamente
 *            para que el resultado sea 100% determinista.
 *            Se evaluó también PageRank dentro del subgrafo: en los 5
 *            grupos de prueba coincide siempre con "más hijos" (mismo
 *            ganador), así que no se justifica la complejidad extra de
 *            una iteración de PageRank para este caso de uso — se deja
 *            documentado en el reporte como alternativa equivalente.
 *            Sobre datos reales:
 *              bookings    -> "services"  (4 hijos dentro del grupo)
 *              heterogéneo -> "deals"     (3 hijos, empatado con
 *                                          "más grado" y con PageRank)
 *
 * Todas las funciones son puras: mismos argumentos -> mismo resultado,
 * sin I/O, sin Math.random, sin estado global.
 */

/** Forma mínima de una relación FK: HIJO (from) -> PADRE (to). Coincide
 *  estructuralmente con el formato real `{ from, fromField, to, ... }`,
 *  así que se le puede pasar el array de relaciones tal cual viene del
 *  extractor de esquema sin transformarlo. */
export interface GroupRelation {
  from: string;
  to: string;
}

export type NamingMethod =
  | 'common-prefix'      // Tier 1
  | 'frequent-token'     // Tier 2
  | 'graph-centrality'   // Tier 3
  | 'single-table'       // grupo de 1 sola tabla: no hace falta heurística
  | 'empty-group';       // grupo vacío (caso degenerado)

export interface GroupNameResult {
  /** Nombre final, humanizado y listo para mostrar (ej. "Forms", "Deals"). */
  name: string;
  /** Qué método ganó, para poder loguear/depurar/testear. */
  method: NamingMethod;
  /** Cobertura (0..1) del token o evidencia que sostiene el nombre.
   *  Para 'graph-centrality' es la fracción de aristas internas que
   *  tocan la tabla ganadora (proxy de "cuán central" es). */
  confidence: number;
  /** Tabla o token concreto que originó el nombre, para trazabilidad. */
  evidence: string;
}

const DEFAULT_TOKEN_COVERAGE_THRESHOLD = 0.5;

// ---------------------------------------------------------------------
// Tokenización y normalización morfológica (heurísticas simples, no un
// lematizador real — alcanza para snake_case en inglés estilo Rails).
// ---------------------------------------------------------------------

/** Parte un nombre de tabla snake_case en tokens no vacíos. */
function tokenize(name: string): string[] {
  return name.split('_').filter(Boolean);
}

/** Singulariza un token en inglés con reglas comunes (heurística, no
 *  diccionario): companies->company, properties->property, matches->match,
 *  forms->form, tags->tag, users->user. Deliberadamente conservadora. */
function singularize(word: string): string {
  if (word.length > 3 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.endsWith('ches') || word.endsWith('shes') || word.endsWith('xes') || word.endsWith('zes')) {
    return word.slice(0, -2);
  }
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** Pluraliza un token ya singular (inverso aproximado de singularize).
 *  Si ya termina en "s" se asume plural y se deja igual (evita
 *  "propertieses"). */
function pluralize(word: string): string {
  if (word.endsWith('s')) return word;
  if (word.length > 1 && word.endsWith('y') && !/[aeiou]y$/.test(word)) {
    return word.slice(0, -1) + 'ies';
  }
  if (/(ch|sh|x|z)$/.test(word)) return word + 'es';
  return word + 's';
}

/** snake_case o token suelto -> "Title Case con espacios" para mostrar. */
function humanize(token: string): string {
  return token
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ---------------------------------------------------------------------
// Tier 1: prefijo común estricto (por tokens) de TODOS los miembros.
// ---------------------------------------------------------------------
function commonPrefixTokens(members: string[]): string[] {
  const tokenLists = members.map(tokenize);
  const minLen = Math.min(...tokenLists.map((t) => t.length));
  const prefix: string[] = [];
  for (let i = 0; i < minLen; i++) {
    const candidate = tokenLists[0][i];
    if (tokenLists.every((toks) => toks[i] === candidate)) {
      prefix.push(candidate);
    } else {
      break;
    }
  }
  return prefix;
}

// ---------------------------------------------------------------------
// Tier 2: token más frecuente (cualquier posición), singularizando antes
// de contar. Cada nombre aporta cada token distinto una sola vez (para
// que una tabla con un token repetido, ej. "tags_relations" con dos
// "tag"s tras singularizar duplicados, no infle artificialmente el
// conteo).
// ---------------------------------------------------------------------
function mostFrequentSingularToken(members: string[]): { token: string; coverage: number } | null {
  if (members.length === 0) return null;
  const counts = new Map<string, number>();
  for (const name of members) {
    const uniqueTokens = new Set(tokenize(name).map(singularize));
    for (const tok of uniqueTokens) counts.set(tok, (counts.get(tok) ?? 0) + 1);
  }
  let bestToken = '';
  let bestCount = -1;
  // orden de inserción (Map preserva orden) + comparación estable ->
  // determinista ante empates (gana el primer token visto con ese conteo
  // máximo, siguiendo el orden de aparición de los miembros).
  for (const [tok, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      bestToken = tok;
    }
  }
  return { token: bestToken, coverage: bestCount / members.length };
}

// ---------------------------------------------------------------------
// Tier 3: centralidad dentro del subgrafo inducido por el grupo.
// ---------------------------------------------------------------------
interface CentralityRow {
  table: string;
  children: number; // cuántos miembros del grupo la referencian como padre (fan-in interno)
  degree: number;   // hijos + padres dentro del grupo (grado total interno)
}

function inducedCentrality(members: string[], relations: GroupRelation[]): CentralityRow[] {
  const memberSet = new Set(members);
  const children = new Map<string, number>(members.map((m) => [m, 0]));
  const degree = new Map<string, number>(members.map((m) => [m, 0]));

  for (const rel of relations) {
    if (rel.from === rel.to) continue; // auto-referencia: no aporta a "grupos"
    if (!memberSet.has(rel.from) || !memberSet.has(rel.to)) continue; // solo aristas internas
    children.set(rel.to, (children.get(rel.to) ?? 0) + 1);
    degree.set(rel.from, (degree.get(rel.from) ?? 0) + 1);
    degree.set(rel.to, (degree.get(rel.to) ?? 0) + 1);
  }

  return members
    .map((table) => ({
      table,
      children: children.get(table) ?? 0,
      degree: degree.get(table) ?? 0,
    }))
    .sort((a, b) => {
      if (b.children !== a.children) return b.children - a.children;
      if (b.degree !== a.degree) return b.degree - a.degree;
      return a.table.localeCompare(b.table); // desempate final: alfabético, 100% determinista
    });
}

// ---------------------------------------------------------------------
// Función pública
// ---------------------------------------------------------------------

/**
 * Deriva un nombre legible para un grupo de tablas a partir únicamente
 * de los nombres de las tablas y las relaciones FK entre ellas.
 *
 * @param members    Nombres de las tablas del grupo (ej. resultado de un
 *                    algoritmo de detección de comunidades).
 * @param relations  TODAS las relaciones del esquema (child -> parent);
 *                    la función filtra internamente las que caen dentro
 *                    del grupo. No hace falta pre-filtrar.
 * @param options.tokenCoverageThreshold  Umbral de cobertura (0..1) para
 *                    aceptar el Tier 2 antes de caer al Tier 3.
 *                    Por defecto 0.5 (mayoría simple), valor que separa
 *                    limpiamente los 5 grupos de prueba reales.
 */
export function nameGroup(
  members: string[],
  relations: GroupRelation[],
  options?: { tokenCoverageThreshold?: number }
): GroupNameResult {
  const threshold = options?.tokenCoverageThreshold ?? DEFAULT_TOKEN_COVERAGE_THRESHOLD;

  return (
    trivialName(members) ??
    commonPrefixName(members) ??
    frequentTokenName(members, threshold) ??
    graphCentralityName(members, relations)
  );
}

/**
 * Grupo vacío o de una sola tabla: no hay nada que inferir, la respuesta no
 * sale de ninguna heurística. `null` si el grupo tiene 2 o más tablas.
 */
function trivialName(members: string[]): GroupNameResult | null {
  if (members.length === 0) {
    return { name: 'Sin nombre', method: 'empty-group', confidence: 0, evidence: '' };
  }
  if (members.length === 1) {
    return {
      name: humanize(members[0]),
      method: 'single-table',
      confidence: 1,
      evidence: members[0],
    };
  }
  return null;
}

/** Tier 1: prefijo común estricto — `null` si no todas las tablas lo comparten. */
function commonPrefixName(members: string[]): GroupNameResult | null {
  const prefix = commonPrefixTokens(members);
  if (prefix.length === 0) return null;
  const label = prefix.join('_');
  return {
    name: humanize(pluralize(label)),
    method: 'common-prefix',
    confidence: 1,
    evidence: label,
  };
}

/** Tier 2: token singularizado más frecuente — `null` si no llega al umbral. */
function frequentTokenName(members: string[], threshold: number): GroupNameResult | null {
  const freq = mostFrequentSingularToken(members);
  if (!freq || freq.coverage < threshold) return null;
  return {
    name: humanize(pluralize(freq.token)),
    method: 'frequent-token',
    confidence: freq.coverage,
    evidence: freq.token,
  };
}

/**
 * Tier 3: fallback estructural — la tabla con más hijos dentro del grupo.
 * Es el último escalón, así que siempre devuelve un nombre: nunca `null`.
 */
function graphCentralityName(members: string[], relations: GroupRelation[]): GroupNameResult {
  const centrality = inducedCentrality(members, relations);
  const winner = centrality[0];
  const totalInternalEdges = centrality.reduce((acc, row) => acc + row.children, 0) || 1;
  return {
    name: humanize(winner.table),
    method: 'graph-centrality',
    confidence: winner.children / totalInternalEdges,
    evidence: winner.table,
  };
}
