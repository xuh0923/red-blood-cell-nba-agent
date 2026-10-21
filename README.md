# CourtVision Agent

红细胞队 Team28 的 NBA 视频分析项目。当前版本是纯本地可运行闭环：输入比赛视频和可选的 JSON/CSV 比赛资料，使用 YOLO + BoT-SORT 连续检测与跟踪球员、篮球，生成可追溯的本地分析结果、时间轴、球场雷达和数据面板。

## 当前能力

- 浏览器上传 MP4/MOV 与可选 JSON/CSV 比赛资料
- 本地视觉服务连续检测球员、篮球并同步绘制跟踪框和球场雷达
- 支持名单约束、号码 OCR 接口和本地人工身份确认
- 从资料中读取 xFG、引力、胜负影响和比赛统计；缺失字段保持空态，不编造数据
- 本地规则分析器生成结构化事件、证据、解说提示和结果页问答
- `public/showcase` 提供不依赖后端的静态作品展示

## 快速开始

环境要求：Node.js 22+、npm 10+、Python 3.11+、ffmpeg/ffprobe。推荐 NVIDIA GPU；服务会自动使用 CUDA，未检测到 CUDA 时回退到 CPU。

```powershell
npm install
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r services\vision\requirements.txt
npm run dev
```

如使用 NVIDIA 显卡，先安装 CUDA 版 PyTorch 后再安装其余依赖。项目已在 RTX 3060 + CUDA 12.8 上验证：

```powershell
.\.venv\Scripts\python.exe -m pip install --index-url https://download.pytorch.org/whl/cu128 torch==2.11.0+cu128 torchvision==0.26.0+cu128
.\.venv\Scripts\python.exe -m pip install -r services\vision\requirements.txt
```

打开 `http://127.0.0.1:5173`，进入“素材导入”上传视频。`npm run dev` 会同时启动 React 前端和本地视觉服务；首次识别会下载 YOLO 模型。任务文件保存在 `.local-data/jobs/{jobId}`。

默认视觉配置使用 `YOLO11s`、GPU 960 像素推理、连续轨迹筛选和篮球时序校验，优先减少场边人员与短暂误检。可复制 `.env.example` 为 `.env` 后按显卡性能调整；服务会自动读取该文件。CPU 环境建议把 `COURTVISION_MODEL_SIZE` 改为 `640`。

根路径读取 `apps/web/public/showcase` 中的静态展示产物，不访问云端接口。需要更新展示内容时运行：

```powershell
npm run showcase:prepare -- --job <本地任务UUID> --analysis <分析JSON路径>
```

## 验证

```powershell
npm run typecheck
npm test
npm run build
npm run test:e2e
```

端到端测试默认调用本机 Microsoft Edge；测试不需要 AWS 凭证、AWS CLI、CDK 或云端账号。

## 目录

```text
apps/web             React 操作台、作品展示和本地工作流
packages/contracts   跨前端、视觉和分析器共享的数据契约
services/vision      Python 本地检测、跟踪、OCR 和任务服务
services/agent       确定性本地规则分析器
services/renderer    ffmpeg 可视化脚本生成器
docs                 架构、数据格式和开发记录
```

## 协作约束

- 修改前执行 `git status --short`，阅读相关代码、测试和文档，不覆盖他人的未提交修改。
- TypeScript 使用严格模式、2 空格缩进、双引号、分号；禁止用 `any` 绕过类型检查。
- 共享数据结构只在 `packages/contracts` 定义；复杂转换放入独立模块，不堆在 JSX 中。
- 不得编造比分、球员姓名、命中结果或比赛统计；缺失数据必须显示“暂无数据”“未确认”等明确状态。
- 本项目运行边界是本地服务，不添加云端依赖或外部设备接入；新增能力必须保持无 AWS 凭证也能启动和测试。
- 改动后按影响范围运行 `npm run typecheck`、`npm test`、`npm run build` 和相关端到端测试。
- 提交信息统一使用：`git commit -m "【问题】问题描述【修改】修改内容"`。

详细架构见 [docs/architecture.md](docs/architecture.md)，名单格式见 [docs/roster-database-format.md](docs/roster-database-format.md)。
