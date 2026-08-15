/**
 * Port type strings used by pymss comfy-mss nodes.
 * Must match pymss/graph/core.py: AUDIO, STRING, PYMSS_MSS_PARAMS, PYMSS_VR_PARAMS,
 * plus ComfyUI core: BOOLEAN, COMBO.
 */
export const PORT = {
  AUDIO: 'AUDIO',
  STRING: 'STRING',
  MSS_PARAMS: 'PYMSS_MSS_PARAMS',
  VR_PARAMS: 'PYMSS_VR_PARAMS',
  BOOLEAN: 'BOOLEAN',
  COMBO: 'COMBO',
} as const

export type PortType = (typeof PORT)[keyof typeof PORT]

/**
 * Static node specification. Drives both litegraph registration and the
 * comfy-mss JSON adapter, so the two never drift apart.
 *
 * - `type`: the comfy-mss class_type (must match pymss register_node name).
 * - `inputs`: declared input slots. `widget` marks converted-widget inputs
 *   (ComfyUI keeps their value in widgets_values, not in a link).
 * - `outputs`: declared output slots. For separate nodes these are dynamic
 *   stem pairs and are set at runtime by the editor from the chosen model.
 * - `widgets`: ordered widget definitions; their order defines the
 *   `widgets_values` array layout that pymss reads by index.
 */
export interface WidgetSpec {
  name: string
  type: 'text' | 'combo' | 'number' | 'toggle'
  default: string | number | boolean
  options?: (string | number)[]
}

export interface InputSlotSpec {
  name: string
  type: PortType
  /** converted-widget input: link stays null, value lives in widgets_values */
  widget?: { name: string }
  shape?: number
  optional?: boolean
}

export interface OutputSlotSpec {
  name: string
  type: PortType
}

export interface NodeSpec {
  type: string
  title: string
  category: string
  inputs: InputSlotSpec[]
  outputs: OutputSlotSpec[]
  widgets: WidgetSpec[]
  /** output node (pymss SaveAudio family) */
  isOutput?: boolean
  /** dynamic stem outputs — editor rebuilds outputs from the active model */
  dynamicStems?: boolean
}

