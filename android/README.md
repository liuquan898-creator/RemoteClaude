# RemoteClaude 安卓控制端

在手机上查看和操作电脑上的 Claude 会话窗口。设计见 [docs/04-android-client.md](../docs/04-android-client.md)，协议见 [docs/03-protocol.md](../docs/03-protocol.md)。

## 构建

需要 JDK 17（Android Studio 自带的 `jbr` 即可）和 Android SDK（compileSdk 36、build-tools 35.0.1）。

```powershell
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
```

```powershell
.\gradlew.bat :app:assembleDebug :app:testDebugUnitTest
```

产物在 `app/build/outputs/apk/`：

| 版本 | 包名 | 区别 |
|---|---|---|
| 调试版 `app-debug.apk` | `com.remoteclaude.android.debug` | 允许 `ws://` 明文连接，方便连局域网或模拟器里的本机服务器 |
| 正式版 `app-release.apk` | `com.remoteclaude.android` | 只能连 `https`/`wss`；开启代码裁剪；有 `keystore.properties` 时用自己的正式签名，没有就退回调试签名（只适合自己侧载），见 [docs/08](../docs/08-release-and-update.md) 第 4 节 |

两个版本包名不同，可以同时装在一台手机上。

**服务器地址**不写在仓库里，构建时从仓库根目录的 `deploy/prod/build.json`（不入库，样例 `deploy/build.example.json`）读 `server`，写进 `BuildConfig.SERVER_ADDRESS`，见 [docs/08](../docs/08-release-and-update.md) 第 1 节：

- 配了：正式版只连这个地址，登录页不显示地址框。
- 没配：正式版的登录页也显示"服务器地址"框，自己填。
- 调试版总是显示地址框，没填时用配的那个。

如果依赖下载慢，可以在命令后面加本机代理参数，例如 `-Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=7897`。不要把代理写进仓库里的 `gradle.properties`。

## 版本选择

构建工具用 AGP 8.13、Gradle 8.13、Kotlin 2.2.21，库版本相应取与 compileSdk 36 兼容的稳定版（见 `gradle/libs.versions.toml` 开头的说明）。升级到 AGP 9 / compileSdk 37 时可以把库一并升到最新。

## 代码结构

`app/src/main/java/com/remoteclaude/android/` 下：

| 包 / 文件 | 职责 |
|---|---|
| `protocol/` | 消息解析与构造、服务器地址整理。不依赖 Android，有单元测试 |
| `net/` | 账号接口、信令 WebSocket（OkHttp）、网络切换监听 |
| `rtc/` | WebRTC 初始化、单条画面连接（应答方）、统计信息 |
| `video/` | 画面坐标换算（有单元测试）、按视频原始分辨率渲染的 TextureView、手势识别 |
| `input/` | 输入事件发送与滚动合并 |
| `data/` | 设置、登录令牌、设备编号存储（令牌用 Keystore 加密） |
| `RemoteController.kt` | 整个控制端的状态机：登录、重连、窗口列表、画面连接、前后台 |
| `ui/` | Compose 界面：账号页（登录、注册、找回密码）、会话列表（含电脑切换）、远程画面页、设置、锁屏 |

## 本机联调

用模拟器连电脑上的服务器和被控端：

1. 在仓库根目录启动服务器和被控端（见根目录 README）。
2. 需要验证输入时，按 `tools/input-test-window.ps1` 开头的说明打开输入测试窗口，不要拿真实的 Claude 会话试。
3. 模拟器里装调试版（正式版只能连 `https`/`wss`，连不了本机的明文地址），服务器地址填 `ws://10.0.2.2:8787`（模拟器里的 `10.0.2.2` 就是电脑本机），用在网页上注册的测试账号登录。
4. 真机和电脑在同一个局域网时，要让服务器监听局域网地址（`server/config.json` 的 `bind` 改成 `0.0.0.0`），App 里填 `ws://电脑IP:8787`。也可以用数据线连上后执行 `adb reverse tcp:8787 tcp:8787`，App 里填 `ws://127.0.0.1:8787`。
