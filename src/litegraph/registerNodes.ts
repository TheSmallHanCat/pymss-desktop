/**
 * Register all pymss comfy-mss node types into LiteGraph.
 *
 * Each node's `type` string equals the comfy class_type pymss registers
 * (pymss/graph/nodes.py), so a serialized graph loads directly via
 * pymss.graph.load_comfy_file.
 */
import { LiteGraph, LGraphNode, type LGraphNode as LGraphNodeType } from '@comfyorg/litegraph'
import { NODE_SPECS, NodeSpec, WidgetSpec, PORT } from './nodeSpecs'

type AnyNode = any

function widgetCallback(node: AnyNode, spec: WidgetSpec) {
  return (v: any) => {
    node.properties[spec.name] = v
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
  klass._pymssSpec = spec
  return klass
}

let registered = false

export function registerPymssNodes() {
  if (registered) return
  registered = true
  for (const spec of Object.values(NODE_SPECS)) {
    LiteGraph.registerNodeType(spec.type, makeNodeClass(spec) as any)
  }
}

export { NODE_SPECS }
