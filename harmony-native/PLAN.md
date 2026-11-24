# 鸿蒙原生控制端移植计划（草案，待用户确认）

把 `android/`（Kotlin + Compose）移植成 HarmonyOS NEXT 原生应用（ArkTS + ArkUI，Stage 模型），功能对齐安卓 App。协议、服务器、被控端都不改（Push 那部分以另一个会话最终写进 `docs/03-protocol.md` 的为准）。

## 1. WebRTC 选型

用 ohpm 上的 **`@ohos/webrtc` 1.0.5**（OpenHarmony 三方库，仓库 gitcode.com/CPF-ApplicationTPC/ohos_webrtc）：

- 2026-10-28 发布 1.0.5，仓库 2026-11-24 还有提交；基于 WebRTC m120；HAR 里带预编译的 `libohos_webrtc.so`。
- ArkTS 接口照 W3C：`RTCPeerConnection`（`ontrack`、`ondatachannel`、`createDataChannel`、`getStats`、`setCodecPreferences`）、`RTCDataChannel`（`send(string | ArrayBuffer)`、`bufferedAmount`、`bufferedAmountLowThreshold`/`onbufferedamountlow`）。
- 渲染：`VideoRenderController` 画到 XComponent 上，有 `onFrameResolutionChanged`，能 `setSurfaceSize` 把渲染缓冲设成视频原始分辨率，再在 ArkUI 里缩放平移（对应安卓自写的 `VideoTextureView`，放大后字不糊）。
- 要求 API 15 以上；用户手机是 HarmonyOS 7.0（API 26），没问题。

**风险**：它只有 H264/H265 走硬件解码，被控端默认的 VP9 是软件解码。Claude 窗口是 1280×2088 左右的文字画面，软解多半够用，但要在真机上测帧率、CPU 和发热。不够时有两条退路，都不用改被控端代码：手机在应答里用 `setCodecPreferences` 把 H264 排前面；或者把电脑上被控端配置 `codec` 改成 `H264`。另外它的 H264 硬解只报 level 3.1，1280×2088 能不能协商上也要实测。

不选的两条：

- 自己用 NDK 编 libwebrtc：上游不支持 OHOS，要把这个库做过的补丁再做一遍，几周起步，没有收益。
- 隐藏 ArkWeb 跑 WebRTC、原生界面显示：ArkWeb 收到的视频交不出来给原生界面（同层渲染只支持 `<embed>`/`<object>`），画面只能在网页的 `<video>` 里画，硬解、后台行为都没有文档——这其实就是现在装着的壳。

## 2. 目录

```
harmony-native/                    DevEco 工程（hvigor，命令行可构建）
  AppScope/app.json5               包名 com.remoteclaude.harmony（测试期用 .dev，见第 6 节）
  entry/src/main/ets/
    entryability/EntryAbility.ets  生命周期；点推送通知进来的 want（审批 id、电脑 id）
    protocol/   Protocol、ServerAddress、ClipAssembler、UnlockCipher     纯逻辑，有单元测试
    net/        AuthApi（http）、SignalingClient（webSocket）、NetworkWatcher（connection）
    rtc/        RtcEngine、PeerSession（应答方、input/file 通道）、StatsReader
    video/      Viewport（坐标换算，有单元测试）、RemoteStage（XComponent + 手势）
    input/      InputSender（移动、滚轮 16ms 合并）、FontZoom
    image/      ImagePrep（转正、缩到 2048、JPEG 85）、ImageSizing（有单元测试）
    files/      FileSource（文件选择器）、FileUploads（分块、进度、卡住判断，有单元测试）
    windows/    HostCommands（菜单显示条件，有单元测试）、WindowClose
    approvals/  PushRegistrar（取 token、push-register / push-unregister）
    data/       SettingsStore（Preferences；令牌用 HUKS 的 AES-GCM 密钥加密后存）
    RemoteController.ets           整个控制端的状态机，逻辑照搬安卓的 RemoteController
    pages/、components/            账号页、会话列表、画面页、设置、审批面板、菜单
  entry/src/test/                  单元测试（对照 android/app/src/test 移植）
  scripts/install.ps1              本机构建并用 hdc 装到手机
```

签名配置不入库：`build-profile.json5` 里不放 `signingConfigs`，本机的签名放在被 `.gitignore` 忽略的文件里，构建脚本合进去。

## 3. 功能对照

