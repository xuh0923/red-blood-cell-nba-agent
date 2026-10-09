# ESP32 解说机器人接入设计

## 已有硬件与代码

只读检查位置：`E:\work\game\NBA_AWS\module\chuangkebisai`。

现有项目基于 ESP-IDF 和 `xiaozhi-esp32-2.2.4`，目标板为 ESP32-S3。自定义板 `chuangkebisai-audio` 使用 INMP441 麦克风、MAX98357 扬声器、I2S 音频、超声波传感器、蜂鸣器和 LED。当前自定义配置实际连接的是 LCD1602，并不是 OLED；上游固件具备 OLED/表情支持，但如果最终改用 OLED，需要同步确认接线、驱动和板级配置。

固件已有 Wi-Fi、WebSocket/MQTT+UDP、Opus 音频、TTS 状态和表情消息能力。本阶段不修改固件。

## 首选通讯方式

第一版使用安全 WebSocket (`wss://`)：

- 与现有 XiaoZhi WebSocket 协议最接近
- 单连接同时承载 JSON 控制消息和 Opus 二进制音频
- 穿透普通 Wi-Fi 网络更容易
- 比 MQTT + UDP 更容易在比赛现场调试

云端建议由 API Gateway WebSocket 维护连接，DynamoDB 保存 `deviceId -> connectionId`，Lambda 负责鉴权、投递控制消息，Polly 生成音频，音频适配器转成设备支持的 Opus 帧。长音频不应整段放入 JSON，可使用短时签名 URL 或连续二进制帧。

## 消息契约

所有云端消息包含 `version`、`jobId`、`eventId`、`sequence` 和 `issuedAt`。`sequence` 用于弱网重连后去重和排序。

```json
{
  "type": "narration",
  "version": 1,
  "jobId": "11111111-1111-4111-8111-111111111111",
  "eventId": "shot-quality",
  "sequence": 2,
  "issuedAt": "2026-10-08T10:00:00.000Z",
  "text": "这是一记预期命中率只有百分之四十二的高难度出手。",
  "emotion": "excited",
  "audioUrl": "https://example.cloudfront.net/device/audio/shot-quality.opus"
}
```

正式实现还会映射到固件已有消息：

```json
{"type":"llm","emotion":"happy","text":"😀"}
{"type":"tts","state":"start"}
{"type":"tts","state":"sentence_start","text":"解说文本"}
{"type":"tts","state":"stop"}
```

WebSocket 二进制帧传输 Opus，设备解码后通过 MAX98357 播放。显示端按 `emotion` 映射表情，不把自由文本直接当设备指令执行。

## 接入阶段

1. 浏览器设备模拟器：验证事件顺序、语音稿和表情映射。
2. 局域网桥接器：不改业务系统，先让现有 ESP32 接收一段固定 Opus 和表情。
3. AWS WebSocket：加入设备注册、临时令牌、心跳和断线续传。
4. 比赛联动：视频事件到点时推送解说；设备回传 `buffering/speaking/idle/error`。

安全要求：每台设备使用短期令牌；服务端校验 `Device-Id`/`Client-Id`；签名音频 URL 短期有效；不把 AWS 密钥烧录进设备。
