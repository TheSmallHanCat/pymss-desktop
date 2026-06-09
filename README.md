# Pymss Studio

Pymss Studio 是一个基于 Tauri 的桌面端音频源分离应用，前端使用 Vue 3 + TypeScript + Vite，后端由 Rust/Tauri 调度 Python worker，核心分离能力来自外部的 [`pymss`](https://github.com/pymss-project/pymss) 项目。

## 功能

- 音频源分离
- 模型列表、下载、删除与存储管理
- 音频信息读取与波形峰值缓存
- 编辑器混音导出
- Windows 发布版支持 CUDA / CPU 两套运行时

## 技术栈

- 前端：Vue 3、TypeScript、Vite、Naive UI
- 桌面壳：Tauri v2
- Python：`python/worker.py` 负责模型、音频和推理相关任务

## 项目结构

- `src/`：前端页面、组件、路由、状态管理
- `src-tauri/`：Rust 侧 Tauri 应用与配置
- `python/`：Python worker 和运行时依赖说明
- `scripts/`：Python 运行时准备与清理脚本
- `installer/`：Windows 安装包脚本

## 开发前准备

- `pnpm` 10.33.2
- Node.js
- Rust / Cargo
- Python 解释器
- `pymss` 核心仓库或可用的 `PYMSS_STUDIO_PYMSS_PATH`

Python worker 会优先从以下位置寻找 `pymss`：

- 开发环境：`<workspace>/pymss-desktop` 与 `<workspace>/pymss` 为兄弟目录
- 发布环境：`<root>/python/worker.py`、`<root>/pymss/`、`<root>/python-runtime/python.exe`

如需手动指定核心库位置，可设置 `PYMSS_STUDIO_PYMSS_PATH`。

## 运行项目

```bash
pnpm install
pnpm dev
```

`pnpm dev` 只启动前端开发服务器，默认运行在 `http://localhost:1420`。

如果要同时启动 Tauri 主进程：

```bash
pnpm tauri dev
```

## 构建项目

```bash
pnpm build
pnpm tauri build
```

- `pnpm build` 会先执行 `vue-tsc --noEmit`，再执行 Vite 构建
- `pnpm tauri build` 会先跑 `pnpm build`

## Python 运行时

`python/requirements.txt` 只用于说明 worker 需要哪些运行时依赖，真正的发布运行时由脚本准备：

```powershell
./scripts/prepare-python-runtime.ps1 -Variant cuda
```

可选的变体：

- `cuda`：Windows CUDA 版
- `default`：Windows CPU 版
- `mps` / `mlx`：用于对应平台的扩展变体

脚本会把 Python、Torch 和 worker 依赖打包到 `python-runtime/`。

## 环境变量

- `PYMSS_STUDIO_PYTHON`：指定 Python 解释器路径，默认是 `python`
- `PYMSS_STUDIO_PYMSS_PATH`：指定 `pymss` 核心库路径
- `PYMSS_STUDIO_DEFAULT_OUTPUT_DIR`：默认分离输出目录

## 发布说明

Windows 发布分为两条线：

- CUDA 版：用于 NVIDIA GPU
- CPU 版：用于不依赖 CUDA 的环境

CI 会先准备 Python runtime，再构建 Tauri 程序，最后组装便携包和安装包。超出 GitHub Release 单文件限制的资产会被自动拆分。

## 常见问题

### 为什么 `pnpm build` 前要先确保 Python 依赖可用？

因为桌面应用虽然是前端驱动，但真正的模型管理和推理逻辑在 Python worker 里；没有可用的 `pymss` 核心库，很多功能无法正常工作。

### 为什么启动后找不到模型？

先确认 `pymss` 核心仓库位置是否正确，再检查 `PYMSS_STUDIO_PYMSS_PATH` 是否指向了可用目录。

### 发布包里为什么有 `python-runtime/`？

这是打包后的嵌入式 Python 运行时，包含 worker 所需的依赖和 Torch。

## 说明

本项目默认没有单独的自动化测试套件；当前验证方式主要是 `pnpm build`、`pnpm tauri build`，以及 Python worker 的 `env_info` / `list_models` 冒烟检查。