| 安卓 App | 鸿蒙原生版 |
|---|---|
| 账号页（登录、注册、找回密码） | 同；`@kit.NetworkKit` 的 http |
| 令牌用 Keystore 加密 | HUKS（`@kit.UniversalKeystoreKit`）AES-GCM，密文存 Preferences；密码不落盘 |
| 信令 WebSocket、断线退避重连 | `@kit.NetworkKit` 的 webSocket；服务器的 ping 能不能自动回 pong 要实测 |
| 网络切换立即重连 | `connection` 的 netAvailable / netCapabilitiesChange |
| 会话列表、电脑切换、"已打开 / 全部会话"、关闭窗口、环境折叠、缩略图后补 | 照搬，ArkUI Grid / List |
| 右上角菜单（平铺、锁定、解锁、升级被控端、设置） | 照搬（`host-state` / `host-cmd`） |
| 远程画面、按视频原始分辨率渲染 | `@ohos/webrtc` 的 XComponent 渲染器 |
| 手势（点、长按右键、拖动滚动、方向锁定、双指缩放平移、惯性） | `onTouch` 自己识别，逻辑照搬 `RemoteStageView`；长按震动用 `vibrator` |
| 输入栏、发送、多行、字体大小条 | 同 |
| 发图片 | `PhotoViewPicker`（不用申请权限）+ `@kit.ImageKit` 转正、缩放、重编码 |
| 发文件 | `DocumentViewPicker` + `fs` 分块读 + `cryptoFramework` 算 SHA-256；`file` 通道按 bufferedAmount 控流 |
| 剪贴板回传 | `pasteboard` 写系统剪贴板（写不需要权限）+ 提示 |
| 锁定、解锁（数据通道 / 不连画面时 RSA-OAEP 加密走信令） | 同；`cryptoFramework` 的 `RSA3072|PKCS1_OAEP|SHA256|MGF1_SHA256` |
| 统计信息浮层 | `getStats`（分辨率、帧率、码率、RTT、直连还是中继） |
| 审批和提问面板、横幅、复制命令 | 照搬 |
| 后台常驻接收审批（前台服务 + 常驻通知） | **做不了，改成 Push Kit**：登录后发 `push-register`，退出登录发 `push-unregister`；点通知打开 App，连上信令后直接弹审批面板 |
| 通知上直接"允许""拒绝" | **做不了**：推送通知的按钮不能不打开 App 就执行代码。改成点通知进 App 作答 |
| 打开 App 时验证指纹 | `@kit.UserAuthenticationKit` |
| 保持屏幕常亮 | `window.setWindowKeepScreenOn` |
| 切后台断开画面；选图、选文件、发文件时不断 | 同；选图选文件用短时任务（`requestSuspendDelay`）撑住，发文件用长时任务（数据传输） |
| 被控端版本、检查更新、立即升级 | 照搬（`host-update`） |
| App 内下载安装新版本 | **做不了**：鸿蒙不能侧载。替代见第 4 节 |
| 电池优化引导 | 去掉（鸿蒙没有这个概念） |

## 4. App 升级的替代

- 自用阶段：电脑上运行 `harmony-native/scripts/install.ps1`，构建并用 hdc 装到手机（USB，或手机开"无线调试"后 `hdc tconn`）。设置页显示当前版本。
- 想在手机上自己升级：在 AppGallery Connect 做"邀请测试"（每期最多 90 天）或上架，需要华为开发者账号实名。用户要的时候再做。
- 服务器的 `/api/update/android` 不动，鸿蒙版暂不提示新版本（要提示得给服务器加一个 harmony 渠道，属于改服务器，先不做）。

## 5. Push Kit 需要用户做的

1. AppGallery Connect 里建项目和应用（包名 `com.remoteclaude.harmony`），在"增长 > 推送服务"开通。
2. DevEco Studio 自动签名时登录 AGC、关联这个应用、勾选 Push Kit（DevEco 6.0.0 Beta5 起自动签名就能调推送）。
3. 服务器发推送要的服务账号密钥由服务器那条线处理。
4. 审批提醒属于"工作事项提醒"（`WORK`），要在 AGC 申请自分类权益（约 3 个工作日）；批下来之前只能用测试消息（每个项目每天 1000 条，自用够了）。

## 6. 分阶段和真机验收

每个阶段：命令行构建 → hdc 装到手机 → 按 `docs/04-android-client.md` 的验收编号在手机上逐项做（截屏、`tools/input-test-window.ps1` 测试窗口的日志）→ 没验到的列出来 → 提交到本分支（不推送）。

| 阶段 | 内容 | 验收 |
|---|---|---|
| 0 | WebRTC 打通验证：最小 App 登录 → 选一个测试窗口 → 出画面 → 数据通道点一下 | 出画面、点击落到测试窗口；记首帧时间、VP9 软解的帧率和发热、走直连还是中继。决定要不要换 H264。**不通就停下来报告** |
| 1 | 账号、会话列表、全部会话、打开/新建/关闭窗口 | A1、A2、A24～A26、A36、A38～A40 |
| 2 | 画面、手势、文字输入、切换会话、字体大小、统计浮层 | A3～A12、A16、A17、A43 |
| 3 | 发图片、发文件、剪贴板回传 | A19、A33～A35、A41、A42 |
| 4 | 锁定解锁、平铺、被控端升级、设置页、指纹锁 | A20～A23、A37 |
| 5 | 审批和提问、Push 通知 | A28、A29、A31、A32；A30 改成"点通知进 App 作答" |
| 6 | 前后台、网络切换、电脑上下线、安全、安装脚本、文档 `docs/10-harmony-client.md` | A13～A15、A18 |
