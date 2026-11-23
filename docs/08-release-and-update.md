# 08 发布与升级

手机 App 和电脑被控端都从自己的服务器升级，发新版本只要一条命令。

## 1. 发新版本

### 打包配置

自己的服务器地址、安装包传到哪里，这些因人而异，不写在仓库里，放在本机的 `deploy/prod/build.json`（`deploy/prod/` 整个目录不入库）。部署时运行的 `scripts/init-prod-config.js` 会生成一份，也可以照 `deploy/build.example.json` 手写：

```json
{
  "server": "rc.example.com",
  "hostAppId": "com.example.remoteclaude.host",
  "releaseSsh": "my-server",
  "releaseDir": "/opt/remote-claude/releases",
  "env": {
    "ELECTRON_MIRROR": "https://npmmirror.com/mirrors/electron/"
  }
}
```

| 项 | 说明 |
|---|---|
| `server` | 自己的信令服务器，写域名或完整地址（`wss://rc.example.com/ws`）。打包时写进 App（`BuildConfig.SERVER_ADDRESS`）和被控端（装好的程序的 `package.json` 里的 `defaultServer`），装好就连它 |
| `hostAppId` | 被控端安装程序的应用标识，不写用 `com.remoteclaude.host`。**定了就别再改**：安装程序靠它认出电脑上的旧版本，改了会装出两份 |
| `releaseSsh` | `release.js` 把安装包传到哪台服务器：`ssh` 能直接连上的名字，比如 `~/.ssh/config` 里的别名，登录的用户要能免密 `sudo` |
| `releaseDir` | 服务器上的发布目录，不写用 `/opt/remote-claude/releases` |
| `env` | 打包时额外设的环境变量。从 GitHub 下载 Electron 和打包工具卡住时，在这里设镜像（`ELECTRON_MIRROR`、`ELECTRON_BUILDER_BINARIES_MIRROR`） |

三处读这个文件：`scripts/release.js`、`host/electron-builder.config.js`（被控端打包）、`android/app/build.gradle.kts`（App 构建），前两处经 `scripts/build-config.js`。环境变量 `RC_BUILD_CONFIG` 可以指到别的文件。

没有这个文件、或者没写 `server` 也能打包（`release.js` 要加 `--no-upload`），打出来的安装包不带服务器地址：App 的登录页多一个"服务器地址"框；被控端要在 `%APPDATA%\remote-claude-host\config.json` 里写 `server`，没写的话启动时弹框提示。这样的安装包 `release.js` 不让上传：已经装着的 App 和被控端自动升级成它以后就不知道连哪里了。

### 一条命令

在开发电脑上，仓库根目录运行：

```powershell
node scripts/release.js 0.7.1 --notes "这次改了什么"
```

脚本依次：

1. 改版本号：App 的 `versionName` 改成新版本、`versionCode` 加 1（`android/app/build.gradle.kts`）；被控端 `host/package.json` 的 `version`。新版本号必须比现在的大。
2. 跑测试、打包：App 跑单元测试后打正式版安装包（固定签名，见第 4 节）；被控端跑单元测试后用 electron-builder 打 Windows 安装程序。两个安装包都复制一份到 `dist/`。
3. 上传到服务器的发布目录（打包配置里的 `releaseSsh` 和 `releaseDir`）：先放安装包，最后换版本说明，每个渠道只留最近 3 个安装包。

版本号改动不会自动提交，发布完提交一下（脚本最后会提示命令）。

其它用法：`--only android` 或 `--only host` 只发一边；`--no-upload` 只改版本号、打包，不上传；`--only host --upload-only` 不打包，把上一步 `--no-upload` 打好的被控端安装包传上去。环境变量 `RC_RELEASE_SSH`、`RC_RELEASE_DIR` 可以临时换服务器和目录。

只想打被控端、不动版本号时，在 `host/` 目录下 `npm run dist`，安装程序在 `host/dist/`。

**工作目录里有别人没提交的改动时**（几个会话同时在改），脚本会把它们一起打进安装包。这时在只含已提交代码的干净副本里发：

```powershell
git worktree add --detach $env:TEMP\rc-rel HEAD
# 不入库的东西要补上：打包配置（没有它打出来的包不带服务器地址，脚本也不让上传），把 deploy\prod\build.json 拷过去，
# 或者设环境变量 RC_BUILD_CONFIG 指到原目录里那份；
# android\local.properties；android\keystore.properties（storeFile 改成签名文件的绝对路径）；
# host\node_modules 整个拷过去（robocopy /E），或者在副本里 npm ci
cd $env:TEMP\rc-rel; node scripts/release.js 0.9.6 --only host --notes "…"
```