export const NODE_SPECS: Record<string, NodeSpec> = {
  pymss_load_audio: {
    type: 'pymss_load_audio',
    title: 'Load Audio',
    category: 'pymss/audio',
    inputs: [{ name: 'audio', type: PORT.COMBO, widget: { name: 'audio' } }],
    outputs: [
      { name: 'audio', type: PORT.AUDIO },
      { name: 'audio_name', type: PORT.STRING },
    ],
    widgets: [
      { name: 'audio', type: 'text', default: 'input.wav' },
      // Runtime input slot name: hosts (pymss-studio inference page / pymss CLI)
      // key their inputs mapping by this. Leave empty for graphs that carry
      // their own file path.
      { name: 'input_name', type: 'text', default: '' },
    ],
  },
  pymss_load_audio_batch: {
    type: 'pymss_load_audio_batch',
    title: 'Load Audio Batch',
    category: 'pymss/audio',
    inputs: [
      { name: 'folder', type: PORT.STRING },
      { name: 'recursive', type: PORT.BOOLEAN },
      { name: 'sort_files', type: PORT.BOOLEAN },
    ],
    outputs: [
      { name: 'audio', type: PORT.AUDIO },
      { name: 'audio_name', type: PORT.STRING },
    ],
    widgets: [
      { name: 'folder', type: 'text', default: '' },
      { name: 'recursive', type: 'toggle', default: false },
      { name: 'sort_files', type: 'toggle', default: true },
      // Runtime input slot name — same semantics as pymss_load_audio.
      { name: 'input_name', type: 'text', default: '' },
    ],
  },
  pymss_mss_params: {
    type: 'pymss_mss_params',
    title: 'MSS Params',
    category: 'pymss/params',
    inputs: [],
    outputs: [{ name: 'mss_params', type: PORT.MSS_PARAMS }],
    widgets: [
      { name: 'batch_size', type: 'number', default: 1 },
      { name: 'overlap_size', type: 'combo', default: 'Default', options: ['Default', '256', '512', '1024', '2048', '4096', '8192'] },
      { name: 'chunk_size', type: 'combo', default: 'Default', options: ['Default', 'Default', '256', '512', '1024', '2048', '4096', '8192'] },
      { name: 'normalize', type: 'toggle', default: false },
      { name: 'enable_tta', type: 'toggle', default: false },
      { name: 'standardize', type: 'toggle', default: false },
    ],
  },
  pymss_vr_params: {
    type: 'pymss_vr_params',
    title: 'VR Params',
    category: 'pymss/params',
    inputs: [],
    outputs: [{ name: 'vr_params', type: PORT.VR_PARAMS }],
    widgets: [
      { name: 'batch_size', type: 'number', default: 1 },
      { name: 'window_size', type: 'number', default: 512 },
      { name: 'aggression', type: 'number', default: 5 },
      { name: 'enable_tta', type: 'toggle', default: false },
      { name: 'high_end_process', type: 'toggle', default: false },
      { name: 'enable_post_process', type: 'toggle', default: false },
      { name: 'post_process_threshold', type: 'number', default: 0.2 },
      { name: 'normalize', type: 'toggle', default: false },
    ],
  },
  mss_separate: {
    type: 'mss_separate',
    title: 'MSS Separate',
    category: 'pymss/separate',
    inputs: [
      { name: 'audio', type: PORT.AUDIO },
      { name: 'params', type: PORT.MSS_PARAMS, shape: 7 },
    ],
    outputs: [],
    dynamicStems: true,
    widgets: [
      { name: 'model_name', type: 'combo', default: '', options: [] },
      { name: 'device', type: 'combo', default: 'auto', options: ['auto', 'cpu', 'cuda', 'mps'] },
      { name: 'download_missing', type: 'toggle', default: true },
      { name: 'source', type: 'combo', default: 'modelscope', options: ['modelscope', 'huggingface'] },
      { name: 'device_ids', type: 'text', default: '0' },
      { name: 'debug', type: 'toggle', default: false },
    ],
  },
  vr_separate: {
    type: 'vr_separate',
    title: 'VR Separate',
    category: 'pymss/separate',
    inputs: [
      { name: 'audio', type: PORT.AUDIO },
      { name: 'params', type: PORT.VR_PARAMS, shape: 7 },
    ],
    outputs: [],
    dynamicStems: true,
    widgets: [
      { name: 'model_name', type: 'combo', default: '', options: [] },
      { name: 'device', type: 'combo', default: 'auto', options: ['auto', 'cpu', 'cuda', 'mps'] },
      { name: 'download_missing', type: 'toggle', default: true },
      { name: 'source', type: 'combo', default: 'modelscope', options: ['modelscope', 'huggingface'] },
      { name: 'device_ids', type: 'text', default: '0' },
      { name: 'debug', type: 'toggle', default: false },
    ],
  },
  custom_mss_separate: {
    type: 'custom_mss_separate',
    title: 'Custom MSS Separate',
    category: 'pymss/separate',
    inputs: [
      { name: 'audio', type: PORT.AUDIO },
      { name: 'params', type: PORT.MSS_PARAMS, shape: 7 },
    ],
    outputs: [],
    dynamicStems: true,
    widgets: [
      { name: 'model_name', type: 'combo', default: '', options: [] },
      { name: 'model_type', type: 'combo', default: 'mel_band_roformer', options: ['mel_band_roformer', 'bs_roformer', 'bs_roformer_hyperace', 'mdx23c', 'htdemucs', 'apollo', 'bandit', 'bandit_v2', 'scnet'] },
      { name: 'device', type: 'combo', default: 'auto', options: ['auto', 'cpu', 'cuda', 'mps'] },
      { name: 'download_missing', type: 'toggle', default: false },
      { name: 'source', type: 'combo', default: 'modelscope', options: ['modelscope', 'huggingface'] },
      { name: 'device_ids', type: 'text', default: '0' },
      { name: 'debug', type: 'toggle', default: false },
    ],
  },
  pymss_save_audio: {
    type: 'pymss_save_audio',
    title: 'Save Audio',
    category: 'pymss/output',
    isOutput: true,
    inputs: [
      { name: 'audio', type: PORT.AUDIO },
      { name: 'filename', type: PORT.STRING, shape: 7 },
      { name: 'output_format', type: PORT.COMBO, widget: { name: 'output_format' } },
      { name: 'output_folder', type: PORT.STRING, widget: { name: 'output_folder' } },
      { name: 'sample_rate', type: PORT.COMBO, widget: { name: 'sample_rate' } },
      { name: 'wav_bit_depth', type: PORT.COMBO, widget: { name: 'wav_bit_depth' } },
      { name: 'flac_bit_depth', type: PORT.COMBO, widget: { name: 'flac_bit_depth' } },
      { name: 'mp3_bit_rate', type: PORT.COMBO, widget: { name: 'mp3_bit_rate' } },
    ],
    outputs: [],
    widgets: [
      { name: 'output_format', type: 'combo', default: 'wav', options: ['wav', 'flac', 'mp3', 'm4a'] },
      { name: 'output_folder', type: 'text', default: 'Default' },
      { name: 'sample_rate', type: 'combo', default: '44100', options: ['44100', '48000', '88200', '96000'] },
      { name: 'wav_bit_depth', type: 'combo', default: 'FLOAT', options: ['FLOAT', 'PCM_24', 'PCM_16'] },
      { name: 'flac_bit_depth', type: 'combo', default: 'PCM_24', options: ['PCM_24', 'PCM_16'] },
      { name: 'mp3_bit_rate', type: 'combo', default: '320k', options: ['128k', '192k', '256k', '320k'] },
    ],
  },
  pymss_audio_ensemble: {
    type: 'pymss_audio_ensemble',
    title: 'Audio Ensemble',
    category: 'pymss/audio_tools',
    inputs: [],
    outputs: [{ name: 'audio', type: PORT.AUDIO }],
    widgets: [{ name: 'input_count', type: 'number', default: 2 }],
  },
  pymss_audio_invert_phase: {
    type: 'pymss_audio_invert_phase',
    title: 'Invert Phase',
    category: 'pymss/audio_tools',
    inputs: [{ name: 'a', type: PORT.AUDIO }],
    outputs: [{ name: '-a', type: PORT.AUDIO }],
    widgets: [],
  },
  pymss_audio_normalize: {
    type: 'pymss_audio_normalize',
    title: 'Normalize',
    category: 'pymss/audio_tools',
    inputs: [{ name: 'audio', type: PORT.AUDIO }],
    outputs: [{ name: 'audio', type: PORT.AUDIO }],
    widgets: [],
  },
  PreviewAudio: {
    type: 'PreviewAudio',
    title: 'Preview Audio',
    category: 'pymss/output',
    inputs: [{ name: 'audio', type: PORT.AUDIO }],
    outputs: [],
    widgets: [],
  },
  StringConcatenate: {
    type: 'StringConcatenate',
    title: 'String Concatenate',
    category: 'pymss/string',
    inputs: [
      { name: 'string_a', type: PORT.STRING },
      { name: 'string_b', type: PORT.STRING },
      { name: 'delimiter', type: PORT.STRING, optional: true },
    ],
    outputs: [{ name: 'STRING', type: PORT.STRING }],
    widgets: [],
  },
}

