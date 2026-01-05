"use strict";
(() => {
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __commonJS = (cb, mod) => function __require() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };

  // code.ts
  var require_code = __commonJS({
    "code.ts"() {
      figma.showUI(__html__, { width: 520, height: 420 });
      figma.notify("Token Auditor & Linter: \u0437\u0430\u043F\u0443\u0441\u0442\u0438\u043B\u0441\u044F \u2705");
      var localPaintStyleIds = /* @__PURE__ */ new Set();
      var styleNameById = /* @__PURE__ */ new Map();
      var localVariableIds = /* @__PURE__ */ new Set();
      var variableNameById = /* @__PURE__ */ new Map();
      var paletteCandidatesCache = [];
      function isRGBAValue(v) {
        return !!v && typeof v === "object" && "r" in v && "g" in v && "b" in v && typeof v.r === "number" && typeof v.g === "number" && typeof v.b === "number";
      }
      function pickFirstModeColorValue(variable) {
        var _a;
        const modeIds = Object.keys((_a = variable.valuesByMode) != null ? _a : {});
        if (modeIds.length === 0) return null;
        const v = variable.valuesByMode[modeIds[0]];
        if (!isRGBAValue(v)) return null;
        return { r: v.r, g: v.g, b: v.b, a: typeof v.a === "number" ? v.a : 1 };
      }
      function extractSolidFromPaintStyle(style) {
        var _a, _b;
        const paints = (_a = style.paints) != null ? _a : [];
        if (!paints.length) return null;
        const p = paints[0];
        if (p.type !== "SOLID") return null;
        const a = (_b = p.opacity) != null ? _b : 1;
        return { r: p.color.r, g: p.color.g, b: p.color.b, a };
      }
      async function getLocalPaletteCandidates() {
        const out = [];
        const localStyles = await figma.getLocalPaintStylesAsync();
        for (const s of localStyles) {
          const rgba = extractSolidFromPaintStyle(s);
          if (!rgba) continue;
          out.push({ kind: "STYLE", id: s.id, name: s.name, rgba });
        }
        const localColorVars = await figma.variables.getLocalVariablesAsync("COLOR");
        for (const v of localColorVars) {
          const rgba = pickFirstModeColorValue(v);
          if (!rgba) continue;
          out.push({ kind: "VARIABLE", id: v.id, name: v.name, rgba });
        }
        return out;
      }
      function extractRGBAFromRawFill(fill) {
        var _a;
        if (fill.type !== "SOLID") return null;
        const a = (_a = fill.opacity) != null ? _a : 1;
        return {
          r: fill.color.r,
          g: fill.color.g,
          b: fill.color.b,
          a
        };
      }
      function srgbToLinear(c) {
        if (c <= 0.04045) return c / 12.92;
        return Math.pow((c + 0.055) / 1.055, 2.4);
      }
      function rgbaDistance(a, b) {
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
        return Math.sqrt(dr * dr + dg * dg + db * db + da * da) * 1e3;
      }
      function findClosestPaletteCandidates(raw, candidates, limit = 5) {
        return candidates.map((c) => ({
          kind: c.kind,
          id: c.id,
          name: c.name,
          distance: rgbaDistance(raw, c.rgba)
        })).sort((a, b) => a.distance - b.distance).slice(0, limit);
      }
      function hexToRGBAColor(hex) {
        const h = hex.trim().replace(/^#/, "");
        if (!(h.length === 6 || h.length === 8)) return null;
        const r = parseInt(h.slice(0, 2), 16);
        const g = parseInt(h.slice(2, 4), 16);
        const b = parseInt(h.slice(4, 6), 16);
        const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255;
        if ([r, g, b, a].some((n) => Number.isNaN(n))) return null;
        return { r: r / 255, g: g / 255, b: b / 255, a: a / 255 };
      }
      var FILL_SUPPORTED_NODE_TYPES = [
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
      var STROKE_SUPPORTED_NODE_TYPES = [
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
        "LINE"
      ];
      function collectNodesDeep(nodes) {
        const out = [];
        const visit = (node) => {
          out.push(node);
          if ("children" in node) {
            for (const child of node.children) visit(child);
          }
        };
        for (const n of nodes) visit(n);
        return out;
      }
      function toHex01(v) {
        return Math.round(v * 255).toString(16).padStart(2, "0");
      }
      function formatSolidPaint(p) {
        var _a;
        const { r, g, b } = p.color;
        const opacity = (_a = p.opacity) != null ? _a : 1;
        let s = `#${toHex01(r)}${toHex01(g)}${toHex01(b)}`.toUpperCase();
        if (opacity < 1) s += ` @ ${Math.round(opacity * 100)}%`;
        return s;
      }
      function ruleIdToDomain(ruleId) {
        if (ruleId.startsWith("stroke-")) return "STROKE";
        if (ruleId.startsWith("fill-")) return "FILL";
        return "NUMERIC";
      }
      function describePrimaryFill(fills) {
        const p = fills.find((x) => {
          var _a;
          return ((_a = x == null ? void 0 : x.opacity) != null ? _a : 1) > 0;
        });
        if (!p) return { fillValue: void 0, fillEnabled: void 0 };
        const fillEnabled = p.visible !== false;
        if (p.type === "SOLID") {
          const rgba = extractRGBAFromRawFill(p);
          if (rgba && paletteCandidatesCache.length) {
            const matches = findClosestPaletteCandidates(rgba, paletteCandidatesCache, 3);
          }
          return { fillValue: formatSolidPaint(p), fillEnabled };
        }
        if (p.type === "IMAGE") return { fillValue: "image", fillEnabled };
        return { fillValue: p.type.toLowerCase(), fillEnabled };
      }
      function makeBaseIssue(node, ruleId, message) {
        return {
          ruleId,
          message,
          issueDomain: ruleIdToDomain(ruleId),
          nodeId: node.id,
          nodeName: node.name,
          nodeType: node.type,
          nodeOpacity: "opacity" in node ? node.opacity : void 0
        };
      }
      function makeIssue(node, ruleId, message, extra) {
        const base = makeBaseIssue(node, ruleId, message);
        if (extra) Object.assign(base, extra);
        return base;
      }
      function checkFillIsStyle(node) {
        var _a;
        if (!FILL_SUPPORTED_NODE_TYPES.includes(node.type)) return [];
        if (!("fillStyleId" in node)) return [];
        if (!node.fillStyleId || node.fillStyleId === figma.mixed) return [];
        const fillStyleSource = localPaintStyleIds.has(node.fillStyleId) ? "LOCAL" : "EXTERNAL";
        const fillStyleName = (_a = styleNameById.get(node.fillStyleId)) != null ? _a : fillStyleSource === "EXTERNAL" ? "(external style)" : "(local style)";
        let fillValue;
        let fillEnabled;
        if ("fills" in node) {
          const fills = node.fills;
          if (fills !== figma.mixed && Array.isArray(fills)) {
            const d = describePrimaryFill(fills);
            fillValue = d.fillValue;
            fillEnabled = d.fillEnabled;
          }
        }
        return [
          makeIssue(node, "fill-is-style", "Fill \u0437\u0430\u0434\u0430\u043D \u0447\u0435\u0440\u0435\u0437 style.", {
            fillSourceKind: "STYLE",
            fillValue,
            fillEnabled,
            fillStyleName,
            fillStyleSource
          })
        ];
      }
      function checkFillNotVariable(node) {
        var _a, _b, _c;
        if (!FILL_SUPPORTED_NODE_TYPES.includes(node.type)) return [];
        if (!("fills" in node)) return [];
        const fills = node.fills;
        if (fills === figma.mixed) return [];
        if (!Array.isArray(fills) || fills.length === 0) return [];
        const { fillValue, fillEnabled } = describePrimaryFill(fills);
        if ("fillStyleId" in node && node.fillStyleId && node.fillStyleId !== figma.mixed) {
          return [];
        }
        const hasFillVarBinding = Boolean((_a = node.boundVariables) == null ? void 0 : _a.fills);
        if (hasFillVarBinding) {
          let fillVariableName = void 0;
          let fillVariableSource = void 0;
          try {
            const bindings = (_b = node.boundVariables) == null ? void 0 : _b.fills;
            const first = Array.isArray(bindings) ? bindings[0] : void 0;
            const varId = first && typeof first === "object" ? first.id : void 0;
            if (typeof varId === "string") {
              fillVariableSource = localVariableIds.has(varId) ? "LOCAL" : "EXTERNAL";
              fillVariableName = (_c = variableNameById.get(varId)) != null ? _c : fillVariableSource === "EXTERNAL" ? "(external variable)" : "(local variable)";
            }
          } catch (e) {
          }
          return [
            makeIssue(node, "fill-is-variable", "Fill \u043F\u0440\u0438\u0432\u044F\u0437\u0430\u043D \u043A variable.", {
              fillSourceKind: "VARIABLE",
              fillValue,
              fillEnabled,
              fillVariableName,
              fillVariableSource
            })
          ];
        }
        return [
          makeIssue(node, "fill-not-variable", "Fill \u043D\u0435 \u043F\u0440\u0438\u0432\u044F\u0437\u0430\u043D \u043A variable (hard-coded fill).", {
            fillSourceKind: "RAW",
            fillValue,
            fillEnabled
          })
        ];
      }
      function checkStrokeNotVariable(node) {
        var _a;
        if (!STROKE_SUPPORTED_NODE_TYPES.includes(node.type)) return [];
        if (!("strokes" in node)) return [];
        const strokes = node.strokes;
        if (strokes === figma.mixed) return [];
        if (!Array.isArray(strokes) || strokes.length === 0) return [];
        const hasAnyVisiblePaint = strokes.some((p) => {
          var _a2;
          return ((_a2 = p.opacity) != null ? _a2 : 1) > 0;
        });
        if (!hasAnyVisiblePaint) return [];
        const hasStrokeVarBinding = Boolean((_a = node.boundVariables) == null ? void 0 : _a.strokes);
        if (hasStrokeVarBinding) return [];
        let strokeValue;
        const solid = strokes.find((p) => p.type === "SOLID");
        if (solid) strokeValue = formatSolidPaint(solid);
        return [
          makeIssue(
            node,
            "stroke-not-variable",
            "Stroke \u043D\u0435 \u043F\u0440\u0438\u0432\u044F\u0437\u0430\u043D \u043A variable (hard-coded stroke).",
            { strokeValue }
          )
        ];
      }
      function summarize(nodes) {
        var _a;
        const byType = {};
        for (const n of nodes) byType[n.type] = ((_a = byType[n.type]) != null ? _a : 0) + 1;
        return {
          total: nodes.length,
          byType
        };
      }
      figma.ui.onmessage = async (msg) => {
        var _a;
        if (msg.type === "close") {
          figma.closePlugin();
          return;
        }
        if (msg.type === "select-node") {
          const nodeId = msg.nodeId;
          const node = await figma.getNodeByIdAsync(nodeId);
          if (!node) {
            figma.notify("\u041D\u043E\u0434\u0430 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430 (\u0432\u043E\u0437\u043C\u043E\u0436\u043D\u043E \u0443\u0434\u0430\u043B\u0435\u043D\u0430).");
            return;
          }
          if (node.type === "DOCUMENT" || node.type === "PAGE") {
            figma.notify("\u041D\u0435\u043B\u044C\u0437\u044F \u0432\u044B\u0434\u0435\u043B\u0438\u0442\u044C DOCUMENT/PAGE.");
            return;
          }
          const sceneNode = node;
          figma.currentPage.selection = [sceneNode];
          figma.viewport.scrollAndZoomIntoView([sceneNode]);
          return;
        }
        if (msg.type === "select-nodes") {
          const nodeIds = msg.nodeIds;
          if (!Array.isArray(nodeIds) || nodeIds.length === 0) {
            figma.notify("\u041D\u0435\u0442 \u043D\u043E\u0434 \u0434\u043B\u044F \u0432\u044B\u0434\u0435\u043B\u0435\u043D\u0438\u044F.");
            return;
          }
          const nodes = await Promise.all(
            nodeIds.map((id) => figma.getNodeByIdAsync(id))
          );
          const sceneNodes = [];
          for (const n of nodes) {
            if (!n) continue;
            if (n.type === "DOCUMENT" || n.type === "PAGE") continue;
            sceneNodes.push(n);
          }
          if (sceneNodes.length === 0) {
            figma.notify("\u041D\u043E\u0434\u044B \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u044B (\u0432\u043E\u0437\u043C\u043E\u0436\u043D\u043E \u0443\u0434\u0430\u043B\u0435\u043D\u044B).");
            return;
          }
          figma.currentPage.selection = sceneNodes;
          figma.viewport.scrollAndZoomIntoView(sceneNodes);
          if (sceneNodes.length !== nodeIds.length) {
            figma.notify(
              `\u0412\u044B\u0434\u0435\u043B\u0435\u043D\u043E ${sceneNodes.length} \u0438\u0437 ${nodeIds.length} \u043D\u043E\u0434 (\u0447\u0430\u0441\u0442\u044C \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430/\u043D\u0435 SceneNode).`
            );
          }
          return;
        }
        if (msg.type === "scan") {
          try {
            localPaintStyleIds = new Set(
              (await figma.getLocalPaintStylesAsync()).map((s) => s.id)
            );
            styleNameById = /* @__PURE__ */ new Map();
            for (const s of await figma.getLocalPaintStylesAsync()) {
              styleNameById.set(s.id, s.name);
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
            const nodesWithFillStyle = all.filter(
              (n) => "fillStyleId" in n && n.fillStyleId && n.fillStyleId !== figma.mixed
            ).length;
            console.log("[scan] nodes:", all.length, "nodesWithFillStyle:", nodesWithFillStyle);
            const issues = [];
            for (const n of all) {
              issues.push(...checkFillIsStyle(n));
              issues.push(...checkFillNotVariable(n));
              issues.push(...checkStrokeNotVariable(n));
            }
            const topMap = /* @__PURE__ */ new Map();
            for (const issue of issues) {
              if (issue.fillSourceKind !== "RAW") continue;
              if (!issue.fillValue) continue;
              topMap.set(issue.fillValue, ((_a = topMap.get(issue.fillValue)) != null ? _a : 0) + 1);
            }
            const rawFills = Array.from(topMap.entries()).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([hex, count]) => ({ hex, count }));
            const rawSuggestionsByHex = {};
            for (const rf of rawFills) {
              const rgba = hexToRGBAColor(rf.hex);
              if (!rgba) continue;
              const matches = findClosestPaletteCandidates(rgba, paletteCandidatesCache, 3);
              rawSuggestionsByHex[rf.hex] = matches.map((m) => ({
                kind: m.kind,
                id: m.id,
                name: m.name,
                distance: m.distance
              }));
            }
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
                rawSuggestionsByHex
              }
            });
          } catch (err) {
            console.error("[scan] error:", err);
            figma.notify(`Scan error: ${String(err)}`, { timeout: 6e3 });
            figma.ui.postMessage({
              type: "scan-result",
              payload: {
                summary: { total: 0, byType: {} },
                issues: [],
                rawFills: [],
                error: String(err)
              }
            });
          }
        }
      };
    }
  });
  require_code();
})();
//# sourceMappingURL=code.js.map
