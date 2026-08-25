# Pymss Studio 读屏支持 — 实施计划

- **对应设计**: `docs/plans/2025-08-25-screen-reader-support-design.md`(方案 C)
- **分支**: `feat/screen-reader-support`(基于 `main@7c1a18e`)
- **基线核对**: 2025-08-25 已对最新 main 重新核对
  - `styles/global.scss` 存在但无 `:focus`/`:focus-visible` 样式 → 焦点环确为空白
  - 手写 `role="dialog"` 共 8 处:SeparateView×4、ModelsView×1、`DownloadDetailModal`、`CustomModelImportDialog`、`WorkflowRevisionConflictModal`
  - router 为 hash 路由,加 `/simple` 直接增条目即可
  - `main.ts` bootstrap 清晰,stores 在 pinia 挂载后惰性初始化
  - 已有 `useEditorShortcuts`、`EditorTransportBar` 的 `sr-only`/`aria-pressed`、`SeparateView` 的 `role=listbox/option` 等地基

## 实施原则

- **每个阶段可独立提交、可独立验证**;不依赖后续阶段即可运行
- **每个任务给出验收标准**(读屏/键盘/自动三类)与**触及文件**
- **i18n 双语同步**:`zh-CN.json` 与 `en.json` 必须同批改;改完跑 `tests/i18nKeys.test.ts`
- **不碰 Rust / Python worker**:WebView2 自动暴露 a11y 树,后端零改动
- **复用优先**:优先复用 Naive UI 自带 a11y 与已有 stores/actions,不重写业务逻辑
- **提交粒度**:按阶段内的任务提交,commit message 用 `feat(a11y):` / `fix(a11y):` 前缀

---

## 阶段 1 — 原语层 + 全局外壳

> 这一层是后续所有阶段的地基,且能立即提升全应用基线。最先做。

### T1.1 `SrText` 全局 sr-only 文本组件
- **文件**: `src/components/SrText.vue`(新增)
- **做法**: 把 `EditorTransportBar.vue` 里内联的 `.sr-only` 提为可复用组件;`EditorTransportBar` 改为引用它
- **验收**: 组件渲染为 `<span class="sr-only">`;视觉无变化;读屏能读出内容
- **依赖**: 无

### T1.2 `useLiveAnnouncer` 单例播报器
- **文件**: `src/composables/useLiveAnnouncer.ts`(新增)
- **做法**: 单例;`announce(text, { assertive })` 往两个 `aria-live` 区写入;节流策略(同文本 500ms 内去重;进度类每 1s 至多一次);暴露 `announcePolite`/`announceAssertive`
- **验收**: 调用后读屏能听到;快速连续调用只播报节流后结果
- **依赖**: T1.1(用 SrText 或直接 DOM 节点)

### T1.3 `A11yProvider` 组件
- **文件**: `src/components/A11yProvider.vue`(新增);`src/App.vue` 包一层
- **做法**: 挂载 polite/assertive 两个 `aria-live` 区(absolute、clip、aria-hidden 视觉隐藏但读屏可读);提供跳转链接目标锚点;`<main id="main-content" tabindex="-1">` 由它管理 id
- **验收**: DOM 里存在两个 live 区;读屏可读;`#main-content` 存在且可编程聚焦
- **依赖**: T1.2

### T1.4 `useFocusTrap` 焦点陷阱
- **文件**: `src/composables/useFocusTrap.ts`(新增)
- **做法**: `trap(el)` 记录当前焦点、监听 Tab/Shift+Tab 循环、Esc 关闭回调、`release()` 回归焦点;初次进入聚焦首个可聚焦元素或容器
- **验收**: 在手写 dialog 内 Tab 不跳出;Esc 触发关闭回调;关闭后焦点回到触发按钮
- **依赖**: 无

### T1.5 `useRovingTabindex` 漫游焦点
- **文件**: `src/composables/useRovingTabindex.ts`(新增)
- **做法**: 通用容器内子项 roving tabindex(Home/End/Arrow 导航、方向可配水平/垂直/网格);暴露 `activate(index)` 与当前激活索引
- **验收**: 容器内只有一个 tabindex=0,其余 -1;方向键移动焦点;Home/End 跳首尾
- **依赖**: 无

