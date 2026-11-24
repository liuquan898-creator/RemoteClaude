# 10 鸿蒙原生控制端

把安卓控制端（`android/`，[04](04-android-client.md)）原生移植到 HarmonyOS NEXT：ArkTS + ArkUI，Stage 模型。功能对齐安卓 App，协议、服务器、被控端都不用改（推送除外，见第 6 节）。代码在 `harmony-native/`。

早先还试过一个加载网页控制端的 ArkWeb 壳，原生版取代了它，没有收进仓库。

## 1. 技术栈

| 项 | 选择 | 说明 |
|---|---|---|
| 语言与界面 | ArkTS + ArkUI，状态管理 V2（`@ObservedV2`/`@Trace`、`@ComponentV2`） | 单页面，按状态切账号页、会话列表、画面页 |
| 系统版本 | `compatibleSdkVersion` 5.0.3(15)，用 SDK API 26 编译 | WebRTC 库要求 API 15 起。验收用的真机是 HarmonyOS 7.0（API 26） |
| WebRTC | ohpm 的 `@ohos/webrtc` 1.0.5（OpenHarmony 三方库，仓库 gitcode.com/CPF-ApplicationTPC/ohos_webrtc，基于 WebRTC m120） | 自带预编译的 arm64 `.so`，接口照 W3C：`RTCPeerConnection`、`RTCDataChannel`、`getStats`。选型过程见第 3 节 |
| 视频渲染 | 库里的 `VideoRenderController`（XComponent） | XComponent 的大小设成视频原始像素，再用 `scale` 缩放、`position` 平移，放大后小字不糊（对应安卓自写的 `VideoTextureView`） |
| 信令、账号接口 | `@kit.NetworkKit` 的 `webSocket`、`http` | 服务器的 WebSocket ping 系统自动回 pong |
| 登录令牌 | 关键资产存储 `@kit.AssetStoreKit` | 系统加密保管，卸载 App 时一起删。设置放 Preferences |
| 解锁密码加密 | `@kit.CryptoArchitectureKit`，`RSA3072\|PKCS1_OAEP\|SHA256\|MGF1_SHA256` | 同协议 2.9 |
| App 锁 | `@kit.UserAuthenticationKit` 的系统验证框（人脸、指纹、锁屏密码） | |
| 推送 | `@kit.PushKit` | 第 6 节 |

## 2. 代码结构

`harmony-native/entry/src/main/ets/` 下：

| 目录 / 文件 | 职责 |
|---|---|
| `protocol/` | 协议消息的解析和构造（`Protocol.ts`）、服务器地址整理、剪贴板分块拼接、账号接口回复（都是普通 `.ts`）；解锁密码加密（`UnlockCipher.ets`） |
| `logic/` | 纯逻辑，对照安卓端移植：坐标换算 `Viewport`、滚动合并 `InputSender`、菜单显示条件 `HostCommands`、关窗口 `WindowClose`、发文件 `FileUploads`、图片尺寸、时间文字、代码块拆分、字体大小快捷键（都是普通 `.ts`，有单元测试） |
| `net/` | 账号接口、信令 WebSocket、网络切换监听 |
| `rtc/` | 一条画面连接 `PeerSession`（应答方、`input`/`file` 两条数据通道）、统计 |
| `RemoteController.ets` | 整个控制端的状态机，逻辑照搬安卓端的 `RemoteController.kt` |
| `model/AppState.ets` | 界面状态（V2 可观察对象） |
| `components/` | 账号页、会话列表、画面页（`RemoteStage` 是画面和手势）、设置、审批面板、菜单和对话框 |
| `data/`、`image/`、`files/`、`approvals/`、`common/` | 设置存储、发图前处理、读文件、推送令牌、日志和杂项 |

协议解析、纯逻辑放在 `.ts` 里而不是 `.ets`：ArkTS 不许用 `any`，解析动态 JSON 很别扭；`.ts` 还能在电脑上用 node 直接跑单元测试。`.ets` 能导入 `.ts`，反过来不行。

单元测试在 `harmony-native/test/`（92 个，对照 `android/app/src/test` 移植，另补了滚动合并的），`bash harmony-native/scripts/test.sh` 运行（Node 24 原生跑 TypeScript，`test/loader.mjs` 给不带扩展名的导入补 `.ts`）。

## 3. WebRTC 选型