export const BUILTIN_SPECS: Record<string, NodeSpec> = {
  // ComfyUI core audio nodes registered by pymss (pymss/graph/builtin_nodes.py)
  LoadAudio: {
    type: 'LoadAudio',
    title: 'Load Audio (Legacy)',
    category: 'pymss/builtin',
    inputs: [{ name: 'audio', type: PORT.COMBO, widget: { name: 'audio' } }],
    outputs: [
      { name: 'audio', type: PORT.AUDIO },
      { name: 'audio_name', type: PORT.STRING },
    ],
    widgets: [{ name: 'audio', type: 'text', default: 'input2.wav' }],
  },
  SaveAudio: {
    type: 'SaveAudio',
    title: 'Save Audio (FLAC)',
    category: 'pymss/builtin',
    isOutput: true,
    inputs: [
      { name: 'audio', type: PORT.AUDIO },
      { name: 'filename_prefix', type: PORT.STRING },
    ],
    outputs: [],
    widgets: [],
  },
  SaveAudioMP3: {
    type: 'SaveAudioMP3',
    title: 'Save Audio MP3',
    category: 'pymss/builtin',
    isOutput: true,
    inputs: [
      { name: 'audio', type: PORT.AUDIO },
      { name: 'filename_prefix', type: PORT.STRING },
      { name: 'quality', type: PORT.COMBO, widget: { name: 'quality' } },
    ],
    outputs: [],
    widgets: [{ name: 'quality', type: 'combo', default: 'V0', options: ['V0', 'V1', 'V2', '320k', '256k', '192k', '128k'] }],
  },
  SaveAudioOpus: {
    type: 'SaveAudioOpus',
    title: 'Save Audio Opus',
    category: 'pymss/builtin',
    isOutput: true,
    inputs: [
      { name: 'audio', type: PORT.AUDIO },
      { name: 'filename_prefix', type: PORT.STRING },
      { name: 'bitrate', type: PORT.COMBO, widget: { name: 'bitrate' } },
    ],
    outputs: [],
    widgets: [{ name: 'bitrate', type: 'combo', default: '128k', options: ['96k', '128k', '160k', '192k', '256k'] }],
  },
  SaveAudioAdvanced: {
    type: 'SaveAudioAdvanced',
    title: 'Save Audio Advanced',
    category: 'pymss/builtin',
    isOutput: true,
    inputs: [
      { name: 'audio', type: PORT.AUDIO },
      { name: 'filename_prefix', type: PORT.STRING },
      { name: 'output_format', type: PORT.COMBO, widget: { name: 'output_format' } },
      { name: 'sample_rate', type: PORT.COMBO, widget: { name: 'sample_rate' } },
      { name: 'wav_bit_depth', type: PORT.COMBO, widget: { name: 'wav_bit_depth' } },
      { name: 'flac_bit_depth', type: PORT.COMBO, widget: { name: 'flac_bit_depth' } },
      { name: 'mp3_bit_rate', type: PORT.COMBO, widget: { name: 'mp3_bit_rate' } },
    ],
    outputs: [],
    widgets: [
      { name: 'output_format', type: 'combo', default: 'wav', options: ['wav', 'flac', 'mp3', 'opus'] },
      { name: 'sample_rate', type: 'combo', default: '44100', options: ['44100', '48000', '88200', '96000'] },
      { name: 'wav_bit_depth', type: 'combo', default: 'FLOAT', options: ['FLOAT', 'PCM_24', 'PCM_16'] },
      { name: 'flac_bit_depth', type: 'combo', default: 'PCM_24', options: ['PCM_24', 'PCM_16'] },
      { name: 'mp3_bit_rate', type: 'combo', default: '320k', options: ['128k', '192k', '256k', '320k'] },
    ],
  },
  TrimAudioDuration: {
    type: 'TrimAudioDuration',
    title: 'Trim Audio Duration',
    category: 'pymss/builtin',
    inputs: [
      { name: 'audio', type: PORT.AUDIO },
      { name: 'start_index', type: PORT.COMBO },
      { name: 'duration', type: PORT.COMBO },
    ],
    outputs: [{ name: 'audio', type: PORT.AUDIO }],
    widgets: [],
  },
  SplitAudioChannels: {
    type: 'SplitAudioChannels',
    title: 'Split Audio Channels',
    category: 'pymss/builtin',
    inputs: [{ name: 'audio', type: PORT.AUDIO }],
    outputs: [
      { name: 'left', type: PORT.AUDIO },
      { name: 'right', type: PORT.AUDIO },
    ],
    widgets: [],
  },
  JoinAudioChannels: {
    type: 'JoinAudioChannels',
    title: 'Join Audio Channels',
    category: 'pymss/builtin',
    inputs: [
      { name: 'audio_left', type: PORT.AUDIO },
      { name: 'audio_right', type: PORT.AUDIO },
    ],
    outputs: [{ name: 'audio', type: PORT.AUDIO }],
    widgets: [],
  },
  AudioConcat: {
    type: 'AudioConcat',
    title: 'Audio Concat',
    category: 'pymss/builtin',
    inputs: [
      { name: 'audio1', type: PORT.AUDIO },
      { name: 'audio2', type: PORT.AUDIO },
      { name: 'direction', type: PORT.COMBO, widget: { name: 'direction' } },
    ],
    outputs: [{ name: 'audio', type: PORT.AUDIO }],
    widgets: [{ name: 'direction', type: 'combo', default: 'front', options: ['front', 'back'] }],
  },
  AudioMerge: {
    type: 'AudioMerge',
    title: 'Audio Merge',
    category: 'pymss/builtin',
    inputs: [
      { name: 'audio1', type: PORT.AUDIO },
      { name: 'audio2', type: PORT.AUDIO },
      { name: 'merge_method', type: PORT.COMBO, widget: { name: 'merge_method' } },
    ],
    outputs: [{ name: 'audio', type: PORT.AUDIO }],
    widgets: [{ name: 'merge_method', type: 'combo', default: 'average', options: ['average', 'append', 'sum'] }],
  },
  AudioAdjustVolume: {
    type: 'AudioAdjustVolume',
    title: 'Adjust Volume',
    category: 'pymss/builtin',
    inputs: [
      { name: 'audio', type: PORT.AUDIO },
      { name: 'volume', type: PORT.COMBO },
    ],
    outputs: [{ name: 'audio', type: PORT.AUDIO }],
    widgets: [],
  },
  EmptyAudio: {
    type: 'EmptyAudio',
    title: 'Empty Audio',
    category: 'pymss/builtin',
    inputs: [
      { name: 'duration', type: PORT.COMBO },
      { name: 'sample_rate', type: PORT.COMBO },
      { name: 'channels', type: PORT.COMBO },
    ],
    outputs: [{ name: 'audio', type: PORT.AUDIO }],
    widgets: [],
  },
  AudioEqualizer3Band: {
    type: 'AudioEqualizer3Band',
    title: '3-Band Equalizer',
    category: 'pymss/builtin',
    inputs: [
      { name: 'audio', type: PORT.AUDIO },
      { name: 'low_gain_dB', type: PORT.COMBO },
      { name: 'low_freq', type: PORT.COMBO },
      { name: 'mid_gain_dB', type: PORT.COMBO },
      { name: 'mid_freq', type: PORT.COMBO },
      { name: 'mid_q', type: PORT.COMBO },
      { name: 'high_gain_dB', type: PORT.COMBO },
      { name: 'high_freq', type: PORT.COMBO },
    ],
    outputs: [{ name: 'audio', type: PORT.AUDIO }],
    widgets: [],
  },
  // ComfyUI core string nodes registered by pymss
  StringSubstring: {
    type: 'StringSubstring',
    title: 'String Substring',
    category: 'pymss/string',
    inputs: [
      { name: 'string', type: PORT.STRING },
      { name: 'start', type: PORT.COMBO },
      { name: 'end', type: PORT.COMBO },
    ],
    outputs: [{ name: 'STRING', type: PORT.STRING }],
    widgets: [],
  },
  StringReplace: {
    type: 'StringReplace',
    title: 'String Replace',
    category: 'pymss/string',
    inputs: [
      { name: 'string', type: PORT.STRING },
      { name: 'find', type: PORT.STRING },
      { name: 'replace', type: PORT.STRING },
    ],
    outputs: [{ name: 'STRING', type: PORT.STRING }],
    widgets: [],
  },
  StringTrim: {
    type: 'StringTrim',
    title: 'String Trim',
    category: 'pymss/string',
    inputs: [
      { name: 'string', type: PORT.STRING },
      { name: 'mode', type: PORT.COMBO, widget: { name: 'mode' } },
    ],
    outputs: [{ name: 'STRING', type: PORT.STRING }],
    widgets: [{ name: 'mode', type: 'combo', default: 'both', options: ['both', 'left', 'right'] }],
  },
  CaseConverter: {
    type: 'CaseConverter',
    title: 'Case Converter',
    category: 'pymss/string',
    inputs: [
      { name: 'string', type: PORT.STRING },
      { name: 'mode', type: PORT.COMBO, widget: { name: 'mode' } },
    ],
    outputs: [{ name: 'STRING', type: PORT.STRING }],
    widgets: [{ name: 'mode', type: 'combo', default: 'upper', options: ['upper', 'lower', 'title', 'capitalize'] }],
  },
  StringFormat: {
    type: 'StringFormat',
    title: 'String Format',
    category: 'pymss/string',
    inputs: [
      { name: 'value', type: PORT.STRING },
      { name: 'f_string', type: PORT.STRING },
    ],
    outputs: [{ name: 'STRING', type: PORT.STRING }],
    widgets: [],
  },
  RegexReplace: {
    type: 'RegexReplace',
    title: 'Regex Replace',
    category: 'pymss/string',
    inputs: [
      { name: 'string', type: PORT.STRING },
      { name: 'regex_pattern', type: PORT.STRING },
      { name: 'replace', type: PORT.STRING },
    ],
    outputs: [{ name: 'STRING', type: PORT.STRING }],
    widgets: [],
  },
  RegexExtract: {
    type: 'RegexExtract',
    title: 'Regex Extract',
    category: 'pymss/string',
    inputs: [
      { name: 'string', type: PORT.STRING },
      { name: 'regex_pattern', type: PORT.STRING },
      { name: 'mode', type: PORT.COMBO, widget: { name: 'mode' } },
      { name: 'group_index', type: PORT.COMBO },
    ],
    outputs: [{ name: 'STRING', type: PORT.STRING }],
    widgets: [{ name: 'mode', type: 'combo', default: 'first', options: ['first', 'all'] }],
  },
  JsonExtractString: {
    type: 'JsonExtractString',
    title: 'JSON Extract String',
    category: 'pymss/string',
    inputs: [
      { name: 'json_string', type: PORT.STRING },
      { name: 'key', type: PORT.STRING },
    ],
    outputs: [{ name: 'STRING', type: PORT.STRING }],
    widgets: [],
  },
}