### T1.6 全局焦点环样式
- **文件**: `src/styles/global.scss`(修改)
- **做法**: 加全局 `:focus-visible` 焦点环(2px outline + offset),用主题 token;确保亮/暗主题都可见;为已知会吞掉焦点的自定义控件(`.chip`/`.nav-item`/`.track-row`)补 `:focus-visible`
- **验收**: Tab 遍历任意控件都有可见焦点环;不依赖鼠标
- **依赖**: 无

### T1.7 路由焦点迁移 + document.title
- **文件**: `src/router/index.ts`(修改)、`src/App.vue`(修改)
- **做法**: 全局 `afterEach` 钩子把焦点移到 `#main-content` 或视图标题;同步 `document.title = pageTitle`(读屏靠标题播报导航)
- **验收**: 路由切换后焦点到主区;读屏播报新页面标题
- **依赖**: T1.3

### T1.8 SideNav 语义化 + 跳转链接
- **文件**: `src/components/SideNav.vue`(修改)、`src/App.vue`(修改)
- **做法**: `<aside>` → `<nav aria-label="主导航">`;活动项加 `aria-current="page"`;App 顶部加"跳到主内容"跳转链接(首个可聚焦元素)
- **验收**: 读屏识别为导航;活动项播报"当前页";跳转链接可 Tab 到并回车跳过导航
- **依赖**: T1.3、T1.7

### T1.9 boot-splash 与 StartupOnboarding
- **文件**: `src/App.vue`(修改)、`src/components/StartupOnboarding.vue`(修改)
- **做法**: `boot-splash` 加 `aria-hidden="true"`(瞬态不读);`StartupOnboarding` 打开时焦点进首按钮 + 焦点陷阱
- **验收**: 启动遮罩期读屏不读过渡;Onboarding 打开焦点进按钮、Tab 不逃逸
- **依赖**: T1.4

**阶段 1 验收**: `pnpm build` 通过;纯键盘能跳过导航、切换视图、看到焦点环;读屏能播报路由标题;live 区已就位。

---

## 阶段 2 — 简化操作页 `/simple`(盲人核心路径,尽早交付价值)

### T2.1 路由 + 视图骨架
- **文件**: `src/router/index.ts`(加 `/simple` 路由)、`src/views/SimpleView.vue`(新增)
- **做法**: hash 路由加 `{ path: '/simple', name: 'simple', component: ... }`;骨架为单列 `<main>` + `<h1>` + 若干 `<section aria-labelledby>`
- **验收**: 访问 `#/simple` 渲染骨架;读屏能读页面标题与各 section
- **依赖**: 阶段 1

### T2.2 入口(三处)
- **文件**: `src/components/SideNav.vue`(底部加入口)、`src/views/SettingsView.vue`(加入口)、`src/components/StartupOnboarding.vue`(提一句)
- **做法**: SideNav 底部加"简化操作模式"链接(在 settings 上方);Onboarding 加一行说明;设置页加一个开关区
- **验收**: 三处可达;点击跳 `/simple`
- **依赖**: T2.1

### T2.3 分离区(核心)
- **文件**: `src/views/SimpleView.vue`(扩展)
- **做法**: 复用 `useTaskStore`/`useModelStore`/`useWorkflowStore`;`<select>` 模型 / `<select>` 工作流 → 按钮"添加音频文件"(调 `@tauri-apps/plugin-dialog` open 多选)→ 待处理文件列表(每项有"移除"按钮)→ "开始分离"按钮 → 进度区接 `useLiveAnnouncer` → 完成后"导出"按钮
- **验收**: 纯键盘能完成"选模型→加文件→开始→看进度→导出"全流程;进度被读屏播报
- **依赖**: T2.1、T1.2

