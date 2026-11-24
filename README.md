# RemoteClaude

在手机上看着、操作电脑上的 **Claude 桌面端会话窗口**，并在手机上审批 Claude Code 的工具调用、回答它的提问。只认 Claude 的窗口，别的窗口看不到也点不到。

服务器是自己搭的：一台有域名的小服务器，画面能直连就直连，直连不了经自己的中继转发，不经过第三方。

> 这是个人项目，和 Anthropic 没有关系。Claude 是 Anthropic 的商标。
>
> 被控端靠 Claude 桌面端的窗口和界面文字工作（没有公开接口可用），Claude 桌面端升级后部分功能可能要跟着修，见 [07](docs/07-claude-sessions.md)。

## 能做什么

- **看和操作会话**：在安卓 App 或浏览器里选一个 Claude 会话，看它的实时画面，用触摸、鼠标、键盘操作它。按窗口采集，文字清晰；默认 VP9、30 帧。
- **浏览、打开、新建、关闭会话**：App 里能看到 Claude 桌面端的全部会话，点一个就在电脑上开成单独窗口；也能在某个环境下新建会话、关掉会话窗口。
- **手机审批**：Claude Code 要审批工具调用、审批计划，或者用 AskUserQuestion 提问时，手机收到通知，在 App 里或通知上直接作答，效果和在电脑上点一样。Claude 桌面端自己弹的确认框（比如自带浏览器的"允许 Claude 操作这个网站？"）也会提醒到手机，能直接点"允许一次""拒绝"。
- **发图片、发文件**：从手机把图片、文件（单个不超过 50 MB）发到电脑，路径自动填进 Claude 的输入框。
- **剪贴板**：看着画面时，电脑上新复制的文字自动放进手机剪贴板。
- **锁定和解锁电脑**：手机上锁屏；装了解锁服务后还能输入 Windows 密码或 PIN 解锁。
- **窗口平铺**：电脑上的 Claude 会话窗口自动按 1/3 屏宽排好，手机上也能重排、提到最前。
- **多台电脑、多个账号**：一个账号可以登录多台电脑；账号之间互相看不到。
- **自动升级**：手机 App 和电脑被控端都从自己的服务器升级，发新版本一条命令。

网页控制端只有看画面和操作这部分，主要用来调试和应急；完整功能在安卓 App 里。

## 组成

```
安卓 App（android/）/ 浏览器（web/）
        │  HTTPS + WebSocket：登录、列窗口、选窗口、WebRTC 协商
        ▼
你的服务器：信令服务器（server/）+ coturn 中继
        ▲
        │  WebSocket（只向外连接，电脑不开入站端口）
你的电脑：被控端（host/，Electron）── Claude Code 插件（claude-plugin/）
```

画面和输入事件走 WebRTC：能直连就直连，直连不了经 coturn 中继。信令服务器不经手画面。

| 目录 | 作用 |
|---|---|
| `host/` | 被控端（Windows，Electron）。枚举 Claude 窗口、按窗口采集画面并推流、把远程输入注入到选中的窗口；浏览和打开会话（`host/sessions/`）；自动平铺窗口（`host/tiler/`）；转发审批（`host/approvals/`）；解锁服务（`host/unlock-service/`） |
| `server/` | 信令服务器（Node.js）。账号、邮件验证码、按账号转发信令、签发中继的临时凭据、托管网页和安装包 |
| `web/` | 控制端网页，纯静态文件，无需构建 |
| `android/` | 安卓控制端（Kotlin + Compose），构建和联调方法见 [android/README.md](android/README.md) |
| `claude-plugin/` | Claude Code 插件：把审批和提问交给被控端转到手机（[09](docs/09-approvals.md)） |
| `deploy/` | 服务器部署用的文件：Docker 编排、Caddy 和 coturn 配置示例、打包配置样例 |
| `scripts/` | 生成配置（`init-config.js`、`init-prod-config.js`）、发版本（`release.js`）、Claude 升级后的自检（`claude-selfcheck.js`） |
| `tools/` | 开发用的小工具，比如输入测试窗口（`input-test-window.ps1`），用来安全地验证远程输入 |
| `docs/` | 设计文档和开发记录 |

