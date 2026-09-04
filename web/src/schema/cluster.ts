/**
 * cluster-algorithm.ts
 * ---------------------------------------------------------------------------
 * Agrupa automáticamente las tablas de un esquema relacional en "temas"
 * visuales (clusters) para un diagrama entidad-relación, a partir del grafo
 * de foreign keys (tabla hija --FK--> tabla padre).
 *
 * Algoritmo: Louvain (maximización de modularidad, multi-nivel), reescrito
 * a mano sin ninguna dependencia externa y SIN ninguna fuente de
 * aleatoriedad: en cada pasada, los nodos y las comunidades candidatas se
 * visitan siempre en un orden fijo (orden alfabético de nombre de tabla / id
 * de comunidad), así que la salida es 100% determinista para una misma
 * entrada, sin necesitar semilla ni PRNG.
 *
 * EVIDENCIA EXPERIMENTAL (ver <scratch>/report-algoritmos.md):
 * - Se comparó contra Leiden (CPM y modularidad, con y sin ponderar aristas
 *   hacia hubs), label propagation, greedy modularity (CNM) y variantes con
 *   exclusión dura de tablas "hub" (alto grado).
 * - Sobre dos versiones reales del mismo esquema Rails (51 y 52 tablas, que
 *   difieren en 2 tablas), Louvain con resolution=1.0 y peso = cantidad de
 *   FKs entre cada par de tablas dio:
 *     - Determinismo: idéntico en 30/30 corridas.
 *     - Estabilidad: ARI = 1.000 entre ambas versiones (ningún par de tablas
 *       cambió de "juntas" a "separadas" al agregar/quitar 2 tablas).
 *     - Legibilidad: 9 y 10 grupos respectivamente, tamaños entre 1 y 11
 *       tablas (todos dentro del rango objetivo 4-10 grupos).
 * - Tratamiento de hubs: se probó (a) excluir del grafo las tablas de alto
 *   grado y reinsertarlas después, y (b) ponderar las aristas para penalizar
 *   conexiones hacia hubs. AMBOS tratamientos empeoraron el resultado: (a)
 *   fragmentó el esquema en 18 grupos (muchos de 1 sola tabla), porque hay
 *   tablas cuya ÚNICA relación es con el hub (p. ej. logs, admin_notes solo
 *   referencian a "users"): al sacar el hub, esas tablas quedan aisladas.
 *   (b) subió la cantidad de grupos a 12-22 sin mejorar la estabilidad de
 *   forma consistente. Por eso esta implementación NO excluye ni penaliza
 *   hubs para el clustering: los deja participar normalmente en la
 *   modularidad (que ya los asigna a la comunidad más razonable disponible)
 *   y en cambio expone `identifyHubs()` como ayuda puramente VISUAL: el
 *   caller puede usarla para dibujar esas tablas con un estilo distinto
 *   (borde punteado, badge "compartida", etc.) sin moverlas de cluster.
 */

// ---------------------------------------------------------------------------
// Tipos de entrada (coinciden con el formato exportado por el introspector
// de esquema: { entities: [...], relations: [...] })
// ---------------------------------------------------------------------------

export interface SchemaField {
  name: string;
  type?: string;
  nullable?: boolean;
  primaryKey?: boolean;
}

export interface SchemaEntity {
  name: string;
  fields?: SchemaField[];
}

/** relación HIJO -> PADRE: `from` tiene la foreign key, `to` es la tabla referenciada. */
export interface SchemaRelation {
  from: string;
  to: string;
  fromField?: string;
  onDelete?: string | null;
}

export interface ClusterOptions {
  /**
   * Resolución de modularidad (parámetro γ de Reichardt-Bornholdt).
   * >1 produce más grupos más chicos, <1 produce menos grupos más grandes.
   * Default recomendado (y el usado en la evaluación experimental): 1.0.
   */
  resolution?: number;
  /** Tope de pasadas de "local moving" por nivel, red de seguridad anti-loop. Default 100. */
  maxPassesPerLevel?: number;
  /** Tope de niveles de agregación, red de seguridad anti-loop. Default 20. */
  maxLevels?: number;
}

