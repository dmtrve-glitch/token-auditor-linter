figma.showUI(__html__, { width: 520, height: 420 });


type Issue = {
   ruleId:
    | "fill-not-variable"
    | "fill-is-style"
    | "fill-is-variable"
    | "stroke-not-variable"
    | "stroke-is-style"
    | "stroke-is-variable"


  message: string;
  nodeId: string;
  nodeName: string;
  nodeType: SceneNode["type"];
  issueDomain: "FILL" | "STROKE" | "NUMERIC";
  fillValue?: string;
  nodeFillValue?: string; // реальный Fill ноды для отображения в карточке (может быть "—")
  fillEnabled?: boolean; // true = paint.visible !== false (если visible нет — считаем включенным)
  nodeOpacity?: number;
  strokeValue?: string;
  fillStyleName?: string;
  fillStyleSource?: "LOCAL" | "EXTERNAL";
  fillVariableName?: string;
  fillVariableId?: string;
  fillVariableSource?: "LOCAL" | "EXTERNAL";
  fillSourceKind?: "RAW" | "STYLE" | "VARIABLE";
  nodeFillEnabled?: boolean;
  nodeStrokeValue?: string;
  nodeStrokeEnabled?: boolean;
};

figma.notify("Token Auditor & Linter: запустился ✅");

let localPaintStyleIds: Set<string> = new Set();
let styleNameById: Map<string, string> = new Map();
let localVariableIds: Set<string> = new Set();
let variableNameById: Map<string, string> = new Map();
let paletteCandidatesCache: PaletteCandidate[] = [];


type RGBAColor = { r: number; g: number; b: number; a: number };

type PaletteCandidate = {
  kind: "STYLE" | "VARIABLE";
  id: string;
  name: string;
  rgba: RGBAColor ;
  // metadata (future: private/public collections)
  collectionId?: string;
  collectionName?: string;
};

function resolveStyleName(styleId: string): string | undefined {
  const cached = styleNameById.get(styleId);
  if (cached) return cached;

  try {
    const s = figma.getStyleById(styleId);
    if (s && typeof s.name === "string" && s.name.trim()) {
      styleNameById.set(styleId, s.name);
      return s.name;
    }
  } catch (e) {
    // ignore
  }

  return undefined;
}


function isRGBAValue(v: unknown): v is { r: number; g: number; b: number; a?: number } {
  return (
    !!v &&
    typeof v === "object" &&
    "r" in v &&
    "g" in v &&
    "b" in v &&
    typeof (v as any).r === "number" &&
    typeof (v as any).g === "number" &&
    typeof (v as any).b === "number"
  );
}

function isVariableAliasValue(v: any): v is { type: "VARIABLE_ALIAS"; id: string } {
  return v && typeof v === "object" && v.type === "VARIABLE_ALIAS" && typeof v.id === "string";
}

async function pickFirstModeColorValue(variable: Variable, depth = 0): Promise<RGBAColor | null> {
  if (depth > 6) return null; // защита от циклов алиасов

  const modeIds = Object.keys(variable.valuesByMode ?? {});
  if (modeIds.length === 0) return null;

  const modeId = modeIds[0];
  const v = (variable.valuesByMode as any)[modeId];

  if (isRGBAValue(v)) {
    return { r: v.r, g: v.g, b: v.b, a: typeof v.a === "number" ? v.a : 1 };
  }

  // NEW: resolve VARIABLE_ALIAS
  if (isVariableAliasValue(v)) {
    const target = await figma.variables.getVariableByIdAsync(v.id);
    if (!target) return null;

    const targetModeIds = Object.keys(target.valuesByMode ?? {});
    if (targetModeIds.length === 0) return null;

    // пробуем тот же modeId, иначе первый доступный
    const tv =
      (target.valuesByMode as any)[modeId] ??
      (target.valuesByMode as any)[targetModeIds[0]];

    if (isRGBAValue(tv)) {
      return { r: tv.r, g: tv.g, b: tv.b, a: typeof tv.a === "number" ? tv.a : 1 };
    }

    if (isVariableAliasValue(tv)) {
      const next = await figma.variables.getVariableByIdAsync(tv.id);
      if (!next) return null;
      return pickFirstModeColorValue(next, depth + 1);
    }

    return null;
  }

  return null;
}