需要的环境：

| | 要求 |
|---|---|
| 被控的电脑 | Windows 10/11，装着 Claude 桌面端 |
| 手机 | 安卓 8.0 以上 |
| 服务器 | 有公网 IP 和域名的 Linux 服务器，装 Docker（或者直接用 Node.js 22.13 以上跑）；要能发邮件（注册和找回密码用验证码） |
| 开发和打包 | Node.js 22.13 以上；打 App 要 JDK 17 和 Android SDK |

## 本机试用

不用服务器，先在一台电脑上跑通。需要 Node.js 22.13 以上（服务器用到内置的 SQLite）、Windows 10/11。

```powershell
npm run setup
```

```powershell
npm run server
```

```powershell
npm run host
```

然后：

1. 浏览器打开 <http://127.0.0.1:8787>，点"注册账号"用邮箱注册。本机配置的发信模式是 `log`，不会真的发邮件，验证码打印在服务器的终端里。
2. 在电脑上的被控端窗口里用同一个账号登录。
3. 回到浏览器，就能看到这台电脑和它上面的 Claude 会话。

`npm run setup` 会安装依赖并生成 `server/config.json` 和 `host/config.json`。账号数据存在 `server/data/`。如果 Electron 运行时下载卡住（从 GitHub 下载，国内常见），先设置镜像再装：

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"; node host/node_modules/electron/install.js
```

想在手机上试，用安卓模拟器或同一个局域网里的真机装调试版，见 [android/README.md](android/README.md)。

## 正式使用：用自己的服务器

仓库和安装包里都不带任何人的服务器地址。正式使用要自己搭服务器，装好 App 和被控端后在登录页填上自己的服务器地址：

1. **部署服务器**：照下面"[部署到服务器](#部署到服务器)"一节做，得到自己的地址，比如 `https://rc.example.com`。
2. **写打包配置**（只有要用 `release.js` 上传安装包时才需要）：部署时运行的 `scripts/init-prod-config.js` 会生成 `deploy/prod/build.json`（`deploy/prod/` 整个目录不入库），填上 `releaseSsh`（安装包传到哪台服务器）。也可以照 [deploy/build.example.json](deploy/build.example.json) 手写一份。各项说明见 [08](docs/08-release-and-update.md) 第 1 节。服务器地址不写在这里，也不会写进安装包。
3. **打安装包**（先 `npm run setup` 装好依赖；打 App 还要 JDK 17、Android SDK 和签名，见 [android/README.md](android/README.md) 和 [08](docs/08-release-and-update.md) 第 4 节）：
   ```powershell
   node scripts/release.js 1.0.0 --no-upload
   ```
   `dist/` 里得到 `RemoteClaude-Host-Setup-x.y.z.exe`（电脑）和 `RemoteClaude-x.y.z.apk`（手机），里面不带服务器地址，谁装都可以连自己的服务器。版本号要比仓库里现在的大；只打一边加 `--only host` 或 `--only android`。去掉 `--no-upload` 就同时传到服务器的发布目录，已经装着的 App 和被控端会自动升级。
4. **安装**：
   - **电脑**：运行安装程序，装在当前用户目录、开机自启。窗口的登录页上填服务器地址（`rc.example.com` 这样的域名就行），注册一个账号并登录。之后有新版本时，在没人看画面的时候自己重启升级，填过的地址和登录状态都保留。
   - **手机**：装 apk，登录页填同一个服务器地址，用同一个账号登录。之后 App 提示"有新版本"时点"更新"。
   - **手机审批**：电脑上装一次 Claude Code 插件（电脑上要有 Node.js），之后 Claude 要审批或提问时手机会收到通知（详见 [09](docs/09-approvals.md)）：
     ```powershell
     claude plugin marketplace add <仓库所在目录>\claude-plugin
     ```
     ```powershell
     claude plugin install remoteclaude@remoteclaude-local
     ```
   - **从手机解锁电脑**（可选）：装解锁服务，会弹管理员确认，见 [06](docs/06-unlock-service.md)：
     ```powershell
     powershell -ExecutionPolicy Bypass -File host\unlock-service\install.ps1
     ```