| 方案 | 结论 |
|---|---|
| ohpm 的 `@ohos/webrtc` | **采用**。2026-10 发布 1.0.5，仓库还在维护；带预编译库；数据通道、统计、渲染都有 |
| 自己用 NDK 编 libwebrtc | 上游不支持 OHOS，要把上面那个库的补丁再做一遍，几周起步 |
| 隐藏的 ArkWeb 跑 WebRTC、原生界面显示 | ArkWeb 收到的视频交不出来给原生界面（同层渲染只支持 `<embed>`/`<object>`），画面只能画在网页的 `<video>` 里，等于原来的壳 |

这个库只有 H264/H265 走硬件解码，被控端默认的 VP9 是软件解码（libvpx）。真机实测（2026-11-24，局域网）：1280×2088 的 Claude 窗口 VP9 软解 30 fps、不丢帧，App 占 CPU 约 9.5%；从点窗口到画面连通约 0.2 秒。所以没有改编码。以后真遇到卡顿，可以在 `PeerSession` 里对视频收发器 `setCodecPreferences` 把 H264 排前面（被控端不用改），注意这个库的 H264 硬解只报 level 3.1。

几个接入要点：

- 应答方、Trickle ICE、对端描述设好前的候选先缓存，和安卓端一样。
- 数据通道收发文本用 `send(string)`，图片和文件的分块用 `send(ArrayBuffer)`。
- 第一帧：渲染器换了新轨道后第一次报分辨率就算出了画面；另外每秒读一次统计，`framesDecoded` 大于 0 也算（安卓踩过的坑 02 第 12 条：重连后分辨率不变时渲染器不再报）。
- 这个库的 HAR 自带声明了相机、麦克风权限，App 从不申请也不用。

## 4. 和安卓 App 不一样的地方

| 安卓 App | 鸿蒙原生版 | 原因 |
|---|---|---|
| 后台常驻接收审批（前台服务 + 常驻通知） | 切到后台就断开；审批提醒靠服务器经华为推送发通知（第 6 节） | 鸿蒙不让普通 App 在后台保持网络连接 |
| 通知上直接点"允许""拒绝" | 点通知打开 App，自动弹审批面板 | 推送通知的按钮不能不打开 App 就执行代码 |
| App 里下载安装新版本 | 电脑上运行 `harmony-native/scripts/install.ps1` 装新版（第 7 节） | 鸿蒙不能侧载安装包 |
| 选图、选文件、发文件时切到后台最多撑 2 分钟 / 10 分钟 | 用系统短时任务撑着，单次约 3 分钟 | 同上。发大文件经中继时可能不够，文件就发不完，提示重发 |
| 设置里的"后台接收审批""电池优化""通知铃声" | 去掉 | 没有对应的东西；铃声在系统的通知设置里 |
| 图片透明部分转 JPEG 时铺白底 | 没做 | 只影响带透明的非 PNG 图（少见） |

## 5. 构建和签名

需要 DevEco Studio（默认 `D:\Program Files\DevEco Studio`，环境变量 `DEVECO_HOME` 可改）。不需要打包配置 `deploy/prod/build.json`。

- **签名不入库**。`build-profile.json5` 是生成物：`scripts/gen-build-profile.js` 用 `build-profile.template.json5` 加上本机的 `signing.local.json5`（DevEco 自动签名生成的 `signingConfigs` 里的那一项）生成它，两者都被 `.gitignore` 忽略。
  - 第一次签名：DevEco 打开 `harmony-native`，File > Project Structure > Signing Configs，登录华为账号，勾自动签名，关联 AppGallery Connect 里的应用（包名 `com.remoteclaude.mobile`），"开通开放能力"里勾 Push Kit；然后 `node harmony-native/scripts/take-signing.js` 把签名存进 `signing.local.json5`。
  - 自动签名的证书、Profile 存在 `%USERPROFILE%\.ohos\config\`，按华为账号命名，同一个账号签的几个工程共用这几个文件，后签的会覆盖先签的。Profile 绑定包名，换包名要重签。
- **服务器地址不写进安装包**（和被控端、安卓 App 一样，见 [08](08-release-and-update.md) 第 1 节）。登录页总是显示"服务器地址"框，预填上次用的；登录成功时存在手机上，设置里能"更换服务器"（先退出旧服务器上的登录、注销推送，再回登录页用新服务器上的账号登录）。早先把地址写进安装包的 0.2.0 登录时已经把地址存在了手机上，升级后照样用它，不用重新填（`restoreServerAddress`）。正式版只认 `https`/`wss`，调试版还允许 `ws://` 明文。
- 构建：`pwsh -File harmony-native\scripts\install.ps1`（构建正式版并装到手机），或 Git Bash 里 `bash harmony-native/scripts/build.sh [release|debug]`（只构建，默认也是正式版）。
- 包名 `com.remoteclaude.mobile`：和 AppGallery Connect 里注册的应用一致，推送靠它认应用（AppGallery Connect 不允许包名里带 harmony）。最初的测试版用的是 `com.remoteclaude.harmony`，和新包名并存、不再覆盖。