### T2.4 模型管理区
- **文件**: `src/views/SimpleView.vue`(扩展)
- **做法**: 列表(模型名/状态)+ 安装/删除/导入按钮,调现有 `useModelStore` actions
- **验收**: 纯键盘能安装/删除/导入模型;操作结果经 live 区播报
- **依赖**: T2.1、T1.2

### T2.5 结果区(原生 audio 播放)
- **文件**: `src/views/SimpleView.vue`(扩展)
- **做法**: 分离完成列表;每项用原生 `<audio controls>` 预览(读屏天然支持);导出按钮
- **验收**: 读屏能操作原生 audio 控件;导出可用
- **依赖**: T2.1

### T2.6 顶部条
- **文件**: `src/views/SimpleView.vue`
- **做法**: "返回主界面"链接 / 语言切换 / 设置入口;`<h1>` 页面标题
- **验收**: 三者可达;返回主界面跳 `/`
- **依赖**: T2.1

### T2.7 i18n
- **文件**: `src/i18n/zh-CN.json`、`src/i18n/en.json`(加 `simple.*` 键)、`tests/i18nKeys.test.ts`
- **做法**: 所有简化页文案进 `simple` 命名空间;跑 i18n 键校验
- **验收**: 两份 json 键一致;`pnpm test` i18n 用例通过
- **依赖**: T2.3-T2.6

**阶段 2 验收**: 盲人用户走 `/simple` 纯键盘+读屏完成分离主流程;不碰画布/拖拽。

---

## 阶段 3 — 对话框审计 + Toast/进度直播

### T3.1 手写 dialog 焦点陷阱审计(8 处)
- **文件**: SeparateView(×4)、ModelsView(×1)、`DownloadDetailModal`、`CustomModelImportDialog`、`WorkflowRevisionConflictModal`
- **做法**: 逐一核对 焦点陷阱(T1.4) + 初始焦点 + Esc 关闭 + 焦点回归 + `aria-labelledby` 指向标题;缺失项补齐
- **验收**: 每个 dialog 打开焦点进、Tab 不逃逸、Esc 关、关后回触发按钮、标题被读
- **依赖**: T1.4

### T3.2 Toast 播报旁挂
- **文件**: 新增 `src/composables/useAnnouncedMessage.ts`(包装 Naive UI `useMessage`)
- **做法**: 提供 `useAnnouncedMessage()` 返回与 `useMessage` 同接口的包装;每次 `message.success/error/warning/info` 旁挂一次 `useLiveAnnouncer.announcePolite`
- **验收**: 任意 `message.*` 调用后读屏播报;不破坏原 toast 行为
- **依赖**: T1.2
- **注**: 全量替换现有 `useMessage` 调用点工作量大,先建包装并在新代码用;迁移现有调用点作为渐进任务

### T3.3 进度直播区接入
- **文件**: `src/stores/task.ts`(任务进度)、`src/stores/model.ts`/相关下载(下载进度)、`src/stores/settings.ts`(迁移进度)
- **做法**: 关键状态变化点(任务开始/完成/失败、下载百分比里程碑、迁移阶段)调 `useLiveAnnouncer`;节流避免噪音
- **验收**: 分离任务全生命周期被读屏播报;下载进度按里程碑播报
- **依赖**: T1.2

**阶段 3 验收**: 所有手写 dialog 符合焦点规范;关键进度被读屏播报。

---

## 阶段 4 — 标准视图查漏(主界面)

### T4.1 SeparateView
- **已有**: `role=listbox/option/aria-selected` ✓
- **补**: 4 个 dialog 已在 T3.1 处理;文件拖放区改可键盘操作(`tabindex` + Enter 触发文件选择);分离任务进度已在 T3.3
- **验收**: 纯键盘能选模型/工作流、加文件、开始分离
- **依赖**: 阶段 3

### T4.2 ModelsView
- **已有**: `aria-pressed/tabindex/aria-current` ✓
- **补**: 模型卡 Enter/Space 激活(打开详情);下载进度已在 T3.3;dialog 已在 T3.1
- **验收**: 纯键盘浏览/安装/删除/查看模型详情
- **依赖**: 阶段 3