没写打包配置也能打包（只是不能用 `release.js` 上传）。

**更换服务器**：电脑上在被控端窗口点"更换服务器"（登录后在账号下面），或者右键托盘图标选"更换服务器…"；手机上在设置里点"更换服务器"。换了会退出旧服务器上的账号，回到登录页，用新服务器上的账号登录后连新服务器。

**从带服务器地址的旧版升级**：0.9.25 及以前的被控端、0.9.8 及以前的 App 是把服务器地址打进安装包的。升级到不带地址的版本后照样连原来的服务器，不用重新填、也不用重新登录：被控端第一次启动时从登录状态（`account.json` 里记着登录的是哪个服务器）找回地址写进 `config.json`；App 用登录时存在手机上的地址。没登录过的要在登录页填一次。

## 控制端怎么操作

**安卓 App 的会话列表**

- "已打开"页签：电脑上已经开着的 Claude 会话窗口，点进去看画面。右上角的"⋮"菜单不点开窗口就能重排窗口、锁定和解锁电脑。
- "全部会话"页签：Claude 桌面端里的全部会话，按环境分组。点一个会话，电脑上会自动把它开成单独窗口（已开着就直接切过去），手机随即进入它的画面；在某个环境旁点"新建"，电脑上开一个选好这个环境的新会话窗口，在画面里打第一句话就开始了。被控端是替你在 Claude 界面里点菜单做到的，不动你的鼠标键盘，详见 [07](docs/07-claude-sessions.md)。网页版控制端没有这个页签。

**手机上看画面时**（App 和手机浏览器）

| 手势 | 效果 |
|---|---|
| 单指轻点 | 左键点击 |
| 单指长按 | 右键点击 |
| 单指拖动 | 滚动远程内容 |
| 双指捏合 / 拖动 | 缩放和平移画面（只影响本地显示） |

打字用底部输入框，点"发送"是把文字填进远程窗口再按回车。

字太小看不清：点右上角的"⋮"，选"字体大小"，画面下面出现"缩小""默认""放大"，调的是电脑上 Claude 自己的字体大小（所有 Claude 窗口一起变），调完点"完成"。

手机浏览器里比 App 多两样：输入框旁边的"填入"只填文字、不按回车；"⋮"菜单里点"显示按键栏"，会多出一排 Esc、回车、换行（Shift+回车）、方向键、Tab、全选、复制、粘贴、撤销等按键，默认是收起的。

**电脑浏览器**

- 鼠标移动、左中右键、拖动、滚轮都原样转发。
- 点一下画面后，键盘直接打到远程窗口，包括 Ctrl+A 这类快捷键。F5、F11、F12 留给浏览器自己。
- Ctrl+V 粘贴的是**本机**剪贴板里的文字。
- Ctrl+滚轮缩放画面，点"适应"还原。
- 用中文输入法时，请在底部输入框里打字再点"填入"或"发送"。

## 配置

**被控端**：从源码运行读 `host/config.json`；装好的正式版读 `%APPDATA%\remote-claude-host\config.json`（没有就全用默认值，只写要改的项）。服务器地址一般不用手写：在被控端窗口里填或更换时，会写进这个文件的 `server`（别的项原样保留）。

