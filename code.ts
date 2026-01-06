figma.showUI(__html__, { width: 520, height: 420 });

type FillSourceKind = "RAW" | "STYLE" | "VARIABLE";
type FillSourceDetail = "DIRECT" | "STYLE_VARIABLE";
type FillVariableSource = "LOCAL" | "EXTERNAL";


type Issue = {
   ruleId:
    | "fill-not-variable"
    | "fill-is-style"
    | "fill-is-variable"
    | "stroke-not-variable";
  message: string;
  nodeId: string;
  nodeName: string;
  nodeType: SceneNode["type"];
  issueDomain: "FILL" | "STROKE" | "NUMERIC";
  fillValue?: string;
  fillEnabled?: boolean; // true = paint.visible !== false (если visible нет — считаем включенным)
  nodeOpacity?: number;
  strokeValue?: string;
  fillStyleName?: string;
  fillStyleSource?: "LOCAL" | "EXTERNAL";
  fillVariableName?: string;
  fillVariableSource?: FillVariableSource;
  fillSourceKind?: FillSourceKind;
  fillSourceDetail?: FillSourceDetail;



};

figma.notify("Token Auditor & Linter: запустился ✅");

let localPaintStyleIds: Set<string> = new Set();
let styleNameById: Map<string, string> = new Map();
let styleUsesVariableById: Map<string, boolean> = new Map();
let localVariableIds: Set<string> = new Set();
let variableNameById: Map<string, string> = new Map();
let paletteCandidatesCache: PaletteCandidate[] = [];

type RGBAColor = { r: number; g: number; b: number; a: number };
type CandidateKind = "STYLE" | "VARIABLE";
type PaletteCandidate = {
  kind: CandidateKind;
  id: string;
  name: string;
  rgba: RGBAColor ;
};

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

// Берём первое доступное значение (mode) — достаточно для v0.3 read-only.
// Позже (в v0.4+) можно будет учитывать explicit mode / consumer.
function pickFirstModeColorValue(variable: Variable): RGBAColor | null {
  const modeIds = Object.keys(variable.valuesByMode ?? {});
  if (modeIds.length === 0) return null;

  const v = (variable.valuesByMode as any)[modeIds[0]];
  // Если там alias — пропускаем (на v0.3 ок).
  if (!isRGBAValue(v)) return null;

  return { r: v.r, g: v.g, b: v.b, a: typeof v.a === "number" ? v.a : 1 };
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

  // local paint styles (async API)
  const localStyles = await figma.getLocalPaintStylesAsync();
  for (const s of localStyles) {
    const rgba = extractSolidFromPaintStyle(s);
    if (!rgba) continue;
    out.push({ kind: "STYLE", id: s.id, name: s.name, rgba });
  }

  // local color variables (async API)
  const localColorVars = await figma.variables.getLocalVariablesAsync("COLOR");
  for (const v of localColorVars) {
    const rgba = pickFirstModeColorValue(v);
    if (!rgba) continue;
    out.push({ kind: "VARIABLE", id: v.id, name: v.name, rgba });
  }

  return out;
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

type PaletteMatch = PaletteCandidate & { distance: number };


function srgbToLinear(c: number): number {
  // c в диапазоне 0..1
  if (c <= 0.04045) return c / 12.92;
  return Math.pow((c + 0.055) / 1.055, 2.4);
}

function rgbaDistance(a: RGBAColor, b: RGBAColor): number {
  try {
    // Convert sRGB [0..1] -> linear
    const cbrt = (x: number) => (x < 0 ? -Math.pow(-x, 1 / 3) : Math.pow(x, 1 / 3));
    const norm = (x: number) => (x > 1 ? x / 255 : x);
    const srgbToLinear = (x: number) =>
    x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);

    // Linear RGB -> OKLab (approx, standard matrix)
    const rgbToOKLab = (c: RGBAColor) => {
    const r = srgbToLinear(norm(c.r));
    const g = srgbToLinear(norm(c.g));
    const b2 = srgbToLinear(norm(c.b));

    const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b2;
    const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b2;
    const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b2;

    const l_ = cbrt(l);
    const m_ = cbrt(m);
    const s_ = cbrt(s);


    return {
      L: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
      a: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
      b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
      alpha: c.a,
    };
  };

  const A = rgbToOKLab(a);
  const B = rgbToOKLab(b);

  // Weighted distance: OKLab euclidean + alpha penalty
  const dL = A.L - B.L;
  const da = A.a - B.a;
  const db = A.b - B.b;
  const dColor = Math.sqrt(dL * dL + da * da + db * db);

  const dAlpha = Math.abs((A.alpha ?? 1) - (B.alpha ?? 1));

  return dColor + dAlpha * 0.25;
    } catch (e) {
    console.log("[rgbaDistance] error", e, a, b);
    return 1e9;
  }

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
      rgba: c.rgba,
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);
}