### T4.3 ResultsView
- **补**: 结果列表加 `role`/表头语义/动作按钮 `aria-label`
- **验收**: 读屏能读出列表结构与每项可用操作
- **依赖**: 无

### T4.4 SettingsView
- **已有**: `aria-label` 侧栏 ✓
- **补**: 核对每个控件 label 关联;迁移进度已在 T3.3;简化模式入口已在 T2.2
- **验收**: 纯键盘改设置;每控件有可读 label
- **依赖**: 阶段 2、3

**阶段 4 验收**: 主界面四个标准视图纯键盘+读屏可用。

---

## 阶段 5 — 编辑器(混音器 + 波形 + 传输条)

### T5.1 轨道行键盘化(roving tabindex)
- **文件**: `src/components/editor/EditorMixer.vue`(修改)
- **做法**: `@mousedown` 选择 → `useRovingTabindex`(↑↓ 切换轨道、Enter 选中);M/S 静音独奏按钮已存在 ✓;选中状态经 `useLiveAnnouncer` 播报
- **验收**: 纯键盘上下切轨道、选中、静音/独奏;读屏播报选中轨道
- **依赖**: T1.2、T1.5

### T5.2 跳转 + 时间码播报
- **文件**: `src/composables/useEditorPlayback.ts` 或 `EditorView.vue`(接现有快捷键)
- **做法**: 已有 ArrowLeft/Right ±1s/±5s ✓;轨道聚焦时跳转,直播区口述时间码(节流,播放中每 1s);传输条加"口述位置"开关
- **验收**: 跳转/播放时读屏播报时间码;可关
- **依赖**: T1.2、T5.1

### T5.3 波形文本等价 + 轨道摘要
- **文件**: `src/components/editor/EditorWaveform.vue`(修改)、`src/components/editor/EditorMixer.vue`(轨道头加摘要)
- **做法**: `<canvas>` 加 `role="img"` + 描述性 `aria-label`(名称/声道/时长/淡入淡出);轨道头加 `SrText` 摘要(全状态);聚焦轨道时从 `peaks` 算一句响度概况播报
- **验收**: 读屏能读出每轨完整摘要;聚焦时听到响度概况
- **依赖**: T1.1、T1.2、T5.1

### T5.4 电平表口述
- **文件**: `src/components/editor/EditorMixer.vue`
- **做法**: 轨道聚焦时口述峰值数值(已有 `title` 但不可靠)
- **验收**: 聚焦轨道能听到当前电平
- **依赖**: T5.1

### T5.5 资源入轨键盘化
- **文件**: `src/components/editor/EditorAssetPanel.vue`(修改)
- **做法**: 每个资源加"加入时间线"动作(Enter/按钮 → `addTrackFromAsset`),替代鼠标拖拽
- **验收**: 纯键盘能把资源加入时间线
- **依赖**: 无

### T5.6 淡入淡出可键盘编辑
- **文件**: `src/components/editor/EditorInspectorPanel.vue`(核对)
- **做法**: 确保淡入淡出有数字输入框且带 label(可键盘编辑),不依赖波形拖拽
- **验收**: 纯键盘改淡入淡出数值
- **依赖**: 无

**阶段 5 验收**: 编辑器纯键盘完成"加轨/选轨/静音独奏/跳转/改淡入淡出/导出";波形信息以文本可达。

---

## 阶段 6 — 工作流节点编辑器(最深,最后)

### T6.1 图形大纲替代视图(主可访问路径)
- **文件**: `src/components/workflow/WorkflowNodeEditor.vue`(修改,加视图切换)、可能新增 `src/components/workflow/WorkflowOutlineTree.vue`
- **做法**: 工具栏加切换;画布换成 `role="tree"`/`role="treeitem"` 嵌套列表(步骤[模型/输入/输出]→工具节点→保存目标→备注);WAI-ARIA 树模式箭头键导航
- **验收**: 切到大纲视图后纯键盘树形浏览;读屏读出节点层级与内容
- **依赖**: 阶段 1