| 字段 | 说明 |
|---|---|
| `server` | 信令服务器地址，写法和手机 App 登录页一样：部署后只写域名（`rc.example.com`），本机测试写 `http://127.0.0.1:8787`。以前的 `wss://你的域名/ws`、`ws://127.0.0.1:8787/ws` 写法也认。账号接口地址由它推出。没有时被控端窗口显示登录页，让你填 |
| `targets` | 允许远控的进程名，默认只有 `claude.exe` |
| `maxBitrateKbps` | 视频码率上限，默认 10000。只有画面大面积变化时才用得到；服务器或手机流量紧就调低 |
| `maxFps` | 帧率上限，默认 30。调到 60 滑动稍顺一点，但滑动时流量最多翻倍 |
| `startBitrateKbps` | 打开画面时带宽估计的起步值，默认 2500，不超过码率上限 |
| `codec` | 优先用的编码：`VP9`（默认）、`VP8`、`H264`、`AV1`，`auto` 表示按 Chromium 的默认顺序 |
| `fileDir` | 手机发来的文件存在哪里，默认"下载"里的 `RemoteClaude` 目录 |
| `clipboardSync` | 有人看画面时，把电脑上新复制的文字发给控制端。默认开，写成 `false` 关掉 |
| `dialogNotice` | Claude 桌面端自己弹的确认框（自带浏览器的"允许 Claude 操作这个网站？"等，不经过工具审批）出现几秒没人点，就提醒手机（见 [09](docs/09-approvals.md) 第 4 节）。默认开，写成 `false` 关掉 |
| `claudeLogFile` | Claude 桌面端的日志文件，上一项靠读它。不写就自己找（`%LOCALAPPDATA%\Claude\logs\main.log` 或 `%APPDATA%\Claude\logs\main.log`） |
| `claudeSelfCheck` | Claude 桌面端升级后，等电脑空闲时自动试一遍新建和打开会话，走不通就提醒手机（见 [07](docs/07-claude-sessions.md) 第 8 节）。默认开，写成 `false` 关掉 |

被控端点窗口的关闭按钮只是藏到系统托盘，远程查看不受影响；单击托盘图标重新打开窗口，右键托盘图标选"退出 RemoteClaude"才真正退出。托盘图标橙色表示已连上服务器，灰色表示没连上，鼠标停在上面能看到状态和正在查看的设备数。

