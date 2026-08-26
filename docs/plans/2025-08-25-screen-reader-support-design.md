# Pymss Studio 读屏支持设计方案

- **日期**: 2025-08-25
- **状态**: 已确认,待实施
- **方案**: C — 简化操作页 + 主界面全量可达(含画布可驱动)
- **读屏矩阵**: NVDA + Windows 讲述器 + JAWS(试用版)
- **波形策略**: 播放 + 口述时间码 + 轨道文本摘要(不做声学声化)

---

## 0. 背景与现状

Pymss Studio 是 Tauri 桌面应用(Vue 3 + Naive UI + Rust 编排 Python worker),核心功能是音源分离。代码库**已有部分可达性地基**:

- Naive UI 组件自带 ARIA;手写 `role="dialog"`/`aria-modal` 共 **8 处**:SeparateView×4、ModelsView×1、`CustomModelImportDialog`、`DownloadDetailModal`、`WorkflowRevisionConflictModal`
- `EditorTransportBar` 已有 `sr-only` 类、`aria-pressed`、`aria-label`
- `SeparateView` 已有 `role="listbox"`/`role="option"`/`aria-selected`
- `useEditorShortcuts.ts` 已有一套编辑器全局键盘快捷键(播放/停止/跳转 ±1s/±5s/静音/独奏/缩放/撤销重做/保存)
- i18n 双语(zh-CN / en),`tests/i18nKeys.test.ts` 校验两份键一致

**主要缺口**:

1. 画布部件 `EditorWaveform`(纯 `<canvas>`,无文本替代)和 `WorkflowNodeEditor`(5000 行 2D 空间图)对读屏完全不可达
2. 自定义容器键盘不可操作(轨道行 `@mousedown` 选择、跳转靠鼠标坐标、资源拖拽仅鼠标)
3. 进度/toast/播放态无 `aria-live` 播报
4. 手写 `role="dialog"` 缺焦点陷阱与焦点回归
5. 自定义控件(`.chip`/`.nav-item`/`.track-row`)无 `:focus-visible` 焦点环

Tauri 用 WebView2(Chromium),MSAA/UIA 树自动暴露给读屏,**无需改 Rust 或 Python worker**。

## 0.1 架构策略

考虑过三条路:

- **A. 复用 Naive UI a11y + 自建薄层原语 + 为画布加并行可访问 DOM**(推荐)
- B. 自建全套 a11y 框架(焦点陷阱/树漫游/直播区全自研)
- C. 引入 `focus-trap`、`aria-live` 等外部库

选 **A**:已有地基可直接嫁接;Tauri WebView2 自动暴露 a11y 树;外部库与离线打包/体积不划算。两个画布部件的核心思路是**提供文本化等价界面**,而非让 2D 画布本身可键盘拖拽——这是 WAI-ARIA 对复杂空间控件的标准做法。

## 0.2 简化页决策

用户选 **方案 C(两者都要,最全)**:

- **路径 1 — 简化操作页 `/simple`**:线性、语义化、表单驱动,覆盖分离 + 模型管理 + 结果。盲人用户日常走这条。
- **路径 2 — 主界面全量可达**:所有原视图做到 ARIA 完整 + 键盘可操作 + 焦点管理 + 直播区;波形与工作流画布额外做成可驱动,供进阶盲人用户使用。

两条路径共享同一套 stores(`task`/`model`/`settings`/`workflow`/`editor`)和原语层,不另起状态。

---

## 1. 原语层(新增,两条路径共用)

| 文件 | 作用 |
|---|---|
| `src/components/A11yProvider.vue` | 挂 `aria-live` polite/assertive 双区、跳转链接目标、路由切换焦点迁移 |
| `src/composables/useLiveAnnouncer.ts` | 单例播报器(进度/toast/播放态/时间码),节流策略(播放中默认每 1s) |
| `src/composables/useFocusTrap.ts` | 手写 `role="dialog"` 块的陷阱 + 回归焦点 + Esc 关闭 |
| `src/composables/useRovingTabindex.ts` | 混音器轨道行、工作流节点的漫游焦点 |
| `src/components/SrText.vue` | 全局 `sr-only` 文本包装(把 `EditorTransportBar` 内联 `.sr-only` 提为全局) |

## 2. 简化操作页 `/simple`(新增)

**路由与入口**: `/simple` 路由;SideNav 底部 + 设置页 + 首启 Onboarding 三处放"简化操作模式"入口。**不自动跳转**(JS 检测读屏不可靠且涉隐私)。

