/**
 * Register all pymss comfy-mss node types into LiteGraph.
 *
 * Each node's `type` string equals the comfy class_type pymss registers
 * (pymss/graph/nodes.py), so a serialized graph loads directly via
 * pymss.graph.load_comfy_file.
 */
import { LiteGraph, LGraphNode, LGraphCanvas, type LGraphNode as LGraphNodeType } from '@comfyorg/litegraph'
import { NODE_SPECS, BUILTIN_SPECS, NodeSpec, WidgetSpec, PORT } from './nodeSpecs'

type AnyNode = any

// litegraph 0.17 的 hidpi 处理是坏的: resize() 把 bgcanvas/canvas 尺寸都设为
// CSS 像素,但 drawBackCanvas() 里 ctx.setTransform(devicePixelRatio,...) 又乘
// 了 dpr,且 drawFrontCanvas 合成时 drawImage(bgcanvas, w/dpr, h/dpr) 再除一次。
// Retina(dpr=2)下背景内容只占左上 1/4。上游 bug 未修,这里 patch 两个绘制方法,
// 绘制期间把 window.devicePixelRatio 视为 1,让整个画布统一按 CSS 分辨率渲染
// (代价: Retina 下画布内容略低清,但渲染区域和鼠标坐标都正确)。
if (typeof window !== 'undefined') {
  const proto = (LGraphCanvas as any)?.prototype
  if (proto && !proto.__pymssDprPatched) {
    const withCssDpr = (fn: (...a: any[]) => any) => function (this: any, ...args: any[]) {
      const realDpr = window.devicePixelRatio
      Object.defineProperty(window, 'devicePixelRatio', { get: () => 1, configurable: true })
      try {
        return fn.apply(this, args)
      } finally {
        Object.defineProperty(window, 'devicePixelRatio', { get: () => realDpr, configurable: true })
      }
    }
    proto.drawBackCanvas = withCssDpr(proto.drawBackCanvas)
    proto.drawFrontCanvas = withCssDpr(proto.drawFrontCanvas)
    proto.__pymssDprPatched = true
  }
}

// 右键菜单/搜索框的子菜单默认需要点击才展开。litegraph 的 ContextMenu 支持
// autoopen 选项(hover 自动展开子菜单)但没有全局开关,这里 patch 构造函数,
// 所有菜单默认 autoopen: true。
if (typeof window !== 'undefined') {
  const CM = (LiteGraph as any).ContextMenu
  if (CM && !CM.__pymssAutoopenPatched) {
    const origCtor = CM
    const PatchedCM = function (this: any, ...args: any[]) {
      if (args[1] && typeof args[1] === 'object') args[1].autoopen = args[1].autoopen ?? true
      return new origCtor(...args)
    }
    PatchedCM.prototype = origCtor.prototype
    Object.setPrototypeOf(PatchedCM, origCtor)
    for (const k of Object.getOwnPropertyNames(origCtor)) {
      if (!['prototype', 'name', 'length'].includes(k)) {
        try { (PatchedCM as any)[k] = (origCtor as any)[k] } catch { /* getter-only */ }
      }
    }
    ;(LiteGraph as any).ContextMenu = PatchedCM
    PatchedCM.__pymssAutoopenPatched = true
  }
}

function widgetCallback(node: AnyNode, spec: WidgetSpec) {
  return (v: any) => {
    node.properties[spec.name] = v
    if (spec.name === 'model_name') {
      node.onModelNameChanged?.(v)
    }
    // Widget edits (changeValue path) do not notify the graph on their own —
    // canvas node ops wrap themselves in beforeChange/afterChange, but
    // widget edits don't. Fire afterChange so undo/save toolbars enable.
    node.graph?.afterChange(node)
  }
}

/** Default stems when no model is selected yet (two placeholder slots). */
const DEFAULT_STEMS = ['stem_1', 'stem_2']

/** Build a stem pair of outputs: `<stem> (Audio)` + `<stem> (String)`. */
function stemOutputNames(stem: string) {
  return [`${stem} (Audio)`, `${stem} (String)`]
}

/**
 * Apply the dynamic stem outputs to a separate node (idempotent).
 * Called by the editor after the user picks a model whose stems are known.
 */