- `host\node_modules` **必须是真实目录，不能用目录链接**指回原目录：electron-builder 顺着链接找依赖时会漏掉 koffi 的原生模块（`@koromix/koffi-win32-x64`），装好的被控端一启动就报"Cannot find the native Koffi module"。2026-11-20 发 0.9.6 时踩过，电脑离线了几分钟（05 的 2.24）。脚本现在打完会检查 `koffi.node` 在不在，没有就不上传。
- 被控端的单元测试在 node 里跑，测不到打包结果。装到电脑上之前，先用临时资料目录试运行一下 `host\dist\win-unpacked\RemoteClaude Host.exe`（设 `RC_HOST_PROFILE`、`RC_HOST_NO_TILER=1`、`RC_APPROVALS_DIR`），看日志里有没有"被控端 x.y.z 启动"、有没有弹报错框。
- 发完把版本号的改动在原来的工作目录里也改一遍再提交；用完 `git worktree remove` 删掉副本。
- 别人没提交的改动如果都在不进安装包的目录里（`claude-plugin/`、`docs/` 之类），不用另起副本：先看 `git status --short -- host android scripts` 是空的，就在原目录发（2026-11-20 的 0.9.7 / 0.9.5 是这样发的，05 的 2.25）。
- 想先试运行、装好了再上传被控端：用 `--only host --no-upload` 打包，试运行、装完以后，再用 `--only host --upload-only` 把 `host\dist` 里的安装程序和 `latest.yml` 传上去（先放安装程序，最后换 `latest.yml`）。上传前脚本会核对打好的包里写的服务器和打包配置里的是不是同一个。

## 2. 手机 App 怎么升级

- 登录后（之后每隔 6 小时回到前台时）问服务器 `GET /api/update/android`。服务器上的版本更新、包名和本 App 一样时，会话列表上方出现"有新版本 x.y.z"和更新说明。设置里也有"检查更新"。
- 点"更新"：下载安装包（显示进度），核对 SHA-256，然后打开系统的安装界面，点"安装"。
- 断点续传（0.8.1 起）：手机从内地连香港服务器常常丢包掉线，没下完的部分存在缓存目录的 `<sha256 前 16 位>.part` 里。断线后 App 自动等一会儿再从断点接着下（一直下不动才放弃，提示下载失败），App 被关掉后再点"更新"也接着上次的进度；服务器不支持续传时从头下。全部下完核对 SHA-256，对了才交给系统安装。代码在 `update/ResumableDownload.kt`，有单元测试。
- 第一次升级时，系统会先要求允许 RemoteClaude"安装未知应用"：在弹出的设置页里打开开关，回到 App 点"安装"（安装包已经下好，不会重新下载）。这是安卓的规定，绕不过去。
- 调试版的包名不同（`.debug`），服务器上发布的是正式版，调试版不会提示。

## 3. 电脑被控端怎么升级

被控端现在做成了 Windows 安装程序（`RemoteClaude-Host-Setup-x.y.z.exe`），装在当前用户目录 `%LOCALAPPDATA%\Programs\remote-claude-host`，不需要管理员权限。

- **第一次安装**：从 `dist/` 拿安装程序双击运行（没有代码签名，Windows 可能提示"已保护你的电脑"，点"更多信息"→"仍要运行"）。装好会自动启动，第一次运行时打开开机自启。
- **配置**：装好的版本默认连打包时写进去的服务器（打包配置里的 `server`，见第 1 节）。要改服务器等设置，在 `%APPDATA%\remote-claude-host\config.json` 里写，格式同 `host/config.example.json`，只写要改的项。打包时没写服务器、这里也没写，启动时会弹框提示。
- **登录状态**：开发版（`npm start` 从源码运行）和安装版用同一个数据目录 `%APPDATA%\remote-claude-host`，换成安装版不用重新登录，服务器上还是同一台电脑。两个不能同时运行，后启动的会直接退出。
- **自动升级**：启动 1 分钟后检查一次，之后每 4 小时一次，从服务器的 `/download/host/latest.yml` 查版本（带被控端的登录令牌）。有新版本就在后台下载完整安装包（约 110 MB），下好后等没人在看画面时静默安装、自动重新启动；有人在看就一直等到大家都退出画面。
- **马上升级**：托盘菜单里显示当前版本和升级状态，有"检查更新""立即升级到 x.y.z"和"开机自动启动"；手机 App 的设置里显示电脑被控端的版本和状态，可以"检查更新"或"立即升级"（协议文档 2.6）。马上升级时正在看画面的连接会断开，被控端重启后手机自动重连。
- 从源码运行的开发版不自动升级，手机设置里显示"从源码运行的开发版"。