**布局**: 单列纵向,语义化 `<section>` + `<h1/h2>` 层级,纯表单控件,原生 `<audio controls>` 播放(读屏天然支持)。

- **分离区**: `<select>` 模型 / `<select>` 工作流 → 按钮"添加音频文件"(调现有 dialog plugin) → 待处理文件列表(可键盘移除) → "开始分离"按钮 → `aria-live` 进度区 → 完成后"导出"按钮
- **模型管理区**: 列表 + 安装/删除/导入按钮(复用 `useModelStore`)
- **结果区**: 分离完成列表 + 原生 `<audio>` 预览 + 导出
- **顶部条**: 返回主界面 / 切换语言 / 设置入口

**复用**: 不重写分离逻辑,全部调现有 stores/actions;`worker.py` 与 Rust 层零改动。

**缓解"分别但不平等"**:

- 同一引擎、同一模型、同一分离质量、同一输出;文案叫"简化操作模式 / Simplified Mode",不叫"盲人版"
- 简化页只覆盖分离 + 模型管理 + 结果;工作流编辑器和波形混音器不进简化页,盲人进阶用户走主界面(基线可达 + 文本大纲兜底)
- 数据共享:简化页直接复用现有 stores,不另起状态,分叉风险主要在视图层

## 3. 全局外壳与导航

- **跳转链接**: `App.vue` 首个可聚焦元素加"跳到主内容";`<main id="main-content" tabindex="-1">`
- **路由焦点 + 标题**: 路由切换时焦点移到 `<main>` 或视图标题;同步设置 `document.title`(TitleBar 显示了 `pageTitle` 但 `document.title` 未设,读屏靠标题播报导航)
- **SideNav**: `<aside>` → `<nav :aria-label="t('a11y.mainNav')">`;活动项加 `aria-current="page"`(现仅有 `.active` 样式类);导航名称和跳转链接文本均通过 i18n 键提供,不硬编码中文
- **启动遮罩**: `StartupOnboarding` 打开时焦点进首按钮并陷阱;`boot-splash` 给 `aria-hidden`(瞬态,不应被读)
- `document.documentElement.lang` 已在 i18n 设好 ✓

## 4. 标准视图(分离/模型/结果/设置/工作流列表)— 主界面路径

查漏补缺(已有不错地基):

- **SeparateView**: `role=listbox/option/aria-selected` 已有但需补完整 listbox 键盘行为(方向键/Home/End + 单一 tabstop,或改为普通列表按钮语义);4 个手写 `role="dialog"` 块过 `useFocusTrap`;分离任务进度接 `useLiveAnnouncer`(开始/完成/失败);文件拖放区改成可键盘操作(`tabindex` + Enter)
- **ModelsView**: 已有 `aria-pressed/tabindex/aria-current` ✓;模型卡 Enter/Space 激活;下载进度接直播区
- **SettingsView**: 已有 `aria-label` 侧栏 ✓;核对每个控件 label 关联;模型目录迁移进度直播
- **ResultsView**: 结果列表补 `role`/表头/动作 `aria-label`
- **WorkflowsView**: `SideNav.vue:21` 将 `/workflows` 作为一级导航项;对工作流列表页做全量审计:ARIA 结构、键盘可达性、焦点管理、新建/打开/删除操作结果经直播区播报

## 5. 编辑器:混音器 + 传输条 + 波形 — 主界面路径

- **传输条**: 已到位 ✓
- **轨道行**: `@mousedown` 选择 → `useRovingTabindex`(↑↓ 切换、Enter 选中、**M 静音 / R 独奏**,与 `useEditorShortcuts.ts:75-81` 的实现一致);选中状态经直播区播报
- **跳转**: 已有 ArrowLeft/Right ±1s/±5s ✓;轨道聚焦时跳转,直播区口述时间码(节流,可开关)
- **淡入淡出**: 若靠波形拖拽,确保 Inspector 里有数字输入框且带 label(可键盘编辑)
- **波形 `EditorWaveform`**: `<canvas>` 加 `role="img"` + 描述性 `aria-label`(名称/声道/时长/淡入淡出);轨道头加 `SrText` 摘要(名称/声道/时长/淡入淡出/静音态);聚焦时口述响度概况(从 `peaks` 算一句,如"约 2.3s 处最响,后半段较安静")
- **电平表**: `track-meter` 仅可视;聚焦时口述峰值数值(已有 `title` 但 title 不可靠)
- **资源入轨**: `EditorAssetPanel` 每个资源加"加入时间线"动作(Enter/按钮 → `addTrackFromAsset`),替代鼠标拖拽