export function setSeparateStems(node: LGraphNodeType, stems: string[]) {
  const n = node as AnyNode
  while (n.outputs && n.outputs.length) n.removeOutput(0)
  const list = stems.length ? stems : DEFAULT_STEMS
  for (const stem of list) {
    for (const name of stemOutputNames(stem)) {
      n.addOutput(name, PORT.AUDIO === name ? PORT.AUDIO : (name.endsWith('(String)') ? PORT.STRING : PORT.AUDIO))
    }
  }
  n.stems = list
}

/** Inject the downloaded-model list into every separate node's model_name
 * combo: spec defaults (new nodes) + live widgets (editor calls refresh below). */
export function applyModelOptions(values: string[]) {
  for (const spec of Object.values(NODE_SPECS)) {
    for (const w of spec.widgets) {
      if (w.name === 'model_name') w.options = values
    }
  }
}

/** Refresh one node instance's model_name combo options (call after graph
 * configure and whenever the model list changes). */
export function refreshNodeModelOptions(node: any, values: string[]) {
  const widget = (node.widgets || []).find((w: any) => w.name === 'model_name')
  if (!widget) return
  widget.options = widget.options || {}
  widget.options.values = values
}

function makeNodeClass(spec: NodeSpec): any {
  const klass = class extends LGraphNode {
    static title = spec.title
    static category = spec.category
    stems: string[] = spec.dynamicStems ? DEFAULT_STEMS : []

    constructor() {
      super(spec.title)
      this.serialize_widgets = true
      this.properties = this.properties || {}
      for (const w of spec.widgets) {
        if (this.properties[w.name] === undefined) this.properties[w.name] = w.default
        const wtype = w.type === 'toggle' ? 'toggle' : w.type === 'number' ? 'number' : w.type === 'combo' ? 'combo' : 'text'
        const widget = this.addWidget(
          wtype as any,
          w.name,
          this.properties[w.name],
          widgetCallback(this, w) as any,
          (w.options ? { values: w.options } : undefined) as any,
        )
        if (widget) widget.value = this.properties[w.name]
      }

      for (const input of spec.inputs) {
        const extra: any = {}
        if (input.widget) extra.widget = { name: input.widget.name }
        if (input.shape !== undefined) extra.shape = input.shape
        this.addInput(input.name, input.type, extra)
      }

      if (spec.dynamicStems) {
        for (const stem of DEFAULT_STEMS) {
          for (const name of stemOutputNames(stem)) {
            this.addOutput(name, name.endsWith('(String)') ? PORT.STRING : PORT.AUDIO)
          }
        }
      } else {
        for (const output of spec.outputs) this.addOutput(output.name, output.type)
      }

      if (spec.isOutput) (this as any).is_output_node = true
    }

    onExecute() {
      /* Execution happens in pymss; the canvas is edit-only. */
    }
  }
  ;(klass as any)._pymssSpec = spec
  return klass
}

let registered = false

/** Node type names pymss accepts (bare + pymss_ prefix alias for separates). */
export function allNodeTypes(): string[] {
  const types = new Set<string>()
  for (const spec of Object.values(NODE_SPECS)) {
    types.add(spec.type)
    if (spec.dynamicStems && spec.type.startsWith('mss_')) types.add(`pymss_${spec.type}`)
  }
  for (const spec of Object.values(BUILTIN_SPECS)) types.add(spec.type)
  return [...types]
}

export function registerPymssNodes() {
  if (registered) return
  registered = true
  const register = (spec: NodeSpec, type = spec.type) => {
    const cls = makeNodeClass(spec) as any
    LiteGraph.registerNodeType(type, cls)
    // registerNodeType 用 type 名派生 category(无 '/' 时置空串,覆盖类的
    // static category),导致右键 Add Node 菜单按类别分组为空。补回 spec.category。
    cls.category = spec.category
  }
  for (const spec of Object.values(NODE_SPECS)) {
    register(spec)
    // pymss registers `pymss_mss_separate` etc. as aliases of the bare names;
    // register the same class under the prefixed name so imported graphs load.
    if (spec.dynamicStems && spec.type.startsWith('mss_')) {
      register(spec, `pymss_${spec.type}`)
    }
  }
  for (const spec of Object.values(BUILTIN_SPECS)) {
    register(spec)
  }
}

export { NODE_SPECS, BUILTIN_SPECS }