### T6.2 连接 combobox 编辑
- **文件**: 大纲树组件内
- **做法**: 每个步骤的输入用 `combobox` 选源(上一步输出/工具输出),替代拖线;复用 `buildWorkflowConsumedValueSetForDraft`
- **验收**: 纯键盘为步骤输入选源;保存后画布连接同步
- **依赖**: T6.1

### T6.3 画布可驱动(额外深度)
- **文件**: `src/components/workflow/WorkflowNodeEditor.vue`
- **做法**: `useRovingTabindex` 遍历节点;Enter 开节点编辑器;Delete 删除(已有快捷键 ✓);选择/缩放状态经直播区播报
- **验收**: 画布视图下纯键盘遍历节点、编辑、删除
- **依赖**: T1.2、T1.5、T6.1

### T6.4 复用已有快捷键
- **做法**: copy/paste/undo/redo 已有 ✓;确认在大纲视图也生效
- **验收**: 大纲视图下 Ctrl+C/V/Z/Y 工作
- **依赖**: T6.1

**阶段 6 验收**: 工作流编辑器有两条可达路径(大纲树 / 可驱动画布);纯键盘能创建/编辑/删除节点与连接。

---

## 阶段 7 — 验证与收尾

### T7.1 axe-core 冒烟(dev-only)
- **文件**: `package.json`(devDep 加 `axe-core`)、`tests/a11y/` 新增、`vite.config` dev 注入
- **做法**: dev-only;渲染各视图跑 axe 规则;CI 不强制(避免环境依赖)
- **验收**: dev 跑能产出违规清单
- **依赖**: 各阶段完成

### T7.2 快捷键帮助对话框
- **文件**: 新增 `src/components/ShortcutsHelpDialog.vue`;全局快捷键(如 `?`)打开
- **做法**: 列出所有键盘快捷键(复用 `useEditorShortcuts` 定义);焦点陷阱
- **验收**: `?` 打开;读屏读出快捷键列表;Esc 关
- **依赖**: 阶段 1

### T7.3 三读屏走查
- **做法**: NVDA + 讲述器 + JAWS(试用版)在 WebView2 下走查每视图主流程;记录问题并修
- **验收**: 三读屏均能完成核心路径;JAWS 自定义控件(树/列表框/combobox)无重大 quirks
- **依赖**: 全部功能阶段完成

### T7.4 文档
- **文件**: `README.md`/`README.zh-CN.md`(加"无障碍"小节)、`AGENTS.md`(加 a11y 维护说明)
- **做法**: 说明简化页入口、快捷键、读屏测试矩阵
- **验收**: 用户能从 README 找到无障碍功能
- **依赖**: 无

---

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 简化页与主界面特性分叉 | 明确简化页只覆盖分离+模型+结果;工作流/混音器不进简化页;共享 stores 不另起状态 |
| Toast 旁挂迁移量大 | 先建包装(T3.2),新代码用;现有调用点渐进迁移,不阻塞 |
| 工作流大纲与画布双向同步复杂 | 大纲为主可访问路径,画布可驱动为辅;大纲编辑直接写 graphDefinition,画布只是另一种渲染 |
| JAWS 自定义控件 quirks | T7.3 重点测树/列表框/combobox;必要时回退到更朴素的原生控件 |
| 焦点环与现有视觉冲突 | 用 `:focus-visible` 而非 `:focus`,仅键盘导航时显示,不影响鼠标点击观感 |

## 建议提交节奏

- 阶段 1: 一到两个 PR(原语层 / 全局外壳)
- 阶段 2: 一个 PR(简化页完整)
- 阶段 3: 一个 PR(对话框 + 直播)
- 阶段 4: 一个 PR(标准视图查漏)
- 阶段 5: 一个 PR(编辑器)
- 阶段 6: 一到两个 PR(大纲 / 画布可驱动)
- 阶段 7: 一个 PR(验证收尾)

draft PR 先开,后续按阶段拆 PR 合并到本分支或直接进 main。