被控端的登录状态不在配置文件里：设备编号和加密后的令牌存在 Electron 的用户数据目录（`%APPDATA%\remote-claude-host\`）。开发时设环境变量 `RC_HOST_PROFILE` 指向另一个目录，就能在同一台电脑上再跑一个被控端，模拟第二台电脑；这时再设 `RC_HOST_NO_TILER=1`，免得两个被控端一起排窗口。

**服务器**：`server/config.json`

| 字段 | 说明 |
|---|---|
| `port` / `bind` | 监听端口和地址。默认只监听 `127.0.0.1`，由反向代理对外提供 HTTPS |
| `trustProxy` | 在反向代理后面时设为 `true`，用来取真实客户端 IP 做限流 |
| `dataDir` | 账号数据库所在目录，默认 `server/data/`；环境变量 `RC_DATA_DIR` 优先 |
| `registration.open` | 是否开放注册，默认 `true`。自己的账号注册好以后改成 `false`，别人就注册不了、用不了你的中继流量 |
| `mail` | 发信，`mode` 四选一：`smtp`（填 `host`、`port`、`secure`、`user`、`pass`、`from`）；`tencent-ses` 腾讯云邮件推送的 API（填 `secretId`、`secretKey`、`region`、`templateId`、`from`，模板只有一个变量 `code`）；`log` 只把验证码打印到日志（本机开发用）；`memory` 自动化测试用 |
| `iceServers` | 额外的 STUN/TURN 服务器列表 |
| `turn` | coturn 的地址和共享密钥，服务器据此签发 24 小时有效的临时凭据 |
| `limits` | 可选，覆盖限流参数，见 `server/lib/config.js` |

**打包**：`deploy/prod/build.json`，安装包传到哪里、被控端的应用标识，见 [08](docs/08-release-and-update.md) 第 1 节。服务器地址不写进安装包。

## 窗口平铺

被控端自带 Claude 会话窗口的自动平铺（从 [claude-window-tiler](https://github.com/liuquan898-creator/claude-window-tiler) 插件并进来、用 JavaScript 重写的，在 `host/tiler/`）。

- 每个会话窗口固定占屏幕宽度的 1/3，从最左边的屏开始，一个屏从左到右放满 3 个再放右边的下一个屏；新开的排在最后，关掉的马上补位；最大化的也排进去，最小化的不占位置。先往哪个屏放可以在托盘菜单的"屏幕顺序"里选：从左到右（默认）、从右到左、主屏优先；屏有 2～3 个时还列出按屏幕序号的所有排法（屏 1 → 2 → 3、屏 2 → 3 → 1 ……）。
- 新开会话后不再自动收起 Claude 主窗口（想要以前的效果，在配置文件里把 `hide_main_window` 改成 `true`）；从任务栏或 Alt+Tab 切到 Claude 时，把所有会话窗口一起提到最前。被控端为远程输入切前台时不会这样做。
- 托盘菜单：立即重排、把所有会话提到最前、暂停自动平铺、屏幕顺序、打开配置文件。快捷键 Ctrl+Alt+Shift+T 立即重排。手机 App 画面页的"更多"菜单里也有重排、提到最前、暂停。
- 配置文件是 `%USERPROFILE%\.claude-window-tiler\config.toml`，各项说明见文件里的注释，改完保存下次重排就生效（快捷键要重启被控端）。
- 如果还装着原来的 claude-window-tiler 插件：它在运行时内置平铺不启动，免得两个一起挪窗口；每 30 秒再看一次，旧的退出后自动接手。不再需要旧插件时：
  ```powershell
  claude plugin uninstall window-tiler
  ```

## 账号

- 用邮箱注册，验证码 6 位、10 分钟有效。找回密码同样用邮箱验证码，重置后这个账号所有已登录的设备都会下线。
- 电脑上的被控端和手机、网页都登录同一个账号。一个账号可以登录多台电脑，控制端先选电脑、再选会话；不同账号之间互相看不到。
- 在被控端上退出登录，这台电脑就从控制端的列表里消失。
- 接口和消息格式见 [03 通信协议](docs/03-protocol.md)。

## 安全设计

能操作 Claude 窗口，就等于能让 Claude 在电脑上执行命令，所以这几条是硬约束：

- **只认白名单进程**。窗口枚举、采集、输入注入三处都会核对进程名，默认只有 `claude.exe`。
- **输入只落在选中的窗口上**。注入前确认该窗口在前台；鼠标事件还要确认落点最上层就是这个窗口，被别的程序挡住就丢弃并提示。
- **电脑不开入站端口**。被控端只向外连接信令服务器。
- **账号隔离**。服务器只在同一账号内转发消息，别的账号既看不到你的电脑，也发不了消息给它。
- **密码和令牌不存明文**。密码用 scrypt 加盐散列；登录令牌和验证码只存散列值。被控端的令牌用 Windows DPAPI 加密，安卓端用 Keystore 加密。
- **防爆破**。登录失败按 IP 和邮箱分别计数，15 分钟内错 10 次锁定 15 分钟；验证码错 5 次作废；发验证码按邮箱和 IP 限频。
- **令牌可作废**。退出登录、重置密码、同一设备重新登录都会让旧令牌失效，用它连着的连接立即断开。
- **公网部署必须用 HTTPS**，否则密码和令牌在网络上是明文。

还没做的（见 [02](docs/02-architecture.md) 的安全模型一节）：没有二次验证；没有按账号的流量配额，开放注册时别人能用你的中继。**账号密码等于这台电脑的操作权，请用强密码，自己用的服务器注册完就关掉开放注册。**

## 已知限制

- **远程操作会占用电脑的鼠标和键盘**。Windows 的模拟输入只能打到前台窗口，所以点击或打字时那个会话窗口会被切到最前。只看画面、只移动鼠标不会抢前台。
- **电脑必须保持解锁、不息屏**。锁屏后采集不到画面也注入不了输入。有人在看时被控端会阻止显示器休眠，但不会阻止手动锁屏。锁了屏可以用解锁服务从手机解开（[06](docs/06-unlock-service.md)）。
- **弹出的系统菜单和对话框看不到**。按窗口采集只包含窗口本身，右键菜单、文件选择框这类独立弹窗不在画面里。Claude 界面内部的下拉和弹层不受影响。
- **多行或超过 40 字的文字通过剪贴板粘贴**，会覆盖电脑上的剪贴板内容。
- **剪贴板只同步文字**：只在看着画面时、只同步新复制的文字，图片和文件不同步；网页控制端没有。手机发过去的长文字、图片、文件路径不会再同步回来。
- **最小化的窗口**被选中时会自动还原。
- **浏览、打开、新建会话认的是 Claude 界面上的文字**，目前认简体中文和英文（英文没实测过），Claude 桌面端升级后可能要改，见 [07](docs/07-claude-sessions.md) 第 5、6 节。
- 被控端只支持 Windows，控制端 App 只有安卓。

## 部署到服务器

下面按"一台 Linux 服务器、用 Docker"来写，地址用 `rc.example.com`、公网 IP 用 `203.0.113.10` 举例。

| 组件 | 怎么跑 | 对外端口 |
|---|---|---|
| 信令服务 | 容器 `remote-claude`，加入 Caddy 所在的 docker 网络，不映射宿主机端口 | 无，经 Caddy 的 443 |
| HTTPS | Caddy 反向代理，证书自动申请 | 80、443 |
| 中继 | 容器 `remote-claude-coturn`，宿主机网络 | UDP/TCP 3478，UDP 49160-49200 |

步骤：

1. **DNS**：子域名 A 记录指向服务器公网 IP。建议用单独的子域名，不要挂在别的网站的某个路径下（原因见 `deploy/Caddyfile.example` 开头）。
2. **防火墙 / 安全组**：放行入站 TCP 80、443，UDP 3478、TCP 3478、UDP 49160-49200。
3. **发信**：准备一个能发邮件的 SMTP 账号（或腾讯云邮件推送），把服务器配置里的 `mail` 一节写进本机的 `deploy/prod/mail.json`，字段见上面"配置"一节。没有这个文件时先用 `log` 模式，验证码只打印在服务器日志里。
4. **生成生产配置**（在本机，写到不入库的 `deploy/prod/`）：
   ```powershell
   node scripts/init-prod-config.js --domain rc.example.com --public-ip 203.0.113.10 --private-ip 10.0.0.5
   ```
   `--private-ip` 是服务器网卡上的内网地址（`ip -4 addr` 查看），公网 IP 直接配在网卡上的可以不写。生成四个文件：`server.config.json`（信令服务配置）、`turnserver.conf`（coturn 配置，和前者共用一个随机生成的密钥）、`host.config.json`（从源码运行被控端时用的配置）、`build.json`（打包配置）。
5. **上传并启动**：把 `server/`、`web/`、`deploy/` 打包放到服务器 `/opt/remote-claude/src/`，`deploy/compose.yaml` 放到 `/opt/remote-claude/`，两份生产配置放到同一目录：`server.config.json` 属主 uid 1000、`turnserver.conf` 属主 uid 65534，权限都是 600；再建一个属主 uid 1000 的 `data/` 目录放账号数据库。Caddy 所在的 docker 网络名写进 `/opt/remote-claude/.env`（`docker network ls` 查看；没有 Caddy 就先 `docker network create proxy`，再让 Caddy 容器加入它）：
   ```bash
   echo "RC_PROXY_NETWORK=proxy" | sudo tee /opt/remote-claude/.env
   ```
   ```bash
   cd /opt/remote-claude && sudo docker compose up -d --build
   ```
6. **Caddy**：在 Caddyfile 里加上 `deploy/Caddyfile.example` 里的站点块（域名换成自己的），校验后平滑重载：
   ```bash
   sudo docker exec <Caddy 容器名> caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
   ```
   ```bash
   sudo docker exec <Caddy 容器名> caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
   ```
7. **检查**：`https://rc.example.com/healthz` 返回 200；浏览器打开 `https://rc.example.com` 能看到登录页，注册自己的账号。
8. 回到上面"[正式使用](#正式使用用自己的服务器)"的第 3 步，打安装包、装到电脑和手机上。