function extractSolidFromPaintStyle(style: PaintStyle): RGBAColor | null {
  const paints = style.paints ?? [];
  if (!paints.length) return null;

  const p = paints[0];
  if (p.type !== "SOLID") return null;

  const a = (p as SolidPaint).opacity ?? 1;
return { r: p.color.r, g: p.color.g, b: p.color.b, a };
}

async function getLocalPaletteCandidates(): Promise<PaletteCandidate[]> {
  const out: PaletteCandidate[] = [];

  // local color variables (async API)
  const localColorVars = await figma.variables.getLocalVariablesAsync("COLOR");
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const collectionNameById = new Map(collections.map(c => [c.id, c.name]));

  for (const v of localColorVars) {
    const rgba = await pickFirstModeColorValue(v);
    if (!rgba) continue;
    out.push({
  kind: "VARIABLE",
  id: v.id,
  name: v.name,
  rgba,
  collectionId: v.variableCollectionId,
  collectionName: collectionNameById.get(v.variableCollectionId) ?? "(unknown)",
});
  }
  return out;
}

// Приводим RGBA (0..1) к стабильному строковому ключу
// Используем округление до 0–255, alpha тоже учитываем
function rgbaToKey(c: RGBAColor): string {
  const r = Math.round(c.r * 255);
  const g = Math.round(c.g * 255);
  const b = Math.round(c.b * 255);
  const a = Math.round(c.a * 255);
  return `${r},${g},${b},${a}`;
}

// Извлекаем RGBAColor из RAW fill
// IMAGE сюда не должен доходить — его мы не матчим
function extractRGBAFromRawFill(fill: Paint): RGBAColor | null {
  if (fill.type !== "SOLID") return null;

  const a = fill.opacity ?? 1;
  return {
    r: fill.color.r,
    g: fill.color.g,
    b: fill.color.b,
    a,
  };
}

type PaletteMatch = {
  kind: "STYLE" | "VARIABLE";
  id: string;
  name: string;
  distance: number;
};

function srgbToLinear(c: number): number {
  // c в диапазоне 0..1
  if (c <= 0.04045) return c / 12.92;
  return Math.pow((c + 0.055) / 1.055, 2.4);
}

function rgbaDistance(a: RGBAColor, b: RGBAColor): number {
  // сравниваем в linear RGB, alpha оставляем как есть (0..1)
  const ar = srgbToLinear(a.r);
  const ag = srgbToLinear(a.g);
  const ab = srgbToLinear(a.b);

  const br = srgbToLinear(b.r);
  const bg = srgbToLinear(b.g);
  const bb = srgbToLinear(b.b);

  const dr = ar - br;
  const dg = ag - bg;
  const db = ab - bb;
  const da = a.a - b.a;

  // масштабирую на 1000 просто чтобы distance был “человеческим” числом, порядок не важен
  return Math.sqrt(dr * dr + dg * dg + db * db + da * da) * 1000;
}