## 6. 推送（审批提醒）

协议见 [03](03-protocol.md) 2.10，服务器怎么推见 [09](09-approvals.md) 第 10 节。App 这边：

- 每次连上信令都取推送令牌（`pushService.getToken()`）发 `push-register`；有令牌时请求通知权限（系统只弹一次，拒了要到系统设置里开）。退出登录前发 `push-unregister` 并删掉本机令牌。
- 点通知打开 App（`clickAction.actionType` 0），`clickAction.data` 出现在 Want 的 `parameters` 里；`EntryAbility` 在 `onCreate`/`onNewWant` 里看到 `approvalId` 就让控制器在审批列表到了以后自动弹面板（最多等 15 秒）。入口 Ability 是 `singleton`，首页 skill 带 `ohos.want.action.home`、不配 `uris`。
- 调试版把推送令牌打在日志里（`hdc shell hilog -x | findstr 推送令牌`），方便在电脑上直接给这台手机发测试推送；正式版不打。

## 7. 升级

- 自用：手机用 USB 连着电脑（或开"无线调试"后 `hdc tconn`），运行 `pwsh -File harmony-native\scripts\install.ps1`。同包名、同签名覆盖安装，登录状态和设置都保留。手机锁屏时装不上。
- 不用电脑升级：要在 AppGallery Connect 做"邀请测试"或上架，需要华为开发者实名，审核要几天，暂时没做。服务器的 `/api/update/android` 是安卓渠道，鸿蒙版不查。
- 设置页显示 App 版本；电脑被控端的版本、检查更新、立即升级和安卓一样。

## 8. 开发中踩过的坑

1. **ArkTS 不认辨识联合的收窄**。`if (!r.ok) r.reason` 在 `.ts` 里没问题，`.ets` 里报"属性不存在"。给 ArkTS 用的结果类型做成一个接口、字段都在。`switch (msg.type)` 收窄可以用。
2. **自定义类名不能和 ArkUI 组件重名**：`Screen`、`Menu` 都是内置组件名，叫这些名字的类会让编译器把 `Screen.Auth` 当成组件调用。
3. **`@Builder` 的参数按值传**：`StatusDot(color)`、`uploadBar(this.s.upload)` 这样写，状态变了界面不刷新。要么在 `@Builder` 里直接读状态，要么做成 `@ComponentV2` 用 `@Param`。
4. **软键盘默认把整个页面往上推**，顶栏和画面会被推出屏幕。`setKeyboardAvoidMode(KeyboardAvoidMode.RESIZE)` 改成压短页面（像安卓的 `imePadding`）。
5. **视口这类普通对象的变化界面看不到**：`Viewport` 是普通类，改了它的字段不触发刷新。画面区另记一个 `@Local layoutSeq`，视口变了就加一，算布局的方法先读它，才会跟着重算。
6. **手机锁屏时 `aa start` 起不来 App**（10106102），`hdc install` 也可能失败；`snapshot_display` 截出来是锁屏。调试时让手机"保持唤醒"。
7. **Git Bash 里调 `hdc`**：要 `MSYS_NO_PATHCONV=1`，否则 `/data/local/tmp/...` 被改成 `C:/Program Files/Git/data/...`；本地路径用反斜杠的 Windows 路径。
8. **`uitest uiInput inputText` 注入不了表情**（变成 `??`），也会在末尾多一个换行；测表情要手动打或经剪贴板。
9. **`mediatool send` 在用户版系统上用不了**，没法从电脑往图库塞测试图片；`hdc file send` 能放到"下载"（`/storage/media/100/local/files/Docs/Download`），文件选择器能看到。
10. **`Want.parameters` 的取值**：推送的 `clickAction.data` 直接是 `parameters` 的键；用 `aa start ... --ps approvalId x` 能在命令行模拟点通知。