更新代码时重复第 5 步的上传，再执行 `sudo docker compose up -d --build`；账号数据在 `data/` 里，不受影响，记得定期备份。`deploy/remote-claude.service` 是不用 Docker 时的 systemd 写法，留作参考。

**手机和电脑离服务器都很远时**（比如服务器在境外、人在境内），画面绕着中继走会很卡。可以在离得近的地方另放一台只跑 coturn 的服务器当中继：不用域名，`turnserver.conf` 照抄、改成它自己的 IP，共享密钥用同一个；再把它的地址加进信令服务器配置的 `iceServers` 和 `turn.urls`，排在前面。信令服务器签发的一份临时凭据两边都认。实测记录见 [05](docs/05-handoff-tasks.md) 的 2.14。

## 文档

| 文档 | 内容 |
|---|---|
| [01 需求与范围](docs/01-requirements.md) | 最初要解决什么问题、功能清单、不做什么、前提约束 |
| [02 架构设计](docs/02-architecture.md) | 组件与流程、被控端实现要点、安全模型、技术选型、踩过的坑 |
| [03 通信协议](docs/03-protocol.md) | 账号接口、信令消息、WebRTC 约定、输入事件格式 |
| [04 安卓控制端设计](docs/04-android-client.md) | 技术栈、页面、手势、接入要点、验收标准 |
| [05 开发记录](docs/05-handoff-tasks.md) | 开发过程中的工作日志：每项功能怎么验证的、哪些没验证、任务清单。很长，按需查 |
| [06 解锁服务](docs/06-unlock-service.md) | 从手机解锁电脑用的 Windows 服务：原理、安全措施、安装 |
| [07 浏览和打开 Claude 会话](docs/07-claude-sessions.md) | 手机上浏览全部会话、打开和新建会话窗口：被控端怎么做到的、Claude 升级后怎么修 |
| [08 发布与升级](docs/08-release-and-update.md) | 打包配置；一条命令发新版本；手机 App 和电脑被控端怎么自动升级；App 签名 |
| [09 手机审批](docs/09-approvals.md) | 在手机上审批 Claude Code 的工具调用、回答 Claude 的提问：插件、被控端、App 怎么配合，后台通知 |