export interface HubOptions {
  /**
   * Umbral de grado (cantidad de relaciones FK, contando ambos extremos, sin
   * contar auto-referencias) a partir del cual una tabla se considera "hub".
   * Default: max(6, ceil(2 * sqrt(cantidadDeTablas))) — calibrado para que en
   * un esquema de ~50 tablas típico solo capture 1-2 tablas realmente
   * centrales (en los datos de referencia: "users").
   */
  degreeThreshold?: number;
}

// ---------------------------------------------------------------------------
// Construcción del grafo no dirigido y ponderado
// ---------------------------------------------------------------------------

/**
 * Agrega las relaciones (dirigidas, hijo->padre, posiblemente con múltiples
 * FKs entre el mismo par de tablas) en un grafo NO dirigido donde el peso de
 * cada arista es la cantidad de relaciones FK entre ese par de tablas.
 * Las auto-referencias (from === to, p. ej. árboles: folders.parent_id ->
 * folders) se ignoran: no aportan información sobre a qué "tema" pertenece
 * la tabla frente a las demás.
 */
function buildWeightedAdjacency(
  entities: SchemaEntity[],
  relations: SchemaRelation[]
): { nodes: string[]; adjacency: Map<string, Map<string, number>> } {
  const nodeSet = new Set<string>();
  for (const e of entities) nodeSet.add(e.name);
  // por si una relación referencia una tabla no listada en entities, la sumamos igual
  for (const r of relations) {
    nodeSet.add(r.from);
    nodeSet.add(r.to);
  }
  const nodes = Array.from(nodeSet).sort(); // orden fijo, no depende del Set

  const adjacency = new Map<string, Map<string, number>>();
  for (const n of nodes) adjacency.set(n, new Map());

  const addEdge = (a: string, b: string, weight: number): void => {
    const am = adjacency.get(a)!;
    am.set(b, (am.get(b) ?? 0) + weight);
    const bm = adjacency.get(b)!;
    bm.set(a, (bm.get(a) ?? 0) + weight);
  };

  for (const r of relations) {
    if (r.from === r.to) continue; // auto-referencia, se ignora
    addEdge(r.from, r.to, 1);
  }

  return { nodes, adjacency };
}

// ---------------------------------------------------------------------------
// Louvain determinista (sin PRNG): multi-nivel, orden de visita siempre
// alfabético (por nombre de tabla / id de comunidad canónico).
// ---------------------------------------------------------------------------

interface LevelGraph {
  nodes: string[]; // siempre mantenido ordenado
  adjacency: Map<string, Map<string, number>>;
  nodeWeight: Map<string, number>; // grado ponderado de cada nodo (suma de pesos incidentes)
  totalWeight: number; // 2m = suma de todos los grados ponderados
}

function buildLevelGraph(nodes: string[], adjacency: Map<string, Map<string, number>>): LevelGraph {
  const nodeWeight = new Map<string, number>();
  let totalWeight = 0;
  for (const n of nodes) {
    let w = 0;
    for (const wt of adjacency.get(n)!.values()) w += wt;
    nodeWeight.set(n, w);
    totalWeight += w;
  }
  return { nodes: [...nodes].sort(), adjacency, nodeWeight, totalWeight };
}

/**
 * Los tres números que gobiernan la corrida de Louvain: la resolución de
 * modularidad y los dos topes anti-loop. Es `ClusterOptions` ya resuelto
 * (sin opcionales), y viaja entero por los tres niveles del algoritmo en vez
 * de repartirse como parámetros sueltos que hay que reordenar bien.
 */
interface LouvainSettings {
  /** γ de Reichardt-Bornholdt: >1 más grupos y más chicos, <1 menos y más grandes. */
  resolution: number;
  /** Tope de pasadas de "local moving" dentro de un nivel. */
  maxPassesPerLevel: number;
  /** Tope de niveles de agregación. */
  maxLevels: number;
}

/**
 * Peso total (k_i,in) de `node` hacia cada comunidad vecina. Los vecinos se
 * recorren en orden alfabético fijo para que el resultado no dependa del
 * orden de iteración del Map de adyacencia.
 */