## 9. 验收记录

2026-11-24 在鸿蒙真机（HarmonyOS 7.0）上，连正式服务器、局域网直连，用 `tools/input-test-window.ps1` 的测试窗口做输入类验证。编号同 [04](04-android-client.md) 的验收表。

| 编号 | 结果 |
|---|---|
| A1 账号 | 登录、令牌保存、App 锁通过；登录页的服务器地址框、设置里"更换服务器"的地址校验通过（真的更换会退出登录，没点确定）；从 0.2.0 升级到 0.2.1 沿用了手机上存的地址。注册、找回密码、各种错误提示的界面和代码都在，**没在真机上走**（服务器关了注册；不想拿正式账号试错密码） |
| A2 会话列表 | 通过：和电脑一致、缩略图、下拉刷新、页签上的个数 |
| A3 首帧 | 通过：约 0.2 秒连通，1 秒内出画面 |
| A4 清晰度 | 通过：1280×2088 不放大能读清正文 |
| A5 点击准确 | 通过：落点和预期差 2 个像素以内 |
| A6 滚动 | 通过：上下方向正确；横向滑动不误触发点击 |
| A7 长按 | 通过：右键按下、松开 |
| A8 缩放平移 | **没验**：命令行注入不了双指手势，要手动试 |
| A9 文字 | 通过：中文、英文、数字逐字输入；表情经粘贴通道正确（注入工具打不了表情） |
| A10 多行 | 通过：两行原样，最后一次回车 |
| A11 发送 | 通过 |
| A12 切换会话 | 通过：1 秒内出新画面 |
| A13 前后台 | 通过：后台时 CPU 0%，回来 3 秒内回到原窗口；冷启动也自动回到上次的窗口 |
| A14 网络切换 | **没验**（要切 Wi-Fi） |
| A15 被控端上下线 | **没验**（重启被控端时 App 锁着） |
| A16 错误提示 | **没验**（要制造窗口被挡住） |
| A17 公网/中继 | **没验**（要用移动网络）；统计浮层能显示直连还是中继 |
| A18 安全 | 令牌在关键资产存储、密码不落盘、App 锁可用；正式版只连 https/wss。没抓包 |
| A19 发图片 | **没验**：图库里只有用户自己的照片，没拿来测 |
| A20～A23 锁屏、解锁、锁定 | **没验**：要真的锁用户的电脑、输入 Windows 密码，留给用户 |
| A24 全部会话 | 通过 |
| A25 打开会话 | 通过：开一个没开着的会话，自动进入画面 |
| A26 新建会话 | **没验**（会在电脑上新开会话窗口） |
| A27 打开失败 | **没验** |
| A28 审批 | 通过（模拟审批文件）：3 秒内出横幅，"拒绝并说明"的原话送回电脑 |
| A29 提问 | 通过：单选、多选、自己填的文字，问题原文一字不差 |
| A30 后台通知 | 改做法，通过：App 在后台时服务器经华为推送发通知（2026-11-24 服务器配好凭据后用模拟审批测），点通知打开 App 并自动弹出审批面板，作答送回电脑 |
| A31 别处作答 | 通过：4 秒内横幅消失 |
| A32 复制命令 | 通过：反引号里的命令单独一块，"复制"写进手机剪贴板 |
| A33 发文件 | 通过：小文件、30 MB 内容一致，进度条，同名存成 (1)、(2) |
| A34 发文件出错 | 部分：超大、旧版被控端的提示有代码；"取消"在局域网上来不及点（30 MB 一秒传完），**没验** |
| A35 发文件时操作 | **没验** |
| A36 关闭会话窗口 | 通过：卡片马上消失、个数减一、Claude 主窗口没有关闭按钮 |
| A37 不点开窗口就操作电脑 | 通过：列表页菜单的平铺项、暂停/恢复（经信令）；锁定、解锁没验 |
| A38 环境折叠 | 通过：重开 App 还是折叠的 |
| A39 "已打开"刷新 | 通过 |
| A40 顺序 | 通过（照被控端给的顺序） |
| A41 剪贴板回传 | 通过：中文、表情、换行 |
| A42 不该同步的 | 通过：手机发过去的多行文字不回传 |
| A43 字体大小 | 通过：三个按钮发 Ctrl+=、Ctrl+-、Ctrl+0 |
