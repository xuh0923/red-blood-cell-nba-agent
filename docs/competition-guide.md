# 比赛执行指南

## 硬性要求

1. 应用必须由 AWS CDK 部署。
2. 实际 Agent 必须托管在 Bedrock AgentCore。
3. 最终提交必须是 CloudFront URL。
4. 所有资源只使用 `us-east-1`。
5. 正式 `cdk.json` 必须配置 `NBAHackathonParticipantBoundary`。
6. 不执行 `cdk bootstrap`；主办方已预置。
7. AWS 命令显式使用 `--profile nba`。
8. GitHub 仓库保持 Private，不提交任何密钥。

## 产品与评分重点

- 输入真实比赛视频和深度赛场数据，输出带数据可视化的比赛画面。
- 重点指标：预期命中率、持球/无球引力、胜负影响。
- 人工评分重点是准确性、内容、观感和 UX，不以堆服务代替产品质量。
- 数据只用于它能证明的结论，禁止伪造逐帧轨迹。
- 比赛当天测试素材适配窗口很短，流水线必须提前做到只替换输入即可重跑。

## 权威信息优先级

比赛当天 Portal/现场通知 > 最新正式参赛指南 > Quick Start > 培训转写纪要。

参考资料：

- Quick Start: https://csdn.feishu.cn/docx/Y21TdJqrHopofmx2w21cmqHLnLb
- 参赛终极指南: https://csdn.feishu.cn/wiki/B3NSwj16GiSCR7kcM5vc9RjMnQb
- 赛前培训纪要: https://csdn.feishu.cn/docx/FS05dToF1oUmTGxaEjdckPD1nwe