想了解整体先读 02，想改代码先读 02 的"开发中踩过的坑"和对应功能的那一篇。文档是随着开发一路写下来的，01 和 04 里有些"待开发""第一版不做"的说法已经过时，以代码和 05 的记录为准。

## 不入库的文件

已写在 `.gitignore` 里：

- `server/config.json`、`host/config.json`：本机配置。新环境用 `npm run init-config` 生成，或参照同目录的 `config.example.json` 手写。
- `server/data/`：本机测试时的账号数据库。
- `deploy/prod/`：自己这套服务器的东西，只存在本机和服务器上：
  - `server.config.json`、`turnserver.conf`、`host.config.json`：由 `scripts/init-prod-config.js` 生成，含发信密码和 TURN 密钥。丢了就重新生成并替换服务器上的配置。
  - `build.json`：打包配置，安装包传到哪里（样例 `deploy/build.example.json`）。
  - `mail.json`：发信配置。
  - 安卓正式版的签名文件（见 [08](docs/08-release-and-update.md) 第 4 节）。**签名文件要另外备份**，丢了就发不出能直接升级的安装包。
- `android/keystore.properties`、`android/local.properties`：签名配置和本机的 SDK 路径。
- `host/config.*.json`：被控端的其它配置副本（比如本机测试用的那份）。
- `dist/`：打好的安装包。
- `node_modules/`

## 许可

[MIT](LICENSE)。用到的第三方库（Electron、koffi、electron-updater、ws、nodemailer、OkHttp、Jetpack Compose、stream-webrtc-android 等）各有自己的许可证。

远程控制软件能操作你的电脑，请只连自己搭的、信得过的服务器；作者不对使用造成的损失负责。