function neighborCommunityWeights(
  graph: LevelGraph,
  community: Map<string, string>,
  node: string
): Map<string, number> {
  const neighborWeight = new Map<string, number>();
  const adjacency = graph.adjacency.get(node)!;
  for (const nb of Array.from(adjacency.keys()).sort()) {
    if (nb === node) continue; // self-loop defensivo
    const c = community.get(nb)!;
    neighborWeight.set(c, (neighborWeight.get(c) ?? 0) + adjacency.get(nb)!);
  }
  return neighborWeight;
}

/**
 * Una "pasada de nivel": mueve nodos entre comunidades mientras mejore la
 * modularidad, visitando siempre los nodos en orden alfabético fijo (nunca
 * el orden de inserción de un Map/Set ni un orden aleatorio).
 * Devuelve la asignación final community: Map<nodo, idComunidad> y si hubo
 * al menos un movimiento en toda la pasada.
 */
function runLocalMoving(
  graph: LevelGraph,
  settings: LouvainSettings
): { community: Map<string, string>; changed: boolean } {
  const community = new Map<string, string>();
  for (const n of graph.nodes) community.set(n, n); // cada nodo arranca en su propia comunidad

  const commTotal = new Map<string, number>();
  for (const n of graph.nodes) {
    const c = community.get(n)!;
    commTotal.set(c, (commTotal.get(c) ?? 0) + graph.nodeWeight.get(n)!);
  }

  let anyChangeEver = false;
  const m2 = graph.totalWeight;
  if (m2 === 0) return { community, changed: false };

  for (let pass = 0; pass < settings.maxPassesPerLevel; pass++) {
    let improved = false;

    for (const node of graph.nodes) {
      // graph.nodes ya está ordenado alfabéticamente de forma fija
      const curComm = community.get(node)!;
      const kNode = graph.nodeWeight.get(node)!;

      // sacar temporalmente al nodo de su comunidad actual
      commTotal.set(curComm, (commTotal.get(curComm) ?? 0) - kNode);

      const neighborWeight = neighborCommunityWeights(graph, community, node);

      // candidatas: comunidad actual + comunidades vecinas, en orden alfabético
      const candidates = new Set<string>(neighborWeight.keys());
      candidates.add(curComm);
      const sortedCandidates = Array.from(candidates).sort();

      let bestComm = curComm;
      let bestGain = -Infinity;
      for (const c of sortedCandidates) {
        const kIn = neighborWeight.get(c) ?? 0;
        const sigmaTot = commTotal.get(c) ?? 0;
        const gain = kIn - (settings.resolution * sigmaTot * kNode) / m2;
        // desempate determinista: en igualdad estricta, se prefiere la
        // comunidad ya visitada primero en orden alfabético (sortedCandidates
        // ya garantiza eso al usar '>' estricto, no '>=')
        if (gain > bestGain + 1e-12) {
          bestGain = gain;
          bestComm = c;
        }
      }

      commTotal.set(bestComm, (commTotal.get(bestComm) ?? 0) + kNode);
      community.set(node, bestComm);
      if (bestComm !== curComm) {
        improved = true;
        anyChangeEver = true;
      }
    }

    if (!improved) break;
  }

  return { community, changed: anyChangeEver };
}

/**
 * Bautiza cada comunidad con el nombre de tabla alfabéticamente menor entre
 * sus miembros: así el id de super-nodo es trazable hasta una tabla real y
 * estable entre corridas, en vez de un contador arbitrario.
 *
 * @returns community-id-actual -> super-node-id
 */
function nameSuperNodes(graph: LevelGraph, community: Map<string, string>): Map<string, string> {
  const groups = new Map<string, string[]>();
  for (const n of graph.nodes) {
    const c = community.get(n)!;
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c)!.push(n);
  }

  const superIdOf = new Map<string, string>();
  for (const [c, members] of groups) {
    superIdOf.set(c, [...members].sort()[0]);
  }
  return superIdOf;
}