## 6. 工作流节点编辑器 — 主界面路径(最深)

1. **"图形大纲"替代视图**(主可访问路径): 工具栏加切换,画布换成 `role="tree"`/`role="treeitem"` 嵌套列表——步骤(含模型/输入/输出)→ 工具节点 → 保存目标 → 备注。按 WAI-ARIA 树模式箭头键导航
2. **连接编辑**: 大纲树里每个步骤的输入用 `combobox` 选源(上一步输出/工具输出),替代拖线;候选项逻辑当前位于 `WorkflowNodeEditor.vue` 的 `inputOptions(index)`(注:`buildWorkflowConsumedValueSetForDraft` 只统计已消费输出,不能生成候选源);**需提取并共享该候选项构建/校验逻辑**,供大纲树与画布共同消费,避免连接规则漂移
3. **画布可驱动**(C 的额外深度): `useRovingTabindex` 遍历节点,Enter 开节点编辑器,Delete 删除(已有快捷键 ✓),选择/缩放状态经直播区播报
4. 复用已有 copy/paste/undo/redo 快捷键 ✓

## 7. 对话框与遮罩审计

盘点所有手写 `role="dialog"` 共 **8 处**(SeparateView×4、ModelsView×1、`CustomModelImportDialog`、`DownloadDetailModal`、`WorkflowRevisionConflictModal`):逐一核对**焦点陷阱 + 初始焦点 + Esc 关闭 + 焦点回归 + `aria-labelledby` 指向标题**。Naive UI 的 `n-dialog`/`n-modal` 自带陷阱,主要查手写那几个。

## 8. 直播区与进度

- 任务/下载/分离进度 → `useLiveAnnouncer`
- **Toast**(`useMessage`): Naive UI 消息默认不被读屏播报 → 每个 `message.*` 调用旁挂一次播报
- 播放/暂停/停止/跳转状态变化 → 播报

## 9. 焦点样式与对比

- 全局 `:focus-visible` 焦点环(自定义 `.chip`/`.nav-item`/`.track-row` 等都缺)
- 定义可见焦点环 token,亮/暗主题都可见;复用现有主题 token 体系(`--primary` 等)

## 10. i18n

- 所有新 aria 串加进 `src/i18n/zh-CN.json` 和 `en.json`
- `tests/i18nKeys.test.ts` 同步加键(它本来就校验两份一致)
- 优先复用已有键(`common.collapse/minimize/maximize/close/undo/redo` 等)

## 11. 测试与验证矩阵

| 维度 | 做法 |
|---|---|
| NVDA | WebView2 下全视图键盘走查 |
| Windows 讲述器 | 同上 |
| JAWS(试用版) | 重点查自定义控件 quirks(树/列表框/combobox) |
| 纯键盘 | 每个视图无鼠标完成主流程 |
| 自动化 | dev-only 接入 axe-core,加 `tests/a11y` 冒烟(渲染视图跑规则) |
| 快捷键帮助 | 复用 `useEditorShortcuts`,加一个"快捷键列表"对话框 |
| CI | 现有 `pnpm test` 加 i18n 键校验已覆盖;axe 跑在 dev |

## 12. 落地顺序(C 范围)

1. 原语层(`A11yProvider`/`useLiveAnnouncer`/`useFocusTrap`/`useRovingTabindex`/`SrText`) + 全局外壳(跳转链接/路由焦点/标题/SideNav)
2. **简化页 `/simple`**(尽早交付盲人核心路径价值)
3. 对话框审计 + Toast/进度直播区
4. 标准视图查漏(主界面:Separate/Models/Results/Settings)
5. 编辑器(混音器轨道行键盘化 + 波形文本摘要 + 时间码播报)
6. 工作流图形大纲 + 连接 combobox + 画布可驱动(最深,最后)
7. 焦点样式 + axe 冒烟 + 三读屏走查

## 13. 不在本期范围(YAGNI)

- 声学声化(耳标/音高映射波形)——用户明确选不做
- 读屏软件自动检测与自动跳转——涉隐私且不可靠
- macOS VoiceOver 支持——当前只有 Windows 构建(AGENTS.md)
- 高对比度主题单独实现——复用现有主题 token,仅保证焦点环可见即可
- Rust/Python worker 层改动——WebView2 自动暴露 a11y 树,无需后端参与
