figma.showUI(__html__, { width: 520, height: 420 });

type Issue = {
  ruleId: "fill-not-variable" | "stroke-not-variable";
  message: string;
  nodeId: string;
  nodeName: string;
  nodeType: SceneNode["type"];
  fillValue?: string;
  nodeOpacity?: number;
  strokeValue?: string;
};

figma.notify("Token Auditor & Linter: запустился ✅");

// constants / supported types
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

//utils
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

function makeBaseIssue(
  node: SceneNode,
  ruleId: Issue["ruleId"],
  message: string
  ): Issue {
  return {
    ruleId,
    message,
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

//rules

function checkFillNotVariable(node: SceneNode): Issue[] {
  if (!FILL_SUPPORTED_NODE_TYPES.includes(node.type)) return [];

  if (!("fills" in node)) return [];
  const fills = node.fills;

  if (fills === figma.mixed) return [];

  if (!Array.isArray(fills) || fills.length === 0) return [];

  const hasAnyVisiblePaint = fills.some((p) => (p.opacity ?? 1) > 0);
  if (!hasAnyVisiblePaint) return [];

  const hasFillVarBinding = Boolean(node.boundVariables?.fills);
  if (hasFillVarBinding) return [];

  // определение цвета
  let fillValue: string | undefined;
  const solid = fills.find((p) => p.type === "SOLID") as SolidPaint | undefined;
  if (solid) fillValue = formatSolidPaint(solid);

  return [
  makeIssue(
    node,
    "fill-not-variable",
    "Fill не привязан к variable (hard-coded fill).",
    { fillValue }
    ),
    ];
}

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

function summarize(nodes: SceneNode[]) {
  const byType: Record<string, number> = {};
  for (const n of nodes) byType[n.type] = (byType[n.type] ?? 0) + 1;

  return {
    total: nodes.length,
    byType
  };
}

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

  if (msg.type === "scan") {
    const selection = figma.currentPage.selection;

    // 1) Если ничего не выделено — сканируем всю страницу
    const roots = selection.length > 0 ? selection : figma.currentPage.children;

    // 2) Собираем все вложенные ноды рекурсивно
    const all = collectNodesDeep(roots);

    const issues: Issue[] = [];
    for (const n of all) {
      issues.push(...checkFillNotVariable(n));
      issues.push(...checkStrokeNotVariable(n));
    }

    figma.ui.postMessage({
      type: "scan-result",
      payload: {
        summary: summarize(all),
        issues
      }
    });
  }
};