/**
 * Agrega el grafo de nivel actual según las comunidades encontradas: cada
 * comunidad se convierte en un super-nodo cuyo id es, de forma determinista,
 * el nombre de tabla original más chico alfabéticamente entre sus miembros
 * (así el id de super-nodo es trazable y estable, no un contador arbitrario).
 *
 * IMPORTANTE (bug corregido durante la validación): el peso ("grado") de
 * cada super-nodo se calcula sumando los pesos de sus miembros ORIGINALES
 * (`graph.nodeWeight`), NO recalculándolo a partir de la adyacencia nueva.
 * La adyacencia nueva excluye a propósito las aristas internas de la
 * comunidad (self-loops, que no aportan nada a la decisión de mover un nodo
 * a otra comunidad), pero esas aristas SÍ forman parte del grado total del
 * super-nodo y de `totalWeight` (2m), que debe conservarse igual en todos
 * los niveles de agregación. Si se recalcula el peso solo a partir de la
 * adyacencia recortada, el grado de los super-nodos con mucha estructura
 * interna queda subestimado, el término de penalización de la resolución
 * (`resolution * commTotal * k_i / m2`) se vuelve artificialmente chico, y
 * el algoritmo termina fusionando de más en los niveles siguientes (en la
 * práctica: todo el esquema colapsaba en 1 sólo cluster gigante).
 */
function aggregateGraph(
  graph: LevelGraph,
  community: Map<string, string>
): { next: LevelGraph; superNodeOf: Map<string, string> } {
  const superIdOf = nameSuperNodes(graph, community);
  const superNodes = Array.from(new Set(superIdOf.values())).sort();

  const newAdjacency = new Map<string, Map<string, number>>();
  for (const sn of superNodes) newAdjacency.set(sn, new Map());

  // peso de cada super-nodo = suma de los pesos ORIGINALES de sus miembros
  // (conserva el total exacto de la red en cada nivel; ver comentario arriba)
  const newNodeWeight = new Map<string, number>();
  for (const sn of superNodes) newNodeWeight.set(sn, 0);

  for (const n of graph.nodes) {
    const sn = superIdOf.get(community.get(n)!)!;
    newNodeWeight.set(sn, newNodeWeight.get(sn)! + graph.nodeWeight.get(n)!);
    for (const [nb, wt] of graph.adjacency.get(n)!) {
      const snb = superIdOf.get(community.get(nb)!)!;
      if (snb === sn) continue; // self-loop intra-comunidad: no afecta el ranking de "a qué comunidad moverse"
      const m = newAdjacency.get(sn)!;
      m.set(snb, (m.get(snb) ?? 0) + wt);
    }
  }

  let newTotalWeight = 0;
  for (const w of newNodeWeight.values()) newTotalWeight += w;

  const next: LevelGraph = {
    nodes: superNodes,
    adjacency: newAdjacency,
    nodeWeight: newNodeWeight,
    totalWeight: newTotalWeight,
  };

  // `superIdOf` YA es el mapping comunidad-actual -> super-nodo que el caller
  // necesita para propagar el membership global; no hace falta copiarlo.
  return { next, superNodeOf: superIdOf };
}

/**
 * Corre el Louvain multi-nivel completo y devuelve, para cada tabla
 * original, el id de super-nodo final (un nombre de tabla, no un número).
 */
function louvainRepresentative(
  nodes: string[],
  adjacency: Map<string, Map<string, number>>,
  settings: LouvainSettings
): Map<string, string> {
  // membership global: tabla original -> id del super-nodo que la representa en el nivel actual
  const membership = new Map<string, string>();
  for (const n of nodes) membership.set(n, n);

  let level = buildLevelGraph(nodes, adjacency);

  for (let iter = 0; iter < settings.maxLevels; iter++) {
    if (level.totalWeight === 0) break; // sin aristas: no hay nada más que agregar

    const { community, changed } = runLocalMoving(level, settings);
    if (!changed) break;

    const { next, superNodeOf } = aggregateGraph(level, community);

    // si la agregación no redujo la cantidad de nodos, no hay progreso: cortar
    if (next.nodes.length >= level.nodes.length) break;

    promoteMembership(membership, community, superNodeOf);
    level = next;
  }

  return membership;
}

/**
 * Reapunta cada tabla original al super-nodo que la representa en el nivel
 * recién agregado. Una tabla cuyo representante actual no aparece en la
 * partición del nivel (no debería pasar) se deja donde estaba en vez de
 * perderse: el mapa `membership` siempre queda total.
 */
