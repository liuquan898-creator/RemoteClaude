# RemoteClaude 鸿蒙原生控制端

HarmonyOS NEXT 原生 App（ArkTS + ArkUI），功能对齐安卓 App。设计、构建、签名、推送、升级和验收记录见 [docs/10-harmony-client.md](../docs/10-harmony-client.md)，协议见 [docs/03-protocol.md](../docs/03-protocol.md)。

```powershell
pwsh -File harmony-native\scripts\install.ps1
```

构建正式版并用 hdc 装到 USB 连着的手机。安装包里不带服务器地址，第一次在登录页填。第一次构建要先在 DevEco Studio 里自动签名、运行 `node harmony-native/scripts/take-signing.js`（签名不入库，见 docs/10 第 5 节）。

单元测试（电脑上用 Node 24 跑）：`bash harmony-native/scripts/test.sh`