function findClosestPaletteCandidates(
  raw: RGBAColor,
  candidates: PaletteCandidate[],
  limit = 5
): PaletteMatch[] {
  return candidates
    .map((c) => ({
      kind: c.kind,
      id: c.id,
      name: c.name,
      distance: rgbaDistance(raw, c.rgba),
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);
}

type RawSuggestion = {
  kind: "STYLE" | "VARIABLE";
  id: string;
  name: string;
  distance: number;
  rgba?: RGBAColor; // чтобы UI мог рисовать реальный свотч кандидата
};


type RawSuggestionsByHex = Record<string, RawSuggestion[]>;

// hex "#RRGGBB" или "#RRGGBBAA" -> RGBAColor (0..1)
function hexToRGBAColor(hex: string): RGBAColor | null {
  const h = hex.trim().replace(/^#/, "");
  if (!(h.length === 6 || h.length === 8)) return null;

  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255;

  if ([r, g, b, a].some((n) => Number.isNaN(n))) return null;

  return { r: r / 255, g: g / 255, b: b / 255, a: a / 255 };
}

// ============================================================
// 1) CONSTANTS: какие типы нод поддерживаем (fills / strokes)
// ============================================================
const FILL_SUPPORTED_NODE_TYPES: SceneNode["type"][] = [
  "TEXT",
  "RECTANGLE",
  "ELLIPSE",
  "FRAME",
  "COMPONENT",
  "COMPONENT_SET",
  "INSTANCE",
  "VECTOR",
  "POLYGON",
  "STAR"
];

const STROKE_SUPPORTED_NODE_TYPES: SceneNode["type"][] = [
  "RECTANGLE",
  "ELLIPSE",
  "POLYGON",
  "STAR",
  "VECTOR",
  "TEXT",
  "FRAME",
  "COMPONENT",
  "INSTANCE",
  "GROUP",
  "LINE",
];

// ============================================================
// 2) UTILS: маленькие вспомогательные функции (не rules)
// ============================================================

// собирает все ноды
function collectNodesDeep(nodes: readonly SceneNode[]): SceneNode[] {
  const out: SceneNode[] = [];

  const visit = (node: SceneNode) => {
    out.push(node);

    // Если у ноды есть дети (FRAME/GROUP/COMPONENT/INSTANCE и т.п.)
    if ("children" in node) {
      for (const child of node.children) visit(child);
    }
  };

  for (const n of nodes) visit(n);
  return out;
}

// нормализация цветов
function toHex01(v: number) {
  return Math.round(v * 255).toString(16).padStart(2, "0");
}

function formatSolidPaint(p: SolidPaint): string {
  const { r, g, b } = p.color;
  const opacity = p.opacity ?? 1;

  let s = `#${toHex01(r)}${toHex01(g)}${toHex01(b)}`.toUpperCase();
  if (opacity < 1) s += ` @ ${Math.round(opacity * 100)}%`;
  return s;
}

type RawColor = {
  hex: string;      // "#RRGGBB"
  alpha: number;    // 0..1
  count: number;    // сколько раз встретилось
};
function solidToHex(p: SolidPaint): string {
  const { r, g, b } = p.color;
  return `#${toHex01(r)}${toHex01(g)}${toHex01(b)}`.toUpperCase();
}
function aggregateSolidFills(nodes: SceneNode[]): RawColor[] {
  const map = new Map<string, RawColor>();

  for (const node of nodes) {
    if (!("fills" in node)) continue;

    const fills = node.fills;
    if (fills === figma.mixed) continue;
    if (!Array.isArray(fills) || fills.length === 0) continue;

    for (const paint of fills) {
      if (!paint) continue;
      if (paint.type !== "SOLID") continue;

      const alpha = paint.opacity ?? 1;
      if (alpha <= 0) continue;

      const hex = solidToHex(paint);
      const key = `${hex}@${Math.round(alpha * 100)}`;

      const existing = map.get(key);
      if (existing) existing.count += 1;
      else map.set(key, { hex, alpha, count: 1 });
    }
  }

  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}
function ruleIdToDomain(ruleId: Issue["ruleId"]): Issue["issueDomain"] {
  if (ruleId.startsWith("stroke-")) return "STROKE";
  if (ruleId.startsWith("fill-")) return "FILL";
  return "NUMERIC";
}
function describePrimaryFill(fills: readonly Paint[]) {
  // берём первый "живой" paint (не полностью прозрачный)
  const p = fills.find((x) => (x?.opacity ?? 1) > 0);
  if (!p) return { fillValue: undefined as string | undefined, fillEnabled: undefined as boolean | undefined };

  const fillEnabled = (p as any).visible !== false;

  if (p.type === "SOLID") {
  const rgba = extractRGBAFromRawFill(p as SolidPaint);
  
  if (rgba && paletteCandidatesCache.length) {
  const matches = findClosestPaletteCandidates(rgba, paletteCandidatesCache, 3);

}
  
  return { fillValue: formatSolidPaint(p as SolidPaint), fillEnabled };
}

  if (p.type === "IMAGE") return { fillValue: "image", fillEnabled };

  // на будущее: GRADIENT_* / VIDEO и т.п.
  return { fillValue: p.type.toLowerCase(), fillEnabled };
}

function describePrimaryStroke(strokes: readonly Paint[]) {
  // берём первый "живой" paint (не полностью прозрачный)
  const p = strokes.find((x) => (x?.opacity ?? 1) > 0);
  if (!p) return { strokeValue: undefined as string | undefined };

  if (p.type === "SOLID") {
    return { strokeValue: formatSolidPaint(p as SolidPaint) };
  }

  return { strokeValue: "(non-solid stroke)" };
}

function isMixed(v: unknown): v is typeof figma.mixed {
  return v === figma.mixed;
}

function getCardPaintInfo(
  node: SceneNode,
  prop: "fills" | "strokes"
): { value: string; enabled?: boolean } {
  try {
    if (!(prop in node)) return { value: "—" };

    const paints = (node as any)[prop] as Paint[] | typeof figma.mixed;
    if (!paints || paints === figma.mixed) return { value: "—" };
    if (!Array.isArray(paints) || paints.length === 0) return { value: "—" };

    const p = paints[0];
    if (!p) return { value: "—" };

    const enabled = (p as any).visible !== false;

    if (p.type !== "SOLID") return { value: p.type.toLowerCase(), enabled };

    return { value: formatSolidPaint(p as SolidPaint), enabled };
  } catch (e) {
    return { value: "—" };
  }
}

function shortStyleId(id: string): string {
  if (!id) return "unknown";
  // у styleId часто формат "5775:77" — его оставляем как есть
  if (id.length <= 14) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}


//делают объект Issue “по шаблону”
function makeBaseIssue(
  node: SceneNode,
  ruleId: Issue["ruleId"],
  message: string
): Issue {
  const cardFill = getCardPaintInfo(node, "fills");
  const cardStroke = getCardPaintInfo(node, "strokes");

  return {
    ruleId,
    message,
    issueDomain: ruleIdToDomain(ruleId),
    nodeId: node.id,
    nodeName: node.name,
    nodeType: node.type,
    nodeOpacity: "opacity" in node ? node.opacity : undefined,

    // Card Truth (single source of truth for ALL cards)
    nodeFillValue: cardFill.value,
    nodeFillEnabled: cardFill.enabled,
    nodeStrokeValue: cardStroke.value,
    nodeStrokeEnabled: cardStroke.enabled,
  };
}

function makeIssue(
  node: SceneNode,
  ruleId: Issue["ruleId"],
  message: string,
  extra?: Partial<Issue>
  ): Issue {
  const base = makeBaseIssue(node, ruleId, message);
  if (extra) Object.assign(base, extra);
  return base;
  }

// ============================================================
// 3) RULES: проверки (возвращают Issue[])
// ============================================================

// возвращает список проблем, если у ноды fill имеет style
function checkFillIsStyle(node: SceneNode): Issue[] {
  if (!FILL_SUPPORTED_NODE_TYPES.includes(node.type)) return [];

  if (!("fillStyleId" in node)) return [];
  if (!node.fillStyleId || node.fillStyleId === figma.mixed) return [];

  const fillStyleSource: "LOCAL" | "EXTERNAL" =
    localPaintStyleIds.has(node.fillStyleId) ? "LOCAL" : "EXTERNAL";

  const resolved = resolveStyleName(node.fillStyleId);

  const fillStyleName =  resolved ??
  (fillStyleSource === "EXTERNAL"
    ? `(external style · ${shortStyleId(node.fillStyleId)})`
    : "(local style)");

  // 10T: достаём текущий SOLID fill (если доступен) для отображения/статистики
  let fillValue: string | undefined;
  let fillEnabled: boolean | undefined;

  if ("fills" in node) {
    const fills = node.fills;
    if (fills !== figma.mixed && Array.isArray(fills)) {
      const d = describePrimaryFill(fills);
      fillValue = d.fillValue;
      fillEnabled = d.fillEnabled;

    }
  }
  return [
    makeIssue(node, "fill-is-style", "Fill задан через style.", {
      fillSourceKind: "STYLE",
      fillValue,
      fillEnabled,
      fillStyleName,
      fillStyleSource,
    }),
  ];
}
// возвращает список проблем, если у ноды stroke имеет style
function checkStrokeIsStyle(node: SceneNode): Issue[] {
  // stroke поддерживаем на тех же типах, где в принципе бывает stroke
  if (!("strokeStyleId" in node)) return [];
  if (!node.strokeStyleId || isMixed(node.strokeStyleId)) return [];


  const fillStyleSource: "LOCAL" | "EXTERNAL" =
    localPaintStyleIds.has(node.strokeStyleId) ? "LOCAL" : "EXTERNAL";

  const resolved = resolveStyleName(node.strokeStyleId);

const fillStyleName =
  resolved ??
  (fillStyleSource === "EXTERNAL"
    ? `(external style · ${shortStyleId(node.strokeStyleId)})`
    : "(local style)");

  let fillValue: string | undefined;
  let fillEnabled: boolean | undefined;

  if ("strokes" in node) {
    const strokes = node.strokes;
    if (strokes && !isMixed(strokes)) {
      const solid = (strokes as Paint[]).find(
        (p) => p.type === "SOLID"
      ) as SolidPaint | undefined;

      if (solid) {
        fillValue = formatSolidPaint(solid);
        // visible=false считаем как disabled
        fillEnabled = (solid as any).visible !== false;
      }
    }
  }

  return [
    makeIssue(node, "stroke-is-style", "Stroke задан через style.", {
      fillSourceKind: "STYLE",
      fillValue,
      fillEnabled,
      fillStyleName,
      fillStyleSource,
    }),
  ];
}

// Возвращает список проблем, если у ноды есть fills
function checkFillNotVariable(node: SceneNode): Issue[] {
  if (!FILL_SUPPORTED_NODE_TYPES.includes(node.type)) return [];

  if (!("fills" in node)) return [];
  const fills = node.fills;

  if (fills === figma.mixed) return [];
  if (!Array.isArray(fills) || fills.length === 0) return [];


  // единый расчёт цвета (используем ниже и для VARIABLE, и для RAW)
 const { fillValue, fillEnabled } = describePrimaryFill(fills);

  // STYLE поглощает RAW
  if ("fillStyleId" in node && node.fillStyleId && node.fillStyleId !== figma.mixed) {
  return [];
  }

  // VARIABLE
 const hasFillVarBinding = Boolean(node.boundVariables?.fills);
if (hasFillVarBinding) {
  let fillVariableName: string | undefined = undefined;
  let fillVariableSource: "LOCAL" | "EXTERNAL" | undefined = undefined;

  try {
    const bindings = node.boundVariables?.fills;
    const first = Array.isArray(bindings) ? bindings[0] : undefined;

    const varId =
      first && typeof first === "object" ? (first as any).id : undefined;

    if (typeof varId === "string") {
      fillVariableSource = localVariableIds.has(varId) ? "LOCAL" : "EXTERNAL";
      fillVariableName =
        variableNameById.get(varId) ??
        (fillVariableSource === "EXTERNAL" ? "(external variable)" : "(local variable)");
    }
  } catch (e) {
    // fail-safe
  }

  return [
    makeIssue(node, "fill-is-variable", "Fill привязан к variable.", {
      fillSourceKind: "VARIABLE",
      fillValue,
      fillEnabled,
      fillVariableName,
      fillVariableSource,
    }),
  ];
}

 

  // RAW hard-coded
  return [
    makeIssue(node, "fill-not-variable", "Fill не привязан к variable (hard-coded fill).", {
      fillSourceKind: "RAW",
      fillValue,
      fillEnabled,
    }),
  ];
}

// Возвращает список проблем, если у ноды есть stroke
function checkStrokeNotVariable(node: SceneNode): Issue[] {

  // DEBUG: посмотреть, где именно хранится variable binding для stroke
try {
  if ("strokes" in node && (node as any).strokes) {
    const strokes = (node as any).strokes;
    const first = Array.isArray(strokes) ? strokes[0] : undefined;

    // логируем только для нод, у которых вообще есть stroke и имя похоже на тестовое
    // (если хочешь — убери условие и будет много спама)
    if (node.name && node.name.toLowerCase().includes("test")) {
      console.log("[stroke-var debug]", {
        nodeId: node.id,
        nodeName: node.name,
        strokeStyleId: (node as any).strokeStyleId,
        nodeBound: (node as any).boundVariables,
        paintBound: first?.boundVariables,
        strokesRaw: strokes,
      });
    }
  }
} catch (e) {
  console.log("[stroke-var debug] error", e);
}

  if (!STROKE_SUPPORTED_NODE_TYPES.includes(node.type)) return [];

  if (!("strokes" in node)) return [];
  const strokes = (node as any).strokes as readonly Paint[] | PluginAPI["mixed"];

  if (strokes === figma.mixed) return [];
  if (!Array.isArray(strokes) || strokes.length === 0) return [];

  const hasAnyVisiblePaint = strokes.some((p) => (p.opacity ?? 1) > 0);
  if (!hasAnyVisiblePaint) return [];

  const hasStrokeVarBinding = Boolean(node.boundVariables?.strokes);
  if (hasStrokeVarBinding) return [];

  let strokeValue: string | undefined;
  const solid = strokes.find((p) => p.type === "SOLID") as SolidPaint | undefined;
  if (solid) strokeValue = formatSolidPaint(solid);

  const strokeEnabled =
  solid ? ((solid as any).visible !== false) : true;

// VARIABLE (аналогично fills)
try {
  const bindings = (node as any).boundVariables?.strokes;
  const first = Array.isArray(bindings) ? bindings[0] : bindings;

  const varId =
    first && typeof first === "object" ? (first as any).id : undefined;

  if (typeof varId === "string") {
    const fillVariableSource = localVariableIds.has(varId) ? "LOCAL" : "EXTERNAL";
    const fillVariableName =
      variableNameById.get(varId) ??
      (fillVariableSource === "EXTERNAL"
        ? "(external variable)"
        : "(local variable)");

    return [
      makeIssue(node, "stroke-is-variable", "Stroke привязан к variable.", {
        fillSourceKind: "VARIABLE",
        fillValue: strokeValue,
        fillEnabled: true, // если хочешь точнее — можем вычислить visible у SOLID как в fill
        fillVariableName,
        fillVariableSource,
        strokeValue,
      }),
    ];
  }
} catch (e) {
  // fail-safe
}

// RAW hard-coded
return [
  makeIssue(
    node,
    "stroke-not-variable",
    "Stroke не привязан к variable (hard-coded stroke).",
    {
      fillSourceKind: "RAW",
      fillValue: strokeValue,
      fillEnabled: true,
      strokeValue,
    }
  ),
];


}
// возвращает список проблем, если у ноды stroke имеет variable
function checkStrokeIsVariable(node: SceneNode): Issue[] {
  if (!("strokes" in node)) return [];

  const strokes = (node as any).strokes;

  // не сравниваем с figma.mixed, чтобы TS не ругался: mixed отсекаем по типу
  if (!strokes || strokes === figma.mixed) return [];

  const solid = (strokes as Paint[]).find(
    (p) => p.type === "SOLID"
  ) as SolidPaint | undefined;

  if (!solid) return [];

  const strokeValue = formatSolidPaint(solid);
  const fillEnabled = (solid as any).visible !== false;

  // ✅ реальный кейс из твоего debug: variable лежит тут
  const alias = (solid as any)?.boundVariables?.color;
  const varId = alias?.id;

  // fallback: иногда бывает на уровне node.boundVariables.strokes
  const nodeVar = (node as any)?.boundVariables?.strokes;
  const fallbackId = Array.isArray(nodeVar) ? nodeVar?.[0]?.id : nodeVar?.id;

  const resolvedVarId =
    (typeof varId === "string" ? varId : undefined) ??
    (typeof fallbackId === "string" ? fallbackId : undefined);

  if (!resolvedVarId) return [];

  const fillVariableSource: "LOCAL" | "EXTERNAL" =
    localVariableIds.has(resolvedVarId) ? "LOCAL" : "EXTERNAL";

  const fillVariableName =
    variableNameById.get(resolvedVarId) ??
    (fillVariableSource === "EXTERNAL"
      ? "(external variable)"
      : "(local variable)");

  return [
    makeIssue(node, "stroke-is-variable", "Stroke задан через variable.", {
      fillSourceKind: "VARIABLE",
      fillValue: strokeValue,
      fillEnabled,
      fillVariableName,
      fillVariableSource,
      fillVariableId: resolvedVarId,
      strokeValue,
    }),
  ];
}


// ============================================================
// 4) SUMMARY: статистика для UI
// ============================================================
function summarize(nodes: SceneNode[]) {
  const byType: Record<string, number> = {};
  for (const n of nodes) byType[n.type] = (byType[n.type] ?? 0) + 1;

  return {
    total: nodes.length,
    byType
  };
}

// ============================================================
// 5) MESSAGE ROUTER: команды из UI (close / select-node / scan)
// ============================================================
figma.ui.onmessage = async (msg) => {
  if (msg.type === "close") {
    figma.closePlugin();
    return;
  }

  if (msg.type === "select-node") {
    const nodeId = msg.nodeId as string;

    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
      figma.notify("Нода не найдена (возможно удалена).");
      return;
    }

    // Figma возвращает BaseNode, но нам нужно выбрать только SceneNode
    if (node.type === "DOCUMENT" || node.type === "PAGE") {
      figma.notify("Нельзя выделить DOCUMENT/PAGE.");
      return;
    }

    const sceneNode = node as SceneNode;
    figma.currentPage.selection = [sceneNode];
    figma.viewport.scrollAndZoomIntoView([sceneNode]);

    return;
  }

  if (msg.type === "select-nodes") {
    const nodeIds = msg.nodeIds as string[];

    if (!Array.isArray(nodeIds) || nodeIds.length === 0) {
      figma.notify("Нет нод для выделения.");
      return;
    }

    const nodes = await Promise.all(
      nodeIds.map((id) => figma.getNodeByIdAsync(id))
    );

    const sceneNodes: SceneNode[] = [];
    for (const n of nodes) {
      if (!n) continue;
      if (n.type === "DOCUMENT" || n.type === "PAGE") continue;
      sceneNodes.push(n as SceneNode);
    }

    if (sceneNodes.length === 0) {
      figma.notify("Ноды не найдены (возможно удалены).");
      return;
    }

    figma.currentPage.selection = sceneNodes;
    figma.viewport.scrollAndZoomIntoView(sceneNodes);

    // опционально: мягкий фидбек, если что-то не выделилось
    if (sceneNodes.length !== nodeIds.length) {
      figma.notify(
        `Выделено ${sceneNodes.length} из ${nodeIds.length} нод (часть не найдена/не SceneNode).`
      );
    }

    return;
  }

  if (msg.type === "scan") {
   try {
    localPaintStyleIds = new Set(
      (await figma.getLocalPaintStylesAsync()).map((s) => s.id)
    );
    styleNameById = new Map();

    for (const s of await figma.getLocalPaintStylesAsync()) {
    styleNameById.set(s.id, s.name);
    }
    const localVars = await figma.variables.getLocalVariablesAsync();
    localVariableIds = new Set(localVars.map((v) => v.id));
    variableNameById = new Map(localVars.map((v) => [v.id, v.name]));

    const paletteCandidates = await getLocalPaletteCandidates();
    paletteCandidatesCache = paletteCandidates;
     
    console.log("[paletteCandidates] total =", paletteCandidates.length);
console.log(
  "[paletteCandidates] sample =",
  paletteCandidates.slice(0, 10).map((c: any) => ({
    kind: c.kind,
    id: c.id,
    name: c.name,
    rgba: c.rgba,
  }))
);


    const selection = figma.currentPage.selection;
    const roots = selection.length > 0 ? selection : figma.currentPage.children;
    const all = collectNodesDeep(roots);

    // DEBUG: style fills presence
    const nodesWithFillStyle = all.filter((n) =>
    ("fillStyleId" in n) && n.fillStyleId && n.fillStyleId !== figma.mixed
    ).length;

    console.log("[scan] nodes:", all.length, "nodesWithFillStyle:", nodesWithFillStyle);


    const issues: Issue[] = [];
    for (const n of all) {
      issues.push(...checkFillIsStyle(n));
      issues.push(...checkFillNotVariable(n));
      issues.push(...checkStrokeIsStyle(n));
      issues.push(...checkStrokeNotVariable(n));
      issues.push(...checkStrokeIsVariable(n));

      }

    // Top fill colors — только проблемные (из issues), без variable
    const topMap = new Map<string, number>();

    for (const issue of issues) {
    if (issue.fillSourceKind !== "RAW") continue;
    if (!issue.fillValue) continue;

    topMap.set(issue.fillValue, (topMap.get(issue.fillValue) ?? 0) + 1);
    }

    const rawFills = Array.from(topMap.entries())
   .sort((a, b) => b[1] - a[1])
   .map(([hex, count]) => ({ hex, count }));

   const rawSuggestionsByHex: RawSuggestionsByHex = {};

   for (const rf of rawFills) {
    const rgba = hexToRGBAColor(rf.hex);
    if (!rgba) continue;

    if (!rgba) {
  console.log("[match] rawRGBA=null for", rf.hex);
} else if (!paletteCandidates.length) {
  console.log("[match] no candidates for", rf.hex);
}

    const matches = findClosestPaletteCandidates(rgba, paletteCandidatesCache, 3);
   rawSuggestionsByHex[rf.hex] = matches.map((m) => {
  const cand = paletteCandidatesCache.find((c) => c.kind === m.kind && c.id === m.id);
  return {
    kind: m.kind,
    id: m.id,
    name: m.name,
    distance: m.distance,
    rgba: cand?.rgba,
  };
});

}

    // DEBUG: style issues created
    const styleIssues = issues.filter((i) => i.ruleId === "fill-is-style").length;
    console.log("[scan] issues:", issues.length, "styleIssues:", styleIssues);

    console.log("[scan] rawSuggestionsByHex keys:", Object.keys(rawSuggestionsByHex).length);

     figma.ui.postMessage({
      type: "scan-result",
      payload: {
        summary: summarize(all),
        issues,
        rawFills,
        paletteCandidates,
        rawSuggestionsByHex,

      },
    });
  } catch (err) {
    console.error("[scan] error:", err);
    figma.notify(`Scan error: ${String(err)}`, { timeout: 6000 });

    
    figma.ui.postMessage({
      type: "scan-result",
      payload: {
        summary: { total: 0, byType: {} },
        issues: [],
        rawFills: [],
        error: String(err),
      },
    });
  }}}