type RawSuggestion = Omit<PaletteMatch, "rgba"> & { rgba?: RGBAColor };

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


function solidToHex(p: SolidPaint): string {
  const { r, g, b } = p.color;
  return `#${toHex01(r)}${toHex01(g)}${toHex01(b)}`.toUpperCase();
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

//делают объект Issue “по шаблону”
function makeBaseIssue(
  node: SceneNode,
  ruleId: Issue["ruleId"],
  message: string
  ): Issue {
  return {
    ruleId,
    message,
    issueDomain: ruleIdToDomain(ruleId),
    nodeId: node.id,
    nodeName: node.name,
    nodeType: node.type,
    nodeOpacity: "opacity" in node ? node.opacity : undefined,

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

  const fillStyleName =
    styleNameById.get(node.fillStyleId) ??
    (fillStyleSource === "EXTERNAL" ? "(external style)" : "(local style)");

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
      fillSourceDetail: styleUsesVariableById.get(node.fillStyleId) ? "STYLE_VARIABLE" : "DIRECT",
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

  return [
    makeIssue(
      node,
      "stroke-not-variable",
      "Stroke не привязан к variable (hard-coded stroke).",
      { strokeValue }
    ),
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
    styleUsesVariableById = new Map();


    for (const s of await figma.getLocalPaintStylesAsync()) {
    styleNameById.set(s.id, s.name);
    const usesVar = (s.paints ?? []).some((p) => Boolean((p as any).boundVariables?.color));
    styleUsesVariableById.set(s.id, usesVar);
    }
    
    const localVars = await figma.variables.getLocalVariablesAsync();
    localVariableIds = new Set(localVars.map((v) => v.id));
    variableNameById = new Map(localVars.map((v) => [v.id, v.name]));

    const paletteCandidates = await getLocalPaletteCandidates();
    paletteCandidatesCache = paletteCandidates;
     
      console.log("[scan] paletteCandidates:", paletteCandidates.length);

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
      issues.push(...checkStrokeNotVariable(n));
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
   .slice(0, 30)
   .map(([hex, count]) => ({ hex, count }));

   const rawSuggestionsByHex: RawSuggestionsByHex = {};

   for (const rf of rawFills) {
    const rawText = String(rf.hex ?? "").trim();
    const [hexPartRaw, atPartRaw] = rawText.split("@");
    const hexPart = String(hexPartRaw ?? "").trim();
    const rgbaBase = hexToRGBAColor(hexPart);
    if (!rgbaBase) continue;

    const alpha = atPartRaw
  ? Math.max(0, Math.min(1, parseFloat(String(atPartRaw).replace("%", "").trim()) / 100))
  : rgbaBase.a;

    const rgba: RGBAColor = { r: rgbaBase.r, g: rgbaBase.g, b: rgbaBase.b, a: alpha };


    if (!rgba) continue;

    const matches = findClosestPaletteCandidates(rgba, paletteCandidatesCache, 3);
    rawSuggestionsByHex[rf.hex] = matches.map((m) => ({
    kind: m.kind,
    id: m.id,
    name: m.name,
    rgba: m.rgba,
    
    distance: m.distance,
  }));
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