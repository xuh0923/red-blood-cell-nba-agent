# CourtVision 系统架构

## 产品闭环

用户在 Web 工作台上传比赛视频与深度赛场数据。系统创建任务、保存输入、让 Agent 结合数据和关键帧生成结构化分析，再按时间轴把指标、解释和解说渲染到视频。结果通过 CloudFront 访问，也可以向 ESP32 解说设备发送语音与表情事件。

```text
浏览器 / CloudFront
        |
        v
API Gateway -> Lambda API -> DynamoDB
        |                任务状态
        v
S3 input -> Step Functions
              |-- 关键帧提取
              |-- Bedrock AgentCore -> Bedrock 模型
              |-- Polly 解说音频
              |-- ECS/Fargate + ffmpeg 渲染
              `-- S3 output -> CloudFront
                                      |
                                      `-- WebSocket -> ESP32
```

## 服务职责

| 服务 | 职责 | 为什么使用托管服务 |
|---|---|---|
| CloudFront | 唯一公开入口，分发页面和成片 | 满足赛事硬要求，降低视频分发延迟 |
| S3 | 保存输入、分析 JSON、中间文件和成片 | 无需管理文件服务器，生命周期可控 |
| API Gateway + Lambda | 创建任务、签发上传 URL、查询状态 | 低运维、按请求运行 |
| DynamoDB | 保存 Job 状态与结果索引 | Serverless，适合状态轮询 |
| Step Functions | 显式编排分析、渲染和发布步骤 | 失败位置、重试和执行历史清晰 |
| Bedrock AgentCore | 承载实际 Agent，调用工具并输出可执行 JSON | 赛事硬要求，也是 Agent 的正式运行边界 |
| Bedrock | 理解关键帧、生成战术解释与解说 | 使用主办方允许的模型能力 |
| Polly | 生成稳定的中文解说音频 | 方便 Web 和 ESP32 使用同一音频资产 |
| ECS/Fargate | 运行 ffmpeg 成片任务 | 视频任务较重且时长不固定，不维护 EC2 |
| CloudWatch | 日志、指标与失败告警 | 便于比赛当天快速定位问题 |

不为了数量引入没有实际职责的服务。Rekognition、EventBridge、MediaConvert 只有在实测能提高检测、解耦或编码兼容性后才加入。

## 数据契约

`packages/contracts` 是唯一事实来源。Agent 不能只返回自然语言，必须返回 `Analysis v1`：

- `events`：开始/结束秒数、单一核心指标、画面文案、锚点和证据
- `narration`：时间点、文本和情绪
- `provenance`：输入视频、数据文件和可选摘要
- `warnings`：数据不足或只能做弱判断的地方

赛事数据主要是投篮事件，不将它包装成不存在的逐帧运动轨迹。视觉推断和结构化数据必须在 `evidence` 中分开说明。

## 当前实现边界

当前版本已完成可测试的本地工作流、共享契约、API、正式 AgentCore Runtime、Step Functions 编排和 ffmpeg 脚本生成器。本地视觉服务会用 YOLO 和 ByteTrack 连续处理视频，输出带时间戳的归一化球员轨迹，并由 Web 播放器同步叠加。身份置信度不足时显示轨迹编号，不把视觉候选包装成已确认姓名。

AWS 暂停期间，本地任务保存在 `.local-data`，Web 通过与云端任务相同的状态模型轮询进度。云端恢复后，连续视觉推理将迁移到 SageMaker，轨迹写入 S3，任务状态继续由 Step Functions 和 DynamoDB 管理。AgentCore 只消费已经压缩成事件和证据的视觉结果，不负责逐帧目标跟踪。

本地视觉已具备比赛名单约束、可选多帧号码 OCR 和人工身份校验。号码 OCR 只有在同一号码跨帧投票一致、且名单中唯一时才自动命名；人工确认会标记来源并写回任务结果。下一里程碑是镜头切换后的身份恢复、球场坐标标定和篮球专用检测器；随后加入 Fargate 渲染、Polly 和 ESP32 WebSocket。

## 部署约束

- 只部署到 `us-east-1`
- 所有 CDK IAM Role 使用 `NBAHackathonParticipantBoundary`
- 命令使用 `--profile nba`
- 禁止执行 `cdk bootstrap`
- GitHub 保持 Private，不提交凭证、视频和生成结果
- 最终提交 CloudFront URL