function promoteMembership(
  membership: Map<string, string>,
  community: Map<string, string>,
  superNodeOf: Map<string, string>
): void {
  for (const [orig, curSuper] of membership) {
    const c = community.get(curSuper);
    if (c === undefined) continue;
    const sn = superNodeOf.get(c);
    if (sn !== undefined) membership.set(orig, sn);
  }
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

/**
 * Agrupa las tablas de un esquema en clusters temáticos usando Louvain
 * (maximización de modularidad) sobre el grafo de foreign keys, de forma
 * 100% determinista (mismo input -> mismo output siempre, sin PRNG).
 *
 * @param entities  Tablas del esquema (solo se usa `name`).
 * @param relations Relaciones FK hijo->padre.
 * @param options   `resolution` (default 1.0), límites de seguridad anti-loop.
 * @returns Map<nombreDeTabla, groupId> donde groupId es un entero 0..k-1,
 *          asignado de forma determinista (grupos ordenados por tamaño
 *          descendente y luego alfabéticamente por su primer miembro), para
 *          que el mismo cluster conceptual tienda a mantener el mismo id
 *          entre redibujados sucesivos del diagrama.
 */
export function clusterSchema(
  entities: SchemaEntity[],
  relations: SchemaRelation[],
  options: ClusterOptions = {}
): Map<string, number> {
  const resolution = options.resolution ?? 1.0;
  const maxPassesPerLevel = options.maxPassesPerLevel ?? 100;
  const maxLevels = options.maxLevels ?? 20;

  const { nodes, adjacency } = buildWeightedAdjacency(entities, relations);

  if (nodes.length === 0) return new Map();

  const membership = louvainRepresentative(nodes, adjacency, {
    resolution,
    maxPassesPerLevel,
    maxLevels,
  });

  // agrupar tablas por representative final
  const groups = new Map<string, string[]>();
  for (const n of nodes) {
    const rep = membership.get(n)!;
    if (!groups.has(rep)) groups.set(rep, []);
    groups.get(rep)!.push(n);
  }

  // orden canónico y determinista de los grupos: tamaño descendente, empate
  // por orden alfabético del primer miembro. Así, entre redibujados donde el
  // esquema no cambió, el groupId de cada cluster se mantiene estable.
  const orderedGroups = Array.from(groups.values())
    .map((members) => [...members].sort())
    .sort((a, b) => {
      if (b.length !== a.length) return b.length - a.length;
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });

  const result = new Map<string, number>();
  orderedGroups.forEach((members, groupId) => {
    for (const m of members) result.set(m, groupId);
  });

  return result;
}

/**
 * Identifica tablas "hub" (de grado alto) para que la UI las pueda destacar
 * visualmente (p. ej. borde distinto, badge "compartida") SIN excluirlas del
 * clustering ni recalcular nada: es un análisis puramente informativo,
 * independiente de `clusterSchema`.
 *
 * Justificación (ver report-algoritmos.md): excluir hubs del grafo antes de
 * clusterizar fragmenta el esquema, porque suele haber tablas cuya única FK
 * apunta al hub (logs, admin_notes -> users); ponderar para penalizar
 * aristas hacia hubs tampoco mejoró los resultados. La solución que
 * funcionó fue dejar que la modularidad decida (clusterSchema) y usar esta
 * función solo para estilizar, no para reparticionar.
 *
 * @param degreeThreshold Grado mínimo (cantidad de relaciones FK que tocan
 *   la tabla, sin contar auto-referencias) para considerarla hub. Default:
 *   max(6, ceil(2 * sqrt(cantidadDeTablas))).
 */
export function identifyHubs(
  entities: SchemaEntity[],
  relations: SchemaRelation[],
  options: HubOptions = {}
): Set<string> {
  const { nodes, adjacency } = buildWeightedAdjacency(entities, relations);
  const n = nodes.length;
  const defaultThreshold = Math.max(6, Math.ceil(2 * Math.sqrt(n)));
  const threshold = options.degreeThreshold ?? defaultThreshold;

  const hubs = new Set<string>();
  for (const node of nodes) {
    let degree = 0;
    for (const wt of adjacency.get(node)!.values()) degree += wt;
    if (degree >= threshold) hubs.add(node);
  }
  return hubs;
}