解锁服务（docs/06）是单独装的 Windows 服务，不随被控端升级；要改它时照旧用 `host/unlock-service/install.ps1` 重新安装。

**注意：别从 Claude 桌面端的会话里启动被控端。** Claude 桌面端是商店版（MSIX）应用，从它的 Claude Code 会话里启动的程序（包括 Claude 替你运行的命令）写 `%APPDATA%` 时会被系统悄悄转到 `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\` 下。这样启动的被控端把登录状态存在那里，正常启动（开机自启、安装程序、双击快捷方式）的被控端看不到，就会显示登录页、换一个设备编号。2026-11-19 切换到安装版时就遇到了：之前 Claude 替用户启动的开发版把登录状态存在了转向的目录里，切换时把其中的 `account.json`、`device.json`、`Local State` 复制到了真正的 `%APPDATA%\remote-claude-host`。以后要由 Claude 重启被控端，用不经过 Claude 的方式启动，比如 `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '"<安装目录>\RemoteClaude Host.exe"' }`（WMI 起的进程不在 Claude 的容器里）。

## 4. App 的签名

App 内升级要求新旧安装包的签名一样，签名一变手机上就只能先卸载再装（登录状态会丢）。

- 正式版签名由 `android/keystore.properties` 指定（不入库），签名文件放在 `deploy/prod/` 里（也不入库）。第一次用时自己生成一个签名文件，口令自己定：

  ```powershell
  keytool -genkeypair -v -keystore deploy\prod\android-release.keystore -alias remoteclaude -keyalg RSA -keysize 2048 -validity 10000
  ```

  再写 `android/keystore.properties`（`storeFile` 相对 `android/` 目录，或者写绝对路径）：

  ```properties
  storeFile=../deploy/prod/android-release.keystore
  storePassword=签名文件的口令
  keyAlias=remoteclaude
  keyPassword=密钥的口令
  ```

- **请另外备份签名文件和口令**（比如拷到网盘或另一台电脑）。丢了就再也发不出能直接升级的安装包。
- 换一台电脑发版本：把签名文件和 `keystore.properties` 拷过去即可。没有 `keystore.properties` 时 `release.js` 会拒绝发 App；直接用 gradle 打的正式版会退回调试签名，只适合自己侧载。

## 5. 服务器上的发布目录

```
/opt/remote-claude/releases/
  android/latest.json                  {"package","versionCode","versionName","file","size","sha256","notes","releasedAt"}
  android/RemoteClaude-x.y.z.apk
  host/latest.yml                      electron-builder 生成
  host/RemoteClaude-Host-Setup-x.y.z.exe
```

目录以只读方式挂进信令服务容器（`deploy/compose.yaml` 里的 `./releases:/app/releases:ro`，环境变量 `RC_RELEASES_DIR`）。接口见协议文档 1.7，都要带登录令牌，手机和电脑的令牌都行，外人下载不到安装包。下载接口支持 `Range`，App 用它断点续传；被控端下载的是完整安装程序，没有差分更新（没上传 `.blockmap`）。

**手机到服务器丢包多、下载很慢时**，把服务器的 TCP 拥塞控制换成 BBR 会好很多（`/etc/sysctl.d/90-bbr.conf` 里写 `net.ipv4.tcp_congestion_control=bbr`，`/etc/modules-load.d/bbr.conf` 里写 `tcp_bbr`）。作者实测过一次：手机从内地连香港服务器，延迟约 230ms、丢包约 10%，默认的 cubic 把下载压到每秒十几 KB，换成 BBR 后正常（[05](05-handoff-tasks.md) 2.12）。Caddy 容器有自己的网络命名空间，已经在跑的容器要用 `nsenter` 单独设一次，或者重建容器（重建后沿用主机的设置）。要改回去：删掉这两个文件，再 `sysctl -w net.ipv4.tcp_congestion_control=cubic`（Caddy 容器里也要设一次，或者重建容器）。

## 6. 本机测试升级

不想动生产环境时：

- 用服务器测试工具 `server/test/helpers.js` 的 `startServer({ releasesDir })` 起一个临时服务器，在发布目录里放测试安装包和版本说明。
- App：模拟器装调试版，用调试版连临时服务器；发布目录里的 `latest.json` 写调试版的包名 `com.remoteclaude.android.debug` 和更大的 `versionCode`。
- 被控端：装一个旧版本的安装程序，用 `RC_HOST_PROFILE`、`RC_HOST_CONFIG`（指向临时服务器）、`RC_HOST_NO_TILER=1` 启动它，发布目录放新版本的安装程序和 `latest.yml`，再从控制端发 `host-update` 让它检查。注意装完重新启动的被控端不会带这些环境变量。

2026-11-19 的测试记录见 [05](05-handoff-tasks.md) 2.10。
