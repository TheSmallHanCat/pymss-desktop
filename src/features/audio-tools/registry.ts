import { AnalyticsOutline, CutOutline, GitMergeOutline, InformationCircleOutline, MicOutline, MusicalNoteOutline, SwapHorizontalOutline } from '@vicons/ionicons5'
import type { AudioToolDefinition } from './types'
import ConvertTool from './tools/convert'
import SdrTool from './tools/sdr'
import MidiTool from './tools/midi'
import InspectTool from './tools/inspect'
import SlicerTool from './tools/slicer'
import AsrTool from './tools/asr'
import MergeTool from './tools/merge'

export const audioTools: AudioToolDefinition[] = [
  { id: 'convert', category: 'convert', titleKey: 'tools.convertTitle', descriptionKey: 'tools.convertDescription', icon: SwapHorizontalOutline, component: ConvertTool },
  { id: 'inspect', category: 'analyze', titleKey: 'tools.inspectTitle', descriptionKey: 'tools.inspectDescription', icon: InformationCircleOutline, component: InspectTool },
  { id: 'sdr', category: 'analyze', titleKey: 'tools.sdrTitle', descriptionKey: 'tools.sdrDescription', icon: AnalyticsOutline, component: SdrTool },
  { id: 'asr', category: 'recognize', titleKey: 'tools.asrTitle', descriptionKey: 'tools.asrDescription', icon: MicOutline, component: AsrTool },
  { id: 'midi', category: 'recognize', titleKey: 'tools.midiTitle', descriptionKey: 'tools.midiDescription', icon: MusicalNoteOutline, component: MidiTool },
  { id: 'slicer', category: 'edit', titleKey: 'tools.slicerTitle', descriptionKey: 'tools.slicerDescription', icon: CutOutline, component: SlicerTool },
  { id: 'merge', category: 'edit', titleKey: 'tools.mergeTitle', descriptionKey: 'tools.mergeDescription', icon: GitMergeOutline, component: MergeTool },
]
